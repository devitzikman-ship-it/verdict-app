/* ============================================================
   VERDICT — Production backend (Supabase + Polymarket)
   ============================================================
   Hardened for 1000+ users:
     • JWT auth (signed tokens, not raw user IDs)
     • bcrypt password hashing (salt rounds 12)
     • In-memory market cache (30s TTL) — stops PM API hammering
     • Per-IP + per-user rate limiting
     • Helmet security headers
     • Proper error handling (no stack leaks)
     • Optimized resolution cron (batched, rate-aware)
     • Affiliate referral system (10% rev share)
     • Dev mode: in-memory DB when Supabase not configured
   ============================================================ */

// Load .env if present
try { require('dotenv').config({ path: require('path').join(__dirname, '.env') }); } catch (_) {}

const express     = require('express');
const path        = require('path');
const cron        = require('node-cron');
const fetch       = require('node-fetch');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const jwt         = require('jsonwebtoken');
const bcrypt      = require('bcryptjs');
const crypto      = require('crypto');
const cors        = require('cors');

// ============ CONFIG ============
const PORT          = process.env.PORT || 3456;
const APP_URL       = process.env.APP_URL || '';   // e.g. https://app.verdict.markets — leave blank for auto-detect
const JWT_SECRET    = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production' || process.env.FLY_APP_NAME) {
    console.error('\n  FATAL: JWT_SECRET not set in production. Exiting.\n');
    process.exit(1);
  }
  return 'verdict-dev-secret-' + Date.now();
})();
const JWT_EXPIRES   = '7d';
const BCRYPT_ROUNDS = 12;
const SLIPPAGE_PCT         = 0.02;   // 2% simulated spread on entry/exit
const PROFIT_TARGET        = 0.06;   // 6% profit target (eval phase)
const VERIFICATION_TARGET  = 0.04;   // 4% profit target (verification phase)
const MAX_LOSS             = 0.04;   // 4% static drawdown from starting balance (NOT trailing)
const DAILY_LOSS_LIMIT     = 0.02;   // 2% max loss in a single calendar day
const POSITION_CAP         = 0.20;   // 20% of account size per single trade
const MIN_TRADING_DAYS     = 7;      // Must trade on at least 7 separate calendar days
const CONSISTENCY_MAX_PCT  = 0.35;   // No single day's profit > 35% of total profit
const EVAL_TIME_LIMIT_DAYS = 30;     // Days to complete eval or verification phase
const PM_GAMMA      = 'https://gamma-api.polymarket.com';
const PM_CLOB       = 'https://clob.polymarket.com';
const PM_DATA       = 'https://data-api.polymarket.com';  // price history

// The Odds API — player props, moneylines, game totals
const ODDS_API_KEY  = process.env.ODDS_API_KEY || '';
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_SPORTS   = ['basketball_nba','football_nfl','baseball_mlb','icehockey_nhl','mma_mixed_martial_arts','soccer_epl','soccer_usa_mls'];

// Affiliate config
const AFFILIATE_COMMISSION = 0.10;  // 10% of eval fee goes to referrer

// Warn if using default JWT secret
if (!process.env.JWT_SECRET) {
  console.warn('\n  ⚠  JWT_SECRET not set — using a random dev secret. Set it in .env for production.\n');
}

// ============ SUPABASE (optional — falls back to in-memory) ============
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
let supabase = null;
let DEV_MODE = false;

if (SUPABASE_URL && SUPABASE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('  ✔  Supabase connected');
} else {
  DEV_MODE = true;
  console.warn('\n  ⚠  No Supabase credentials — running in DEV MODE with in-memory storage.');
  console.warn('     Data resets on restart. Set SUPABASE_URL + SUPABASE_SERVICE_KEY for production.\n');
}

// ============ STRIPE (optional) ============
const STRIPE_SECRET  = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK = process.env.STRIPE_WEBHOOK_SECRET;
let stripe = null;
try {
  const Stripe = require('stripe');
  stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;
} catch (_) {}

if (!stripe) {
  console.warn('  ⚠  STRIPE_SECRET_KEY not set — payment endpoints disabled.\n');
}
if (!ODDS_API_KEY) {
  console.warn('  ⚠  ODDS_API_KEY not set — player props & moneylines disabled (using Polymarket only).\n');
} else {
  console.log('  ✔  The Odds API connected — player props & moneylines enabled');
}

// Plan pricing (cents, ONE-TIME eval fee) and account sizes
// activation fee ($49) is a separate non-removable line item at checkout
const PLANS = {
  starter:  { price: 8900,   size: 5000,   label: 'Starter $5K',   activation: 4900 },
  standard: { price: 15900,  size: 10000,  label: 'Standard $10K',  activation: 4900 },
  pro:      { price: 29900,  size: 25000,  label: 'Pro $25K',       activation: 4900 },
  elite:    { price: 49900,  size: 50000,  label: 'Elite $50K',     activation: 4900 },
  whale:    { price: 89900,  size: 100000, label: 'Whale $100K',    activation: 4900 },
};

// Profit split: trader keeps 80%
const PROFIT_SPLIT = 0.80;

// ============ EMAIL (Resend — optional) ============
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'VERDICT <noreply@trade-verdict.com>';
let resend = null;
if (RESEND_KEY) {
  const { Resend } = require('resend');
  resend = new Resend(RESEND_KEY);
  console.log('  ✔  Resend email connected');
} else {
  console.warn('  ⚠  RESEND_API_KEY not set — emails disabled (password reset, verification).\n');
}

async function sendEmail(to, subject, html) {
  if (!resend) {
    console.log(`[email-preview] To: ${to} | Subject: ${subject}`);
    return false;
  }
  try {
    await resend.emails.send({ from: FROM_EMAIL, to, subject, html });
    return true;
  } catch (e) {
    console.error('[email]', e.message);
    return false;
  }
}

// In-memory token store for password resets & email verification
// { token: { userId, email, type, expiresAt } }
const tokenStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokenStore) { if (v.expiresAt < now) tokenStore.delete(k); }
}, 60000); // clean expired tokens every minute

// ============ IN-MEMORY DEV DB ============
// Simple in-memory storage that mimics Supabase when no DB is configured
const memDB = {
  _tables: {
    users: [],
    accounts: [],
    positions: [],
    fills: [],
    payout_requests: [],
    payments: [],
    affiliates: [],
    referrals: [],
    daily_pnl: [],
  },
  _nextId: {},

  _getId(table) {
    if (!this._nextId[table]) this._nextId[table] = 1;
    return this._nextId[table]++;
  },

  insert(table, data) {
    const row = {
      id: this._getId(table),
      ...data,
      created_at: data.created_at || new Date().toISOString(),
    };
    this._tables[table].push(row);
    return { ...row };
  },

  select(table, filters = {}, opts = {}) {
    let rows = this._tables[table].filter(row => {
      for (const [k, v] of Object.entries(filters)) {
        if (row[k] !== v) return false;
      }
      return true;
    });
    if (opts.order) {
      const col = opts.order.col;
      const asc = opts.order.asc ?? false;
      rows.sort((a, b) => {
        if (a[col] < b[col]) return asc ? -1 : 1;
        if (a[col] > b[col]) return asc ? 1 : -1;
        return 0;
      });
    }
    if (opts.limit) rows = rows.slice(0, opts.limit);
    return rows.map(r => ({ ...r }));
  },

  selectOne(table, filters) {
    return this.select(table, filters, { limit: 1 })[0] || null;
  },

  update(table, filters, data) {
    const row = this._tables[table].find(row => {
      for (const [k, v] of Object.entries(filters)) {
        if (row[k] !== v) return false;
      }
      return true;
    });
    if (!row) return null;
    Object.assign(row, data);
    return { ...row };
  },
};

// ============ UNIFIED DB HELPERS ============
// Works with Supabase in production, in-memory in dev
async function dbInsert(table, data) {
  if (DEV_MODE) return memDB.insert(table, data);
  const { data: rows, error } = await supabase.from(table).insert(data).select();
  if (error) throw new Error(`DB insert ${table}: ${error.message}`);
  return rows[0];
}

async function dbSelect(table, filters = {}, opts = {}) {
  if (DEV_MODE) return memDB.select(table, filters, opts);
  let q = supabase.from(table).select(opts.select || '*');
  for (const [col, val] of Object.entries(filters)) {
    q = q.eq(col, val);
  }
  if (opts.order) q = q.order(opts.order.col, { ascending: opts.order.asc ?? false });
  if (opts.limit) q = q.limit(opts.limit);
  const { data: rows, error } = await q;
  if (error) throw new Error(`DB select ${table}: ${error.message}`);
  return rows;
}

async function dbSelectOne(table, filters) {
  const rows = await dbSelect(table, filters, { limit: 1 });
  return rows[0] || null;
}

async function dbUpdate(table, filters, data) {
  if (DEV_MODE) return memDB.update(table, filters, data);
  let q = supabase.from(table).update(data);
  for (const [col, val] of Object.entries(filters)) {
    q = q.eq(col, val);
  }
  const { data: rows, error } = await q.select();
  if (error) throw new Error(`DB update ${table}: ${error.message}`);
  return rows[0] || null;
}

// ============ MARKET CACHE ============
const cache = {
  _store: new Map(),
  get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) { this._store.delete(key); return null; }
    return entry.data;
  },
  set(key, data, ttlMs) {
    this._store.set(key, { data, expires: Date.now() + ttlMs });
  },
  clear() { this._store.clear(); },
  prune() {
    const now = Date.now();
    for (const [k, v] of this._store) {
      if (now > v.expires) this._store.delete(k);
    }
  }
};
setInterval(() => cache.prune(), 5 * 60 * 1000);

const CACHE_TTL_MARKETS = 3 * 1000;    // 3s — real-time list refresh
const CACHE_TTL_MARKET  = 3 * 1000;    // 3s — single market detail
const CACHE_TTL_EVENTS  = 20 * 1000;   // 20s — event groupings
const CACHE_TTL_SEARCH  = 10 * 1000;   // 10s — search results

// ============ MARKET INDEX — always-fresh master list with CLOB prices ============
const marketIndex = {
  markets: [],        // Full parsed market list
  byId: {},           // Quick lookup by conditionId
  byCategory: {},     // Grouped by category
  bySport: {},        // Sport-specific: { nba: [], mlb: [], nfl: [], ... }
  lastRefresh: 0,
  refreshing: false,
  stats: {},          // Debug stats: { total, clobPriced, categories, sports }
};

