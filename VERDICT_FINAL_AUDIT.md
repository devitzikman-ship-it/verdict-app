# VERDICT Final Audit — Pre-Launch Review

Date: 2026-05-25
Repository state: GitHub main, commit fdabcad

## Executive Summary

**Launch readiness: NEEDS WORK — 3 critical server bugs, then ship**

The trading UI is solid. The funnel works. The copy is decent. But server.js has 3 race conditions / data integrity bugs that can cause real financial damage in production. Fix those, and you're launch-ready.

### Top 5 Wins
1. Trading UI is genuinely impressive — live Polymarket data, CLOB orderbook, chart, detail view all work cleanly
2. Anchor pricing ($199 strikethrough → $138) with discount pills is well-executed
3. 80/20 profit split prominently displayed — strongest selling point, correctly surfaced everywhere
4. Filter/navigation state machine works across all 8 paths (just fixed)
5. Conversion CTA appears at moment of highest intent (user clicks Yes/No on a market)

### Top 5 Blockers (must fix before launch)
1. **Race condition: double-close position** — two concurrent close requests can both credit proceeds, doubling payout (server.js:2715)
2. **Race condition: settlement cron vs close** — cron and user close can both credit balance simultaneously (server.js:3666)
3. **Payout deduplication broken** — missing `status: 'pending'` on insert means duplicate payout requests are never caught (server.js:3330)
4. **XSS in admin command.html** — user input injected via innerHTML without escaping (command.html:665)
5. **Hidden $49 activation fee** — not shown on pricing cards, appears as surprise at Stripe checkout

### Top 5 Quick Wins (< 30 min each)
1. Add `status: 'pending'` to payout insert — 1 line fix
2. Use `esc(q)` for admin chat innerHTML — 1 line fix
3. Add `if (newBalance < 0)` guard before balance deduction — 3 line fix
4. Make "24h refund" guarantee text larger/bolder on plan cards — CSS change
5. Add `acquireOrderLock` to close endpoint — copy pattern from order endpoint

---

## Engineering Report

### Critical (must fix before launch)

**1. Race condition: Close position has no order lock — allows double-close and balance inflation**
- File: server.js:2715-2805
- Why critical: `/api/position/:id/close` lacks `acquireOrderLock(account.id)`. Two concurrent close requests can both pass the `position.status !== 'open'` check before either updates status, both adding proceeds to balance. Doubles payout.
- Fix: Add `acquireOrderLock(account.id)` after ownership check at line 2726, re-read position status before executing sell. Add `releaseOrderLock` in all exit paths, matching the pattern used in `/api/order`.

**2. Race condition: Settlement cron vs close endpoint — double credit**
- File: server.js:3666-3714 and 2715-2805
- Why critical: Cron re-reads position at line 3669, but between check and `dbUpdate` at 3678, a user's close can complete and credit proceeds. Then cron also credits. TOCTOU window.
- Fix: Have `dbUpdate` on positions include a filter for `status: 'open'` and return null if no row matched (skip if null). Or wrap cron settlement in `orderLocks`.

**3. Payout request missing `status` field — duplicate protection silently broken**
- File: server.js:3330-3336
- Why critical: Insert at 3330 doesn't include `status: 'pending'`. Dedup check at 3292 queries `{ account_id, status: 'pending' }`. Since inserted row has no status field, filter never matches — unlimited duplicate payouts.
- Fix: Add `status: 'pending'` to the insert object at line 3335.

**4. XSS in command.html agent chat**
- File: site/command.html:665
- Why critical: `thinking.innerHTML = '<b>You asked:</b> ' + q` where `q` is raw user input. Admin could be socially engineered into pasting malicious string.
- Fix: Use `esc(q)` (page already has an `esc()` function at line 176).

### High (fix within 7 days post-launch)

**5. Unbounded memory: `headshotCache` never evicted**
- File: server.js:1373
- `headshotCache = new Map()` grows indefinitely. No TTL, no max size.
- Fix: Use existing `cache` system with TTL, or add max-size LRU eviction.

**6. No balance sufficiency check before order deduction**
- File: server.js:2638
- `newBalance = +(Number(account.balance) - cost).toFixed(2)` — never checks if result is negative. Edge cases with funded accounts that have lost significantly could go negative.
- Fix: Add `if (newBalance < 0) return res.status(400).json({ error: 'insufficient balance' });` after computing newBalance.

**7. `refreshMarketIndex` fires 23+ concurrent HTTP requests with no cleanup**
- File: server.js:295-476
- 15-second interval, ~23 simultaneous fetches. Never cleared on shutdown. Prevents graceful process exit.
- Fix: Store interval reference, add `process.on('SIGTERM')` handler to clear it.

**8. Admin metrics loads ALL rows into memory**
- File: server.js:3373-3440
- `dbSelect('users', {})`, `dbSelect('accounts', {})`, etc. — entire database loaded per request.
- Fix: Add count/aggregate queries for production Supabase mode.

