# 11 — Trade Panel Conversion Fix (Two Bugs)

## Status: DONE

## Bugs
1. **Outcome state desync** — clicking Yes/No on market card opens trade panel with visual selection but internal state not set. Preview doesn't render until user double-clicks.
2. **Weak conversion prompt** — unauthenticated users see generic "Start an eval to trade" button instead of a high-converting CTA card with pricing, value prop, and clear action.

## How to run
```bash
claude code "Read .claude/PROMPTS/11-conversion-fix.md. Two bugs to fix in trade.html: (1) outcome state desync on card click, (2) weak conversion prompt for unauthenticated users. Both need to ship cleanly."
```