async function refreshMarketIndex() {
  if (marketIndex.refreshing) return;
  marketIndex.refreshing = true;
  try {
    // === TIER 1: Volume + Recency (broad coverage) ===
    const url1 = `${PM_GAMMA}/markets?limit=200&active=true&closed=false&order=volume24hr&ascending=false`;
    const url2 = `${PM_GAMMA}/markets?limit=100&active=true&closed=false&order=startDate&ascending=false`;
    const url3 = `${PM_GAMMA}/markets?limit=100&active=true&closed=false&order=liquidityNum&ascending=false`;

    // === TIER 2: Tag-based sport pulls (Polymarket tags internally) ===
    const tagUrls = [
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&tag=mlb`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&tag=nba`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&tag=nfl`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&tag=nhl`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&tag=ufc`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&tag=soccer`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&tag=tennis`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&tag=f1`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&tag=golf`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&tag=esports`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&tag=crypto`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&tag=politics`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&tag=elections`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&tag=ai`,
    ];

    // === TIER 3: Keyword searches for categories without good tags ===
    const searchUrls = [
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&_q=bitcoin+ethereum+solana+crypto`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&_q=trump+biden+election+congress+senate`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&_q=fed+rate+inflation+gdp+recession+economy`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&_q=openai+chatgpt+nvidia+spacex+ai+anthropic`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&_q=oscar+grammy+movie+netflix+celebrity+album`,
      `${PM_GAMMA}/markets?limit=50&active=true&closed=false&_q=russia+ukraine+china+iran+war+nato`,
    ];

    // === TIER 4: Events-based pull (groups markets into events for context) ===
    const eventUrls = [
      `${PM_GAMMA}/events?limit=30&active=true&closed=false&order=volume24hr&ascending=false`,
      `${PM_GAMMA}/events?limit=20&active=true&closed=false&tag=sports`,
    ];

    const fetches = [
      fetch(url1), fetch(url2), fetch(url3),
      ...tagUrls.map(u => fetch(u)),
      ...searchUrls.map(u => fetch(u)),
    ];
    const eventFetches = eventUrls.map(u => fetch(u));
    const responses = await Promise.allSettled([...fetches, ...eventFetches]);

    const allRaw = [];
    const marketResponses = responses.slice(0, fetches.length);
    const eventResponses = responses.slice(fetches.length);

    // Process market responses
    for (const r of marketResponses) {
      if (r.status === 'fulfilled' && r.value.ok) {
        try {
          const data = await r.value.json();
          if (Array.isArray(data)) allRaw.push(...data);
        } catch(_){}
      }
    }

    // Process event responses — extract markets from inside events
    for (const r of eventResponses) {
      if (r.status === 'fulfilled' && r.value.ok) {
        try {
          const data = await r.value.json();
          if (Array.isArray(data)) {
            for (const event of data) {
              if (event.markets && Array.isArray(event.markets)) {
                // Inject event context into each market
                for (const m of event.markets) {
                  m._eventTitle = event.title;
                  m._eventSlug = event.slug;
                  if (!m.events) m.events = [{ title: event.title, slug: event.slug }];
                }
                allRaw.push(...event.markets);
              }
            }
          }
        } catch(_){}
      }
    }

    // Dedupe by conditionId
    const seen = new Set();
    const deduped = [];
    for (const m of allRaw) {
      const id = m.conditionId || m.condition_id || m.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      deduped.push(m);
    }

    // Parse all
    const parsed = deduped.map(parseMarket).filter(m => m.outcomes.length === 2 && m.active && !m.closed);

    // Now enrich top markets with CLOB midpoint prices (most accurate)
    const topMarkets = parsed.filter(m => m.volume24hr > 500).slice(0, 120);
    const clobUpdates = await enrichWithClobPrices(topMarkets);

    // Apply CLOB prices
    for (const m of parsed) {
      if (clobUpdates[m.id]) {
        m.outcomePrices = clobUpdates[m.id];
        m._clobFresh = true;
      }
    }

    // Build index
    const byId = {};
    const byCategory = {};
    const bySport = { nba: [], nfl: [], mlb: [], nhl: [], ufc: [], soccer: [], tennis: [], golf: [], f1: [], esports: [], other_sports: [] };

    // Sport detection (more granular than category)
    // IMPORTANT: Only classify as a sport if it's ACTUALLY a sports market
    function detectSport(m) {
      // Only consider markets already classified as 'sports' category
      if (m.category !== 'sports') return null;

      const text = `${m.question} ${m.eventTitle} ${m.slug || ''}`.toLowerCase();

      // Esports must come first — many esports have "league" which could match others
      if (/\besport|league of legends|\blol\b.*(?:vs|winner|playoffs|map)|dota|csgo|counter-strike|valorant|\blck\b|\blpl\b|\blec\b|\blcs\b|overwatch|bo[35]/.test(text)) return 'esports';

      if (/\bnba\b|\bwnba\b|basketball|thunder vs|spurs vs|lakers vs|celtics vs|nuggets vs|bucks vs|mystics|storm vs|liberty vs|aces vs|sky vs|fever vs|lynx vs|sparks vs|sun vs|dream vs|wings vs|mercury vs/.test(text)) return 'nba';
      if (/\bnfl\b|super bowl|quarterback|touchdown|chiefs vs|eagles vs|49ers vs/.test(text)) return 'nfl';
      if (/\bmlb\b|baseball|world series|pitcher|batting|yankees vs|dodgers vs|braves vs|nationals vs|tigers vs|orioles vs|rangers vs|angels vs/.test(text)) return 'mlb';
      if (/\bnhl\b|stanley cup|avalanche vs|golden knights|canadiens|bruins vs|rangers vs.*hockey/.test(text)) return 'nhl';
      if (/\bufc\b|\bmma\b|boxing|fight night|knockout|heavyweight|lightweight|featherweight|middleweight/.test(text)) return 'ufc';
      if (/\bsoccer\b|premier league|la liga|champions league|\bmls\b|bundesliga|serie a|\bepl\b|fifa|world cup/.test(text)) return 'soccer';
      if (/\btennis\b|wimbledon|french open|australian open|\bgrand slam\b|roland garros|atp|wta/.test(text)) return 'tennis';
      if (/\bgolf\b|\bpga\b|masters tournament|ryder cup|lpga/.test(text)) return 'golf';
      if (/\bf1\b|formula 1|grand prix|nascar|indy 500|motogp/.test(text)) return 'f1';

      return 'other_sports';
    }

    for (const m of parsed) {
      byId[m.id] = m;
      if (!byCategory[m.category]) byCategory[m.category] = [];
      byCategory[m.category].push(m);

      // Sport sub-index — ONLY put actual sports markets in sport buckets
      if (m.category === 'sports') {
        const sport = detectSport(m);
        if (sport && bySport[sport]) {
          bySport[sport].push(m);
        }
      }
    }

    // Sort each category and sport by volume
    for (const cat of Object.keys(byCategory)) {
      byCategory[cat].sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0));
    }
    for (const sp of Object.keys(bySport)) {
      bySport[sp].sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0));
    }

    marketIndex.markets = parsed;
    marketIndex.byId = byId;
    marketIndex.byCategory = byCategory;
    marketIndex.bySport = bySport;
    marketIndex.lastRefresh = Date.now();
    marketIndex.stats = {
      total: parsed.length,
      clobPriced: topMarkets.length,
      categories: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, v.length])),
      sports: Object.fromEntries(Object.entries(bySport).filter(([, v]) => v.length > 0).map(([k, v]) => [k, v.length])),
    };

    console.log(`[market-index] Refreshed: ${parsed.length} markets | ${Object.keys(byCategory).length} categories | ${Object.entries(bySport).filter(([,v])=>v.length>0).map(([k,v])=>`${k}:${v.length}`).join(', ')} | ${topMarkets.length} CLOB-priced`);
  } catch (e) {
    console.error('[market-index] refresh error:', e.message);
  } finally {
    marketIndex.refreshing = false;
  }
}

// Fetch CLOB midpoints for a batch of markets
async function enrichWithClobPrices(markets) {
  const updates = {};
  // Process in batches of 15 (CLOB handles this fine)
  const batches = [];
  for (let i = 0; i < markets.length; i += 15) {
    batches.push(markets.slice(i, i + 15));
  }

  for (const batch of batches) {
    const promises = batch.map(async (m) => {
      try {
        let tokenIds = [];
        try { tokenIds = JSON.parse(m.clobTokenIds || '[]'); } catch(_){}
        if (!tokenIds.length || !tokenIds[0]) return;

        const r = await fetch(`${PM_CLOB}/midpoint?token_id=${tokenIds[0]}`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(3000),
        });
        if (!r.ok) return;
        const data = await r.json();
        if (data && data.mid != null) {
          const yes = Number(data.mid);
          if (yes > 0 && yes < 1) {
            updates[m.id] = [yes, +(1 - yes).toFixed(4)];
          }
        }
      } catch(_){}
    });
    await Promise.allSettled(promises);
  }
  return updates;
}

// Boot: initial load then refresh every 15s (CLOB prices stay within ~15s of real-time)
refreshMarketIndex();
setInterval(refreshMarketIndex, 15 * 1000);

// ============ JWT HELPERS ============
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch (e) { return null; }
}
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/);
  if (!match) return res.status(401).json({ error: 'unauthorized' });
  const decoded = verifyToken(match[1]);
  if (!decoded || !decoded.userId) return res.status(401).json({ error: 'invalid or expired token' });
  req.userId = decoded.userId;
  next();
}

// ============ AFFILIATE HELPERS ============
function generateAffiliateCode() {
  // 8 char alphanumeric code
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ============ CATEGORY CLASSIFIER ============
// Polymarket Gamma API doesn't expose categories, so we infer from question text
function classifyMarket(question, slug, eventTitle) {
  const text = ((question || '') + ' ' + (slug || '') + ' ' + (eventTitle || '')).toLowerCase();

  // PRIORITY CHECK: If it matches high-confidence political/geopolitical keywords, never classify as sports
  const politicalOverride = ['president','election','congress','senate','republican','democrat','governor','nominee','primary','inaug','pardon','impeach','executive order','legislation'];
  const geopoliticalOverride = ['peace deal','ceasefire','nuclear','sanction','invasion','nato','diplomatic','airspace','war ','troops','military','blockade','uranium','missile'];
  for (const kw of politicalOverride) { if (text.includes(kw)) {
    // Check if it's actually politics/elections
    for (const gkw of ['trump','biden','vance','harris','desantis','haley','kennedy','newsom','gaetz','whitmer','youngkin','musk.*win.*president']) { if (text.includes(gkw.replace('.*','')) && text.includes('president')) return 'politics'; }
    return 'politics';
  }}
  for (const kw of geopoliticalOverride) { if (text.includes(kw)) return 'geopolitics'; }

  const rules = [
    { cat: 'sports',      kw: ['nba','nfl','nhl','mlb','fifa','world cup','champions league','premier league','ufc','boxing','tennis','golf','f1','formula','super bowl','playoffs','stanley cup','world series','olympics','mls','soccer','basketball','football','baseball','hockey','match','vs.','game ','series win','mvp','coach','player','team','score','goal','championship','trophy','draft','season','ncaa','grand prix','wimbledon','us open','french open','australian open','la liga','serie a','bundesliga','ligue 1','euro 2','copa','cricket','ipl','t20','wrestling','martial art','fight night','knockout','heavyweight','lightweight','featherweight','pga','masters','ryder cup','indy 500','nascar','daytona','horse racing','kentucky derby','preakness','belmont','world record','medal','batting','pitching','quarterback','touchdown','field goal','slam dunk','home run','penalty','offside','hat trick','transfer window','free agent','signing','trade deadline','super league','grand slam','davis cup','lol:','lck','lpl','lec','lcs','bo3','bo5','esport','league of legends','dota','csgo','valorant','overwatch','rolster','gen.g','t1 ','fnatic','g2 '] },
    { cat: 'crypto',      kw: ['bitcoin','btc','ethereum','eth','solana','sol','crypto','token','defi','nft','blockchain','binance','coinbase','dogecoin','xrp','cardano','polygon','matic','avalanche','avax','chain','altcoin','stablecoin','usdc','usdt','memecoin','litecoin','ripple','chainlink','uniswap','aave','maker','compound','celsius','ftx','tether','mining','halving','smart contract','dapp','web3','metaverse','dao','yield','staking','gas fee','layer 2','rollup','zk','optimism','arbitrum','base chain','pepe','shib','bonk','hyperliquid','hype ','sui ','jupiter','jup ','pump.fun','polymarket token'] },
    { cat: 'politics',    kw: ['trump','biden','president','congress','senate','house','election','vote','democrat','republican','gop','governor','mayor','primary','caucus','impeach','cabinet','supreme court','scotus','legislation','bill pass','executive order','poll','approve','disapprove','political','party','campaign','nominee','inaug','pardon','indic','desantis','haley','vance','rfk','kennedy','newsom','harris','pence','pelosi','mcconnell','schumer','filibuster','veto','executive branch','judicial','legislative','debate','swing state','battleground','ballot','red state','blue state','swing voter','lobby','pac','super pac','Electoral College','senate race','house race','gubernatorial'] },
    { cat: 'finance',     kw: ['stock market','s&p 500','s&p500','nasdaq','dow jones','fed rate','interest rate','inflation rate','gdp ','recession','market cap','ipo ','earnings report','quarterly earnings','revenue ','bull market','bear market','oil price','gold price','commodity','bond yield','treasury','forex','debt ceiling','deficit','crude oil','wti ','brent ','natural gas price','copper price','silver price','stock futures','options trading','hedge fund','private equity','venture capital','merger','acquisition','ipo valuation'] },
    { cat: 'geopolitics', kw: ['iran','ukraine','russia','china','nato','war','conflict','missile','sanction','nuclear','peace deal','ceasefire','invasion','military','troops','territory','border','diplomacy','treaty','united nations','invasion','hormuz','strait','suez','taiwan','north korea','pyongyang','kim jong','xi jinping','putin','zelensky','netanyahu','gaza','israel','palestine','hamas','hezbollah','yemen','houthi','syria','assad','taliban','afghanistan','iraq','libya','prime minister','head of state','sovereignty','regime','coup','rebellion','insurgent','embargo','occupation'] },
    { cat: 'tech',        kw: ['openai','chatgpt','artificial intelligence','ai model','ai safety','agi ','llm ','anthropic','gemini','gpt-','gpt4','gpt5','machine learning','deep learning','neural network','semiconductor','chip','nvidia','tsmc','tech company','silicon valley','startup','spacex','starship','falcon 9','rocket launch','satellite','robot','iphone','android','app store','cybersecurity','hack ','breach','data leak','cloud computing','aws ','azure ','5g ','6g ','vision pro','mixed reality','self-driving','autonomous vehicle','quantum comput'] },
    { cat: 'culture',     kw: ['oscar','grammy','emmy','movie','film','album','song','celebrity','tv show','netflix','disney','tiktok','youtube','instagram','viral','meme','pop culture','award show','concert','tour','billboard','box office','stream','spotify','podcast','influencer','reality tv','bachelor','kiss','kardashian','taylor swift','drake','kanye','beyonce','rihanna','selena','jenner','bieber','anime','manga','gaming','gta vi','gta 6','twitch','streamer','hbo','amazon prime','hulu','paramount','warner bros','marvel','dc','star wars','sequel','prequel','elon musk','tweet','post ','alien','ufo','uap','extraterrestrial','weinstein','trial','sentenced','prison','conviction','carti','playboi'] },
    { cat: 'economy',     kw: ['unemployment','jobs report','cpi','ppi','housing','real estate','mortgage','consumer','retail','wage','labor','supply chain','manufacturing','import','export','minimum wage','inflation rate','cost of living','rent','home price','eviction','foreclosure','bankruptcy','stimulus','bailout','quantitative','federal reserve','central bank','bank rate','credit'] },
    { cat: 'science',     kw: ['nasa','space','mars','moon','climate','weather','hurricane','earthquake','pandemic','virus','vaccine','fda','cdc','health','medical','drug','disease','study','research','cancer','gene','dna','protein','clinical trial','approval','therapy','surgery','transplant','obesity','diabetes','alzheimer','aging','longevity','extinction','species','biodiversity','carbon','emissions','renewable','solar','wind energy','fusion','particle','cern','telescope','james webb','asteroid','comet'] },
    { cat: 'elections',   kw: ['2024 election','2025 election','2026 election','2027 election','2028 election','midterm','runoff','electoral','swing state','ballot','recount','voting machine','mail-in','absentee','early voting','poll worker','election day','inauguration day','certified','concede'] },
    { cat: 'weather',     kw: ['tornado','flood','wildfire','drought','blizzard','heat wave','cold snap','el nino','la nina','tropical storm','category 5','storm surge','snowfall','rainfall','temperature record'] },
  ];
  for (const { cat, kw } of rules) {
    for (const k of kw) {
      if (text.includes(k)) return cat;
    }
  }
  return 'other';
}

// ============ POLYMARKET HELPERS (cached) ============
function parseMarket(m) {
  let eventTitle = '', eventSlug = '';
  try {
    if (m.events && Array.isArray(m.events) && m.events[0]) {
      eventTitle = m.events[0].title || '';
      eventSlug  = m.events[0].slug || '';
    }
  } catch(_){}
  const cat = classifyMarket(m.question, m.slug, eventTitle);
  return {
    id:              m.condition_id || m.conditionId || m.id,
    slug:            m.slug,
    question:        m.question,
    description:     m.description || '',
    category:        cat,
    endDate:         m.endDate,
    startDate:       m.startDate,
    image:           m.image || null,
    icon:            m.icon || null,
    // Pricing — full depth
    outcomes:        m.outcomes ? JSON.parse(m.outcomes) : ['Yes', 'No'],
    outcomePrices:   m.outcomePrices ? JSON.parse(m.outcomePrices).map(Number) : [0.5, 0.5],
    bestBid:         m.bestBid != null ? Number(m.bestBid) : null,
    bestAsk:         m.bestAsk != null ? Number(m.bestAsk) : null,
    lastTradePrice:  m.lastTradePrice != null ? Number(m.lastTradePrice) : null,
    spread:          m.spread != null ? Number(m.spread) : null,
    // Price changes
    priceChange1h:   m.oneHourPriceChange  != null ? Number(m.oneHourPriceChange) : null,
    priceChange1d:   m.oneDayPriceChange   != null ? Number(m.oneDayPriceChange) : null,
    priceChange1w:   m.oneWeekPriceChange  != null ? Number(m.oneWeekPriceChange) : null,
    priceChange1m:   m.oneMonthPriceChange != null ? Number(m.oneMonthPriceChange) : null,
    // Volume & liquidity
    volume24hr:      Number(m.volume24hr) || 0,
    volume1wk:       Number(m.volume1wk) || 0,
    volume:          Number(m.volumeNum || m.volume) || 0,
    liquidity:       Number(m.liquidityNum || m.liquidity) || 0,
    // State
    closed:          !!m.closed,
    resolved:        !!m.resolved,
    active:          !!m.active,
    acceptingOrders: !!m.acceptingOrders,
    // Event grouping
    eventTitle:      eventTitle,
    eventSlug:       eventSlug,
    // CLOB token IDs (for orderbook if needed)
    clobTokenIds:    m.clobTokenIds || null,
    // Resolution
    resolutionSource: m.resolutionSource || null,
    winningSide:      m.winningSide || null,
  };
}

async function pmFetchMarkets(limit = 50) {
  const cacheKey = `markets:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const url = `${PM_GAMMA}/markets?limit=${limit}&active=true&closed=false&order=volume24hr&ascending=false`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('PM markets fetch failed: ' + r.status);
  const data = await r.json();

  const markets = data.map(parseMarket).filter(m => m.outcomes.length === 2);
  cache.set(cacheKey, markets, CACHE_TTL_MARKETS);
  return markets;
}

async function pmFetchMarket(conditionId) {
  const cacheKey = `market:${conditionId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const url = `${PM_GAMMA}/markets?condition_ids=${conditionId}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('PM market fetch failed: ' + r.status);
  const data = await r.json();
  if (!data || data.length === 0) return null;

  const market = parseMarket(data[0]);
  cache.set(cacheKey, market, CACHE_TTL_MARKET);
  return market;
}

// Fetch Polymarket events (grouped markets) — e.g. "FIFA World Cup" with 60 sub-markets
async function pmFetchEvents(limit = 20) {
  const cacheKey = `events:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const url = `${PM_GAMMA}/events?limit=${limit}&active=true&closed=false&order=volume24hr&ascending=false`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('PM events fetch failed: ' + r.status);
  const data = await r.json();

  const events = data.map(e => ({
    id:        e.id,
    title:     e.title,
    slug:      e.slug,
    category:  classifyMarket(e.title, e.slug, e.title),
    volume:    Number(e.volume) || 0,
    liquidity: Number(e.liquidity) || 0,
    startDate: e.startDate,
    endDate:   e.endDate,
    image:     (e.markets && e.markets[0]) ? e.markets[0].image : null,
    marketCount: (e.markets || []).length,
    markets:   (e.markets || []).map(parseMarket).filter(m => m.outcomes.length === 2),
  }));

  cache.set(cacheKey, events, CACHE_TTL_EVENTS);
  return events;
}

// Fetch markets by category (sports, crypto, politics, etc.)
async function pmFetchByCategory(category, limit = 50) {
  // Prefer the full market index (tags + events + searches)
  if (marketIndex.byCategory[category] && marketIndex.byCategory[category].length > 0) {
    return marketIndex.byCategory[category].slice(0, limit);
  }
  // Fallback to direct fetch
  const all = await pmFetchMarkets(Math.max(limit * 2, 100));
  return all.filter(m => m.category === category).slice(0, limit);
}

// Search Polymarket markets — hybrid: API fuzzy + local keyword filter
async function pmSearch(query, limit = 30) {
  const cacheKey = `search:${query}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const qLower = query.toLowerCase().trim();
  const keywords = qLower.split(/\s+/).filter(w => w.length >= 2);

  // Strategy 1: Pull from PM API search (cast a wide net)
  let apiResults = [];
  try {
    const url = `${PM_GAMMA}/markets?limit=${limit * 3}&active=true&closed=false&_q=${encodeURIComponent(query)}`;
    const r = await fetch(url);
    if (r.ok) {
      const data = await r.json();
      apiResults = data.map(parseMarket).filter(m => m.outcomes.length === 2);
    }
  } catch(_){}

  // Strategy 2: Also pull from our cached broad market list
  let broadResults = [];
  try {
    const all = await pmFetchMarkets(200);
    broadResults = all;
  } catch(_){}

  // Merge and dedupe
  const seen = new Set();
  const merged = [];
  for (const m of [...apiResults, ...broadResults]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push(m);
  }

  // Score each market by how well it matches the search query
  function scoreMatch(m) {
    const text = `${m.question} ${m.eventTitle} ${m.category} ${m.description}`.toLowerCase();
    let score = 0;

    // Exact full query match in question = highest
    if (m.question.toLowerCase().includes(qLower)) score += 100;
    // Exact full query in event title
    if (m.eventTitle && m.eventTitle.toLowerCase().includes(qLower)) score += 80;

    // Individual keyword matches
    for (const kw of keywords) {
      if (m.question.toLowerCase().includes(kw)) score += 30;
      if (m.eventTitle && m.eventTitle.toLowerCase().includes(kw)) score += 20;
      if (m.category === kw) score += 15;
      if (text.includes(kw)) score += 5;
    }

    // Boost by volume (popular markets rank higher for same relevance)
    if (m.volume24hr > 100000) score += 3;
    if (m.volume24hr > 1000000) score += 5;

    return score;
  }

  // Filter: must match at least one keyword somewhere
  const scored = merged
    .map(m => ({ market: m, score: scoreMatch(m) }))
    .filter(s => s.score >= 10)  // must have SOME relevance
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.market);

  cache.set(cacheKey, scored, CACHE_TTL_SEARCH);
  return scored;
}

// Fetch single event with all its sub-markets
async function pmFetchEvent(eventId) {
  const cacheKey = `event:${eventId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const url = `${PM_GAMMA}/events/${eventId}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const e = await r.json();
  if (!e || !e.id) return null;

  const event = {
    id:        e.id,
    title:     e.title,
    slug:      e.slug,
    category:  classifyMarket(e.title, e.slug, e.title),
    volume:    Number(e.volume) || 0,
    liquidity: Number(e.liquidity) || 0,
    startDate: e.startDate,
    endDate:   e.endDate,
    image:     (e.markets && e.markets[0]) ? e.markets[0].image : null,
    marketCount: (e.markets || []).length,
    markets:   (e.markets || []).map(parseMarket).filter(m => m.outcomes.length === 2),
  };
  cache.set(cacheKey, event, CACHE_TTL_EVENTS);
  return event;
}

// Fetch trending markets (highest volume24hr, recently active)
async function pmFetchTrending(limit = 20) {
  const cacheKey = `trending:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const url = `${PM_GAMMA}/markets?limit=${limit}&active=true&closed=false&order=volume24hr&ascending=false`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('PM trending fetch failed: ' + r.status);
  const data = await r.json();

  const markets = data.map(parseMarket).filter(m => m.outcomes.length === 2 && m.volume24hr > 0);
  cache.set(cacheKey, markets, CACHE_TTL_MARKETS);
  return markets;
}

// ============ CLOB API — Orderbook, Trades, Price History ============

// Fetch live orderbook for a market (bid/ask ladder)
async function pmFetchOrderbook(tokenId) {
  const cacheKey = `book:${tokenId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const url = `${PM_CLOB}/book?token_id=${tokenId}`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return null;
    const data = await r.json();

    const book = {
      bids: (data.bids || []).sort((a,b) => Number(b.price) - Number(a.price)).slice(0, 10).map(o => ({ price: Number(o.price), size: Number(o.size) })),
      asks: (data.asks || []).sort((a,b) => Number(a.price) - Number(b.price)).slice(0, 10).map(o => ({ price: Number(o.price), size: Number(o.size) })),
      spread: null,
      midpoint: null,
    };
    if (book.bids.length && book.asks.length) {
      book.spread = +(book.asks[0].price - book.bids[0].price).toFixed(4);
      book.midpoint = +((book.asks[0].price + book.bids[0].price) / 2).toFixed(4);
    }
    cache.set(cacheKey, book, 2000); // 2s cache — orderbook is very real-time
    return book;
  } catch (e) {
    console.error('[clob-book]', e.message);
    return null;
  }
}

// Fetch recent trades for a market
async function pmFetchTrades(tokenId, limit = 20) {
  const cacheKey = `trades:${tokenId}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const url = `${PM_CLOB}/trades?token_id=${tokenId}&limit=${limit}`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return [];
    const data = await r.json();

    const trades = (data || []).map(t => ({
      id: t.id,
      price: Number(t.price),
      size: Number(t.size),
      side: t.side,       // BUY or SELL
      timestamp: t.match_time || t.created_at,
      fee: t.fee ? Number(t.fee) : 0,
    }));
    cache.set(cacheKey, trades, 3000); // 3s cache
    return trades;
  } catch (e) {
    console.error('[clob-trades]', e.message);
    return [];
  }
}

// Fetch CLOB prices (more real-time than Gamma)
async function pmFetchClobPrices(tokenIds) {
  if (!tokenIds || !tokenIds.length) return {};
  const cacheKey = `clobprices:${tokenIds.join(',')}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const url = `${PM_CLOB}/prices?token_ids=${tokenIds.join(',')}`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return {};
    const data = await r.json();
    cache.set(cacheKey, data, 2000);
    return data;
  } catch (e) {
    return {};
  }
}

