/* ============================================================
   QA Agent 2 — Purchase Flow & Eval Account Creation Tests
   ============================================================
   Tests:
   1. Test account creation (all 5 plans)
   2. Duplicate account prevention
   3. Account retrieval (GET /api/account)
   4. Invalid plan handling
   5. Unauthenticated access
   6. Stripe checkout (disabled mode)
   7. Plan sizes verification
   ============================================================ */

const BASE = 'http://localhost:3456';
let passed = 0;
let failed = 0;
const results = [];

function report(name, endpoint, expected, actual, pass, error = null) {
  const status = pass ? 'PASS' : 'FAIL';
  if (pass) passed++; else failed++;
  const entry = { name, endpoint, expected, actual, status, error };
  results.push(entry);
  const icon = pass ? '✅' : '❌';
  console.log(`${icon} [${status}] ${name}`);
  console.log(`     Endpoint: ${endpoint}`);
  console.log(`     Expected: ${expected}`);
  console.log(`     Actual:   ${actual}`);
  if (error) console.log(`     Error:    ${error}`);
  console.log('');
}

async function signup(email) {
  const res = await fetch(`${BASE}/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'TestPass123!', full_name: 'QA Tester' }),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function createTestAccount(token, plan) {
  const res = await fetch(`${BASE}/api/account/test`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ plan }),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function getAccount(token) {
  const res = await fetch(`${BASE}/api/account`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function postCheckout(token, plan) {
  const res = await fetch(`${BASE}/api/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ plan }),
  });
  const data = await res.json();
  return { status: res.status, data };
}