**9. `tokenStore` never bounded — DoS via forgot-password spam**
- File: server.js:144-149
- Password reset creates unbounded tokens. Botnet can fill server memory.
- Fix: Limit to 3 active tokens per userId.

### Medium (technical debt)

**10. 207KB monolithic HTML file** — site/trade.html has all CSS, JS, HTML inline. Prevents browser caching, blocks first contentful paint.

**11. `refreshMarketIndex` is 180 lines** (server.js:295-476) — mixing fetch, parse, dedup, CLOB enrichment, indexing. Impossible to unit test.

**12. `computeEquity` makes N API calls for N positions** (server.js:1434-1463) — serial `pmFetchMarket` calls per position. Use `marketIndex.byId` exclusively.

**13. Frontend intervals never cleared on page unload** (trade.html:2532)

### Test Coverage Gaps

- No test for concurrent close of same position (the race condition)
- No test for settlement cron vs user close simultaneously
- No test for payout deduplication (the broken path)
- No test for MTM cron drawdown enforcement
- No test for inactivity auto-fail (14-day idle)
- No test for admin force-pass, force-fail, pause, unpause, refund
- No test for Stripe webhook amount mismatch
- No test for orderbook walk with insufficient depth
- `test-rules.js` duplicates `evaluateRules` logic instead of importing it — drift risk

---

## Conversion Psychology Report

### Funnel Friction Map

```
index.html (5s splash) → trade.html     → 12-15% bounce (splash delay)
trade.html landing     → Browse markets  → 5-10% leave (density)
Browse                 → Click market    → 3-5% leave
Detail view            → Click Yes/No    → 8-12% leave (paywall)
Conversion card        → Signup gate     → 40-55% LEAVE (biggest drop)
Plans modal (5 tiers)  → Choice          → 15-20% leave (Hick's Law)
Plan selected          → Stripe checkout → 10-15% abandon (fee surprise)
Post-purchase          → First trade     → 5-10% bounce (no onboarding)

Estimated total funnel: 3-6% of visitors convert to paid.
```

### Critical Drop-Off Points (> 10% loss each)

**1. 5-Second Splash Page Blocks All Value Discovery**
- Location: `site/index.html` — full-page `#verdict-splash` with 5s `setTimeout`
- Why: Zero information scent. User sees only "VERDICT" for 5 seconds. No value prop, no skip button. Violates the 3-second rule and reciprocity principle.
- Fix: Remove splash entirely, make trade.html the landing. Or reduce to 2s with skip button + 1-line value prop.
- Expected lift: 12-18% more visitors reaching the product.

**2. Conversion Card = Paywall Before Any Engagement**
- Location: `renderCtaState('conversion')` — `.tp-conversion-card` element
- Why: User clicks Yes/No (showing intent) and hits a paywall. No demo, no paper trades. Polymarket is free — "why pay $138?" The endowment effect is never activated.
- Fix: Add paper trading for unauthenticated users. Separate free signup from paid eval start. Show paper PnL, then upsell.
- Expected lift: 25-40% improvement in signup-to-paid conversion.

**3. Refund Policy Contradiction**
- Location: signup.html line 106 says "fees are non-refundable" vs trade.html plan cards say "24h refund if no trades placed"
- Why: Trust catastrophe. Loss aversion makes users hypervigilant about refund policies at checkout.
- Fix: Make signup checkbox consistent with the actual policy (eval fee refundable within 24h, activation fee non-refundable).
- Expected lift: 8-12% recovery at signup step.

**4. Hidden $49 Activation Fee at Stripe Checkout**
- Location: server.js:3067 — `totalCents = planInfo.price + planInfo.activation` but activation never shown on plan cards
- Why: Price surprise at checkout is #1 cart abandonment cause. User committed to "$138" and sees "$187" on Stripe. Anchoring violated.
- Fix: Bundle activation into displayed price ($187 for Starter) or show total on card.
- Expected lift: 10-15% reduction in checkout abandonment.

### High-Impact Improvements

