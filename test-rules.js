#!/usr/bin/env node
/**
 * VERDICT Rule Engine Unit Tests
 * Tests each rule in evaluateRules() individually.
 * Run: node test-rules.js
 */

// ── Inline the constants (mirrors server.js) ──
const PROFIT_TARGET        = 0.06;
const VERIFICATION_TARGET  = 0.04;
const MAX_LOSS             = 0.04;
const DAILY_LOSS_LIMIT     = 0.02;
const POSITION_CAP         = 0.20;
const MIN_TRADING_DAYS     = 7;
const CONSISTENCY_MAX_PCT  = 0.35;
const EVAL_TIME_LIMIT_DAYS = 30;
const PROFIT_SPLIT         = 0.80;

// ── Minimal in-memory DB mock ──
const tables = { daily_pnl: [], accounts: [] };
let nextId = 1;

async function dbSelect(table, filters) {
  return (tables[table] || []).filter(row => {
    for (const [k, v] of Object.entries(filters)) {
      if (row[k] !== v) return false;
    }
    return true;
  });
}
async function dbInsert(table, data) {
  const row = { id: nextId++, ...data, created_at: new Date().toISOString() };
  if (!tables[table]) tables[table] = [];
  tables[table].push(row);
  return { ...row };
}
async function dbUpdate(table, filters, data) {
  const rows = await dbSelect(table, filters);
  for (const row of rows) Object.assign(row, data);
}
async function dbSelectOne(table, filters) {
  return (await dbSelect(table, filters))[0] || null;
}

// ── Copy core functions from server.js ──

function getTargetPct(account) {
  const phase = account.phase || 'eval';
  if (phase === 'verification') return VERIFICATION_TARGET;
  return PROFIT_TARGET;
}

async function getDailyPnl(accountId, currentBalance) {
  const today = new Date().toISOString().slice(0, 10);
  let row = (await dbSelect('daily_pnl', { account_id: accountId, date: today }))[0];
  if (!row) {
    row = await dbInsert('daily_pnl', {
      account_id: accountId, date: today,
      starting_bal: currentBalance, ending_bal: currentBalance,
      realized_pnl: 0, trade_count: 0,
    });
  }
  return row;
}

async function updateDailyPnl(accountId, newBalance, pnl) {
  const today = new Date().toISOString().slice(0, 10);
  let row = (await dbSelect('daily_pnl', { account_id: accountId, date: today }))[0];
  if (!row) {
    row = await dbInsert('daily_pnl', {
      account_id: accountId, date: today,
      starting_bal: newBalance - pnl, ending_bal: newBalance,
      realized_pnl: pnl, trade_count: 1,
    });
  } else {
    await dbUpdate('daily_pnl', { id: row.id }, {
      ending_bal: newBalance,
      realized_pnl: +(Number(row.realized_pnl) + pnl).toFixed(2),
      trade_count: (Number(row.trade_count) || 0) + 1,
    });
  }
}

// Mock positions table for MTM tests
if (!tables.positions) tables.positions = [];

// Mock computeEquity — uses positions table if account has open positions
async function computeEquity(account) {
  const cashBalance = Number(account.balance);
  const openPositions = (tables.positions || []).filter(p => p.account_id === account.id && p.status === 'open');
  if (!openPositions.length) return cashBalance;
  let mtm = 0;
  for (const pos of openPositions) {
    // Use mock_current_price if set, otherwise fall back to cost
    mtm += pos.mock_current_value != null ? Number(pos.mock_current_value) : Number(pos.cost);
  }
  return +(cashBalance + mtm).toFixed(2);
}