// Fetch price history (timeseries) for charts
async function pmFetchPriceHistory(tokenId, interval = '1d', fidelity = 60) {
  const cacheKey = `history:${tokenId}:${interval}:${fidelity}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    // Polymarket data API for timeseries
    const url = `${PM_CLOB}/prices-history?market=${tokenId}&interval=${interval}&fidelity=${fidelity}`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) {
      // Fallback: try Gamma timeseries
      return await pmFetchPriceHistoryGamma(tokenId, interval);
    }
    const data = await r.json();
    const history = (data.history || data || []).map(p => ({
      t: p.t || p.timestamp,
      p: Number(p.p || p.price),
    }));
    const ttl = interval === '1h' ? 10000 : interval === '1d' ? 30000 : 60000;
    cache.set(cacheKey, history, ttl);
    return history;
  } catch (e) {
    console.error('[price-history]', e.message);
    return await pmFetchPriceHistoryGamma(tokenId, interval);
  }
}

// Fallback: price history from Gamma API
async function pmFetchPriceHistoryGamma(conditionId, interval) {
  try {
    const url = `${PM_GAMMA}/markets/${conditionId}/timeseries?interval=${interval}`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    return (data || []).map(p => ({
      t: p.t || p.timestamp || p.date,
      p: Number(p.p || p.price || p.yes_price || 0),
    }));
  } catch (e) {
    return [];
  }
}

// ============ THE ODDS API — PLAYER PROPS & MONEYLINES ============

// Convert American odds to implied probability (0-1)
function americanToProb(american) {
  if (!american || american === 0) return 0.5;
  if (american > 0) return 100 / (american + 100);
  return Math.abs(american) / (Math.abs(american) + 100);
}

// Fetch live moneylines (h2h) for upcoming games
async function oddsFetchMoneylines(sport = null) {
  if (!ODDS_API_KEY) return [];
  const cacheKey = `odds:ml:${sport || 'all'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const sports = sport ? [sport] : ODDS_SPORTS;
    const allGames = [];

    for (const sp of sports.slice(0, 3)) { // Limit API calls
      const url = `${ODDS_API_BASE}/sports/${sp}/odds/?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=american&dateFormat=iso`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const data = await r.json();

      for (const game of (data || [])) {
        if (!game.bookmakers || !game.bookmakers.length) continue;
        const book = game.bookmakers[0]; // Use first bookmaker
        const h2h = book.markets.find(m => m.key === 'h2h');
        if (!h2h || !h2h.outcomes || h2h.outcomes.length < 2) continue;

        const home = h2h.outcomes.find(o => o.name === game.home_team) || h2h.outcomes[0];
        const away = h2h.outcomes.find(o => o.name === game.away_team) || h2h.outcomes[1];

        const homeProb = americanToProb(home.price);
        const awayProb = americanToProb(away.price);

        allGames.push({
          id: `odds_ml_${game.id}`,
          source: 'odds_api',
          type: 'moneyline',
          sport: sp,
          sportLabel: sp.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          question: `${away.name} vs ${home.name}`,
          home_team: home.name,
          away_team: away.name,
          outcomes: ['Yes', 'No'], // Yes = home win, No = away win
          outcomePrices: [+homeProb.toFixed(4), +awayProb.toFixed(4)],
          home_odds: home.price,
          away_odds: away.price,
          commence_time: game.commence_time,
          category: 'sports',
          volume24hr: 0,
          liquidity: 0,
          active: true,
          closed: new Date(game.commence_time) < new Date(),
          image: null,
          eventTitle: game.sport_title || '',
          slug: game.id,
        });
      }
    }

    cache.set(cacheKey, allGames, 60000); // 60s cache (preserve API quota)
    return allGames;
  } catch (e) {
    console.error('[odds-ml]', e.message);
    return [];
  }
}

