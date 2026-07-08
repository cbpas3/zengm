---
name: game-plan-rebalance
description: Game plan sliders (Phases 1-5) are exploitable — rebalance plan lives in GAME_PLAN_REBALANCE_PLAN.md, awaiting implementation
metadata:
  type: project
---

As of 2026-07-08: playtesting showed the Harder-RPD game plan feature is badly exploitable (24 OVR team went 71-11 with all dials maxed; 64 OVR player at 27.8 PER). All Phases 1-5 are implemented (2-5 by the user, not Claude). Root causes: possession-economy sliders read zero player ratings, `doReb` factor-ratio squares the intended swing, costs are token vs benefits, and AI teams never have a gamePlan (only write site is the user API endpoint — which also makes Phase 5 in-series adjustments dead code for AI teams via the `gamePlan !== undefined` guard in loadTeams.ts).

**How to apply:** The full fix spec + test plan is `GAME_PLAN_REBALANCE_PLAN.md` at repo root (PR-1..PR-5 order; core mechanic = Execution Quality gating: benefits scale with team composites, costs don't). Implement from that doc; don't re-derive. Magnitude tests must assert bands, not just direction — direction-only tests are how the rebound bug shipped.