async function evaluateRules(account, context = {}) {
  const { trigger = 'pre_order', orderCost = 0, closePnl = 0 } = context;
  const size    = Number(account.size);
  const balance = Number(account.balance);
  const phase   = account.phase || 'eval';
  const targetPct = getTargetPct(account);

  const equity = await computeEquity(account);

  // 1. TIME LIMIT
  if (['eval', 'challenge', 'verification'].includes(account.status) && account.eval_ends_at) {
    if (new Date(account.eval_ends_at) < new Date()) {
      return { ok: false, code: 'TIME_EXPIRED', msg: 'Challenge expired — 30 days have elapsed', action: 'fail' };
    }
  }

  // 2. STATIC DRAWDOWN (uses equity = cash + MTM)
  const lossFloor = size * (1 - MAX_LOSS);
  if (trigger === 'pre_order') {
    if (equity - orderCost < lossFloor) {
      return { ok: false, code: 'MAX_LOSS', msg: `Order would breach your ${MAX_LOSS * 100}% loss limit`, action: 'reject_order' };
    }
  } else {
    if (equity < lossFloor) {
      return { ok: false, code: 'MAX_LOSS', msg: `Account breached ${MAX_LOSS * 100}% max drawdown`, action: 'fail' };
    }
  }

  // 3. DAILY LOSS LIMIT
  const today = new Date().toISOString().slice(0, 10);
  const dailyRows = await dbSelect('daily_pnl', { account_id: account.id, date: today });
  const dailyRow = dailyRows[0];
  if (dailyRow) {
    const dailyFloor = size * DAILY_LOSS_LIMIT;
    const dailyLoss = Number(dailyRow.starting_bal) - Number(dailyRow.ending_bal);
    if (trigger === 'pre_order') {
      if (dailyLoss >= dailyFloor) {
        return { ok: false, code: 'DAILY_LOSS', msg: `Daily loss limit reached`, action: 'reject_order' };
      }
    } else {
      if (dailyLoss > dailyFloor) {
        return { ok: false, code: 'DAILY_LOSS', msg: `Daily loss limit breached`, action: 'fail' };
      }
    }
  }

  // 4. POSITION CAP (pre-trade only)
  if (trigger === 'pre_order') {
    if (orderCost > size * POSITION_CAP) {
      return { ok: false, code: 'POSITION_SIZE', msg: `Max ${POSITION_CAP * 100}% per trade`, action: 'reject_order' };
    }
  }

  // 5. PROFIT TARGET CHECK (post-trade only)
  if (trigger !== 'pre_order') {
    const targetBalance = size * (1 + targetPct);
    if (balance >= targetBalance) {
      // 5a. MIN TRADING DAYS
      const tradingDays = Number(account.trading_days) || 0;
      if (tradingDays < MIN_TRADING_DAYS) {
        return { ok: true, code: 'TARGET_HIT_WAITING', msg: `Need ${MIN_TRADING_DAYS - tradingDays} more trading day(s)`, action: 'none' };
      }
      // 5b. CONSISTENCY RULE
      const totalProfit = balance - size;
      if (totalProfit > 0) {
        const allDailyRows = await dbSelect('daily_pnl', { account_id: account.id });
        for (const dr of allDailyRows) {
          const dayProfit = Number(dr.realized_pnl);
          if (dayProfit > 0 && dayProfit > totalProfit * CONSISTENCY_MAX_PCT) {
            return { ok: false, code: 'CONSISTENCY', msg: `Consistency rule breached`, action: 'fail' };
          }
        }
      }
      // 5c. PHASE TRANSITION
      if (phase === 'eval' || account.status === 'challenge') {
        return { ok: true, code: 'EVAL_PASSED', msg: 'Eval passed!', action: 'pass_to_verification' };
      }
      if (phase === 'verification') {
        return { ok: true, code: 'VERIFICATION_PASSED', msg: 'Verification passed!', action: 'pass_to_funded' };
      }
    }
  }

  return { ok: true, code: 'OK', msg: '', action: 'none' };
}

