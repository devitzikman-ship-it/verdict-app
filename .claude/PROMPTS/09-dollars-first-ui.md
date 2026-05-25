# 09 — Dollars-First Trade Panel UX (COMPLETED)

## Status: DONE

## Summary
Converted the trade panel from shares-first (confusing) to dollars-first (intuitive).
User enters dollar amount they want to risk. UI shows payout, multiplier, and loss clearly.
Shares are computed invisibly in the backend.

## Key Changes

### Frontend (trade.html)
- Input label: "RISK AMOUNT (USD)" with $ prefix
- Quick buttons: $10, $25, $50, $100 (was 50, 100, 500, 1K shares)
- Default value: $50 (was 100 shares)
- Preview shows: "IF RIGHT, YOU WIN $X (Y.Xx)" / "IF WRONG, YOU LOSE $Z"
- Payout multiplier badge: green pill showing 2.5x, 1.6x etc
- Profit breakdown: "+$75 · Stake returned: $50"
- Fill price + position size shown as metadata at bottom
- Position cap warning if >20% of account
- CLOB preview updates after 250ms debounce
- Position list shows: "Risked $X · Yx" with unrealized PnL and "If wins: $Y"
- NO shares visible anywhere in the user-facing UI

### Backend (server.js)
- `/api/order` accepts `cost_usd` parameter (dollars to spend)
- Server computes: shares = cost_usd / fill_price
- Response includes: `shares_filled`, `payout_if_win`, `multiplier`
- Legacy `shares` parameter still works for backward compat
- Fill preview endpoint unchanged (frontend converts dollars→approx shares for preview)

### CSS
- `.tp-amount-wrap` + `.tp-dollar-sign` for $ prefix
- `.tp-payout-block`, `.tp-payout-amount`, `.tp-payout-multi` for win display
- `.tp-loss-block`, `.tp-loss-amount` for loss display
- `.tp-meta-line`, `.tp-cap-warning` for metadata

## The Math
```
User types: $50
Fill price: 40¢ (from CLOB orderbook walk)
Shares (hidden): $50 / $0.40 = 125 shares
Payout if wins: 125 × $1.00 = $125
Multiplier: $125 / $50 = 2.5x
Profit: $125 - $50 = $75
Loss if wrong: $50
```

## Files Modified
- `site/trade.html` — trade panel HTML, CSS, JS (updateTradePanel, placeOrder, renderPositions, fetchFillPreview)
- `server.js` — `/api/order` endpoint (cost_usd support, shares computation, response enrichment)
