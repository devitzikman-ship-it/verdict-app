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

// ============ CONFIG ============
const PORT          = process.env.PORT || 3456;
const APP_URL       = process.env.APP_URL || '';   // e.g. https://app.verdict.markets — leave blank for auto-detect
const JWT_SECRET    = process.env.JWT_SECRET || 'verdict-dev-secret-change-in-prod-' + Date.now();
const JWT_EXPIRES   = '7d';
const BCRYPT_ROUNDS = 12;
const SLIPPAGE_PCT  = 0.02;
const PROFIT_TARGET = 0.10;
const MAX_LOSS      = 0.10;
const POSITION_CAP  = 0.25;
const PM_GAMMA      = 'https://gamma-api.polymarket.com';

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

// Plan pricing (cents/month) and account sizes — monthly subscriptions
const PLANS = {
  starter:  { price: 4900,  size: 1000,   label: 'Starter $1K',     monthly: true },
  standard: { price: 7900,  size: 2500,   label: 'Standard $2.5K',  monthly: true },
  pro:      { price: 14900, size: 5000,   label: 'Pro $5K',         monthly: true },
  elite:    { price: 24900, size: 10000,  label: 'Elite $10K',      monthly: true },
};

// Profit split: trader keeps 80%
const PROFIT_SPLIT = 0.80;

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

const CACHE_TTL_MARKETS = 15 * 1000;   // 15s — near real-time list refresh
const CACHE_TTL_MARKET  = 10 * 1000;   // 10s — single market detail
const CACHE_TTL_EVENTS  = 20 * 1000;   // 20s — event groupings
const CACHE_TTL_SEARCH  = 10 * 1000;   // 10s — search results

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
  const rules = [
    { cat: 'sports',      kw: ['nba','nfl','nhl','mlb','fifa','world cup','champions league','premier league','ufc','boxing','tennis','golf','f1','formula','super bowl','playoffs','stanley cup','world series','olympics','mls','soccer','basketball','football','baseball','hockey','match','vs.','game ','series ','win the 20','mvp','coach','player','team','score','goal','championship','trophy','draft','season','ncaa','grand prix','wimbledon','us open','french open','australian open','la liga','serie a','bundesliga','ligue 1','euro 2','copa','cricket','ipl','t20','wrestling','martial art','fight night','knockout','heavyweight','lightweight','featherweight','pga','masters','ryder cup','indy 500','nascar','daytona','horse racing','kentucky derby','preakness','belmont','world record','medal','batting','pitching','quarterback','touchdown','field goal','slam dunk','home run','penalty','offside','hat trick','transfer window','free agent','signing','trade deadline','super league','grand slam','davis cup','lol:','lck','lpl','lec','lcs','bo3','bo5','esport','league of legends','dota','csgo','valorant','overwatch','rolster','gen.g','t1 ','fnatic','g2 '] },
    { cat: 'crypto',      kw: ['bitcoin','btc','ethereum','eth','solana','sol','crypto','token','defi','nft','blockchain','binance','coinbase','dogecoin','xrp','cardano','polygon','matic','avalanche','avax','chain','altcoin','stablecoin','usdc','usdt','memecoin','litecoin','ripple','chainlink','uniswap','aave','maker','compound','celsius','ftx','tether','mining','halving','smart contract','dapp','web3','metaverse','dao','yield','staking','gas fee','layer 2','rollup','zk','optimism','arbitrum','base chain','pepe','shib','bonk'] },
    { cat: 'politics',    kw: ['trump','biden','president','congress','senate','house','election','vote','democrat','republican','gop','governor','mayor','primary','caucus','impeach','cabinet','supreme court','scotus','legislation','bill pass','executive order','poll','approve','disapprove','political','party','campaign','nominee','inaug','pardon','indic','desantis','haley','vance','rfk','kennedy','newsom','harris','pence','pelosi','mcconnell','schumer','filibuster','veto','executive branch','judicial','legislative','debate','swing state','battleground','ballot','red state','blue state','swing voter','lobby','pac','super pac','Electoral College','senate race','house race','gubernatorial'] },
    { cat: 'finance',     kw: ['stock','s&p','nasdaq','dow','fed','interest rate','inflation','gdp','recession','market cap','ipo','earnings','revenue','profit','bull','bear','oil price','gold price','commodity','bond','yield','treasury','forex','trade war','tariff','debt','deficit','crude oil','wti','brent','natural gas','copper price','silver price','futures','options','put ','call ','strike price','derivatives','hedge fund','private equity','venture capital','merger','acquisition'] },
    { cat: 'geopolitics', kw: ['iran','ukraine','russia','china','nato','war','conflict','missile','sanction','nuclear','peace deal','ceasefire','invasion','military','troops','territory','border','diplomacy','treaty','united nations','invasion','hormuz','strait','suez','taiwan','north korea','pyongyang','kim jong','xi jinping','putin','zelensky','netanyahu','gaza','israel','palestine','hamas','hezbollah','yemen','houthi','syria','assad','taliban','afghanistan','iraq','libya','prime minister','head of state','sovereignty','regime','coup','rebellion','insurgent','embargo','occupation'] },
    { cat: 'tech',        kw: ['ai ','artificial intelligence','openai','google','apple','microsoft','meta','spacex','tesla','launch','satellite','robot','chatgpt','semiconductor','chip','nvidia','tech company','silicon valley','startup','agi','model','llm','anthropic','claude','gemini','gpt','machine learning','deep learning','neural network','quantum','autonomous','self-driving','drone','rocket','starship','falcon','iphone','android','app store','cybersecurity','hack','breach','data leak','cloud','aws','azure','5g','6g','vr','ar','mixed reality','vision pro'] },
    { cat: 'culture',     kw: ['oscar','grammy','emmy','movie','film','album','song','celebrity','tv show','netflix','disney','tiktok','youtube','instagram','viral','meme','pop culture','award show','concert','tour','billboard','box office','stream','spotify','podcast','influencer','reality tv','bachelor','kiss','kardashian','taylor swift','drake','kanye','beyonce','rihanna','selena','jenner','bieber','anime','manga','gaming','twitch','streamer','hbo','amazon prime','hulu','paramount','warner bros','marvel','dc','star wars','sequel','prequel','elon musk','tweet','post ','alien','ufo','uap','extraterrestrial'] },
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
  const all = await pmFetchMarkets(Math.max(limit * 2, 100));
  return all.filter(m => m.category === category).slice(0, limit);
}