// ============================================================
// PLANS reference (from server.js)
// ============================================================
const EXPECTED_PLANS = {
  starter:  { price: 8900,   size: 5000,   label: 'Starter $5K',   activation: 4900 },
  standard: { price: 15900,  size: 10000,  label: 'Standard $10K',  activation: 4900 },
  pro:      { price: 29900,  size: 25000,  label: 'Pro $25K',       activation: 4900 },
  elite:    { price: 49900,  size: 50000,  label: 'Elite $50K',     activation: 4900 },
  whale:    { price: 89900,  size: 100000, label: 'Whale $100K',    activation: 4900 },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runTests() {
  const ts = Date.now();
  console.log('============================================================');
  console.log(' QA Agent 2 — Purchase Flow & Eval Account Tests');
  console.log('============================================================\n');

  // ============================================================
  // TEST 1: Create test accounts for ALL 5 plans
  // ============================================================
  console.log('--- Test Group 1: Test Account Creation (all 5 plans) ---\n');

  const plans = ['starter', 'standard', 'pro', 'elite', 'whale'];
  const tokens = {};

  for (const plan of plans) {
    const email = `qa2_${plan}_${ts}@test.com`;
    const { status: signupStatus, data: signupData } = await signup(email);

    if (signupStatus !== 200 || !signupData.token) {
      report(
        `Create ${plan} account — signup`,
        'POST /api/signup',
        'status 200 with token',
        `status ${signupStatus}: ${JSON.stringify(signupData)}`,
        false,
        'Signup failed'
      );
      continue;
    }

    const token = signupData.token;
    tokens[plan] = token;

    const { status, data } = await createTestAccount(token, plan);

    // Check: account created successfully
    const createOk = status === 200 && data.ok === true;
    report(
      `Create ${plan} account — success`,
      'POST /api/account/test',
      `status 200, ok=true, plan=${plan}, size=${EXPECTED_PLANS[plan].size}`,
      `status ${status}, ok=${data.ok}, plan=${data.plan}, size=${data.size}`,
      createOk && data.plan === plan && data.size === EXPECTED_PLANS[plan].size
    );

    // Check: phase is eval
    report(
      `Create ${plan} account — phase=eval`,
      'POST /api/account/test',
      'phase=eval',
      `phase=${data.phase}`,
      data.phase === 'eval'
    );

    // Now retrieve via GET /api/account and verify details
    const { status: getStatus, data: acctData } = await getAccount(token);
    if (getStatus === 200 && acctData.account) {
      const acct = acctData.account;

      // Verify correct size
      report(
        `Create ${plan} account — correct size in GET`,
        'GET /api/account',
        `size=${EXPECTED_PLANS[plan].size}`,
        `size=${acct.size}`,
        acct.size === EXPECTED_PLANS[plan].size
      );

      // Verify balance equals size (fresh account)
      report(
        `Create ${plan} account — balance=size`,
        'GET /api/account',
        `balance=${EXPECTED_PLANS[plan].size}`,
        `balance=${acct.balance}`,
        acct.balance === EXPECTED_PLANS[plan].size
      );

      // Verify phase & status
      report(
        `Create ${plan} account — status=eval`,
        'GET /api/account',
        'status=eval',
        `status=${acct.status}`,
        acct.status === 'eval'
      );

      // Verify profit_target_pct and max_loss_pct are set
      report(
        `Create ${plan} account — profit_target_pct set`,
        'GET /api/account',
        'profit_target_pct=0.06',
        `profit_target_pct=${acct.profit_target_pct}`,
        Number(acct.profit_target_pct) === 0.06
      );

      report(
        `Create ${plan} account — max_loss_pct set`,
        'GET /api/account',
        'max_loss_pct=0.04',
        `max_loss_pct=${acct.max_loss_pct}`,
        Number(acct.max_loss_pct) === 0.04
      );

      // Verify eval_started_at and eval_ends_at
      const hasStart = !!acct.eval_started_at;
      const hasEnd = !!acct.eval_ends_at;
      report(
        `Create ${plan} account — eval_started_at set`,
        'GET /api/account',
        'eval_started_at is set',
        `eval_started_at=${acct.eval_started_at || 'null'}`,
        hasStart
      );

      report(
        `Create ${plan} account — eval_ends_at set`,
        'GET /api/account',
        'eval_ends_at is set',
        `eval_ends_at=${acct.eval_ends_at || 'null'}`,
        hasEnd
      );

      // Verify 30 days apart
      if (hasStart && hasEnd) {
        const startMs = new Date(acct.eval_started_at).getTime();
        const endMs = new Date(acct.eval_ends_at).getTime();
        const diffDays = (endMs - startMs) / (86400 * 1000);
        report(
          `Create ${plan} account — 30 day eval period`,
          'GET /api/account',
          '30 days between start and end',
          `${diffDays.toFixed(2)} days`,
          Math.abs(diffDays - 30) < 0.01
        );
      } else {
        report(
          `Create ${plan} account — 30 day eval period`,
          'GET /api/account',
          '30 days between start and end',
          'cannot compute — missing dates',
          false,
          'eval_started_at or eval_ends_at missing'
        );
      }
    } else {
      report(
        `Create ${plan} account — GET verification`,
        'GET /api/account',
        'status 200 with account object',
        `status ${getStatus}: ${JSON.stringify(acctData).slice(0, 200)}`,
        false,
        'Could not retrieve account for verification'
      );
    }
  }

  // ============================================================
  // TEST 2: Duplicate account prevention
  // ============================================================
  console.log('\n--- Test Group 2: Duplicate Account Prevention ---\n');

  // Use the 'pro' token (already has an active eval)
  if (tokens.pro) {
    const { status, data } = await createTestAccount(tokens.pro, 'pro');
    report(
      'Duplicate account prevention — second eval fails',
      'POST /api/account/test',
      'status 400 with error about existing active account',
      `status ${status}: ${JSON.stringify(data)}`,
      status === 400 && data.error && data.error.toLowerCase().includes('already')
    );
  } else {
    report(
      'Duplicate account prevention — second eval fails',
      'POST /api/account/test',
      'status 400',
      'SKIPPED — no pro token available',
      false,
      'Pro token not available'
    );
  }

  // ============================================================
  // TEST 3: Account retrieval
  // ============================================================
  console.log('\n--- Test Group 3: Account Retrieval ---\n');

  if (tokens.starter) {
    const { status, data } = await getAccount(tokens.starter);

    report(
      'Account retrieval — returns account object',
      'GET /api/account',
      'status 200 with account, positions, fills',
      `status ${status}, has account: ${!!data.account}, has positions: ${!!data.positions}, has fills: ${!!data.fills}`,
      status === 200 && !!data.account && Array.isArray(data.positions) && Array.isArray(data.fills)
    );

    if (data.account) {
      // Verify computed fields
      report(
        'Account retrieval — equity field present',
        'GET /api/account',
        'equity is a number',
        `equity=${data.account.equity}`,
        typeof data.account.equity === 'number'
      );

      report(
        'Account retrieval — loss_floor computed',
        'GET /api/account',
        `loss_floor = size * 0.96 = ${EXPECTED_PLANS.starter.size * 0.96}`,
        `loss_floor=${data.account.loss_floor}`,
        data.account.loss_floor === EXPECTED_PLANS.starter.size * (1 - 0.04)
      );

      report(
        'Account retrieval — profit_target computed',
        'GET /api/account',
        `profit_target = size * 1.06 = ${EXPECTED_PLANS.starter.size * 1.06}`,
        `profit_target=${data.account.profit_target}`,
        data.account.profit_target === EXPECTED_PLANS.starter.size * 1.06
      );

      report(
        'Account retrieval — positions array (empty initially)',
        'GET /api/account',
        'positions = []',
        `positions length = ${data.positions.length}`,
        data.positions.length === 0
      );

      report(
        'Account retrieval — fills array (empty initially)',
        'GET /api/account',
        'fills = []',
        `fills length = ${data.fills.length}`,
        data.fills.length === 0
      );
    }
  }

  // ============================================================
  // TEST 4: Invalid plan
  // ============================================================
  console.log('\n--- Test Group 4: Invalid Plan ---\n');

  // Create a new user for this test (since the existing ones have active accounts)
  const invalidPlanEmail = `qa2_invalid_${ts}@test.com`;
  const { data: invSignup } = await signup(invalidPlanEmail);
  if (invSignup.token) {
    const { status, data } = await createTestAccount(invSignup.token, 'invalid');
    // Based on server code: invalid plan gets silently replaced with 'pro'
    // (cleanPlan = validPlans.includes(plan) ? plan : 'pro')
    // So it will actually succeed with plan='pro'
    report(
      'Invalid plan — handled gracefully (defaults to pro)',
      'POST /api/account/test',
      'status 200, defaults to plan=pro',
      `status ${status}, plan=${data.plan}, size=${data.size}`,
      status === 200 && data.plan === 'pro' && data.size === 25000
    );
  } else {
    report(
      'Invalid plan — handled gracefully',
      'POST /api/account/test',
      'Graceful failure',
      'SKIPPED — signup failed',
      false
    );
  }

  // ============================================================
  // TEST 5: Unauthenticated access
  // ============================================================
  console.log('\n--- Test Group 5: Unauthenticated Access ---\n');

  // No auth header
  const noAuthRes = await fetch(`${BASE}/api/account/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'pro' }),
  });
  const noAuthData = await noAuthRes.json();
  report(
    'Unauthenticated POST /api/account/test — 401',
    'POST /api/account/test',
    'status 401 with error=unauthorized',
    `status ${noAuthRes.status}: ${JSON.stringify(noAuthData)}`,
    noAuthRes.status === 401 && noAuthData.error === 'unauthorized'
  );

  // Bad token
  const badTokenRes = await fetch(`${BASE}/api/account/test`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer fake.invalid.token',
    },
    body: JSON.stringify({ plan: 'pro' }),
  });
  const badTokenData = await badTokenRes.json();
  report(
    'Invalid token POST /api/account/test — 401',
    'POST /api/account/test',
    'status 401 with error about invalid token',
    `status ${badTokenRes.status}: ${JSON.stringify(badTokenData)}`,
    badTokenRes.status === 401
  );

  // Unauthenticated GET /api/account
  const noAuthGetRes = await fetch(`${BASE}/api/account`);
  const noAuthGetData = await noAuthGetRes.json();
  report(
    'Unauthenticated GET /api/account — 401',
    'GET /api/account',
    'status 401',
    `status ${noAuthGetRes.status}: ${JSON.stringify(noAuthGetData)}`,
    noAuthGetRes.status === 401
  );

  // ============================================================
  // TEST 6: Stripe checkout (disabled mode)
  // ============================================================
  console.log('\n--- Test Group 6: Stripe Checkout (disabled) ---\n');

  // Create a new user with no active account
  const stripeEmail = `qa2_stripe_${ts}@test.com`;
  const { data: stripeSignup } = await signup(stripeEmail);
  if (stripeSignup.token) {
    const { status, data } = await postCheckout(stripeSignup.token, 'pro');
    // Stripe is not configured in dev mode, should return 500 with 'Payments not configured'
    report(
      'Stripe checkout — returns clear error when disabled',
      'POST /api/checkout',
      'status 500, error="Payments not configured" (no crash)',
      `status ${status}: ${JSON.stringify(data)}`,
      status === 500 && data.error === 'Payments not configured'
    );
  } else {
    report(
      'Stripe checkout — returns clear error when disabled',
      'POST /api/checkout',
      'Clear error response',
      'SKIPPED — signup failed',
      false
    );
  }

  // ============================================================
  // TEST 7: Plan sizes verification
  // ============================================================
  console.log('\n--- Test Group 7: Plan Sizes Verification ---\n');

  // We already verified sizes during creation, but let's explicitly list them
  for (const [plan, info] of Object.entries(EXPECTED_PLANS)) {
    if (tokens[plan]) {
      const { data } = await getAccount(tokens[plan]);
      if (data.account) {
        report(
          `Plan size verification — ${plan} = $${info.size.toLocaleString()}`,
          'GET /api/account',
          `size=${info.size}`,
          `size=${data.account.size}`,
          data.account.size === info.size
        );
      } else {
        report(
          `Plan size verification — ${plan}`,
          'GET /api/account',
          `size=${info.size}`,
          'no account returned',
          false
        );
      }
    }
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('\n============================================================');
  console.log(' TEST SUMMARY');
  console.log('============================================================');
  console.log(`  Total:  ${passed + failed}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Rate:   ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
  console.log('============================================================\n');

  if (failed > 0) {
    console.log('FAILED TESTS:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  - ${r.name}`);
      if (r.error) console.log(`    Error: ${r.error}`);
    });
  }
}

runTests().catch(e => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});
