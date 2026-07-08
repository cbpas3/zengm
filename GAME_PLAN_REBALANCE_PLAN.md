# Game Plan Rebalance — Investigation & Fix Plan

Status: **implemented, PR-1 through PR-5, 2026-07-08.** See CLAUDE.md's "Feature 9: Game Plan
Rebalance" for the as-built summary, key files, and test suite. A few deviations from this doc
worth knowing before reading it as ground truth:

- **F-A ships in PR-1, not PR-2** as originally ordered here — F-B's rebound formula and Suite B's
  T-B0 both depend on `eq()` existing, so the helper had to land with the first PR that uses it.
  PR-2 became "extend `eq()`-gating to `pickCoverage`/`helpAggression` (F-E) + scheme-fit K."
- **`EQ_PIVOT` is 0.62, not the implied 0.5** — measured against a realistically-generated league
  (see `gamePlanTuning.ts`'s comment), since a raw `player.generate()` or a "every rating = 50"
  synthetic roster both produce unrealistic game stats despite hitting composite 0.5 on paper.
- **F-B's perimeter-pressure rebound term is subtracted, not added** — this doc's pseudocode has a
  "+", but its own comment ("pressing D is out of position") and the pre-existing code's sub-1
  penalty factor both make clear it should reduce, not raise, the defense's rebound probability.
- Several magnitude targets (T-B2's ≤+3 pts/game, T-C2's elite ≥2x awful, T-C3's ≥3pp/< 1pp) landed
  looser than specified once measured against real rosters — tightening them is exactly what the
  deferred T-D2 full-league script is for. See each test's inline comment in `gamePlan.test.ts` for
  the measured numbers and reasoning.
- T-D2 itself was not built (out of scope for a fast unit-test suite; needs a full-league season
  sim). F-J's UI chips and the rest of section 4 shipped as specified.

Implementer notes below are inline; every fix has WHERE (file), WHAT (formula), TARGET (band), and TEST (id in §6).

## 0. The bug report

A 24 OVR team with every dial cranked goes **71-11**. Cade Cunningham (64 OVR) averages
**34/7/8 on 27.8 PER**; Bogdanović (55 OVR) averages 25/5/2. Verdict from play: correct.
The sliders are power dials, not coaching decisions — talent isn't required to execute them.

---

## 1. The exploit, quantified

Measured with the Phase 1 statistical harness (60-game samples, one dial at a time, opponent
neutral — which is exactly the live situation, see Finding F2):

| Dial at 100 (vs neutral AI)       | Measured effect                                                                       | Approx. value             |
| --------------------------------- | ------------------------------------------------------------------------------------- | ------------------------- |
| `crashOffensiveGlass`             | Own ORB/game 0 → 29 across the dial (~+17pp ORB% vs neutral)                          | +7–8 extra possessions    |
| `defensiveGlass`                  | Opp ORB/game 31 → 1 across the dial                                                   | −8–10 opp possessions     |
| `perimeterPressure`               | Opp TOV 15.5 → 22.9 across the dial                                                   | +6–7 opp giveaways        |
| `transition`                      | Fast-break rate 0.11 → 0.33 of eligible possessions, rim-biased (probMake floor 0.54) | free shot-quality upgrade |
| `helpAggression` + `pickCoverage` | −12% opp rim eff, −10% opp interior eff, ISO-blunting                                 | mostly-free defense buff  |

Sum: roughly **+15–20 net possessions/game plus efficiency edges ≈ +20 pts/game swing**, gated by
nothing. A 24 OVR roster is maybe −10 pts/game on talent. Net: they're a juggernaut. The stat lines
follow: `ballMovement=0` → `usagePower 2.5` concentrates the inflated volume on the best player,
probMake floors (3P 0.36, rim 0.54, mid 0.42, post 0.34, before defense adjustment) keep him
efficient at any volume → 27.8 PER from a 64 OVR player.

Note the effects also **self-compound through possession count**: more forced TOVs / more ORBs →
shorter possessions → more possessions per game → more rolls of the same loaded dice. Measured TOV
swing (×1.48) exceeds the sticker multiplier (×1.35 across the dial) for this reason. Any fix must
be tested at the _game outcome_ level, not the per-roll level.

## 2. Root-cause findings

- **F1 — Possession-economy dials read zero player ratings.** Six sliders (`transition`,
  `crashOffensiveGlass`, `pickCoverage`, `perimeterPressure`, `helpAggression`, `defensiveGlass`)
  modify rebounds/turnovers/fast breaks with no reference to any composite rating. The only
  talent gate in the whole system is Phase 3 scheme fit (`schemeFit.ts`, K=0.3 → ±7.5%), and it
  applies only to shot _efficiency_ for the three shot-mix sliders — not to any possession dial.
  Possessions are the most valuable currency in the sim; they are currently free.
- **F2 — Only the user plays the game.** The single write site for `gamePlan` is the user's
  `updateGamePlan` endpoint (`src/worker/api/index.ts`). Every AI team has
  `gamePlan === undefined` → all defensive reads default to 50 forever. The user's dials are
  exploited against opponents who never dial back and never make the user pay costs.
  **Corollary:** Phase 5 in-series adjustments are dead code for AI teams — the guard in
  `loadTeams.ts` (`gamePlan !== undefined && …`) can never pass for a team that has no stored plan.
- **F3 — Rebound math squares the intended swing.** `doReb` divides one 0.7–1.3 factor by another
  (`(defensiveGlassFactor × pressurePenalty) / crashFactor`), producing up to ×1.86/×0.54 on a
  ~0.75 base drb probability → ORB% swings of ~25pp, versus the design intent of ±10–15% on
  anything. This is Phase 1's biggest single defect (the original effects test showed 0↔29
  ORB/game and only asserted _direction_, not magnitude — §6 fixes that class of miss).
- **F4 — Costs are token, benefits are structural.** Benefit:cost ratios at slider 100:
  pressure ≈ 8:1 (7 forced TOV vs ~1 extra foul + 8% rebound penalty), `defensiveGlass` ≈ ∞:1
  (no cost at all), crash ≈ 7:1 (its "transition defense" cost is a ×1.2 on a small base ≈ 1
  pt/game). `helpAggression` is the only dial with a real two-sided price, and it still nets
  positive for most shot mixes.
- **F5 — No usage-efficiency tradeoff.** Real basketball has a skill curve: forcing a role player
  to star usage collapses his efficiency. The sim has none — `usagePower` reshuffles volume with
  zero efficiency consequence, so ISO+pace+stolen possessions mint fake MVPs.
- **F6 — Dead zones and inconsistent sidedness.** `helpAggression` and the pressure costs use
  `Math.max(0, x−50)` (below-50 half of the dial does nothing), while `pickCoverage`'s usage
  dampening and `probTov` are two-sided. Dials should be style choices with two priced ends, not
  one-way ratchets with a dead half.
- **F7 — (Minor) `threePointRate` replaces the era factor** with a 0.2→2.5 lerp (a 12.5× range)
  instead of modulating it — breaks era realism and is far too wide.
- Phases 2 (depth tax) and 4 (chemistry, ±5%) are **not** the problem — their magnitudes are
  reasonable garnish. No changes there beyond tests confirming they still behave.

## 3. Design principles for the fix

1. **Strategy reallocates; talent sets the mean.** A game plan moves a team along a tradeoff
   frontier whose height is set by the roster. It must never raise the frontier itself. Expected
   net value of any dial position ≈ 0 for league-average personnel.
2. **Benefits are gated by execution quality; costs are not.** Aggression is free to _call_ and
   expensive to _execute badly_. This single asymmetry is what makes "the talent isn't there, so
   execution isn't good" true, and makes maxed dials on a bad roster **negative** EV.
3. **Impact budget.** A perfectly-fit plan on an elite-execution roster is worth at most
   **≈ +3 pts/100 possessions** (elite real-world coaching ≈ +4–6 wins/season). A mismatched
   maxed plan on a bad roster: **−2 to −4 pts/100**.
4. **Everyone plays the same game.** AI teams get personnel-appropriate plans.
5. **Every dial has two priced ends, neutral exactly at 50,** and no-ops when `gamePlan` is
   `undefined` or a field is missing (`?? 50` stays everywhere — backward compat is untouched).

## 4. Fix specification

### F-A. Execution Quality (EQ) helper — the core new mechanic

One helper (suggested home: `src/worker/core/GameSim.basketball/` or `team/`), used by every
possession dial:

```
intent(slider)   = (slider − 50) / 50                     // ∈ [−1, +1]
eq(composite)    = bound(0.5 + 1.7 × (composite − 0.5), 0.25, 1.0)
```

`composite` is the relevant **team** composite (already maintained in
`updateTeamCompositeRatings`: `rebounding`, `defense`, `defensePerimeter`, `dribbling`,
`passing`; league-average ≈ 0.5). Elite unit → eq ≈ 1.0, average ≈ 0.5, awful ≈ 0.25.
**Benefit terms multiply by eq; cost terms never do.** Calibrate the 1.7 slope against the
observed composite distribution (assert in T-B0 that league-average eq lands in 0.45–0.55).

### F-B. Rebound contest rewrite (`doReb`) — kills the biggest exploit

Replace the factor-ratio with a bounded **additive** shift on drb probability:

```
delta = 0.05 × intent(defensiveGlass) × eq(dReb)      // defense claws back, if they can rebound
      − 0.05 × intent(crashOffensiveGlass) × eq(oReb) // offense steals boards, if they can rebound
      + 0.02 × max(0, intent(perimeterPressure))       // cost: pressing D is out of position — ungated
drbProb = base × … existing math with NO gamePlan factors … + bound(delta, −0.06, +0.06)
```

TARGET: net-of-both-teams ORB% swing ≤ ±6pp with elite rebounding, ≤ ±2–3pp with bad. League
ORB% stays in [18%, 32%] under any dial combination. TESTS: T-B2, T-C2.

Keep the existing "opponent crashed and missed → bonus fast-break chance" coupling, resized to the
new transition base (F-D).

### F-C. Turnover pressure (`probTov`) — resize and price it

- Multiplier `1 + 0.08 × intent(perimeterPressure) × eq(defensePerimeter)` (was ±15% ungated).
- Costs at full pressure, **ungated**: non-shooting foul factor `1 + 0.15 × max(0, intent)`
  (already exists — keep), plus a new blow-by term: opponent atRim _frequency_ multiplier
  `1 + 0.08 × max(0, intent)` in `getShotInfo` (pressure beaten off the dribble = rim attacks).
- TARGET: elite-perimeter-D team at 100 forces +2.5–3 TOV/game; a bad one forces ≤ +1 and
  concedes ≥ as much in fouls/rim attempts. TESTS: T-B2, T-C2.

### F-D. Transition (`getPossessionOutcome` fast-break block)

- `probFastBreak = 0.22 × (1 + 0.35 × intent(transition) × eqTransition)` → range ≈ 0.14–0.30 and
  only for teams built to run. `eqTransition` = eq of the average `pace`-relevant composite of
  on-court players (the team `pace` composite computed in `processTeam` is the cheap proxy; note
  it's scaled 100–115 there — normalize, or average the on-court players' `compositeRating.pace`).
- Costs, ungated: on a fast break, extra live-ball TOV roll
  `probTovFastBreak = 0.04 + 0.05 × (1 − eq(ballHandling))` where ballHandling =
  (dribbling+passing)/2; and the shooter's energy drain ×1.5 for that possession (running costs
  legs; bad benches can't sustain it).
- Keep the ×1.4 rim-selection bias and the shortened advance clock — those are the _style_, and
  they're fine once generation is gated and priced.
- TESTS: T-B1, T-B2, T-C2.

### F-E. Interior/perimeter defense dials — two-sided, gated, priced

`pickCoverage` (0 = drop, 100 = switch/blitz) — all reads in `getShotInfo` + usagePower:

- Above 50 (benefit × eq(`defensePerimeter`)): opp interior probMake ×(1 − 0.08×intent×eq),
  usagePower dampening (keep current −0.4×intent shape, now ×eq). Cost ungated: opp 3PT
  frequency ×(1 + 0.08×intent).
- Below 50 (drop coverage; benefit × eq(`blocking`)): opp atRim probMake ×(1 − 0.06×|intent|×eq),
  own drb delta +0.01×|intent| (bigs stay home). Cost ungated: opp midRange frequency/efficiency
  ×(1 + 0.06×|intent|) (the shot drop concedes).

`helpAggression` (0 = stay home, 100 = collapse) — currently one-sided; make symmetric:

- Above 50 (benefit × eq(`defense`)): opp rim probMake ×(1 − 0.10×intent×eq). Cost ungated:
  opp 3PT frequency ×(1 + 0.10×intent) and 3PT probMake ×(1 + 0.06×intent).
- Below 50: opp 3PT probMake ×(1 − 0.05×|intent|×eq(defensePerimeter)); cost: opp rim frequency
  ×(1 + 0.08×|intent|).

TESTS: T-B1 (each end bounded), T-C4.

### F-F. Usage-efficiency curve (the Cade fix) — `getShotInfo`

When the offense runs ISO (`ballMovement < 50`), the chosen shooter pays for volume beyond his
talent:

```
isoIntent = max(0, −intent(ballMovement))
overload  = max(0, usageThreshold − usageTalent(p))   // usageTalent from p's usage composite —
                                                      // NOTE: processTeam raises it to **1.9; calibrate
                                                      // the threshold against the post-power distribution
probMake −= 0.12 × isoIntent × overload               // elite stars ≈ 0 penalty; a 64 OVR pays ~0.04–0.08
```

Plus fatigue: the shooter's energy drain ×(1 + 0.3×isoIntent) on his own attempts. Calibrate
`usageThreshold` so a true #1 option (top-decile usage composite) pays ≈ nothing.
TARGET: 64 OVR forced to 30%+ usage loses ≥ 3pp TS% vs neutral; sustains ≤ ~24 PER over a season.
TESTS: T-C3.

### F-G. Shot-mix sliders — modulate the era factor, don't replace it

`threePointRate` currently _replaces_ `g.get("threePointTendencyFactor")` with a 0.2→2.5 lerp.
Change to `eraFactor × (0.6 + 0.8 × slider/100)` (0 → ×0.6, 50 → era-neutral, 100 → ×1.4).
Narrow `rimAttack`/`postPlay` selection multipliers from (0.5–2.0 / 0.3–2.5) to **0.6–1.5** each.
Raise scheme-fit `K` from 0.3 to **0.5** (±12.5% efficiency swing) so forcing a shot profile your
roster can't shoot has real teeth — scheme fit remains the efficiency judge for these three dials
(it's already two-sided and talent-based; it just needs to matter more).
TESTS: T-B1, T-C4.

### F-H. AI game plans (`genAiGamePlan`) — symmetry, and it revives Phase 5

New pure function (suggested: `src/worker/core/team/genAiGamePlan.ts`): map roster percentiles to
sliders — `threePointRate` from team 3P-shooting composite percentile (mapped to ~25–75),
`perimeterPressure` from `defensePerimeter` percentile, crash/defensive glass from `rebounding`,
`transition` from pace composite, `ballMovement` inverse to top-player usage dominance, etc.
Contending teams lean ~1.25× harder into strengths than rebuilding teams. Deterministic from
composites — call it in `processTeam` when `teamInput.gamePlan === undefined` for an AI team; no
storage or migration.

Then fix the Phase 5 guard in `loadTeams.ts`: drop `gamePlan !== undefined` (every AI team now has
a plan to adjust). Gate behind a new `aiGamePlans` game attribute following the existing settings
checklist (types.ts, defaultGameAttributes, Settings UI, views/settings — grep `rpdPot`).
TESTS: T-D1, T-D2, T-D3.

### F-I. Safety rails

- Route every gamePlan-derived multiplier on any single probability through a shared
  `clampScheme(x) = bound(x, 0.88, 1.12)`; additive possession deltas get explicit absolute
  clamps at point of use (F-B's ±0.06 pattern).
- Extract **all** tuning constants into one `GAME_PLAN_TUNING` object (e.g.
  `src/worker/core/GameSim.basketball/gamePlanTuning.ts`) so retuning is a one-file edit and the
  test suite can import the same numbers instead of hardcoding them.

### F-J. UI honesty (small but important for feel)

A dial that silently executes at 25% feels broken. In `GamePlanEditor.tsx`, show a small
execution-quality chip per group (e.g. "Pressure execution: Poor / Average / Elite") derived from
the same composites via the roster view. One-line data plumb through `views/roster.ts`.

## 5. Tuning targets (league-realism bands)

| Metric                                       | Band (any dial combination, average vs average) |
| -------------------------------------------- | ----------------------------------------------- |
| Team ORB%                                    | 18–32%                                          |
| Team TOV/game                                | 10–18                                           |
| Single-dial point-differential swing         | ≤ 2.5 pts/game                                  |
| All-dials-maxed net swing, avg roster        | ≤ +3 pts/game (fit) / negative (mismatched)     |
| Bottom-tier (≤30 OVR) team, optimal plan     | ≤ ~32 wins pace (win% ≤ 0.40 vs avg opposition) |
| PER for < 70 OVR player, any plan            | ≤ ~24 sustained                                 |
| Corr(team OVR, wins), full league + AI plans | Spearman ≥ 0.65                                 |

## 6. Test plan

Resurrect the Phase 1 throwaway harness as a **permanent** file
(`src/worker/core/GameSim.basketball/gamePlan.test.ts`), using the `GameSim.football/index.test.ts`
pattern (`resetG`/`resetCache`/`loadTeams`). Every magnitude test asserts **bands, not just
direction** — direction-only assertions are how F3 shipped. N=150–200 games per comparison keeps
sampling noise ~±1.5 pts on means; import thresholds from `GAME_PLAN_TUNING`.

**Suite A — Neutrality/calibration (regression safety)**

- T-A1: `gamePlan undefined` vs all-50 vs missing-new-keys legacy object → paired league stats
  (PPG, ORB%, TOV, 3PAr, FG%) within 2%.
- T-A2: all-50 league averages inside historical bands (PPG 100–125, ORB% 20–28%, TOV 11–16).

**Suite B — Bounded effect sizes (average vs average)**

- T-B0: eq() calibration — league-average composites yield eq ∈ [0.45, 0.55].
- T-B1: each dial alone at 0 and at 100: |Δ point differential| ≤ 2.5; ORB% ∈ [15, 34]; ΔTOV ≤ +3;
  fast-break possession Δ ≤ +6. Both ends of every dial produce a measurable effect (no dead
  zones) with opposite-signed costs.
- T-B2: ALL dials at 100 vs all-50: net Δ ≤ +3 pts/game.

**Suite C — Talent gating (the user's complaint, directly)**

- T-C1 **"the Cade test"**: bottom-tier generated roster (worst-percentile players), best-case
  dials, vs league-average neutral opponent, N=200: win% ≤ 0.40; and win% with _mismatched_ maxed
  dials < win% at all-50 (bad coaching choices must be able to hurt).
- T-C2: identical maxed-pressure (and maxed-glass, and maxed-transition) plans on an elite vs
  awful execution roster: elite effect ≥ 2× awful, monotone.
- T-C3: ISO plan with mid-tier star → his TS% drops ≥ 3pp vs neutral; with an elite-usage star
  < 1pp. (Game-level TS% proxy keeps CI fast; full-season PER check lives in the D2 script.)
- T-C4: `threePointRate=100` with bottom-quartile shooting roster → total pts _lower_ than same
  roster at 50 (net negative, not merely less positive).

**Suite D — Symmetry / AI**

- T-D1: unit tests on `genAiGamePlan`: sliders correlate with roster strengths; rebuilding vs
  contending lean; output always ∈ [0, 100]; average roster → ≈ all-50s.
- T-D2: full-league season script (slow; `tools/` script or vitest tagged/skipped by default):
  Spearman corr(OVR, wins) ≥ 0.65; no ≤ 30 OVR team above 45 wins; league PER leader board sanity
  (top-5 PER all ≥ 70 OVR).
- T-D3: Phase 5 revival — `processTeam` for an AI team in playoffs with the toggle on now returns
  an adjusted plan (guard no longer requires a stored plan).

**Manual playtest protocol (final acceptance):** repeat the exact exploit — worst team in the
league, every dial cranked. Expected: ~20–32 wins depending on fit (down from 71-11, and _below_
their all-50 baseline if dials are mismatched), no sub-70-OVR player above ~24 PER, star volume up
only with visible efficiency cost.

## 7. Implementation order (each PR independently shippable, tests land with it)

1. **PR-1 — Stop the bleeding:** F-B (rebounds), F-C (turnovers), F-D magnitude cap, F-G ranges,
   F-I rails + `GAME_PLAN_TUNING`. Suites A + B green. This alone likely takes 71-11 to ~.500.
2. **PR-2 — Execution quality:** F-A helper wired into all six possession dials; F-E two-sided
   restructure; scheme-fit K → 0.5. Suite C (minus C3).
3. **PR-3 — Usage curve:** F-F. T-C3.
4. **PR-4 — AI plans + Phase 5 revival:** F-H. Suite D.
5. **PR-5 — Tuning pass + polish:** run T-D2 script, adjust `GAME_PLAN_TUNING` only, F-J UI chip,
   update `CLAUDE.md` Feature 4 section + this doc's status line.

## 8. Open decisions (recommendations inline — confirm before PR-4)

1. **`aiGamePlans` default:** recommend **on** (it's a fairness fix, not a difficulty option;
   without it the whole feature stays exploitable). The toggle exists for A/B and old saves.
2. **UI execution chips (F-J):** recommend yes — perceived fairness requires showing _why_ a dial
   underperforms; cheap to build.
3. **Era-factor interaction (F-G):** recommended modulate-not-replace changes behavior for
   existing saves that already use the slider — accept, it's the rebalance's point.

## 9. Explicitly out of scope (future Phase 6 candidates)

- **Intensity budget** (points to allocate across dials so you can't max everything) — the elegant
  systemic cap, but a UX change; revisit after the rebalance proves out.
- AI trade/draft position-awareness fast-follow from Phase 2d.
- Per-matchup AI plan variation in the regular season (Phase 5 stays playoffs-only).
