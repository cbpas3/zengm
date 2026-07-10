---
name: rfa-plan
description: Restricted free agency plan (rookies leave too early) — spec in RESTRICTED_FREE_AGENCY_PLAN.md, awaiting implementation
metadata:
  type: project
---

As of 2026-07-08: user wants restricted free agency because players walk after rookie contracts expire. Full spec is `RESTRICTED_FREE_AGENCY_PLAN.md` at repo root, awaiting implementation (Sonnet implements from plan docs in this project). Key facts discovered: upstream already has `rookiesCanRefuse` (Settings → Rookie Contracts, default true — setting it false is the zero-code Tier 0 mitigation), plus `contract.rookie`/`contract.rookieResign` flags and a +8 mood component. The v1 design is match-rights with a pre-authorized per-player match ceiling (`p.rfaTid`/`p.rfaMatchLimit`), NOT interactive mid-sim offer-sheet modals (deferred — needs pause/resume machinery in freeAgents/play.ts).

**How to apply:** implement from the plan doc; don't re-derive. Poaching hook points are `freeAgents/autoSign.ts` (AI, ignores mood entirely) and `contractNegotiation/accept.ts` (user, returns string errors — the AI-match rejection rides that channel). Related: [[game-plan-rebalance]] for the band-not-direction testing lesson.