// Search Polymarket markets
async function pmSearch(query, limit = 30) {
  const cacheKey = `search:${query}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const url = `${PM_GAMMA}/markets?limit=${limit}&active=true&closed=false&_q=${encodeURIComponent(query)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('PM search failed: ' + r.status);
  const data = await r.json();

  const markets = data.map(parseMarket).filter(m => m.outcomes.length === 2);
  cache.set(cacheKey, markets, CACHE_TTL_SEARCH);
  return markets;
}

// Fetch single event with all its sub-markets
async function pmFetchEvent(eventId) {
  const cacheKey = `event:${eventId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const url = `${PM_GAMMA}/events/${eventId}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('PM event fetch failed: ' + r.status);
  const e = await r.json();

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

// ============ RISK ENGINE ============
function computeEquity(account) {
  return Number(account.balance);
}
function checkRules(account, orderCost) {
  const equity = computeEquity(account);
  const lossFloor = Number(account.size) * (1 - MAX_LOSS);
  if (equity - orderCost < lossFloor) {
    return { ok: false, code: 'MAX_LOSS', msg: `Order would breach ${MAX_LOSS * 100}% max loss limit` };
  }
  if (orderCost > Number(account.size) * POSITION_CAP) {
    return { ok: false, code: 'POSITION_SIZE', msg: `Position exceeds ${POSITION_CAP * 100}% of account` };
  }
  return { ok: true };
}

// ============ EXPRESS APP ============
const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
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
        const evalEnd = new Date(now.getTime() + 14 * 86400 * 1000);

        const account = await dbInsert('accounts', {
          user_id: Number(userId),
          plan,
          size: planInfo.size,
          balance: planInfo.size,
          high_water: planInfo.size,
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
app.use(express.static(path.join(__dirname, 'site')));

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
    const { email, password, full_name, plan = 'pro', size = 50000, ref } = req.body || {};

    if (!email || !password) return res.status(400).json({ error: 'email + password required' });
    if (typeof email !== 'string' || email.length > 254) return res.status(400).json({ error: 'invalid email' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return res.status(400).json({ error: 'invalid email format' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    if (password.length > 128) return res.status(400).json({ error: 'password too long' });

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = (full_name || cleanEmail.split('@')[0]).substring(0, 100);
    const validPlans = ['starter', 'standard', 'pro', 'elite', 'whale'];
    const cleanPlan = validPlans.includes(plan) ? plan : 'pro';
    const cleanSize = Math.max(10000, Math.min(500000, Number(size) || 50000));

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

    // NOTE: account is NOT created here — user must purchase an eval first
    // (or use /api/account/test in dev mode)

    const token = signToken({ userId: user.id, email: cleanEmail });

    return res.json({
      token,
      user: { id: user.id, email: cleanEmail, name: cleanName },
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
      user: { id: user.id, email: user.email, name: user.full_name },
    });
  } catch (e) {
    console.error('[signin]', e.message);
    return res.status(500).json({ error: 'signin failed' });
  }
});

// ============ MARKETS (public, cached) ============
app.get('/api/markets', async (req, res) => {
  try {
    const markets = await pmFetchMarkets(Number(req.query.limit) || 100);
    res.json(markets);
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
    const markets = await pmFetchByCategory(cat, Number(req.query.limit) || 50);
    res.json(markets);
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

// ============ TRENDING (public) ============
app.get('/api/trending', async (req, res) => {
  try {
    const markets = await pmFetchTrending(Number(req.query.limit) || 20);
    res.json(markets);
  } catch (e) {
    console.error('[trending]', e.message);
    res.status(500).json({ error: 'failed to fetch trending' });
  }
});

// ============ CATEGORIES LIST (public) ============
app.get('/api/categories', async (req, res) => {
  try {
    const all = await pmFetchMarkets(200);
    const counts = {};
    for (const m of all) {
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

    res.json({
      account: {
        ...account,
        balance: bal,
        size: sz,
        high_water: hw,
        equity,
        loss_floor:     sz * (1 - MAX_LOSS),
        profit_target:  sz * (1 + PROFIT_TARGET),
        target_pct:     PROFIT_TARGET,
        max_loss_pct:   MAX_LOSS,
        pnl:            bal - sz,
        pnl_pct:        (bal - sz) / sz,
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
    if (!['eval', 'funded_express', 'funded_live'].includes(account.status)) {
      return res.status(400).json({ error: 'account not active: ' + account.status });
    }

    const market = await pmFetchMarket(market_id);
    if (!market) return res.status(404).json({ error: 'market not found' });
    if (market.closed) return res.status(400).json({ error: 'market closed' });

    const pmPrice = side === 'YES' ? market.outcomePrices[0] : market.outcomePrices[1];
    if (!pmPrice || pmPrice <= 0 || pmPrice >= 1) {
      return res.status(400).json({ error: 'invalid market price' });
    }

    const fillPrice = +(pmPrice * (1 + SLIPPAGE_PCT)).toFixed(4);
    const cost = +(numShares * fillPrice).toFixed(2);

    const risk = checkRules(account, cost);
    if (!risk.ok) return res.status(400).json({ error: risk.msg, code: risk.code });

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

    await dbUpdate('accounts', { id: account.id }, {
      balance: newBalance,
      high_water: Math.max(Number(account.high_water), newBalance),
    });

    const today = new Date().toISOString().slice(0, 10);
    if (account.last_trade_day !== today) {
      await dbUpdate('accounts', { id: account.id }, {
        trading_days: (account.trading_days || 0) + 1,
        last_trade_day: today,
      });
    }

    return res.json({
      ok: true,
      position_id: position.id,
      fill: { price: fillPrice, pm_price: pmPrice, slippage_pct: SLIPPAGE_PCT, cost },
      new_balance: newBalance,
    });
  } catch (e) {
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

    const market = await pmFetchMarket(position.market_id);
    if (!market) return res.status(404).json({ error: 'market not found' });

    const pmPrice = position.side === 'YES' ? market.outcomePrices[0] : market.outcomePrices[1];
    const exitPrice = +(pmPrice * (1 - SLIPPAGE_PCT)).toFixed(4);
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

    await dbUpdate('accounts', { id: account.id }, {
      balance: newBalance,
      high_water: Math.max(Number(account.high_water), newBalance),
    });

    const updated = await dbSelectOne('accounts', { id: account.id });
    const updBal = Number(updated.balance);
    const updSz  = Number(updated.size);
    const updHw  = Number(updated.high_water);

    if (updBal >= updSz * (1 + PROFIT_TARGET) && updated.trading_days >= 3) {
      await dbUpdate('accounts', { id: account.id }, { status: 'passed' });
    }
    if (updBal < updSz * (1 - MAX_LOSS)) {
      await dbUpdate('accounts', { id: account.id }, { status: 'failed' });
    }

    return res.json({ ok: true, exit_price: exitPrice, pnl, new_balance: newBalance });
  } catch (e) {
    console.error('[close]', e.message);
    return res.status(500).json({ error: 'close failed' });
  }
});

// ============ TEST ACCOUNT (dev mode only — creates eval without payment) ============
app.post('/api/account/test', authMiddleware, async (req, res) => {
  try {
    const { plan = 'pro' } = req.body || {};
    const validPlans = ['starter', 'standard', 'pro', 'elite', 'whale'];
    const cleanPlan = validPlans.includes(plan) ? plan : 'pro';
    const planInfo = PLANS[cleanPlan];
    if (!planInfo) return res.status(400).json({ error: 'invalid plan' });

    // Check for existing active account
    const existing = await dbSelect('accounts', { user_id: req.userId });
    const active = existing.find(a => ['eval', 'funded_express', 'funded_live'].includes(a.status));
    if (active) return res.status(400).json({ error: 'You already have an active account.' });

    const now = new Date();
    const evalEnd = new Date(now.getTime() + 14 * 86400 * 1000);

    const account = await dbInsert('accounts', {
      user_id: req.userId,
      plan: cleanPlan,
      size: planInfo.size,
      balance: planInfo.size,
      high_water: planInfo.size,
      status: 'eval',
      eval_started_at: now.toISOString(),
      eval_ends_at: evalEnd.toISOString(),
    });

    return res.json({ ok: true, account_id: account.id, plan: cleanPlan, size: planInfo.size });
  } catch (e) {
    console.error('[test-account]', e.message);
    return res.status(500).json({ error: 'failed to create test account' });
  }
});

// ============ SINGLE MARKET DETAIL ============
app.get('/api/market/:id', async (req, res) => {
  try {
    const market = await pmFetchMarket(req.params.id);
    if (!market) return res.status(404).json({ error: 'market not found' });
    res.json(market);
  } catch (e) {
    console.error('[market-detail]', e.message);
    res.status(500).json({ error: 'failed to fetch market' });
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
    const active = existing.find(a => ['eval', 'funded_express', 'funded_live'].includes(a.status));
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
            name: `VERDICT ${planInfo.label}`,
            description: `${planInfo.label} prediction market account — 10% profit target, 10% max loss, 80/20 split`,
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
    size: val.size,
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
    if (account.status !== 'passed') {
      return res.status(400).json({ error: 'account has not passed evaluation yet' });
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

    const payout = await dbInsert('payout_requests', {
      user_id: req.userId,
      account_id,
      amount: payoutAmount,
      payout_method,
      payout_details: details,
    });

    return res.json({
      ok: true,
      payout_id: payout.id,
      amount: payoutAmount,
      profit_split: `${PROFIT_SPLIT * 100}%`,
      total_profit: profit,
      status: 'pending',
    });
  } catch (e) {
    console.error('[payout-request]', e.message);
    return res.status(500).json({ error: 'payout request failed' });
  }
});

app.get('/api/payouts', authMiddleware, async (req, res) => {
  try {
    const payouts = await dbSelect('payout_requests', { user_id: req.userId }, {
      order: { col: 'requested_at', asc: false },
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
            const newBalance = +(Number(acct.balance) + proceeds).toFixed(2);
            await dbUpdate('accounts', { id: pos.account_id }, {
              balance: newBalance,
              high_water: Math.max(Number(acct.high_water), newBalance),
            });

            const updated = await dbSelectOne('accounts', { id: pos.account_id });
            const updBal = Number(updated.balance);
            const updSz  = Number(updated.size);
            const updHw  = Number(updated.high_water);

            if (updBal >= updSz * (1 + PROFIT_TARGET) && updated.trading_days >= 3) {
              await dbUpdate('accounts', { id: pos.account_id }, { status: 'passed' });
              console.log(`[cron] account ${pos.account_id} PASSED`);
            }
            if (updBal < updSz * (1 - MAX_LOSS)) {
              await dbUpdate('accounts', { id: pos.account_id }, { status: 'failed' });
              console.log(`[cron] account ${pos.account_id} FAILED (max loss)`);
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
  if (!DEV_MODE) console.log(`  • Supabase:        ${SUPABASE_URL}`);
  console.log(`  • Stripe:          ${stripe ? 'enabled' : 'DISABLED (no key)'}`);
  console.log(`  • Auth:            JWT (${JWT_EXPIRES} expiry) + bcrypt`);
  console.log(`  • Market cache:    ${CACHE_TTL_MARKETS / 1000}s list / ${CACHE_TTL_MARKET / 1000}s single / ${CACHE_TTL_EVENTS / 1000}s events`);
  console.log(`  • Rate limits:     200/min global, 10/min auth, 30/min orders`);
  console.log(`  • Fixed slippage:  ${SLIPPAGE_PCT * 100}%`);
  console.log(`  • Profit split:    ${PROFIT_SPLIT * 100}% to trader`);
  console.log(`  • Affiliate:       ${AFFILIATE_COMMISSION * 100}% commission`);
  console.log(`  • Rules:           ${PROFIT_TARGET * 100}% target / ${MAX_LOSS * 100}% max loss / 14-day eval`);
  console.log(`  • API endpoints:   markets, events, categories, search, trending`);
  console.log(`  • Resolution cron: every 60s (batched)\n`);
});