// Fetch player props for upcoming games
async function oddsFetchPlayerProps(sport = 'basketball_nba') {
  if (!ODDS_API_KEY) return [];
  const cacheKey = `odds:props:${sport}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    // First get events
    const eventsUrl = `${ODDS_API_BASE}/sports/${sport}/events?apiKey=${ODDS_API_KEY}&dateFormat=iso`;
    const evR = await fetch(eventsUrl);
    if (!evR.ok) return [];
    const events = await evR.json();

    const props = [];
    // Get props for first 3 events (API quota management)
    for (const ev of (events || []).slice(0, 3)) {
      try {
        const propMarkets = ['player_points', 'player_rebounds', 'player_assists', 'player_threes', 'player_blocks_steals',
                             'pitcher_strikeouts', 'batter_hits', 'batter_home_runs', 'batter_rbis',
                             'player_pass_tds', 'player_rush_yds', 'player_reception_yds'];
        const marketsParam = propMarkets.join(',');
        const url = `${ODDS_API_BASE}/sports/${sport}/events/${ev.id}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=${marketsParam}&oddsFormat=american&dateFormat=iso`;
        const r = await fetch(url);
        if (!r.ok) continue;
        const data = await r.json();

        if (!data.bookmakers || !data.bookmakers.length) continue;
        const book = data.bookmakers[0];

        for (const market of (book.markets || [])) {
          // Group outcomes by player (over/under pairs)
          const playerOutcomes = {};
          for (const outcome of (market.outcomes || [])) {
            const key = `${outcome.description}_${outcome.point}`;
            if (!playerOutcomes[key]) playerOutcomes[key] = { player: outcome.description, point: outcome.point, over: null, under: null };
            if (outcome.name === 'Over') playerOutcomes[key].over = outcome;
            if (outcome.name === 'Under') playerOutcomes[key].under = outcome;
          }

          for (const [, po] of Object.entries(playerOutcomes)) {
            if (!po.over || !po.under || !po.player) continue;
            const overProb = americanToProb(po.over.price);
            const statLabel = market.key.replace('player_', '').replace('pitcher_', '').replace('batter_', '').replace(/_/g, ' ');

            props.push({
              id: `odds_prop_${ev.id}_${market.key}_${po.player}_${po.point}`.replace(/[^a-zA-Z0-9_]/g, '_'),
              source: 'odds_api',
              type: 'player_prop',
              sport,
              sportLabel: sport.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
              question: `${po.player} OVER ${po.point} ${statLabel}`,
              player: po.player,
              stat: statLabel,
              line: po.point,
              outcomes: ['Yes', 'No'], // Yes = Over, No = Under
              outcomePrices: [+overProb.toFixed(4), +(1 - overProb).toFixed(4)],
              over_odds: po.over.price,
              under_odds: po.under.price,
              commence_time: ev.commence_time,
              category: 'sports',
              volume24hr: 0,
              liquidity: 0,
              active: true,
              closed: new Date(ev.commence_time) < new Date(),
              image: null,
              eventTitle: `${ev.away_team} @ ${ev.home_team}`,
              event_id: ev.id,
              slug: `${po.player}-${statLabel}-${po.point}`.toLowerCase().replace(/\s+/g, '-'),
            });
          }
        }
      } catch (_) { continue; }
    }

    cache.set(cacheKey, props, 120000); // 2min cache (heavy on API)
    return props;
  } catch (e) {
    console.error('[odds-props]', e.message);
    return [];
  }
}

// ============ DEMO PLAYER PROPS — realistic simulated data when no Odds API key ============
function generateDemoPlayerProps(sport = 'basketball_nba') {
  const cacheKey = `demo:props:${sport}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Current NBA playoff rosters (May 2026 — based on real active players)
  const nbaGames = [
    {
      id: 'demo_nba_game1', home: 'Cleveland Cavaliers', away: 'New York Knicks',
      commence: new Date(Date.now() + 6 * 3600000).toISOString(),
      players: [
        { name: 'Jalen Brunson', team: 'NYK', points: 24.5, assists: 6.5, rebounds: 3.5, threes: 2.5, steals: 0.5, blocks: 0.5 },
        { name: 'Karl-Anthony Towns', team: 'NYK', points: 22.5, assists: 3.5, rebounds: 11.5, threes: 1.5, steals: 0.5, blocks: 1.5 },
        { name: 'Mikal Bridges', team: 'NYK', points: 17.5, assists: 2.5, rebounds: 4.5, threes: 2.5, steals: 0.5, blocks: 0.5 },
        { name: 'OG Anunoby', team: 'NYK', points: 14.5, assists: 1.5, rebounds: 4.5, threes: 1.5, steals: 1.5, blocks: 0.5 },
        { name: 'Josh Hart', team: 'NYK', points: 9.5, assists: 3.5, rebounds: 7.5, threes: 1.5, steals: 0.5, blocks: 0.5 },
        { name: 'Donovan Mitchell', team: 'CLE', points: 26.5, assists: 4.5, rebounds: 4.5, threes: 3.5, steals: 1.5, blocks: 0.5 },
        { name: 'Darius Garland', team: 'CLE', points: 19.5, assists: 6.5, rebounds: 2.5, threes: 2.5, steals: 1.5, blocks: 0.5 },
        { name: 'Evan Mobley', team: 'CLE', points: 16.5, assists: 2.5, rebounds: 8.5, threes: 0.5, steals: 0.5, blocks: 1.5 },
        { name: 'Jarrett Allen', team: 'CLE', points: 12.5, assists: 1.5, rebounds: 10.5, threes: 0.5, steals: 0.5, blocks: 1.5 },
        { name: 'James Harden', team: 'CLE', points: 14.5, assists: 5.5, rebounds: 4.5, threes: 2.5, steals: 1.5, blocks: 0.5 },
      ]
    },
    {
      id: 'demo_nba_game2', home: 'Oklahoma City Thunder', away: 'San Antonio Spurs',
      commence: new Date(Date.now() + 30 * 3600000).toISOString(),
      players: [
        { name: 'Shai Gilgeous-Alexander', team: 'OKC', points: 30.5, assists: 5.5, rebounds: 5.5, threes: 2.5, steals: 2.5, blocks: 0.5 },
        { name: 'Jalen Williams', team: 'OKC', points: 20.5, assists: 4.5, rebounds: 5.5, threes: 1.5, steals: 1.5, blocks: 0.5 },
        { name: 'Chet Holmgren', team: 'OKC', points: 16.5, assists: 2.5, rebounds: 7.5, threes: 1.5, steals: 0.5, blocks: 2.5 },
        { name: 'Lu Dort', team: 'OKC', points: 10.5, assists: 1.5, rebounds: 3.5, threes: 1.5, steals: 1.5, blocks: 0.5 },
        { name: 'Victor Wembanyama', team: 'SAS', points: 24.5, assists: 3.5, rebounds: 10.5, threes: 2.5, steals: 1.5, blocks: 3.5 },
        { name: 'Devin Vassell', team: 'SAS', points: 17.5, assists: 3.5, rebounds: 3.5, threes: 2.5, steals: 0.5, blocks: 0.5 },
        { name: 'Keldon Johnson', team: 'SAS', points: 14.5, assists: 2.5, rebounds: 5.5, threes: 1.5, steals: 0.5, blocks: 0.5 },
        { name: 'Jeremy Sochan', team: 'SAS', points: 11.5, assists: 3.5, rebounds: 6.5, threes: 0.5, steals: 0.5, blocks: 0.5 },
      ]
    }
  ];

  const mlbGames = [
    {
      id: 'demo_mlb_game1', home: 'New York Yankees', away: 'Boston Red Sox',
      commence: new Date(Date.now() + 8 * 3600000).toISOString(),
      players: [
        { name: 'Aaron Judge', team: 'NYY', hits: 1.5, home_runs: 0.5, rbis: 1.5, total_bases: 2.5, runs: 0.5, strikeouts: 1.5 },
        { name: 'Juan Soto', team: 'NYY', hits: 1.5, home_runs: 0.5, rbis: 1.5, total_bases: 2.5, runs: 0.5, strikeouts: 0.5 },
        { name: 'Jazz Chisholm Jr.', team: 'NYY', hits: 0.5, home_runs: 0.5, rbis: 0.5, total_bases: 1.5, runs: 0.5, strikeouts: 1.5 },
        { name: 'Gerrit Cole', team: 'NYY', pitcher_strikeouts: 6.5, pitcher_outs: 17.5, pitcher_hits_allowed: 5.5, pitcher_walks: 1.5 },
        { name: 'Rafael Devers', team: 'BOS', hits: 1.5, home_runs: 0.5, rbis: 1.5, total_bases: 2.5, runs: 0.5, strikeouts: 0.5 },
        { name: 'Jarren Duran', team: 'BOS', hits: 1.5, home_runs: 0.5, rbis: 0.5, total_bases: 1.5, runs: 0.5, strikeouts: 1.5 },
      ]
    }
  ];

  const statCategories = sport === 'baseball_mlb'
    ? ['hits', 'home_runs', 'rbis', 'total_bases', 'runs', 'strikeouts', 'pitcher_strikeouts', 'pitcher_outs']
    : ['points', 'assists', 'rebounds', 'threes', 'steals', 'blocks'];

  const games = sport === 'baseball_mlb' ? mlbGames : nbaGames;
  const props = [];

  for (const game of games) {
    for (const player of game.players) {
      for (const stat of statCategories) {
        const line = player[stat];
        if (line === undefined || line === null) continue;

        // Generate realistic probability — lines are set near 50/50 with some variation
        const seed = (player.name.length * 7 + line * 13 + stat.length * 3) % 100;
        const baseProb = 0.45 + (seed / 100) * 0.20; // Range: 0.45 - 0.65
        const overProb = +baseProb.toFixed(4);

        const statLabel = stat.replace(/_/g, ' ');
        const displayStat = statLabel.replace('pitcher ', '').replace('batter ', '');

        props.push({
          id: `demo_prop_${game.id}_${stat}_${player.name}`.replace(/[^a-zA-Z0-9_]/g, '_'),
          source: 'demo',
          type: 'player_prop',
          sport,
          sportLabel: sport === 'baseball_mlb' ? 'Baseball Mlb' : 'Basketball Nba',
          question: `${player.name} OVER ${line} ${displayStat}`,
          player: player.name,
          playerTeam: player.team,
          stat: displayStat,
          statKey: stat,
          line: line,
          outcomes: ['Over', 'Under'],
          outcomePrices: [overProb, +(1 - overProb).toFixed(4)],
          over_odds: overProb >= 0.5 ? Math.round(-100 * overProb / (1 - overProb)) : Math.round(100 * (1 - overProb) / overProb),
          under_odds: overProb >= 0.5 ? Math.round(100 * (1 - overProb) / overProb) : Math.round(-100 * (1 - overProb) / overProb),
          commence_time: game.commence,
          category: 'sports',
          volume24hr: Math.floor(5000 + Math.random() * 95000),
          liquidity: Math.floor(2000 + Math.random() * 30000),
          active: true,
          closed: false,
          image: null,
          eventTitle: `${game.away} @ ${game.home}`,
          event_id: game.id,
          slug: `${player.name}-${stat}-${line}`.toLowerCase().replace(/\s+/g, '-'),
        });
      }
    }
  }

  cache.set(cacheKey, props, 300000); // 5min cache
  return props;
}

// ============ ORDER MUTEX (prevents concurrent double-spend) ============
const orderLocks = new Map();
function acquireOrderLock(accountId) {
  if (orderLocks.has(accountId)) return false;
  orderLocks.set(accountId, Date.now());
  return true;
}
function releaseOrderLock(accountId) {
  orderLocks.delete(accountId);
}
// Clean stale locks every 30s (safety net if lock not released due to crash)
setInterval(() => {
  const cutoff = Date.now() - 30000;
  for (const [id, ts] of orderLocks) {
    if (ts < cutoff) orderLocks.delete(id);
  }
}, 30000);

// ============ RISK ENGINE ============

function computeEquity(account) {
  return Number(account.balance);
}

// Get or create today's daily_pnl row for an account
async function getDailyPnl(accountId, currentBalance) {
  const today = new Date().toISOString().slice(0, 10);
  let row = (await dbSelect('daily_pnl', { account_id: accountId, date: today }))[0];
  if (!row) {
    row = await dbInsert('daily_pnl', {
      account_id: accountId,
      date: today,
      starting_bal: currentBalance,
      ending_bal: currentBalance,
      realized_pnl: 0,
      trade_count: 0,
    });
  }
  return row;
}

// Update daily_pnl after a trade close
async function updateDailyPnl(accountId, newBalance, pnl) {
  const today = new Date().toISOString().slice(0, 10);
  let row = (await dbSelect('daily_pnl', { account_id: accountId, date: today }))[0];
  if (!row) {
    row = await dbInsert('daily_pnl', {
      account_id: accountId,
      date: today,
      starting_bal: newBalance - pnl, // approximate starting bal
      ending_bal: newBalance,
      realized_pnl: pnl,
      trade_count: 1,
    });
  } else {
    await dbUpdate('daily_pnl', { id: row.id }, {
      ending_bal: newBalance,
      realized_pnl: +(Number(row.realized_pnl) + pnl).toFixed(2),
      trade_count: (Number(row.trade_count) || 0) + 1,
    });
  }
}

// Get the effective profit target for this account's current phase
function getTargetPct(account) {
  const phase = account.phase || 'eval';
  if (phase === 'verification') return VERIFICATION_TARGET;
  return PROFIT_TARGET; // eval or funded
}

/**
 * Central rule engine. Replaces old checkRules().
 *
 * @param {object} account  — the account row
 * @param {object} context  — { trigger, orderCost?, closePnl? }
 *   trigger: 'pre_order' | 'post_close' | 'post_settlement'
 *   orderCost: cost of the order (pre_order only)
 *   closePnl: realized PnL from this close (post_close/post_settlement only)
 *
 * @returns {object} { ok, code, msg, action, details }
 *   action: 'none' | 'fail' | 'reject_order' | 'pass_to_verification' | 'pass_to_funded'
 */
async function evaluateRules(account, context = {}) {
  const { trigger = 'pre_order', orderCost = 0, closePnl = 0 } = context;
  const size    = Number(account.size);
  const balance = Number(account.balance);
  const phase   = account.phase || 'eval';
  const targetPct = getTargetPct(account);

  // ── 1. TIME LIMIT — eval/verification expired? ──
  if (['eval', 'challenge', 'verification'].includes(account.status) && account.eval_ends_at) {
    if (new Date(account.eval_ends_at) < new Date()) {
      return { ok: false, code: 'TIME_EXPIRED', msg: 'Challenge expired — 30 days have elapsed', action: 'fail' };
    }
  }

  // ── 2. STATIC DRAWDOWN — balance below starting_size * (1 - 4%) ──
  const lossFloor = size * (1 - MAX_LOSS);
  if (trigger === 'pre_order') {
    // Would this order push balance below the drawdown floor?
    if (balance - orderCost < lossFloor) {
      return { ok: false, code: 'MAX_LOSS', msg: `Order would breach your ${MAX_LOSS * 100}% loss limit`, action: 'reject_order' };
    }
  } else {
    // Post-trade: has the account already blown through the floor?
    if (balance < lossFloor) {
      return { ok: false, code: 'MAX_LOSS', msg: `Account breached ${MAX_LOSS * 100}% max drawdown`, action: 'fail' };
    }
  }

  // ── 3. DAILY LOSS LIMIT — today's realized loss > starting_size * 2% ──
  const today = new Date().toISOString().slice(0, 10);
  const dailyRows = await dbSelect('daily_pnl', { account_id: account.id, date: today });
  const dailyRow = dailyRows[0];
  if (dailyRow) {
    const dailyFloor = size * DAILY_LOSS_LIMIT;
    // dailyLoss = how much the balance has dropped from today's starting balance
    const dailyLoss = Math.max(0, Number(dailyRow.starting_bal) - Number(dailyRow.ending_bal));
    if (trigger === 'pre_order') {
      // Block new trades if today's realized loss already hit the 2% daily limit
      if (dailyLoss >= dailyFloor) {
        return { ok: false, code: 'DAILY_LOSS', msg: `Daily loss limit reached — you've lost ${DAILY_LOSS_LIMIT * 100}% today. Trading locked until tomorrow.`, action: 'reject_order' };
      }
    } else {
      // Post-trade: has today's loss exceeded 2%?
      if (dailyLoss > dailyFloor) {
        return {
          ok: false, code: 'DAILY_LOSS',
          msg: `Daily loss limit breached (${(dailyLoss / size * 100).toFixed(1)}% lost today)`,
          action: 'fail',
          details: { daily_loss: dailyLoss, daily_limit: dailyFloor },
        };
      }
    }
  }

  // ── 4. POSITION CAP (pre-trade only) — order > 20% of account size ──
  if (trigger === 'pre_order') {
    if (orderCost > size * POSITION_CAP) {
      return { ok: false, code: 'POSITION_SIZE', msg: `Max ${POSITION_CAP * 100}% per trade — reduce your size`, action: 'reject_order' };
    }
  }

  // ── 5. PROFIT TARGET CHECK (post-trade only) ──
  if (trigger !== 'pre_order') {
    const targetBalance = size * (1 + targetPct);
    if (balance >= targetBalance) {
      // Candidate to pass — run additional checks

      // 5a. MIN TRADING DAYS
      const tradingDays = Number(account.trading_days) || 0;
      if (tradingDays < MIN_TRADING_DAYS) {
        // Don't fail them, just don't let them pass yet
        return {
          ok: true, code: 'TARGET_HIT_WAITING',
          msg: `Profit target hit! Need ${MIN_TRADING_DAYS - tradingDays} more trading day(s) to qualify.`,
          action: 'none',
          details: { trading_days: tradingDays, required: MIN_TRADING_DAYS },
        };
      }

      // 5b. CONSISTENCY RULE — no single day > 35% of total profit
      const totalProfit = balance - size;
      if (totalProfit > 0) {
        const allDailyRows = await dbSelect('daily_pnl', { account_id: account.id });
        for (const dr of allDailyRows) {
          const dayProfit = Number(dr.realized_pnl);
          if (dayProfit > 0 && dayProfit > totalProfit * CONSISTENCY_MAX_PCT) {
            return {
              ok: false, code: 'CONSISTENCY',
              msg: `Consistency rule: ${dr.date} profit ($${dayProfit.toFixed(2)}) is ${(dayProfit / totalProfit * 100).toFixed(0)}% of total — max is ${CONSISTENCY_MAX_PCT * 100}%`,
              action: 'fail',
              details: { date: dr.date, day_profit: dayProfit, total_profit: totalProfit, max_pct: CONSISTENCY_MAX_PCT },
            };
          }
        }
      }

      // 5c. PHASE TRANSITION
      if (phase === 'eval' || account.status === 'challenge') {
        return { ok: true, code: 'EVAL_PASSED', msg: 'Eval passed! Moving to verification phase.', action: 'pass_to_verification' };
      }
      if (phase === 'verification') {
        return { ok: true, code: 'VERIFICATION_PASSED', msg: 'Verification passed! Account is now funded.', action: 'pass_to_funded' };
      }
      // Already funded — no action needed
    }
  }

  return { ok: true, code: 'OK', msg: '', action: 'none' };
}