**5. Five Pricing Tiers = Choice Paralysis (Hick's Law)**
- All 5 plans have identical feature sets — only account size differs. Decision is effortful.
- Fix: Default to showing 3 tiers (Starter, Pro, Whale) with "See all plans" expander.
- Expected lift: 8-12% faster plan selection, more Pro conversions.

**6. "How It Works" Doesn't Explain the Prop Firm Model**
- 3 steps explain prediction markets but never answer "why pay you when Polymarket is free?"
- Fix: Add "We give you $5K-$100K to trade with. You keep 80% of profits." as Step 1.

**7. Competing CTAs for Unauthenticated Users**
- Nav "Sign Up" (implies free), eval bar "$138" (implies paid), conversion card "Sign Up — Start Your Eval" — conflicting messages.
- Fix: Nav button = "Get Funded". Eval bar = benefit-focused. Remove price from top-of-page.

### Trust Signal Gaps

- Live activity feed is explicitly simulated with fake handles — discoverable by attentive users
- "Doxxed Team" badge links nowhere — unverifiable trust signal is worse than none
- No testimonials (correct for pre-launch, but plan for real ones)
- "24h refund" in 10px gray text — #1 risk reducer buried in faint copy
- No FAQ addressing "Is this legal?", "How do payouts work?", "Can I retry?"

### Mobile Issues

- Sidebar hidden on mobile, pick-tabs overflow with no scroll indicator
- 5 plan cards in 2-column grid requires scrolling inside modal
- Touch targets on Yes/No buttons (28px) below 44px minimum
- No persistent balance indicator on mobile (hidden via CSS)

---

## Marketing & Persuasion Report

### Headline Rewrites

**Landing page (index.html):** No headline at all — just "VERDICT" and a video.
- Proposed: Add subheadline: "Get funded up to $100K to trade prediction markets. Keep 80% of profits."
- Reason: Cognitive fluency — visitors must understand what you are within 3 seconds.

**Conversion card:** "Sign up to place this trade"
- Proposed: "This trade could pay 2.4x. Sign up to place it with our capital."
- Reason: Intent-matching — mirror the user's desire (profit), not administrative step (signup).

**Plans modal:** "Choose Your Account Size"
- Proposed: "How much do you want to trade with?"
- Reason: Endowment effect — makes user mentally take ownership before paying.

### CTA Optimization

| Current | Location | Proposed | Rationale |
|---------|----------|----------|-----------|
| "Start your eval . $138" | Eval banner | "Start My Eval — $138" | First-person framing |
| "Start Eval — $XXX" | Plan card buttons | "Get My $25K Account — $348" | Outcome framing |
| "Sign Up — Start Your Eval" | Conversion card | "Get Funded — Start Trading Now" | Benefit-first |
| "Create account" | Signup page | "Create My Account" | Ownership language |
| "Sign Up" | Nav button | "Get Funded" | Value-first |
| "Get started" | How It Works | "Start Trading — Get Funded" | Specificity |

### Missing Persuasion Levers

1. **No free value upfront (Reciprocity)** — add "How to Pass the Eval" guide or paper trading mode
2. **No loss-aversion framing** — copy is all gain-framed. Add: "Every day without a funded account is a day your edge goes to waste."
3. **No competitor anchoring** — "80/20 split" means nothing without showing competitors do 70/30 or 60/40
4. **No "how to pass" content** — users can't visualize success, so they don't buy
5. **Eval cost:account size ratio not surfaced** — "$348 gets you a $25,000 account (72x your eval fee)" is the strongest anchor and it's invisible

### Anchor Pricing Assessment

The $199→$138 strikethrough works mechanically but feels ungrounded — no explanation of why it was $199 or when it goes back. Fix: "Regular price after launch: $599" makes the anchor temporal and credible.

The BIGGER missed anchor: the cost-to-account-size ratio. $348 for $25K is a 72:1 ratio. Surface it explicitly on plan cards.

The hidden $49 activation fee is an anti-anchor — it destroys trust at the moment of highest commitment.

### Scarcity/Urgency Assessment

"LAUNCH PRICING — First 500 traders" is moderately credible for a new product but has no progress indicator (how many left?) and no deadline. Without these, it reads as permanent marketing theater.

Best urgency for this product: "Markets are live now. Every day you wait, you're missing trades." — genuine because prediction markets are time-sensitive.

---

## Recommended Sprint (next 48 hours)

### Must-fix before launch (4-6 hours)
1. **Add `acquireOrderLock` to close endpoint** — prevent double-close race condition
2. **Add `status: 'pending'` to payout insert** — 1 line, fixes duplicate payout bug
3. **Add settlement cron lock or atomic status check** — prevent cron/close double-credit
4. **Use `esc(q)` in command.html** — 1 line XSS fix
5. **Add negative balance guard** — 3 lines in order endpoint
6. **Fix refund policy contradiction** — update signup.html checkbox text

### High-impact quick wins (2-3 hours)
7. **Bundle activation fee into displayed price** — or show total on plan cards
8. **Make "24h refund" guarantee prominent** — bigger text, styled badge
9. **Fix logo to SPA-navigate instead of page redirect** — DONE (this session)
10. **Fix nav state for all 8 paths** — DONE (this session)

### Post-launch v1.1
11. Add paper trading / demo mode for unauthenticated users
12. Remove splash page or add skip + value prop
13. Reduce plans from 5 to 3 visible tiers
14. Rewrite "How It Works" to explain prop firm model
15. Add eval cost:account size ratio to plan cards
16. Split trade.html into separate CSS/JS files
17. Add count/aggregate queries for admin metrics
18. Add SIGTERM handler for graceful shutdown
19. Bound `headshotCache` and `tokenStore`
20. Refactor to state-first architecture (single `appState` + `render()`)

## What to Ignore for v1

- Frontend interval cleanup on unload (SPA, doesn't matter)
- `classifyMarket` keyword optimization (works, just messy)
- `generateDemoPlayerProps` seeding (cosmetic)
- Generic error messages (add correlation IDs later)
- Browser history / popstate support (nice-to-have)
- `verifyPage` msg escaping (all callers use hardcoded strings currently)
