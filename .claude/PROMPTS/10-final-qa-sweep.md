# 10 — Final QA Sweep (Multi-Agent)

## Status: SAVED (run manually when ready)

## How to run
```bash
claude code "Read .claude/PROMPTS/10-final-qa-sweep.md carefully. This is a full multi-agent QA sweep."
```

## Scope
5 parallel test agents covering:
1. Auth & signup flow
2. Purchase & eval creation
3. Trading flow (dollars-first, orderbook walk)
4. Rule engine stress test
5. Admin & admin ops

## Output
Generates VERDICT_QA_REPORT.md with pass/fail matrix, bugs found, and deploy readiness verdict.