/**
 * Execute a phase transition based on evaluateRules result.
 * Called after evaluateRules returns an action like 'pass_to_verification' or 'pass_to_funded'.
 */
async function executePhaseTransition(account, ruleResult) {
  if (ruleResult.action === 'pass_to_verification') {
    // Mark current eval as completed
    await dbUpdate('accounts', { id: account.id }, { status: 'completed_eval' });

    // Create verification account (fresh balance, 4% target, 30-day timer)
    const now = new Date();
    const evalEnd = new Date(now.getTime() + EVAL_TIME_LIMIT_DAYS * 86400 * 1000);
    const planInfo = PLANS[account.plan] || PLANS.pro;

    const verificationAccount = await dbInsert('accounts', {
      user_id: account.user_id,
      plan: account.plan,
      size: planInfo.size,
      balance: planInfo.size,
      high_water: planInfo.size,
      status: 'verification',
      phase: 'verification',
      parent_eval_id: account.id,
      profit_target_pct: VERIFICATION_TARGET,
      max_loss_pct: MAX_LOSS,
      activation_fee_cents: 0, // already paid on eval
      eval_started_at: now.toISOString(),
      eval_ends_at: evalEnd.toISOString(),
    });

    console.log(`[phase] account ${account.id} → completed_eval | new verification account ${verificationAccount.id}`);
    return verificationAccount;
  }

  if (ruleResult.action === 'pass_to_funded') {
    const payoutDate = new Date(Date.now() + 14 * 86400 * 1000);
    await dbUpdate('accounts', { id: account.id }, {
      status: 'funded',
      phase: 'funded',
      payout_eligible_at: payoutDate.toISOString(),
    });
    console.log(`[phase] account ${account.id} → funded | payouts eligible ${payoutDate.toISOString().slice(0, 10)}`);
    return account;
  }

  if (ruleResult.action === 'fail') {
    const failUpdate = { status: 'failed' };
    if (ruleResult.code === 'DAILY_LOSS') failUpdate.daily_loss_breached_at = new Date().toISOString();
    if (ruleResult.code === 'CONSISTENCY') failUpdate.consistency_breached_at = new Date().toISOString();
    await dbUpdate('accounts', { id: account.id }, failUpdate);
    console.log(`[phase] account ${account.id} → failed (${ruleResult.code})`);
    return account;
  }

  return account;
}

// Legacy wrapper — keeps old call sites working during migration (pre-order check only)
function checkRules(account, orderCost) {
  // Synchronous fast-path for pre-order basics (no daily_pnl lookup)
  const size    = Number(account.size);
  const balance = Number(account.balance);
  const lossFloor = size * (1 - MAX_LOSS);
  if (balance - orderCost < lossFloor) {
    return { ok: false, code: 'MAX_LOSS', msg: `Order would breach your ${MAX_LOSS * 100}% loss limit` };
  }
  if (orderCost > size * POSITION_CAP) {
    return { ok: false, code: 'POSITION_SIZE', msg: `Max ${POSITION_CAP * 100}% per trade — reduce your size` };
  }
  return { ok: true };
}

// ============ EXPRESS APP ============
const app = express();
app.set('trust proxy', 1); // Trust Fly.io reverse proxy for rate limiting

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// CORS — restrict to known origins
const ALLOWED_ORIGINS = [
  'https://verdict-app.fly.dev',
  'https://trade-verdict.com',
  'https://www.trade-verdict.com',
  'http://localhost:3456',
  'http://127.0.0.1:3456',
];
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin (no origin header) or whitelisted origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Stripe webhook needs raw body — must come BEFORE express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK) return res.status(400).json({ error: 'Stripe not configured' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK);
  } catch (err) {
    console.error('[stripe-webhook] signature verify failed:', err.message);
    return res.status(400).send('Webhook signature failed');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { userId, plan, referralCode } = session.metadata || {};

    if (userId && plan && PLANS[plan]) {
      try {
        const planInfo = PLANS[plan];
        const now = new Date();
        const evalEnd = new Date(now.getTime() + 30 * 86400 * 1000);

        const account = await dbInsert('accounts', {
          user_id: Number(userId),
          plan,
          size: planInfo.size,
          balance: planInfo.size,
          high_water: planInfo.size,
          status: 'eval',
          phase: 'eval',
          profit_target_pct: PROFIT_TARGET,
          max_loss_pct: MAX_LOSS,
          activation_fee_cents: planInfo.activation,
          eval_started_at: now.toISOString(),
          eval_ends_at: evalEnd.toISOString(),
          stripe_session_id: session.id,
          stripe_payment_id: session.payment_intent,
        });

        if (session.customer) {
          await dbUpdate('users', { id: Number(userId) }, { stripe_customer_id: session.customer });
        }

        await dbInsert('payments', {
          user_id: Number(userId),
          account_id: account.id,
          stripe_session_id: session.id,
          stripe_payment_id: session.payment_intent,
          plan,
          amount_cents: planInfo.price,
          status: 'completed',
        });

        // ---- AFFILIATE: credit the referrer ----
        if (referralCode) {
          const affiliate = await dbSelectOne('affiliates', { code: referralCode });
          if (affiliate) {
            const commission = Math.round(planInfo.price * AFFILIATE_COMMISSION); // in cents
            await dbInsert('referrals', {
              affiliate_id: affiliate.id,
              referrer_user_id: affiliate.user_id,
              referred_user_id: Number(userId),
              payment_id: session.payment_intent,
              plan,
              eval_amount_cents: planInfo.price,
              commission_cents: commission,
              status: 'pending',
            });

            // Update affiliate totals
            await dbUpdate('affiliates', { id: affiliate.id }, {
              total_referrals: (affiliate.total_referrals || 0) + 1,
              total_earned_cents: (affiliate.total_earned_cents || 0) + commission,
              pending_cents: (affiliate.pending_cents || 0) + commission,
            });

            console.log(`[affiliate] ${referralCode} earned $${(commission / 100).toFixed(2)} from user ${userId}`);
          }
        }

        console.log(`[stripe] account created for user ${userId} — ${planInfo.label}`);
      } catch (e) {
        console.error('[stripe-webhook] account creation failed:', e.message);
      }
    }
  }

  res.json({ received: true });
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'site'), { extensions: ['html'] }));

// ============ RATE LIMITING ============
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 200,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
});
app.use(globalLimiter);

const authLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many auth attempts, try again in a minute' },
});

const orderLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Order rate limit reached, slow down' },
});

// ============ AUTH ROUTES ============
app.post('/api/signup', authLimiter, async (req, res) => {
  try {
    const { email, password, full_name, plan = 'pro', size = 25000, ref } = req.body || {};

    if (!email || !password) return res.status(400).json({ error: 'email + password required' });
    if (typeof email !== 'string' || email.length > 254) return res.status(400).json({ error: 'invalid email' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return res.status(400).json({ error: 'invalid email format' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    if (password.length > 128) return res.status(400).json({ error: 'password too long' });

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = (full_name || cleanEmail.split('@')[0]).substring(0, 100);
    const validPlans = ['starter', 'standard', 'pro', 'elite'];
    const cleanPlan = validPlans.includes(plan) ? plan : 'pro';
    const cleanSize = Math.max(5000, Math.min(100000, Number(size) || 25000));

    const existing = await dbSelectOne('users', { email: cleanEmail });
    if (existing) return res.status(400).json({ error: 'email already exists' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Store referral code if provided
    const referralCode = (typeof ref === 'string' && ref.length >= 4 && ref.length <= 20) ? ref.toUpperCase() : null;

    const user = await dbInsert('users', {
      email: cleanEmail,
      password_hash: passwordHash,
      full_name: cleanName,
      referred_by: referralCode || null,
      email_verified: false,
    });

    // Auto-generate affiliate code for new user
    const affCode = generateAffiliateCode();
    await dbInsert('affiliates', {
      user_id: user.id,
      code: affCode,
      total_referrals: 0,
      total_earned_cents: 0,
      pending_cents: 0,
      paid_cents: 0,
    });

    // Send verification email
    const verifyCode = crypto.randomBytes(32).toString('hex');
    tokenStore.set(verifyCode, { userId: user.id, email: cleanEmail, type: 'verify', expiresAt: Date.now() + 24 * 3600 * 1000 });
    const origin = APP_URL || req.headers.origin || `https://${req.headers.host}`;
    const verifyLink = `${origin}/api/verify-email?token=${verifyCode}`;
    sendEmail(cleanEmail, 'Verify your VERDICT account', `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;color:#fff;background:#0a0a0f">
        <h1 style="font-size:24px;font-weight:900;margin-bottom:8px">VERDICT</h1>
        <p style="color:#8b8b9e;margin-bottom:24px">Welcome! Verify your email to get started.</p>
        <a href="${verifyLink}" style="display:inline-block;padding:12px 32px;background:#4e8bff;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px">Verify Email</a>
        <p style="color:#55556a;font-size:12px;margin-top:24px">This link expires in 24 hours. If you didn't create this account, ignore this email.</p>
      </div>
    `);

    // NOTE: account is NOT created here — user must purchase an eval first
    // (or use /api/account/test in dev mode)

    const token = signToken({ userId: user.id, email: cleanEmail });

    return res.json({
      token,
      user: { id: user.id, email: cleanEmail, name: cleanName, email_verified: false },
    });
  } catch (e) {
    console.error('[signup]', e.message);
    return res.status(500).json({ error: 'signup failed' });
  }
});

app.post('/api/signin', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email + password required' });

    const cleanEmail = email.trim().toLowerCase();
    const user = await dbSelectOne('users', { email: cleanEmail });
    if (!user) return res.status(401).json({ error: 'invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'invalid credentials' });

    const token = signToken({ userId: user.id, email: cleanEmail });

    return res.json({
      token,
      user: { id: user.id, email: user.email, name: user.full_name, email_verified: user.email_verified !== false },
    });
  } catch (e) {
    console.error('[signin]', e.message);
    return res.status(500).json({ error: 'signin failed' });
  }
});

// ============ EMAIL VERIFICATION ============
app.get('/api/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send(verifyPage('Invalid link', false));

    const entry = tokenStore.get(token);
    if (!entry || entry.type !== 'verify') return res.status(400).send(verifyPage('Link expired or invalid', false));
    if (entry.expiresAt < Date.now()) { tokenStore.delete(token); return res.status(400).send(verifyPage('Link has expired — request a new one', false)); }

    await dbUpdate('users', { id: entry.userId }, { email_verified: true });
    tokenStore.delete(token);

    return res.send(verifyPage('Email verified! You can close this tab and start trading.', true));
  } catch (e) {
    console.error('[verify-email]', e.message);
    return res.status(500).send(verifyPage('Something went wrong', false));
  }
});

app.post('/api/resend-verification', authMiddleware, async (req, res) => {
  try {
    const user = await dbSelectOne('users', { id: req.userId });
    if (!user) return res.status(404).json({ error: 'user not found' });
    if (user.email_verified) return res.json({ ok: true, message: 'already verified' });

    const verifyCode = crypto.randomBytes(32).toString('hex');
    tokenStore.set(verifyCode, { userId: user.id, email: user.email, type: 'verify', expiresAt: Date.now() + 24 * 3600 * 1000 });
    const origin = APP_URL || req.headers.origin || `https://${req.headers.host}`;
    const verifyLink = `${origin}/api/verify-email?token=${verifyCode}`;
    await sendEmail(user.email, 'Verify your VERDICT account', `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;color:#fff;background:#0a0a0f">
        <h1 style="font-size:24px;font-weight:900;margin-bottom:8px">VERDICT</h1>
        <p style="color:#8b8b9e;margin-bottom:24px">Click below to verify your email address.</p>
        <a href="${verifyLink}" style="display:inline-block;padding:12px 32px;background:#4e8bff;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px">Verify Email</a>
        <p style="color:#55556a;font-size:12px;margin-top:24px">This link expires in 24 hours.</p>
      </div>
    `);
    return res.json({ ok: true, message: 'verification email sent' });
  } catch (e) {
    console.error('[resend-verify]', e.message);
    return res.status(500).json({ error: 'failed to resend' });
  }
});

function verifyPage(msg, success) {
  return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VERDICT — Email Verification</title></head>
  <body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;font-family:Inter,-apple-system,sans-serif;color:#fff">
    <div style="text-align:center;padding:40px">
      <div style="font-size:32px;margin-bottom:16px">${success ? '✅' : '❌'}</div>
      <h1 style="font-size:20px;font-weight:900;margin-bottom:8px">VERDICT</h1>
      <p style="color:${success ? '#00d4aa' : '#ff4757'};font-size:16px;font-weight:600">${msg}</p>
      <a href="/trade.html" style="display:inline-block;margin-top:24px;padding:10px 24px;background:#4e8bff;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:13px">Go to Dashboard</a>
    </div>
  </body></html>`;
}

// ============ FORGOT PASSWORD ============
app.post('/api/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    const cleanEmail = email.trim().toLowerCase();
    const user = await dbSelectOne('users', { email: cleanEmail });

    // Always return success to prevent email enumeration
    if (!user) return res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });

    const resetCode = crypto.randomBytes(32).toString('hex');
    tokenStore.set(resetCode, { userId: user.id, email: cleanEmail, type: 'reset', expiresAt: Date.now() + 60 * 60 * 1000 }); // 1 hour

    const origin = APP_URL || req.headers.origin || `https://${req.headers.host}`;
    const resetLink = `${origin}/reset-password.html?token=${resetCode}`;

    await sendEmail(cleanEmail, 'Reset your VERDICT password', `
      <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;color:#fff;background:#0a0a0f">
        <h1 style="font-size:24px;font-weight:900;margin-bottom:8px">VERDICT</h1>
        <p style="color:#8b8b9e;margin-bottom:24px">You requested a password reset. Click below to set a new password.</p>
        <a href="${resetLink}" style="display:inline-block;padding:12px 32px;background:#4e8bff;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px">Reset Password</a>
        <p style="color:#55556a;font-size:12px;margin-top:24px">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
      </div>
    `);

    return res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
  } catch (e) {
    console.error('[forgot-password]', e.message);
    return res.status(500).json({ error: 'failed to process request' });
  }
});

app.post('/api/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'token and password required' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    if (password.length > 128) return res.status(400).json({ error: 'password too long' });

    const entry = tokenStore.get(token);
    if (!entry || entry.type !== 'reset') return res.status(400).json({ error: 'invalid or expired reset link' });
    if (entry.expiresAt < Date.now()) { tokenStore.delete(token); return res.status(400).json({ error: 'reset link has expired' }); }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await dbUpdate('users', { id: entry.userId }, { password_hash: passwordHash });
    tokenStore.delete(token);

    // Invalidate all old tokens for this user
    for (const [k, v] of tokenStore) {
      if (v.userId === entry.userId && v.type === 'reset') tokenStore.delete(k);
    }

    return res.json({ ok: true, message: 'password updated — you can now log in' });
  } catch (e) {
    console.error('[reset-password]', e.message);
    return res.status(500).json({ error: 'failed to reset password' });
  }
});

