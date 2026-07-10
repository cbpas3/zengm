---
name: game-plan-rebalance
description: Game plan rebalance is fully implemented (PR-1..PR-5); plan doc and CLAUDE.md Feature 9 are the references
metadata:
  type: project
---

As of 2026-07-08 the game-plan rebalance is **fully implemented** (all 5 PRs — user confirmed). `GAME_PLAN_REBALANCE_PLAN.md` (repo root) has a status header listing as-built deviations (EQ_PIVOT=0.62 not 0.5, F-A shipped in PR-1, looser measured test bands); CLAUDE.md "Feature 9" is the as-built summary. T-D2 (full-league tuning script) was never built — it's the known follow-up for tightening magnitude bands.

**Why:** future tuning work should start from the measured numbers in `gamePlan.test.ts` inline comments, not the plan doc's original targets.

**How to apply:** treat CLAUDE.md Feature 9 + `gamePlanTuning.ts` as ground truth over the plan doc. Lesson that carries to all sim features (see [[rfa-plan]]): magnitude tests must assert bands, not direction — direction-only tests are how the original rebound exploit shipped.