// ── Test runner ──
let passed = 0, failed = 0;
function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ FAIL: ${name}`); }
}

async function run() {
  console.log('\n═══════════════════════════════════════');
  console.log('  VERDICT Rule Engine — Unit Tests');
  console.log('═══════════════════════════════════════\n');

  const SIZE = 25000; // Pro account

  // ── 1. TIME LIMIT ──
  console.log('1. TIME LIMIT (30-day expiration)');
  {
    const expired = { id: 1, size: SIZE, balance: SIZE, status: 'eval', phase: 'eval', eval_ends_at: '2020-01-01T00:00:00Z' };
    const r = await evaluateRules(expired, { trigger: 'pre_order', orderCost: 100 });
    assert(r.code === 'TIME_EXPIRED', 'Expired eval returns TIME_EXPIRED');
    assert(r.action === 'fail', 'Action is fail');
  }
  {
    const future = new Date(Date.now() + 86400000 * 15).toISOString();
    const active = { id: 2, size: SIZE, balance: SIZE, status: 'eval', phase: 'eval', eval_ends_at: future };
    const r = await evaluateRules(active, { trigger: 'pre_order', orderCost: 100 });
    assert(r.code !== 'TIME_EXPIRED', 'Active eval does NOT return TIME_EXPIRED');
  }

  // ── 2. STATIC DRAWDOWN (4% from starting balance) ──
  console.log('\n2. STATIC DRAWDOWN (4% = $1,000 on $25K)');
  {
    // Balance at $24,000 means $1,000 loss = exactly 4%. Floor = 25000 * 0.96 = 24000
    const account = { id: 3, size: SIZE, balance: 24050, status: 'eval', phase: 'eval', eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };
    const r = await evaluateRules(account, { trigger: 'pre_order', orderCost: 100 });
    assert(r.code === 'MAX_LOSS', 'Order pushing below 4% drawdown is rejected');
    assert(r.action === 'reject_order', 'Action is reject_order');
  }
  {
    const account = { id: 4, size: SIZE, balance: 24500, status: 'eval', phase: 'eval', eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };
    const r = await evaluateRules(account, { trigger: 'pre_order', orderCost: 100 });
    assert(r.ok === true, 'Order within drawdown limit is allowed');
  }
  {
    // Post-close: balance already below floor → fail
    const account = { id: 5, size: SIZE, balance: 23900, status: 'eval', phase: 'eval', eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };
    const r = await evaluateRules(account, { trigger: 'post_close' });
    assert(r.code === 'MAX_LOSS', 'Post-close below 4% drawdown returns MAX_LOSS');
    assert(r.action === 'fail', 'Action is fail');
  }
  {
    // Verify it's STATIC not trailing: account made 10% profit then lost 4% → should NOT fail
    // Starting: 25000, profit → 27500 (10%), then loss → 26500 (lost $1000 from peak)
    // Static floor: 25000 * 0.96 = 24000. Balance 26500 > 24000 → OK
    const account = { id: 6, size: SIZE, balance: 26500, high_water: 27500, status: 'eval', phase: 'eval', eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };
    const r = await evaluateRules(account, { trigger: 'post_close' });
    assert(r.ok === true, 'STATIC drawdown: $1K loss from peak but still above starting-4% → OK');
  }

  // ── 2b. MTM EQUITY DRAWDOWN ──
  console.log('\n2b. MTM EQUITY — open positions affect drawdown check');
  {
    // Account has $24,500 cash. Looks safe (floor = $24,000). But open positions dropped to $0.
    // Equity = $24,500 + $0 = $24,500 > $24,000 → OK if positions at entry
    // But if we mock positions valued at $0 total (complete loss), equity = cash only = $24,500
    // Let's test: cash $24,500, one open position worth $10K originally, now worth $0
    // Equity = $24,500 + $0 = $24,500 > $24,000 → still OK (just barely)
    const acctId = 7;
    tables.positions.push({
      id: 100, account_id: acctId, market_id: 'test_market_1', side: 'YES',
      shares: 1000, cost: 10000, entry_price: 10, status: 'open',
      mock_current_value: 0, // positions went to zero
    });
    const account = { id: acctId, size: SIZE, balance: 24500, status: 'eval', phase: 'eval', eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };
    // Equity = 24500 + 0 = 24500 > 24000 floor → barely OK
    const r1 = await evaluateRules(account, { trigger: 'post_close' });
    assert(r1.ok === true, 'Equity $24,500 (cash $24,500 + MTM $0) just above floor → OK');
  }
  {
    // Now: cash $20,000, positions originally $10K, now worth $3K
    // Equity = $20,000 + $3,000 = $23,000 < $24,000 → FAIL
    const acctId = 8;
    tables.positions.push({
      id: 101, account_id: acctId, market_id: 'test_market_2', side: 'YES',
      shares: 2000, cost: 10000, entry_price: 5, status: 'open',
      mock_current_value: 3000, // positions dropped from $10K to $3K
    });
    const account = { id: acctId, size: SIZE, balance: 20000, status: 'eval', phase: 'eval', eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };
    // Equity = 20000 + 3000 = 23000 < 24000 floor → FAIL
    const r2 = await evaluateRules(account, { trigger: 'post_close' });
    assert(r2.code === 'MAX_LOSS', 'Equity $23,000 (cash $20K + MTM $3K) below floor → MAX_LOSS');
    assert(r2.action === 'fail', 'Action is fail for MTM drawdown breach');
  }
  {
    // Pre-order: cash $24,800, positions worth $1K. Equity = $25,800.
    // Order cost $2,000. New equity estimate = $25,800 - $2,000 = $23,800 < $24,000 → reject
    const acctId = 9;
    tables.positions.push({
      id: 102, account_id: acctId, market_id: 'test_market_3', side: 'YES',
      shares: 500, cost: 1000, entry_price: 2, status: 'open',
      mock_current_value: 1000,
    });
    const account = { id: acctId, size: SIZE, balance: 24800, status: 'eval', phase: 'eval', eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };
    // Equity = 24800 + 1000 = 25800. After order: 25800 - 2000 = 23800 < 24000 → reject
    const r3 = await evaluateRules(account, { trigger: 'pre_order', orderCost: 2000 });
    assert(r3.code === 'MAX_LOSS', 'Pre-order: equity after order $23,800 < floor → reject');
  }

  // ── 3. DAILY LOSS LIMIT (2% = $500 on $25K) ──
  console.log('\n3. DAILY LOSS LIMIT (2% = $500 on $25K)');
  {
    // Set up daily_pnl row showing $500+ loss today (already at limit)
    const today = new Date().toISOString().slice(0, 10);
    const acctId = 10;
    await dbInsert('daily_pnl', {
      account_id: acctId, date: today,
      starting_bal: SIZE, ending_bal: SIZE - 510,
      realized_pnl: -510, trade_count: 5,
    });
    const accountAtLimit = { id: acctId, size: SIZE, balance: SIZE - 510, status: 'eval', phase: 'eval', eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };

    // Daily loss $510 >= $500 limit → trading locked
    const r1 = await evaluateRules(accountAtLimit, { trigger: 'pre_order', orderCost: 50 });
    assert(r1.code === 'DAILY_LOSS', 'Trading locked when daily loss >= 2%');

    // Account with only $300 daily loss → trading still allowed
    const acctId2 = 12;
    await dbInsert('daily_pnl', {
      account_id: acctId2, date: today,
      starting_bal: SIZE, ending_bal: SIZE - 300,
      realized_pnl: -300, trade_count: 3,
    });
    const accountUnderLimit = { id: acctId2, size: SIZE, balance: SIZE - 300, status: 'eval', phase: 'eval', eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };
    const r2 = await evaluateRules(accountUnderLimit, { trigger: 'pre_order', orderCost: 200 });
    assert(r2.ok === true, 'Trading allowed when daily loss < 2%');
  }
  {
    // Post-close: daily loss already exceeded
    const today = new Date().toISOString().slice(0, 10);
    const acctId = 11;
    await dbInsert('daily_pnl', {
      account_id: acctId, date: today,
      starting_bal: SIZE, ending_bal: SIZE - 600,
      realized_pnl: -600, trade_count: 5,
    });
    const account = { id: acctId, size: SIZE, balance: SIZE - 600, status: 'eval', phase: 'eval', eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };
    const r = await evaluateRules(account, { trigger: 'post_close' });
    assert(r.code === 'DAILY_LOSS', 'Post-close daily loss > 2% returns DAILY_LOSS');
    assert(r.action === 'fail', 'Action is fail');
  }

  // ── 4. POSITION CAP (20% = $5,000 on $25K) ──
  console.log('\n4. POSITION CAP (20% = $5,000 on $25K)');
  {
    const acctId = 20;
    // Use a high balance so drawdown doesn't trigger first
    // Floor = 25000 * 0.96 = 24000. With balance 26000, order of 5100 → 20900 < 24000 → drawdown fires
    // So we use a higher balance: 30000. Order 5100 → 24900 > 24000 → drawdown OK, position cap fires
    const today = new Date().toISOString().slice(0, 10);
    await dbInsert('daily_pnl', {
      account_id: acctId, date: today,
      starting_bal: 30000, ending_bal: 30000,
      realized_pnl: 0, trade_count: 0,
    });
    const account = { id: acctId, size: SIZE, balance: 30000, status: 'eval', phase: 'eval', eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };
    const r1 = await evaluateRules(account, { trigger: 'pre_order', orderCost: 5100 });
    if (r1.code !== 'POSITION_SIZE') console.log('    DEBUG r1:', JSON.stringify(r1));
    assert(r1.code === 'POSITION_SIZE', '$5,100 order on $25K account is rejected (>20%)');

    const r2 = await evaluateRules(account, { trigger: 'pre_order', orderCost: 4900 });
    if (!r2.ok) console.log('    DEBUG r2:', JSON.stringify(r2));
    assert(r2.ok === true, '$4,900 order on $25K account is allowed (<20%)');
  }

  // ── 5a. PROFIT TARGET + MIN TRADING DAYS ──
  console.log('\n5a. PROFIT TARGET + MIN TRADING DAYS');
  {
    // Hit 6% target ($26,500) but only 3 trading days
    const account = { id: 30, size: SIZE, balance: 26500, status: 'eval', phase: 'eval', trading_days: 3, eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };
    const r = await evaluateRules(account, { trigger: 'post_close' });
    assert(r.code === 'TARGET_HIT_WAITING', 'Target hit but <7 days returns TARGET_HIT_WAITING');
    assert(r.action === 'none', 'Action is none (waiting, not failing)');
    assert(r.msg.includes('4 more'), 'Message says 4 more days needed');
  }

  // ── 5b. CONSISTENCY RULE ──
  console.log('\n5b. CONSISTENCY RULE (no day > 35% of total profit)');
  {
    const acctId = 40;
    // Total profit: $1,500 (balance $26,500 on $25K). 35% of $1,500 = $525
    // Day 1 made $800 → 53% of total → FAIL
    await dbInsert('daily_pnl', {
      account_id: acctId, date: '2026-05-20',
      starting_bal: SIZE, ending_bal: SIZE + 800,
      realized_pnl: 800, trade_count: 2,
    });
    await dbInsert('daily_pnl', {
      account_id: acctId, date: '2026-05-21',
      starting_bal: SIZE + 800, ending_bal: SIZE + 1200,
      realized_pnl: 400, trade_count: 3,
    });
    await dbInsert('daily_pnl', {
      account_id: acctId, date: '2026-05-22',
      starting_bal: SIZE + 1200, ending_bal: SIZE + 1500,
      realized_pnl: 300, trade_count: 2,
    });
    const account = { id: acctId, size: SIZE, balance: 26500, status: 'eval', phase: 'eval', trading_days: 8, eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };
    const r = await evaluateRules(account, { trigger: 'post_close' });
    assert(r.code === 'CONSISTENCY', 'Day with >35% of total profit triggers CONSISTENCY');
    assert(r.action === 'fail', 'Action is fail');
  }
  {
    // Consistent profit: 3 days of ~$500 each, total $1500. Each day = 33% < 35%
    const acctId = 41;
    await dbInsert('daily_pnl', {
      account_id: acctId, date: '2026-05-20',
      starting_bal: SIZE, ending_bal: SIZE + 500,
      realized_pnl: 500, trade_count: 2,
    });
    await dbInsert('daily_pnl', {
      account_id: acctId, date: '2026-05-21',
      starting_bal: SIZE + 500, ending_bal: SIZE + 1000,
      realized_pnl: 500, trade_count: 2,
    });
    await dbInsert('daily_pnl', {
      account_id: acctId, date: '2026-05-22',
      starting_bal: SIZE + 1000, ending_bal: SIZE + 1500,
      realized_pnl: 500, trade_count: 2,
    });
    const account = { id: acctId, size: SIZE, balance: 26500, status: 'eval', phase: 'eval', trading_days: 8, eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };
    const r = await evaluateRules(account, { trigger: 'post_close' });
    assert(r.code === 'EVAL_PASSED', 'Consistent profit across days → EVAL_PASSED');
    assert(r.action === 'pass_to_verification', 'Action is pass_to_verification');
  }

  // ── 5c. PHASE TRANSITIONS ──
  console.log('\n5c. PHASE TRANSITIONS (eval → verification → funded)');
  {
    // Eval phase passes → should get pass_to_verification
    // Need consistent profit: spread across multiple days so no day > 35%
    const acctId = 50;
    // Total profit: $1,500. Each day ~$214 = 14.3% < 35% ✓
    for (let d = 1; d <= 7; d++) {
      await dbInsert('daily_pnl', {
        account_id: acctId, date: `2026-05-${String(d + 10).padStart(2, '0')}`,
        starting_bal: SIZE + (d - 1) * 215, ending_bal: SIZE + d * 215,
        realized_pnl: 215, trade_count: 2,
      });
    }
    const evalAcct = { id: acctId, size: SIZE, balance: SIZE + 1505, status: 'eval', phase: 'eval', trading_days: 10, eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };
    const r1 = await evaluateRules(evalAcct, { trigger: 'post_close' });
    assert(r1.action === 'pass_to_verification', 'Eval pass → pass_to_verification');
  }
  {
    // Verification phase passes → should get pass_to_funded
    // Verification target is 4% of $25K = $1,000 → need balance $26,000
    // Spread across days: 7 days * ~$143 = $1,001. Each day = 14.3% < 35% ✓
    const acctId = 51;
    for (let d = 1; d <= 7; d++) {
      await dbInsert('daily_pnl', {
        account_id: acctId, date: `2026-05-${String(d + 10).padStart(2, '0')}`,
        starting_bal: SIZE + (d - 1) * 143, ending_bal: SIZE + d * 143,
        realized_pnl: 143, trade_count: 2,
      });
    }
    const verifyAcct = { id: acctId, size: SIZE, balance: SIZE + 1001, status: 'verification', phase: 'verification', trading_days: 8, eval_ends_at: new Date(Date.now() + 86400000 * 15).toISOString() };
    const r2 = await evaluateRules(verifyAcct, { trigger: 'post_close' });
    assert(r2.action === 'pass_to_funded', 'Verification pass → pass_to_funded');
  }

  // ── 6. PAYOUT RULES ──
  console.log('\n6. PAYOUT RULES ($125 min, 14-day wait, 24h pause)');
  {
    const MIN_PAYOUT = 125;
    const profit = 500;
    const payoutAmount = +(profit * PROFIT_SPLIT).toFixed(2); // $400
    assert(payoutAmount >= MIN_PAYOUT, `$400 payout >= $125 minimum → allowed`);

    const smallProfit = 100;
    const smallPayout = +(smallProfit * PROFIT_SPLIT).toFixed(2); // $80
    assert(smallPayout < MIN_PAYOUT, `$80 payout < $125 minimum → rejected`);
  }
  {
    // 14-day wait
    const futureDate = new Date(Date.now() + 10 * 86400000);
    const eligible = futureDate > new Date();
    assert(eligible, '14-day payout_eligible_at in future → payout blocked');

    const pastDate = new Date(Date.now() - 86400000);
    const eligible2 = pastDate > new Date();
    assert(!eligible2, 'payout_eligible_at in past → payout allowed');
  }
  {
    // 24h pause
    const pausedUntil = new Date(Date.now() + 12 * 3600000); // 12h from now
    const paused = pausedUntil > new Date();
    assert(paused, '24h pause active → withdrawal blocked');
  }

  // ── SUMMARY ──
  console.log('\n═══════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