// ============ MARKETS (public, cached) ============
app.get('/api/markets', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 100;
    // Use market index if available (always fresh), fallback to direct fetch
    if (marketIndex.markets.length > 0) {
      res.json(marketIndex.markets.slice(0, limit));
    } else {
      const markets = await pmFetchMarkets(limit);
      res.json(markets);
    }
  } catch (e) {
    console.error('[markets]', e.message);
    res.status(500).json({ error: 'failed to fetch markets' });
  }
});

// ============ EVENTS (public, cached) ============
app.get('/api/events', async (req, res) => {
  try {
    const events = await pmFetchEvents(Number(req.query.limit) || 20);
    res.json(events);
  } catch (e) {
    console.error('[events]', e.message);
    res.status(500).json({ error: 'failed to fetch events' });
  }
});

// Single event detail with sub-markets
app.get('/api/event/:id', async (req, res) => {
  try {
    const event = await pmFetchEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'event not found' });
    res.json(event);
  } catch (e) {
    console.error('[event-detail]', e.message);
    res.status(500).json({ error: 'failed to fetch event' });
  }
});

// ============ CATEGORY FILTER (public) ============
app.get('/api/markets/category/:cat', async (req, res) => {
  try {
    const cat = req.params.cat.toLowerCase();
    const validCats = ['sports', 'crypto', 'politics', 'finance', 'geopolitics', 'tech', 'culture', 'economy', 'science', 'elections', 'weather', 'other'];
    if (!validCats.includes(cat)) return res.status(400).json({ error: 'invalid category', valid: validCats });
    const limit = Number(req.query.limit) || 50;
    // Use market index first (instant, fresh)
    if (marketIndex.byCategory[cat] && marketIndex.byCategory[cat].length > 0) {
      res.json(marketIndex.byCategory[cat].slice(0, limit));
    } else {
      // Fallback to direct fetch
      const markets = await pmFetchByCategory(cat, limit);
      res.json(markets);
    }
  } catch (e) {
    console.error('[markets-category]', e.message);
    res.status(500).json({ error: 'failed to fetch markets by category' });
  }
});

// ============ SEARCH (public) ============
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.status(400).json({ error: 'query too short (min 2 chars)' });
    const markets = await pmSearch(q, Number(req.query.limit) || 30);
    res.json(markets);
  } catch (e) {
    console.error('[search]', e.message);
    res.status(500).json({ error: 'search failed' });
  }
});

// ============ LIVE PRICES — real-time CLOB prices for displayed markets ============
app.get('/api/prices/live', async (req, res) => {
  try {
    const ids = (req.query.ids || '').split(',').filter(Boolean).slice(0, 20);
    if (!ids.length) return res.json({});

    const results = {};
    for (const id of ids) {
      try {
        // Find market to get CLOB token IDs
        const cached = cache.get(`market:${id}`);
        let tokenIds = [];
        if (cached && cached.clobTokenIds) {
          try { tokenIds = JSON.parse(cached.clobTokenIds); } catch(_){}
        }
        if (tokenIds.length) {
          const prices = await pmFetchClobPrices(tokenIds);
          // Map token IDs back to yes/no prices
          if (prices[tokenIds[0]]) {
            results[id] = {
              yes: Number(prices[tokenIds[0]]) || 0,
              no: tokenIds[1] && prices[tokenIds[1]] ? Number(prices[tokenIds[1]]) : 1 - (Number(prices[tokenIds[0]]) || 0),
              source: 'clob',
              ts: Date.now(),
            };
          }
        }
      } catch(_){}
    }
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: 'price fetch failed' });
  }
});

// ============ TRENDING (public) ============
app.get('/api/trending', async (req, res) => {
  try {
    // Use index: top by 24h volume
    if (marketIndex.markets.length > 0) {
      const sorted = [...marketIndex.markets].sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0));
      res.json(sorted.slice(0, Number(req.query.limit) || 20));
    } else {
      const markets = await pmFetchTrending(Number(req.query.limit) || 20);
      res.json(markets);
    }
  } catch (e) {
    console.error('[trending]', e.message);
    res.status(500).json({ error: 'failed to fetch trending' });
  }
});

// ============ CATEGORIES LIST (public) ============
app.get('/api/categories', async (req, res) => {
  try {
    // Use index for instant response
    const source = marketIndex.markets.length > 0 ? marketIndex.markets : await pmFetchMarkets(200);
    const counts = {};
    for (const m of source) {
      counts[m.category] = (counts[m.category] || 0) + 1;
    }
    const cats = Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    res.json(cats);
  } catch (e) {
    console.error('[categories]', e.message);
    res.status(500).json({ error: 'failed to fetch categories' });
  }
});

// ============ PLAYER PROPS (public) ============
app.get('/api/props', async (req, res) => {
  try {
    const sport = req.query.sport || 'basketball_nba';
    let props = [];

    // Try Odds API first (gives real player prop lines like Jokic O24.5 pts)
    if (ODDS_API_KEY) {
      props = await oddsFetchPlayerProps(sport);
    }

    // No Odds API? Use demo player props for supported sports
    if (!props.length && ['basketball_nba', 'baseball_mlb'].includes(sport)) {
      props = generateDemoPlayerProps(sport);
    }

    // Fallback: serve sport-specific Polymarket markets from our sub-index
    if (!props.length) {
      // Map Odds API sport ID to our internal sport key
      const sportMap = {
        'basketball_nba': 'nba', 'football_nfl': 'nfl', 'baseball_mlb': 'mlb',
        'icehockey_nhl': 'nhl', 'mma_mixed_martial_arts': 'ufc',
        'soccer_epl': 'soccer', 'soccer_usa_mls': 'soccer',
      };
      const sportKey = sportMap[sport] || 'other_sports';
      const sportMarkets = (marketIndex.bySport[sportKey] || []).slice(0, 30);

      if (sportMarkets.length > 0) {
        props = sportMarkets.map(m => ({
          ...m,
          source: 'polymarket',
          type: 'prediction',
          sportLabel: sportKey.toUpperCase(),
          eventTitle: m.eventTitle || m.question,
        }));
      } else {
        // Final fallback: all sports markets
        const sportsMarkets = await pmFetchByCategory('sports', 30);
        props = sportsMarkets.map(m => ({
          ...m,
          source: 'polymarket',
          eventTitle: m.eventTitle || m.question,
        }));
      }
    }
    res.json(props);
  } catch (e) {
    console.error('[props]', e.message);
    // Final fallback: return Polymarket sports
    try {
      const fallback = (marketIndex.bySport && Object.values(marketIndex.bySport).flat().slice(0, 20)) || await pmFetchByCategory('sports', 20);
      res.json(fallback.map(m => ({ ...m, source: 'polymarket', eventTitle: m.eventTitle || m.question })));
    } catch (e2) {
      res.status(500).json({ error: 'failed to fetch props' });
    }
  }
});

app.get('/api/props/sports', (req, res) => {
  res.json([
    { id: 'basketball_nba', label: 'NBA', icon: '🏀' },
    { id: 'football_nfl', label: 'NFL', icon: '🏈' },
    { id: 'baseball_mlb', label: 'MLB', icon: '⚾' },
    { id: 'icehockey_nhl', label: 'NHL', icon: '🏒' },
    { id: 'mma_mixed_martial_arts', label: 'UFC', icon: '🥊' },
    { id: 'soccer_epl', label: 'EPL', icon: '⚽' },
    { id: 'soccer_usa_mls', label: 'MLS', icon: '⚽' },
  ]);
});

// ============ MONEYLINES (public) ============
app.get('/api/moneylines', async (req, res) => {
  try {
    const sport = req.query.sport || null;
    let games = [];
    if (ODDS_API_KEY) {
      games = await oddsFetchMoneylines(sport);
    }
    // Fallback: Polymarket sports markets — only real game matchups (non-Yes/No outcomes = actual teams)
    if (!games.length) {
      const sportsMarkets = await pmFetchByCategory('sports', 50);
      games = sportsMarkets
        .filter(m => m.outcomes.length === 2 && !(m.outcomes[0] === 'Yes' && m.outcomes[1] === 'No'))
        .map(m => {
          const homeProb = m.outcomePrices[0];
          const awayProb = m.outcomePrices[1];
          return {
            ...m,
            source: 'polymarket',
            home_team: m.outcomes[0],
            away_team: m.outcomes[1],
            home_odds: homeProb >= 0.5 ? Math.round(-100 * homeProb / (1 - homeProb)) : Math.round(100 * (1 - homeProb) / homeProb),
            away_odds: awayProb >= 0.5 ? Math.round(-100 * awayProb / (1 - awayProb)) : Math.round(100 * (1 - awayProb) / awayProb),
            sportLabel: m.eventTitle || 'Sports',
            commence_time: m.endDate,
          };
        });
    }
    res.json(games);
  } catch (e) {
    console.error('[moneylines]', e.message);
    res.status(500).json({ error: 'failed to fetch moneylines' });
  }
});

// ============ COMBINED FEED — all sports content in one call ============
app.get('/api/sports-feed', async (req, res) => {
  try {
    const sportFilter = req.query.sport || null;
    const [polyMarkets, moneylines, props] = await Promise.all([
      pmFetchByCategory('sports', 50).catch(() => []),
      oddsFetchMoneylines(sportFilter).catch(() => []),
      oddsFetchPlayerProps(sportFilter || 'basketball_nba').catch(() => []),
    ]);

    // Also include sport sub-index for richer data
    const sportBreakdown = {};
    for (const [sp, markets] of Object.entries(marketIndex.bySport || {})) {
      if (markets.length > 0) {
        sportBreakdown[sp] = markets.slice(0, 10);
      }
    }

    res.json({
      moneylines: moneylines.filter(g => !g.closed),
      props: props.filter(p => !p.closed),
      predictions: polyMarkets,
      bySport: sportBreakdown,
      sportCounts: Object.fromEntries(Object.entries(sportBreakdown).map(([k, v]) => [k, v.length])),
    });
  } catch (e) {
    console.error('[sports-feed]', e.message);
    res.status(500).json({ error: 'failed to fetch sports feed' });
  }
});

// ============ SPORT-SPECIFIC MARKETS (public) ============
// Returns markets for a specific sport: /api/sports/nba, /api/sports/mlb, etc.
app.get('/api/sports/:sport', (req, res) => {
  const sport = req.params.sport.toLowerCase();
  const validSports = Object.keys(marketIndex.bySport || {});
  if (!validSports.includes(sport)) {
    return res.status(400).json({ error: 'invalid sport', valid: validSports.filter(s => (marketIndex.bySport[s] || []).length > 0) });
  }
  const limit = Number(req.query.limit) || 50;
  const markets = (marketIndex.bySport[sport] || []).slice(0, limit);
  res.json(markets);
});

// Sport index overview — what sports have markets & how many
app.get('/api/sports', (req, res) => {
  const sports = {};
  for (const [sp, markets] of Object.entries(marketIndex.bySport || {})) {
    if (markets.length > 0) {
      sports[sp] = {
        count: markets.length,
        topMarkets: markets.slice(0, 3).map(m => ({ question: m.question, price: m.outcomePrices[0], volume24hr: m.volume24hr })),
      };
    }
  }
  res.json(sports);
});

// ============ INDEX HEALTH (public, no auth) — verify data accuracy ============
app.get('/api/index/health', (req, res) => {
  const age = Date.now() - marketIndex.lastRefresh;
  res.json({
    status: age < 30000 ? 'healthy' : age < 60000 ? 'stale' : 'dead',
    lastRefreshMs: age,
    lastRefreshHuman: `${(age / 1000).toFixed(1)}s ago`,
    stats: marketIndex.stats,
    samplePrices: marketIndex.markets.slice(0, 5).map(m => ({
      question: m.question.slice(0, 60),
      category: m.category,
      yesPrice: m.outcomePrices[0],
      clobFresh: !!m._clobFresh,
      volume24hr: m.volume24hr,
    })),
  });
});

// ============ ACCOUNT (auth required) ============
app.get('/api/account', authMiddleware, async (req, res) => {
  try {
    const accounts = await dbSelect('accounts', { user_id: req.userId });
    const account = accounts[0];
    if (!account) return res.json({ account: null, positions: [], fills: [] });

    const positions = await dbSelect('positions', { account_id: account.id });
    const fills = await dbSelect('fills', { account_id: account.id }, {
      order: { col: 'created_at', asc: false },
      limit: 50,
    });

    const equity = computeEquity(account);
    const bal = Number(account.balance);
    const sz  = Number(account.size);
    const hw  = Number(account.high_water);
    const phase = account.phase || 'eval';
    const effectiveTarget = getTargetPct(account);

    // Get today's daily PnL
    const today = new Date().toISOString().slice(0, 10);
    const dailyRows = await dbSelect('daily_pnl', { account_id: account.id, date: today });
    const dailyRow = dailyRows[0];
    const dailyPnl = dailyRow ? Number(dailyRow.realized_pnl) : 0;
    const dailyLoss = dailyRow ? Math.max(0, Number(dailyRow.starting_bal) - Number(dailyRow.ending_bal)) : 0;

    res.json({
      account: {
        ...account,
        balance: bal,
        size: sz,
        high_water: hw,
        equity,
        phase,
        loss_floor:         sz * (1 - MAX_LOSS),
        profit_target:      sz * (1 + effectiveTarget),
        target_pct:         effectiveTarget,
        max_loss_pct:       MAX_LOSS,
        daily_loss_limit:   sz * DAILY_LOSS_LIMIT,
        daily_loss_pct:     DAILY_LOSS_LIMIT,
        position_cap:       sz * POSITION_CAP,
        position_cap_pct:   POSITION_CAP,
        min_trading_days:   MIN_TRADING_DAYS,
        consistency_max:    CONSISTENCY_MAX_PCT,
        pnl:                bal - sz,
        pnl_pct:            (bal - sz) / sz,
        trading_days:       Number(account.trading_days) || 0,
        daily_pnl:          dailyPnl,
        daily_loss_today:   dailyLoss,
        daily_loss_remaining: Math.max(0, sz * DAILY_LOSS_LIMIT - dailyLoss),
      },
      positions: positions.map(p => ({
        ...p,
        shares:      Number(p.shares),
        entry_price: Number(p.entry_price),
        cost:        Number(p.cost),
        exit_price:  p.exit_price != null ? Number(p.exit_price) : null,
        pnl:         p.pnl != null ? Number(p.pnl) : null,
      })),
      fills,
    });
  } catch (e) {
    console.error('[account]', e.message);
    res.status(500).json({ error: 'failed to load account' });
  }
});

// ============ ORDER (auth + rate limited) ============
app.post('/api/order', authMiddleware, orderLimiter, async (req, res) => {
  try {
    const { market_id, side, shares } = req.body || {};
    if (!market_id || typeof market_id !== 'string') return res.status(400).json({ error: 'market_id required' });
    if (!['YES', 'NO'].includes(side)) return res.status(400).json({ error: 'side must be YES or NO' });
    const numShares = Number(shares);
    if (!numShares || numShares <= 0 || numShares > 100000) return res.status(400).json({ error: 'shares must be 1-100000' });

    const accounts = await dbSelect('accounts', { user_id: req.userId });
    const account = accounts[0];
    if (!account) return res.status(404).json({ error: 'no account' });
    if (!['eval', 'challenge', 'verification', 'funded', 'funded_express', 'funded_live', 'live'].includes(account.status)) {
      return res.status(400).json({ error: 'account not active: ' + account.status });
    }

    // Acquire order lock to prevent double-spend from concurrent requests
    if (!acquireOrderLock(account.id)) {
      return res.status(429).json({ error: 'order in progress, please wait' });
    }

    // Support demo player props (IDs start with demo_prop_) alongside real Polymarket markets
    let market;
    if (market_id.startsWith('demo_prop_')) {
      const allDemoProps = [...generateDemoPlayerProps('basketball_nba'), ...generateDemoPlayerProps('baseball_mlb')];
      const demoProp = allDemoProps.find(p => p.id === market_id);
      if (demoProp) {
        market = { id: demoProp.id, question: demoProp.question, outcomePrices: demoProp.outcomePrices, closed: false, category: 'sports' };
      }
    } else {
      market = await pmFetchMarket(market_id);
    }
    if (!market) { releaseOrderLock(account.id); return res.status(404).json({ error: 'market not found' }); }
    if (market.closed) { releaseOrderLock(account.id); return res.status(400).json({ error: 'market closed' }); }

    const pmPrice = side === 'YES' ? market.outcomePrices[0] : market.outcomePrices[1];
    if (!pmPrice || pmPrice <= 0 || pmPrice >= 1) {
      releaseOrderLock(account.id);
      return res.status(400).json({ error: 'invalid market price' });
    }

    const fillPrice = +Math.min(0.99, Math.max(0.01, pmPrice * (1 + SLIPPAGE_PCT))).toFixed(4);
    const cost = +(numShares * fillPrice).toFixed(2);

    // ── PRE-ORDER RULE CHECK (evaluateRules handles time limit, drawdown, daily loss, position cap) ──
    const risk = await evaluateRules(account, { trigger: 'pre_order', orderCost: cost });
    if (!risk.ok) {
      releaseOrderLock(account.id);
      // If the rule engine says fail the account (e.g. time expired), do it
      if (risk.action === 'fail') await executePhaseTransition(account, risk);
      return res.status(400).json({ error: risk.msg, code: risk.code });
    }

    // Ensure daily_pnl row exists for today (tracks starting balance)
    await getDailyPnl(account.id, Number(account.balance));

    const newBalance = +(Number(account.balance) - cost).toFixed(2);

    const position = await dbInsert('positions', {
      account_id: account.id,
      market_id,
      market_question: market.question,
      side,
      shares: numShares,
      entry_price: fillPrice,
      cost,
      status: 'open',
    });

    await dbInsert('fills', {
      account_id: account.id,
      position_id: position.id,
      market_id,
      side,
      shares: numShares,
      price: fillPrice,
      pm_price: pmPrice,
      slippage_pct: SLIPPAGE_PCT,
      notional: cost,
      kind: 'entry',
    });

    const acctUpdate = {
      balance: newBalance,
      high_water: Math.max(Number(account.high_water), newBalance),
      total_trades: (Number(account.total_trades) || 0) + 1,
    };

    // Track trading days — increment if this is a new day
    const today = new Date().toISOString().slice(0, 10);
    if (account.last_trade_day !== today) {
      acctUpdate.trading_days = (account.trading_days || 0) + 1;
      acctUpdate.last_trade_day = today;
    }

    await dbUpdate('accounts', { id: account.id }, acctUpdate);

    // Update daily_pnl ending balance after entry (balance went down by cost)
    const dailyRow = (await dbSelect('daily_pnl', { account_id: account.id, date: today }))[0];
    if (dailyRow) {
      await dbUpdate('daily_pnl', { id: dailyRow.id }, {
        ending_bal: newBalance,
        trade_count: (Number(dailyRow.trade_count) || 0) + 1,
      });
    }

    releaseOrderLock(account.id);
    return res.json({
      ok: true,
      position_id: position.id,
      fill: { price: fillPrice, pm_price: pmPrice, slippage_pct: SLIPPAGE_PCT, cost },
      new_balance: newBalance,
    });
  } catch (e) {
    // Always release lock on error
    try { const accts = await dbSelect('accounts', { user_id: req.userId }); if (accts[0]) releaseOrderLock(accts[0].id); } catch (_) {}
    console.error('[order]', e.message);
    return res.status(500).json({ error: 'order failed' });
  }
});

// ============ CLOSE POSITION ============
app.post('/api/position/:id/close', authMiddleware, orderLimiter, async (req, res) => {
  try {
    const positionId = Number(req.params.id);
    if (!positionId || isNaN(positionId)) return res.status(400).json({ error: 'invalid position id' });

    const position = await dbSelectOne('positions', { id: positionId });
    if (!position || position.status !== 'open') {
      return res.status(404).json({ error: 'position not found or already closed' });
    }

    const account = await dbSelectOne('accounts', { id: position.account_id });
    if (account.user_id !== req.userId) return res.status(403).json({ error: 'forbidden' });

    // Support demo player props alongside real Polymarket markets
    let market;
    if (position.market_id.startsWith('demo_prop_')) {
      const allDemoProps = [...generateDemoPlayerProps('basketball_nba'), ...generateDemoPlayerProps('baseball_mlb')];
      const demoProp = allDemoProps.find(p => p.id === position.market_id);
      if (demoProp) market = { id: demoProp.id, question: demoProp.question, outcomePrices: demoProp.outcomePrices, closed: false };
    } else {
      market = await pmFetchMarket(position.market_id);
    }
    if (!market) return res.status(404).json({ error: 'market not found' });

    const pmPrice = position.side === 'YES' ? market.outcomePrices[0] : market.outcomePrices[1];
    const exitPrice = +Math.min(0.99, Math.max(0.01, pmPrice * (1 - SLIPPAGE_PCT))).toFixed(4);
    const proceeds = +(Number(position.shares) * exitPrice).toFixed(2);
    const pnl = +(proceeds - Number(position.cost)).toFixed(2);
    const newBalance = +(Number(account.balance) + proceeds).toFixed(2);

    await dbUpdate('positions', { id: positionId }, {
      status: 'closed',
      exit_price: exitPrice,
      pnl,
      closed_at: new Date().toISOString(),
    });

    await dbInsert('fills', {
      account_id: account.id,
      position_id: positionId,
      market_id: position.market_id,
      side: position.side,
      shares: Number(position.shares),
      price: exitPrice,
      pm_price: pmPrice,
      slippage_pct: SLIPPAGE_PCT,
      notional: proceeds,
      kind: 'exit',
    });

    const closeUpdate = {
      balance: newBalance,
      high_water: Math.max(Number(account.high_water), newBalance),
    };
    if (pnl > 0) closeUpdate.winning_trades = (Number(account.winning_trades) || 0) + 1;
    await dbUpdate('accounts', { id: account.id }, closeUpdate);

    // Track daily PnL for this close
    await updateDailyPnl(account.id, newBalance, pnl);

    // ── POST-CLOSE RULE EVALUATION (drawdown, daily loss, profit target, phase transition) ──
    const updated = await dbSelectOne('accounts', { id: account.id });
    const ruleResult = await evaluateRules(updated, { trigger: 'post_close', closePnl: pnl });

    let phaseMsg = null;
    if (ruleResult.action === 'fail' || ruleResult.action === 'pass_to_verification' || ruleResult.action === 'pass_to_funded') {
      await executePhaseTransition(updated, ruleResult);
      phaseMsg = ruleResult.msg;
    }

    const response = { ok: true, exit_price: exitPrice, pnl, new_balance: newBalance };
    if (phaseMsg) response.phase_msg = phaseMsg;
    if (ruleResult.code === 'TARGET_HIT_WAITING') response.phase_msg = ruleResult.msg;
    return res.json(response);
  } catch (e) {
    console.error('[close]', e.message);
    return res.status(500).json({ error: 'close failed' });
  }
});

// ============ TEST ACCOUNT (dev mode only — creates eval without payment) ============
app.post('/api/account/test', authMiddleware, async (req, res) => {
  if (!DEV_MODE) return res.status(403).json({ error: 'not available in production' });
  try {
    const { plan = 'pro' } = req.body || {};
    const validPlans = ['starter', 'standard', 'pro', 'elite', 'whale'];
    const cleanPlan = validPlans.includes(plan) ? plan : 'pro';
    const planInfo = PLANS[cleanPlan];
    if (!planInfo) return res.status(400).json({ error: 'invalid plan' });

    // Check for existing active account
    const existing = await dbSelect('accounts', { user_id: req.userId });
    const active = existing.find(a => ['eval', 'challenge', 'verification', 'funded', 'funded_express', 'funded_live', 'live'].includes(a.status));
    if (active) return res.status(400).json({ error: 'You already have an active account.' });

    const now = new Date();
    const evalEnd = new Date(now.getTime() + EVAL_TIME_LIMIT_DAYS * 86400 * 1000);

    const account = await dbInsert('accounts', {
      user_id: req.userId,
      plan: cleanPlan,
      size: planInfo.size,
      balance: planInfo.size,
      high_water: planInfo.size,
      status: 'eval',
      phase: 'eval',
      profit_target_pct: PROFIT_TARGET,
      max_loss_pct: MAX_LOSS,
      activation_fee_cents: planInfo.activation,
      eval_started_at: now.toISOString(),
      eval_ends_at: evalEnd.toISOString(),
    });

    return res.json({ ok: true, account_id: account.id, plan: cleanPlan, size: planInfo.size, phase: 'eval' });
  } catch (e) {
    console.error('[test-account]', e.message);
    return res.status(500).json({ error: 'failed to create test account' });
  }
});

// ============ SINGLE MARKET DETAIL ============
app.get('/api/market/:id', async (req, res) => {
  try {
    // Check index first (instant, CLOB-enriched)
    let market = marketIndex.byId[req.params.id] || null;
    // Then try fresh Gamma fetch
    if (!market) market = await pmFetchMarket(req.params.id);
    // Fallback: try slug-based lookup if hex condition ID fails
    if (!market && !req.params.id.startsWith('0x')) {
      try {
        const r = await fetch(`${PM_GAMMA}/markets?slug=${encodeURIComponent(req.params.id)}&limit=1`);
        if (r.ok) {
          const arr = await r.json();
          if (arr && arr.length) market = parseMarket(arr[0]);
        }
      } catch (_) {}
    }
    if (!market) return res.status(404).json({ error: 'market not found' });
    // Enrich with fresh CLOB midpoint if possible
    try {
      let tokenIds = [];
      try { tokenIds = JSON.parse(market.clobTokenIds || '[]'); } catch(_){}
      if (tokenIds[0]) {
        const mr = await fetch(`${PM_CLOB}/midpoint?token_id=${tokenIds[0]}`, { signal: AbortSignal.timeout(2000) });
        if (mr.ok) {
          const md = await mr.json();
          if (md && md.mid != null) {
            const yes = Number(md.mid);
            if (yes > 0 && yes < 1) {
              market.outcomePrices = [yes, +(1 - yes).toFixed(4)];
              market._clobFresh = true;
            }
          }
        }
      }
    } catch(_){}
    res.json(market);
  } catch (e) {
    console.error('[market-detail]', e.message);
    res.status(500).json({ error: 'failed to fetch market' });
  }
});

// ============ ORDERBOOK (public) ============
app.get('/api/market/:id/book', async (req, res) => {
  try {
    const market = await pmFetchMarket(req.params.id);
    if (!market) return res.status(404).json({ error: 'market not found' });

    // Parse token IDs from the market
    let tokenIds = [];
    try { tokenIds = JSON.parse(market.clobTokenIds || '[]'); } catch(_){}
    if (!tokenIds.length) return res.json({ yes: null, no: null });

    const [yesBook, noBook] = await Promise.all([
      pmFetchOrderbook(tokenIds[0]),
      tokenIds[1] ? pmFetchOrderbook(tokenIds[1]) : null,
    ]);

    res.json({ yes: yesBook, no: noBook });
  } catch (e) {
    console.error('[orderbook]', e.message);
    res.status(500).json({ error: 'failed to fetch orderbook' });
  }
});

// ============ RECENT TRADES (from our own fills) ============
app.get('/api/market/:id/trades', async (req, res) => {
  try {
    const marketId = req.params.id;
    const limit = Math.min(50, Number(req.query.limit) || 20);

    // Query our own fills table — these are real platform trades
    let fills = [];
    try {
      fills = await dbSelect('fills', { market_id: marketId }, {
        order: { col: 'created_at', asc: false },
        limit,
      });
    } catch (_) {
      // If fills table doesn't support ordering, get all and sort
      const all = await dbSelect('fills', { market_id: marketId });
      fills = all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);
    }

    res.json(fills.map(f => ({
      id: f.id,
      price: Number(f.price),
      size: Number(f.shares),
      side: f.kind === 'entry' ? 'BUY' : 'SELL',
      outcome: f.side, // YES or NO
      timestamp: f.created_at,
      notional: Number(f.notional || 0),
    })));
  } catch (e) {
    console.error('[trades]', e.message);
    res.status(500).json({ error: 'failed to fetch trades' });
  }
});

// ============ PRICE HISTORY — real chart data (public) ============
app.get('/api/market/:id/history', async (req, res) => {
  try {
    const market = await pmFetchMarket(req.params.id);
    if (!market) return res.status(404).json({ error: 'market not found' });

    let tokenIds = [];
    try { tokenIds = JSON.parse(market.clobTokenIds || '[]'); } catch(_){}

    const interval = req.query.interval || '1d';     // 1h, 6h, 1d, 1w, 1m, all
    const fidelity = Number(req.query.fidelity) || 60; // data points

    // Try CLOB first, then Gamma fallback
    const tokenId = tokenIds[0] || req.params.id;
    const history = await pmFetchPriceHistory(tokenId, interval, fidelity);
    res.json(history);
  } catch (e) {
    console.error('[price-history]', e.message);
    res.status(500).json({ error: 'failed to fetch price history' });
  }
});

// ============ ENRICHED MARKET DETAIL — everything in one call ============
app.get('/api/market/:id/full', async (req, res) => {
  try {
    const market = await pmFetchMarket(req.params.id);
    if (!market) return res.status(404).json({ error: 'market not found' });

    let tokenIds = [];
    try { tokenIds = JSON.parse(market.clobTokenIds || '[]'); } catch(_){}

    // Fetch everything in parallel
    const [yesBook, trades, history] = await Promise.all([
      tokenIds[0] ? pmFetchOrderbook(tokenIds[0]) : null,
      tokenIds[0] ? pmFetchTrades(tokenIds[0], 15) : [],
      pmFetchPriceHistory(tokenIds[0] || req.params.id, '1d', 96),
    ]);

    res.json({
      ...market,
      orderbook: yesBook,
      recentTrades: trades,
      priceHistory: history,
    });
  } catch (e) {
    console.error('[market-full]', e.message);
    res.status(500).json({ error: 'failed to fetch enriched market' });
  }
});

// ============ STRIPE CHECKOUT ============
app.post('/api/checkout', authMiddleware, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Payments not configured' });

  try {
    const { plan, ref } = req.body || {};
    if (!plan || !PLANS[plan]) return res.status(400).json({ error: 'invalid plan' });

    const planInfo = PLANS[plan];
    const user = await dbSelectOne('users', { id: req.userId });
    if (!user) return res.status(404).json({ error: 'user not found' });

    const existing = await dbSelect('accounts', { user_id: req.userId });
    const active = existing.find(a => ['eval', 'challenge', 'verification', 'funded', 'funded_express', 'funded_live', 'live'].includes(a.status));
    if (active) return res.status(400).json({ error: 'You already have an active account. Complete or fail your current eval first.' });

    const origin = APP_URL || req.headers.origin || `https://${req.headers.host}`;

    // Validate referral code if provided
    let referralCode = null;
    if (ref && typeof ref === 'string' && ref.length >= 4) {
      const aff = await dbSelectOne('affiliates', { code: ref.toUpperCase() });
      if (aff && aff.user_id !== req.userId) {  // can't refer yourself
        referralCode = ref.toUpperCase();
      }
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: user.email,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `VERDICT ${planInfo.label} Challenge`,
            description: `${planInfo.label} eval — 6% profit target, 4% max drawdown, 20% position cap, 80/20 split`,
          },
          unit_amount: planInfo.price,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${origin}/trade.html?paid=1`,
      cancel_url:  `${origin}/index.html#pricing`,
      metadata: {
        userId: String(req.userId),
        plan,
        referralCode: referralCode || '',
      },
    });

    await dbInsert('payments', {
      user_id: req.userId,
      stripe_session_id: session.id,
      plan,
      amount_cents: planInfo.price,
      status: 'pending',
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error('[checkout]', e.message);
    return res.status(500).json({ error: 'checkout failed' });
  }
});

app.get('/api/plans', (req, res) => {
  const plans = Object.entries(PLANS).map(([key, val]) => ({
    id: key,
    label: val.label,
    price: val.price / 100,
    activation: val.activation / 100,
    total: (val.price + val.activation) / 100,
    size: val.size,
    target_pct: PROFIT_TARGET,
    verification_target_pct: VERIFICATION_TARGET,
    max_loss_pct: MAX_LOSS,
    daily_loss_pct: DAILY_LOSS_LIMIT,
    position_cap_pct: POSITION_CAP,
    min_trading_days: MIN_TRADING_DAYS,
    consistency_max_pct: CONSISTENCY_MAX_PCT,
  }));
  res.json(plans);
});

// ============ AFFILIATE ROUTES ============

// Get my affiliate dashboard
app.get('/api/affiliate', authMiddleware, async (req, res) => {
  try {
    const affiliate = await dbSelectOne('affiliates', { user_id: req.userId });
    if (!affiliate) {
      // Create one on-the-fly if missing
      const code = generateAffiliateCode();
      const newAff = await dbInsert('affiliates', {
        user_id: req.userId,
        code,
        total_referrals: 0,
        total_earned_cents: 0,
        pending_cents: 0,
        paid_cents: 0,
      });
      return res.json({
        code: newAff.code,
        link: `${APP_URL || req.headers.origin || 'https://verdict.markets'}?ref=${newAff.code}`,
        total_referrals: 0,
        total_earned: 0,
        pending: 0,
        paid: 0,
        commission_rate: AFFILIATE_COMMISSION * 100,
        referrals: [],
      });
    }

    // Get referral history
    const referrals = await dbSelect('referrals', { affiliate_id: affiliate.id }, {
      order: { col: 'created_at', asc: false },
      limit: 50,
    });

    const origin = APP_URL || req.headers.origin || 'https://verdict.markets';

    return res.json({
      code: affiliate.code,
      link: `${origin}?ref=${affiliate.code}`,
      total_referrals: affiliate.total_referrals || 0,
      total_earned: (affiliate.total_earned_cents || 0) / 100,
      pending: (affiliate.pending_cents || 0) / 100,
      paid: (affiliate.paid_cents || 0) / 100,
      commission_rate: AFFILIATE_COMMISSION * 100,
      referrals: referrals.map(r => ({
        plan: r.plan,
        commission: r.commission_cents / 100,
        status: r.status,
        date: r.created_at,
      })),
    });
  } catch (e) {
    console.error('[affiliate]', e.message);
    return res.status(500).json({ error: 'failed to load affiliate data' });
  }
});

// Custom affiliate code (optional — lets user pick their code)
app.post('/api/affiliate/code', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string') return res.status(400).json({ error: 'code required' });

    const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length < 3 || clean.length > 16) {
      return res.status(400).json({ error: 'code must be 3-16 alphanumeric characters' });
    }

    // Check if taken
    const existing = await dbSelectOne('affiliates', { code: clean });
    if (existing && existing.user_id !== req.userId) {
      return res.status(400).json({ error: 'code already taken' });
    }

    let affiliate = await dbSelectOne('affiliates', { user_id: req.userId });
    if (!affiliate) {
      affiliate = await dbInsert('affiliates', {
        user_id: req.userId,
        code: clean,
        total_referrals: 0,
        total_earned_cents: 0,
        pending_cents: 0,
        paid_cents: 0,
      });
    } else {
      await dbUpdate('affiliates', { id: affiliate.id }, { code: clean });
    }

    return res.json({ ok: true, code: clean });
  } catch (e) {
    console.error('[affiliate-code]', e.message);
    return res.status(500).json({ error: 'failed to update code' });
  }
});

// Validate a referral code (public — used on signup page)
app.get('/api/ref/:code', async (req, res) => {
  try {
    const code = (req.params.code || '').toUpperCase();
    const affiliate = await dbSelectOne('affiliates', { code });
    if (!affiliate) return res.status(404).json({ valid: false });
    return res.json({ valid: true, code });
  } catch (e) {
    return res.status(500).json({ valid: false });
  }
});

// ============ PAYOUT REQUESTS ============
const MIN_PAYOUT = 125; // $125 minimum payout
const WITHDRAWAL_PAUSE_MS = 24 * 60 * 60 * 1000; // 24 hours

app.post('/api/payout/request', authMiddleware, async (req, res) => {
  try {
    const { account_id, payout_method, payout_details } = req.body || {};

    const validMethods = ['crypto', 'rise', 'bank_wire', 'paypal'];
    if (!validMethods.includes(payout_method)) {
      return res.status(400).json({ error: 'Invalid payout method. Use: ' + validMethods.join(', ') });
    }

    const account = await dbSelectOne('accounts', { id: account_id });
    if (!account) return res.status(404).json({ error: 'account not found' });
    if (account.user_id !== req.userId) return res.status(403).json({ error: 'forbidden' });

    // Must be funded to withdraw
    if (!['funded', 'passed', 'live'].includes(account.status)) {
      return res.status(400).json({ error: 'Complete your eval and verification first to unlock withdrawals' });
    }

    // 14-day wait for first payout after funding
    if (account.payout_eligible_at && new Date(account.payout_eligible_at) > new Date()) {
      const daysLeft = Math.ceil((new Date(account.payout_eligible_at) - new Date()) / 86400000);
      return res.status(400).json({ error: `First payout available in ${daysLeft} day(s). Payouts unlock 14 days after funding.` });
    }

    // 24h withdrawal pause — check if still paused from a previous withdrawal
    if (account.paused_until && new Date(account.paused_until) > new Date()) {
      const hoursLeft = Math.ceil((new Date(account.paused_until) - new Date()) / 3600000);
      return res.status(400).json({ error: `Withdrawal paused for ${hoursLeft} more hour(s). 24h cooldown after each withdrawal.` });
    }

    const existing = await dbSelect('payout_requests', { account_id, status: 'pending' });
    if (existing.length > 0) {
      return res.status(400).json({ error: 'you already have a pending payout request for this account' });
    }

    const details = payout_details || {};
    if (payout_method === 'crypto') {
      if (!details.address || typeof details.address !== 'string' || details.address.length < 10) {
        return res.status(400).json({ error: 'valid crypto address required' });
      }
      if (!details.network || typeof details.network !== 'string') {
        return res.status(400).json({ error: 'network required (e.g. ethereum, polygon, solana, bitcoin)' });
      }
    } else if (payout_method === 'rise') {
      if (!details.rise_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.rise_email)) {
        return res.status(400).json({ error: 'valid Rise email required' });
      }
    } else if (payout_method === 'bank_wire') {
      if (!details.bank_name || !details.account_holder) {
        return res.status(400).json({ error: 'bank name and account holder required' });
      }
    } else if (payout_method === 'paypal') {
      if (!details.paypal_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.paypal_email)) {
        return res.status(400).json({ error: 'valid PayPal email required' });
      }
    }

    const profit = Number(account.balance) - Number(account.size);
    const payoutAmount = +(profit * PROFIT_SPLIT).toFixed(2);
    if (payoutAmount <= 0) {
      return res.status(400).json({ error: 'no profit to pay out' });
    }

    // $125 minimum payout
    if (payoutAmount < MIN_PAYOUT) {
      return res.status(400).json({ error: `Minimum payout is $${MIN_PAYOUT}. Your current payout would be $${payoutAmount.toFixed(2)}.` });
    }

    const payout = await dbInsert('payout_requests', {
      user_id: req.userId,
      account_id,
      amount: payoutAmount,
      payout_method,
      payout_details: details,
    });

    // Set 24h withdrawal pause
    const pauseUntil = new Date(Date.now() + WITHDRAWAL_PAUSE_MS).toISOString();
    await dbUpdate('accounts', { id: account_id }, { paused_until: pauseUntil });

    return res.json({
      ok: true,
      payout_id: payout.id,
      amount: payoutAmount,
      profit_split: `${PROFIT_SPLIT * 100}%`,
      total_profit: profit,
      status: 'pending',
      paused_until: pauseUntil,
    });
  } catch (e) {
    console.error('[payout-request]', e.message);
    return res.status(500).json({ error: 'payout request failed' });
  }
});

app.get('/api/payouts', authMiddleware, async (req, res) => {
  try {
    const payouts = await dbSelect('payout_requests', { user_id: req.userId }, {
      order: { col: 'created_at', asc: false },
    });
    res.json(payouts.map(p => ({
      ...p,
      amount: Number(p.amount),
    })));
  } catch (e) {
    console.error('[payouts]', e.message);
    res.status(500).json({ error: 'failed to load payouts' });
  }
});

// ============ RESOLUTION CRON ============
let cronRunning = false;
async function checkResolutions() {
  if (cronRunning) return;
  cronRunning = true;
  try {
    const openPositions = await dbSelect('positions', { status: 'open' });
    if (openPositions.length === 0) { cronRunning = false; return; }
    console.log(`[cron] checking ${openPositions.length} open positions for resolution...`);

    const byMarket = {};
    for (const p of openPositions) {
      if (!byMarket[p.market_id]) byMarket[p.market_id] = [];
      byMarket[p.market_id].push(p);
    }

    const marketIds = Object.keys(byMarket);
    for (let i = 0; i < marketIds.length; i += 5) {
      const batch = marketIds.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(mid => pmFetchMarket(mid))
      );

      for (let j = 0; j < batch.length; j++) {
        const mid = batch[j];
        const result = results[j];
        if (result.status !== 'fulfilled' || !result.value || !result.value.resolved) continue;

        const market = result.value;
        const yesWon = (market.winningSide === 'YES' || market.outcomePrices?.[0] === 1);

        for (const pos of byMarket[mid]) {
          try {
            const settlementPrice = (pos.side === 'YES' && yesWon) || (pos.side === 'NO' && !yesWon) ? 1.0 : 0.0;
            const proceeds = Number(pos.shares) * settlementPrice;
            const pnl = +(proceeds - Number(pos.cost)).toFixed(2);

            await dbUpdate('positions', { id: pos.id }, {
              status: 'resolved',
              exit_price: settlementPrice,
              pnl,
              closed_at: new Date().toISOString(),
            });

            await dbInsert('fills', {
              account_id: pos.account_id,
              position_id: pos.id,
              market_id: mid,
              side: pos.side,
              shares: Number(pos.shares),
              price: settlementPrice,
              pm_price: settlementPrice,
              slippage_pct: 0,
              notional: proceeds,
              kind: 'settlement',
            });

            const acct = await dbSelectOne('accounts', { id: pos.account_id });
            const settlePnl = +(proceeds - Number(pos.cost)).toFixed(2);
            const newBalance = +(Number(acct.balance) + proceeds).toFixed(2);
            await dbUpdate('accounts', { id: pos.account_id }, {
              balance: newBalance,
              high_water: Math.max(Number(acct.high_water), newBalance),
            });

            // Track settlement PnL in daily_pnl
            await updateDailyPnl(pos.account_id, newBalance, settlePnl);

            // Run full rule evaluation post-settlement
            const updated = await dbSelectOne('accounts', { id: pos.account_id });
            const ruleResult = await evaluateRules(updated, { trigger: 'post_settlement', closePnl: settlePnl });
            if (ruleResult.action === 'fail' || ruleResult.action === 'pass_to_verification' || ruleResult.action === 'pass_to_funded') {
              await executePhaseTransition(updated, ruleResult);
              console.log(`[cron] account ${pos.account_id} — ${ruleResult.code}: ${ruleResult.msg}`);
            }
          } catch (e) {
            console.error(`[cron] settlement error for position ${pos.id}:`, e.message);
          }
        }
      }

      if (i + 5 < marketIds.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  } catch (e) {
    console.error('[cron] resolution sweep error:', e.message);
  } finally {
    cronRunning = false;
  }
}
cron.schedule('* * * * *', checkResolutions);

// ============ CATCH-ALL 404 ============
app.use((req, res, _next) => {
  res.status(404).json({ error: 'not found' });
});

// ============ GLOBAL ERROR HANDLER ============
app.use((err, req, res, _next) => {
  console.error('[unhandled]', err.message);
  res.status(500).json({ error: 'internal server error' });
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// ============ BOOT ============
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  VERDICT server running on port ${PORT}${APP_URL ? ' → ' + APP_URL : ''}`);
  console.log(`  • Mode:            ${DEV_MODE ? 'DEV (in-memory)' : 'PRODUCTION (Supabase)'}`);
  if (!DEV_MODE) console.log(`  • Supabase:        connected`);
  console.log(`  • Stripe:          ${stripe ? 'enabled' : 'DISABLED (no key)'}`);
  console.log(`  • Auth:            JWT (${JWT_EXPIRES} expiry) + bcrypt`);
  console.log(`  • Market cache:    ${CACHE_TTL_MARKETS / 1000}s list / ${CACHE_TTL_MARKET / 1000}s single / ${CACHE_TTL_EVENTS / 1000}s events`);
  console.log(`  • Rate limits:     200/min global, 10/min auth, 30/min orders`);
  console.log(`  • Fixed slippage:  ${SLIPPAGE_PCT * 100}%`);
  console.log(`  • Profit split:    ${PROFIT_SPLIT * 100}% to trader`);
  console.log(`  • Affiliate:       ${AFFILIATE_COMMISSION * 100}% commission`);
  console.log(`  • Rules:           ${PROFIT_TARGET * 100}% profit line / ${MAX_LOSS * 100}% loss limit / 30-day challenge / ${POSITION_CAP * 100}% max per trade`);
  console.log(`  • API endpoints:   markets, events, categories, search, trending`);
  console.log(`  • Resolution cron: every 60s (batched)\n`);
});
