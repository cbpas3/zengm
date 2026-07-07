# Implementation Plan — "Harder RPD" Challenge Features

Goal: make an RPD‑100 / `rpdPot=false` save more challenging **without any Gemini/LLM calls**. The
player keeps their foreknowledge of who becomes good; the difficulty comes from making it hard to
_convert_ that into an unstoppable dynasty — you can't just stack stars, ignore roster fit, or set a
game plan once and coast.

All four feature groups feed a small number of **team‑level scalars** that flow through one choke
point (`processTeam` → `GameSim.basketball`). Nothing here touches `developSeason.ts` or RPD math.

---

## Global conventions

### Settings / game attributes (gate everything behind toggles)

Follow the existing pattern used by `rpdPot` / `realPlayerDeterminism`. For each feature add a
boolean (or number) game attribute so it is **opt‑in, testable, and reversible**. Touch these files
for every new attribute (grep `rpdPot` to see the full set — keep them in sync):

- `src/common/types.ts` — add to `GameAttributesLeague`
- `src/common/defaultGameAttributes.ts` — add to the keys array **and** the defaults object
- `src/ui/views/Settings/types.ts` — add to the `Key` union
- `src/ui/views/Settings/settings.tsx` — add the setting definition (category, name, type, help text)
- `src/worker/views/settings.ts` — add to the union list **and** the returned object

New attributes:

| Attribute             | Type    | Default | Meaning                                            |
| --------------------- | ------- | ------- | -------------------------------------------------- |
| `teamChemistry`       | boolean | `false` | Enable the chemistry system                        |
| `positionalDepthTax`  | boolean | `false` | Enable positional‑depth penalties                  |
| `schemeFit`           | boolean | `false` | Enable archetype/scheme × game‑plan fit efficiency |
| `inSeriesAdjustments` | boolean | `false` | Enable AI coach adjustments during playoff series  |

(Defensive game‑plan sliders and the richer offensive plan do **not** need a toggle — a neutral 50
slider is a no‑op, so they are backward compatible on their own.)

### Where team‑level scalars are computed and applied

- **Compute** in `processTeam` (`src/worker/core/game/loadTeams.ts`), which already receives the full
  `players` array, the `teamSeason`, and builds the `t` object handed to the sim. Attach results to
  `t` as new fields.
- **Apply** in `GameSim.basketball/index.ts`:
  - Season/roster‑level multipliers (chemistry, positional‑depth tax) → in `updateTeamCompositeRatings`
    (around line 1319, right where synergy is folded into the composite ratings).
  - Shot‑selection / efficiency effects (scheme fit, defensive plan) → in `doShot` and the
    steal/block/rebound paths, alongside the existing game‑plan reads (lines ~1866‑1904).

Add fields to the `t` object in `processTeam` (all optional, neutral defaults so existing callers and
the All‑Star branch are unaffected):

```ts
t.chemistry = 1; // multiplier ~[0.9, 1.05]
t.depthTax = 1; // multiplier ~[0.85, 1.0]
t.schemeFit = { threePointer: 1, atRim: 1, lowPost: 1 }; // per‑shot efficiency multipliers
// t.gamePlan is extended in Phase 1 (defense fields + new offense fields)
```

Mirror each new field into the `processTeam` `teamInput`/`t` TypeScript shapes and into the
`GameSim.basketball` team type (`src/worker/core/GameSim.basketball/index.ts` ~line 96‑112).

### Verification harness (use after every phase)

The sim is deterministic given a seed. For each phase:

1. `node --run lint-ts` (typecheck, runs `tsc`) — no TS errors. `node --run lint` also runs eslint;
   `node --run test` runs the vitest suite (`--run`). There are existing tests worth extending, e.g.
   `rosterAutoSort.basketball.test.ts` for Phase 2.
2. Load a test league, open the console in the worker, and sim a season with the toggle **off** →
   confirm results are statistically unchanged from before (backward compatibility).
3. Toggle **on**, construct the pathological roster the feature targets (e.g. five stars just traded
   together; no center; scheme mismatched to personnel) and confirm the intended penalty shows up in
   box scores / standings over ~20 sims.

---

## Phase 1 — Game Plan expansion (do first; other phases build on it)

Lowest risk, extends working code, and Phase 3 (scheme fit) depends on the expanded plan existing.

### 1a. Data model

Extend the `gamePlan` shape everywhere it is declared (keep all fields, default 50 = neutral):

- `src/common/types.ts` (`Team.gamePlan`, ~line 1602)
- `src/worker/core/game/loadTeams.ts` (`processTeam` param + `t` shape)
- `src/worker/core/GameSim.basketball/index.ts` (team type, ~line 105)
- `src/worker/api/index.ts` (`updateGamePlan` param type, ~line 4213)
- `src/ui/views/Roster/GamePlanEditor.tsx` (`GamePlan` type + `DEFAULT_GAME_PLAN` + `SLIDER_CONFIG`)

New **offense** fields:

- `transition` — 0 = walk it up in the half court, 100 = push every miss/make. (Distinct from `pace`,
  which is possession count; this is fast‑break _rate_ and feeds transition rim attempts.)
- `crashOffensiveGlass` — 0 = get back on D, 100 = send bodies to the offensive boards. Trades
  offensive rebounds for transition defense (couples with 1c and the depth tax).

New **defense** fields (all new; the sim currently has no defensive plan):

- `pickCoverage` — 0 = drop/conservative, 100 = switch/blitz everything. High helps vs. star
  ISO/pick‑and‑roll but leaves mismatches.
- `perimeterPressure` — 0 = sag off, 100 = pressure the ball. Raises opponent turnovers **and**
  opponent free‑throw rate / blow‑by rim attempts.
- `helpAggression` — 0 = stay home on shooters, 100 = collapse on drives. Cuts opponent rim efficiency
  but raises opponent three‑point _frequency and_ efficiency (kick‑outs).
- `defensiveGlass` — 0 = leak out for offense, 100 = crash defensive boards. Mirror of
  `crashOffensiveGlass` on the other end.

### 1b. UI (`GamePlanEditor.tsx`)

- Split `SLIDER_CONFIG` into two labeled groups: **Offense** and **Defense**, each rendered under a
  subheading. Reuse the existing `GamePlanSlider` component unchanged.
- Add the new sliders with min/max labels (e.g. `pickCoverage`: "Drop coverage" ↔ "Switch everything").
- `DEFAULT_GAME_PLAN` gets every new key at 50. `handleChange`/`updateGamePlan` already generalize.

### 1c. Sim wiring (`GameSim.basketball/index.ts`)

Apply new offense fields:

- `transition`: in the possession loop, when the previous possession ended in a made basket or
  defensive rebound, scale the probability of a fast‑break (early‑clock rim attempt) by
  `0.5 + transition/100`. Reuse the existing `clockFactor`/frontcourt‑advance logic (lines ~1673‑1683)
  — a fast break shortens `advanceClockSeconds` and biases the shot toward `atRim`.
- `crashOffensiveGlass`: scale offensive‑rebound probability by `0.7 + crash/100 * 0.6`; as a cost,
  reduce this team's `transition` defense next possession (grant the opponent the fast‑break bonus
  above proportional to `crash`).

Apply defense fields (they modify the **opponent's** offense while this team is on defense — read
`this.team[this.d].gamePlan`):

- `pickCoverage` high → reduce opponent `usagePower` benefit (line ~1610, star‑heavy ISO) and reduce
  opponent `atRim`/`lowPost` efficiency, but slightly raise opponent open‑three frequency.
- `perimeterPressure` high → increase `probTov` (line ~1700) and increase opponent non‑shooting foul
  rate; small penalty to this team's `defensiveGlass` (out of position).
- `helpAggression` high → multiply opponent `atRim` make prob down, multiply opponent three
  frequency/efficiency up (lines ~1872, ~1897).
- `defensiveGlass` / `crashOffensiveGlass` → fold into the rebound contest (search `oreb`/`dreb`
  probability; scale by `0.7 + slider/100 * 0.6`).

Keep every effect **small** (±10–15% at the extremes) so a maxed slider is a lever, not a cheat code.
All effects must no‑op at 50 and when `gamePlan === undefined`.

### 1d. Update `CLAUDE.md`

Document the expanded slider set under a new "Game Plan" section.

---

## Phase 2 — Positional‑depth tax (Team Fit)

Punishes lineups that don't cover the position spectrum — the "no big man" case the user called out.

> **Consistency with auto-sort (read before implementing).** `rosterAutoSort.basketball.ts`
> (`findStarters`) already forces the starting five to 2 G + 2 F/C, at most one pure C, and promotes a
> big into the lineup _if the roster has one_. So the tax needs **no change to auto-sort**, but two
> rules must hold:
>
> 1. Read positions from the **same player set the sim uses** — top players by `rosterOrder` (which is
>    post-auto-sort), so "no big in the rotation" reliably means "no rosterable big." Do not re-sort by
>    a different key.
> 2. The tax defines **bigs strictly** (`C`/`FC`/`PF`), which is intentionally narrower than
>    `findStarters`' "F/C" (which also counts `SF`/`GF`). This is deliberate so a wing-heavy small-ball
>    team (e.g. 2 G + 3 SF) still gets dinged on the glass even though auto-sort is satisfied.

### 2a. Compute (`processTeam`, `loadTeams.ts`)

After players are loaded and sorted by `rosterOrder`, look at the top ~8 healthy players (those who
will actually get minutes; reuse the `injury.gamesRemaining === 0 || playingThrough` check already in
the file). Each player's position is `p.ratings.at(-1).pos` (values from `POSITIONS` in
`constants.basketball.ts`: `PG,G,SG,GF,SF,F,PF,FC,C`).

Bucket into three coverage groups:

- **Bigs**: `C`, `FC`, `PF`
- **Wings**: `SF`, `GF`, `F`
- **Guards**: `PG`, `G`, `SG`

Compute a `depthTax` multiplier starting at `1.0` and subtract penalties:

- No healthy big in the top 8 → this team's **rebounding** and **interior defense** composite ratings
  take the biggest hit (e.g. ×0.85), and opponent `atRim` efficiency gets a bonus.
- No true point/lead guard → **passing**/ball‑security penalty (raises `probTov` slightly).
- Extreme imbalance (e.g. 6+ of top 8 in one bucket) → small global penalty.

Attach as structured scalars (not one number), e.g.
`t.depthTax = { rebounding: 0.85, interiorD: 0.85, ballHandling: 1, oppRim: 1.1 }`, defaulting to all
`1`. Only compute when `g.get("positionalDepthTax")` is true; otherwise leave neutral.

### 2b. Apply (`GameSim.basketball/index.ts`)

In `updateTeamCompositeRatings` (line ~1288‑1330), multiply the relevant composite ratings by the
depth‑tax scalars right after synergy is folded in. Apply `oppRim` where the opponent's `atRim`
efficiency is computed in `doShot`.

### 2c. UI surface (so it's not invisible)

In the Roster view (`src/ui/views/Roster/`, near the Game Plan / TopStuff area), show a small "Roster
Balance" readout listing detected gaps ("No true center — rebounding & rim protection reduced"). Data
comes from the roster view (`src/worker/views/roster.ts`) computing the same bucket check and passing
a `rosterBalance` object to the UI. This is the feedback loop that makes the tax feel fair.

### 2d. Make the AI position-aware (REQUIRED — the tax backfires without it)

Basketball AI roster-building is currently **completely position-blind**, so a game-time-only penalty
punishes the AI (which never defends against it) more reliably than the user (who will always roster a
big). This must be fixed in the same phase. Confirmed blind spots:

- `team.ovr` basketball (`ovr.basketball.ts`) = top-10 OVRs only; **position ignored**.
- `DRAFT_BY_TEAM_OVR` is **false** for basketball → `getBest` signs FAs in raw `value` order.
- `KEY_POSITIONS_NEEDED` is **undefined** for basketball (only football/hockey use it).
- `dropPlayers` position logic is **disabled for basketball** (`basketball: false`) → cuts by lowest
  value, can cut the last center.

**Fix (contained, reuses existing hooks):** introduce a basketball position-_group_ need concept —
`bigs = {C, FC, PF}`, `guards = {PG, G, SG}` — and wire it into the two existing insertion points:

1. `getBest.ts` — add a basketball branch to the `shouldAddPlayerPosition` logic (currently gated on
   `KEY_POSITIONS_NEEDED`) so that when a team has **zero healthy bigs** (or zero guards), a player in
   the missing group is treated as a need and gets signed even at a min contract. Express as groups,
   not exact `pos`, since `KEY_POSITIONS_NEEDED`'s exact-match model can't say "any big."
2. `checkRosterSizes.ts` `dropPlayers` — add a basketball guard mirroring the football/hockey
   "don't cut your last player at a key position" rule, so the AI won't waive its only big to keep a
   marginally higher-value wing.

This keeps the AI from _creating_ the pathological roster the tax punishes, so the tax mostly shapes
AI behavior (better rosters) rather than silently draining AI teams that never adapt.

**Known remaining gaps (decide scope — see below):** AI **trade** evaluation and **draft** picks are
also position-blind for basketball (both lean on the position-blind `team.ovr` / `value`). Full
robustness would also bias those toward filling a missing group. Recommended: ship 2d as FA-signing +
roster-cut awareness first (covers the common case), and treat trade/draft position-awareness as a
fast-follow only if AI teams still end up bigless in testing.

---

## Phase 3 — Scheme fit (Archetype × Game Plan)

Punishes setting a game plan that doesn't match your personnel — cranking `threePointRate` with no
shooters, or `postPlay` with no post scorers. Primary signal is **actual ratings** (works for every
player); `devFocus` archetypes are an optional bonus layer.

### 3a. Compute (`processTeam`)

For the top ~8 healthy players, average the relevant composite ratings (already computed in
`processTeam`'s `COMPOSITE_WEIGHTS` loop):

- three‑point capability ← `shootingThreePointer`
- rim capability ← `shootingAtRim` / `dunks` / athleticism
- post capability ← `shootingLowPost`

For each offense slider that biases shot **selection**, compare emphasis vs. capability and produce a
per‑shot **efficiency** multiplier (bonus when the plan leans into a strength, penalty when it forces
bad shots the personnel can't hit):

```
schemeFit.threePointer = 1 + k * (teamThreeCapability - 0.5) * (gamePlan.threePointRate/100 - 0.5)
```

(and likewise for `atRim` ← `rimAttack`, `lowPost` ← `postPlay`). `k` ≈ 0.3 so the swing is roughly
±8%. When capability is average or the slider is neutral, the term vanishes → multiplier ≈ 1.

Optional `devFocus` layer: if a player with a `devFocus` (e.g. `Sharpshooter`) is on a plan that
emphasizes their archetype, give a small extra bump. Add a mapping next to `DEV_FOCUS_RATINGS`:

```ts
// src/worker/core/player/developSeason.ts (export alongside DEV_FOCUS_RATINGS)
export const DEV_FOCUS_GAMEPLAN_AFFINITY: Record<
	DevFocusType,
	Partial<Record<"threePointRate" | "rimAttack" | "postPlay", number>>
> = {
	Sharpshooter: { threePointRate: 1 },
	Slasher: { rimAttack: 1 },
	"Post Scorer": { postPlay: 1 },
	// ... etc
};
```

Gate the whole block behind `g.get("schemeFit")`.

### 3b. Apply (`GameSim.basketball/index.ts`)

Multiply the corresponding `probMake` in `doShot`:

- three‑pointer `probMake` (line ~1880) × `schemeFit.threePointer`
- `atRim` `probMake` (line ~1918) × `schemeFit.atRim`
- `lowPost` make prob × `schemeFit.lowPost`

This deliberately pairs with the **frequency** effects the sliders already have: the slider makes you
_take_ more of a shot, scheme fit decides whether taking more of it actually _helps_.

---

## Phase 4 — Team Chemistry

A stored, slowly‑drifting value per team that rewards continuity and punishes churn — so a superteam
assembled overnight underperforms until it gels, and blowing up a roster every year has a cost.

### 4a. Storage

Store on `teamSeason` (carries per‑season history; `processTeam` already receives `teamSeason`).
Add an optional field to the `TeamSeason` type in `src/common/types.ts`:

```ts
chemistry?: number; // 0–100, neutral 50; optional so no migration needed
```

(Adding an optional field to an existing store needs **no schema migration** — same approach the
`gamePlan` field used. Confirm by grepping how `gamePlan` was added to `Team`.)

### 4b. Update loop (drift toward a target each game/day)

Add a helper `updateTeamChemistry(tid)` (new file
`src/worker/core/team/updateChemistry.ts`) called once per team per day of the regular season +
playoffs. Hook it into the existing daily/game post‑processing — the same place standings and player
stats are updated after games (`src/worker/core/game/writeGameStats.ts` or the season day loop in
`src/worker/core/game/play.ts`). Logic:

```
target = f(rosterContinuity, recentResults, starDensity)
chemistry += (target - chemistry) * driftRate   // driftRate ~0.03/game → ~a month to converge
```

- **rosterContinuity**: fraction of current minutes played by players who were on the roster last
  season (and/or games‑played‑together). New arrivals drag the target down.
- **recentResults**: winning nudges target up, losing streaks down (locker‑room mood).
- **starDensity**: many high‑usage stars lowers the _ceiling_ of the target slightly (ball‑sharing
  friction) — this is the specific "can't just stack stars" lever.

Reset/soft‑carry at season rollover (new `teamSeason` created in `newPhasePreseason` or the season‑
init path — seed next season's chemistry from a fraction of last season's, minus a churn penalty for
offseason roster turnover).

Only run when `g.get("teamChemistry")` is true.

### 4c. Apply (`processTeam` → `GameSim`)

Map chemistry to a small global multiplier on **offensive** composite ratings (passing, offensive
synergy contribution) and a smaller one on defense:

```
t.chemistry = 0.95 + (teamSeason.chemistry / 100) * 0.10   // [0.95, 1.05], ±5%
```

Apply in `updateTeamCompositeRatings` where synergy is folded in (line ~1319). Keep the magnitude
modest — chemistry is a tiebreaker between similarly‑talented teams, not a talent replacement.

### 4d. UI

- Show a chemistry meter on the Roster view and/or team page (value + trend arrow). Data via
  `src/worker/views/roster.ts` / a team view already returning `teamSeason` attrs (add `chemistry` to
  the `seasonAttrs` list at `roster.ts:133`).
- Optional: a news/event feed entry when chemistry crosses thresholds ("locker room has gelled").

---

## Phase 5 — In‑series AI adjustments (no Gemini)

During a playoff **series**, the AI opponent's coach adjusts its game plan between games to counter
what the user did in the earlier games of that series — so a superior‑but‑predictable team can get
out‑schemed. Pure heuristic; no LLM.

### 5a. Where to hook

`processTeam` in `loadTeams.ts` already knows the phase (`PHASE.PLAYOFFS`) and — in `loadTeams` — the
pair of `tids` playing (so each team's opponent is the other tid). For a playoff game, when the team
being processed is an **AI** team (`!g.get("userTids").includes(tid)`) and `inSeriesAdjustments` is
on, compute an adjusted game plan and attach it as `t.gamePlan` (overriding the stored one for this
game only — do **not** persist it).

### 5b. Reading series history

Find the current series via `playoffSeries` (see `isGame6EliminationGameOrGame7` already in
`loadTeams.ts` for the lookup pattern) to confirm the two teams are in a series and how many games
have been played. Pull the prior games of this exact matchup this postseason from
`idb.getCopies.games({ season })` filtered to the two tids and `playoffs: true` (mirror the
opportunistic query already used in `seasonGroundTruth.ts`). If box scores were pruned or it's game 1,
skip (no adjustment — neutral).

### 5c. Adjustment logic

From the opponent's (user's) shot profile in the prior series games, nudge the AI's **defensive**
sliders (added in Phase 1) toward counters, and its **offense** toward the AI's own exploited edges:

- User shooting a high, efficient 3PT rate → raise AI `helpAggression` down / `perimeterPressure` up
  and closeouts (reduce opponent 3 frequency term).
- User dominating the paint / offensive glass → raise AI `pickCoverage`/`defensiveGlass`.
- User's star has huge usage/scoring → raise AI `pickCoverage` (switch/blitz the star) at the cost of
  opening role‑player looks.
- Escalate magnitude with series game number (bigger adjustments in games 5‑7) and if the AI is
  trailing the series.

Keep adjustments bounded (each slider moves at most ±25 from its stored value) so the AI stays
coherent. Because the effects route through the Phase 1 defensive sliders, no new sim code is needed —
Phase 5 only _chooses_ slider values.

### 5d. Optional polish

Log a play‑by‑play/news note ("Opponent adjusted: switching everything on your pick‑and‑roll") so the
user sees the chess match. Reuse `logEvent`.

---

## Suggested build order & dependencies

1. **Phase 1** (game‑plan expansion) — foundation; defensive sliders are used by Phases 3 & 5.
2. **Phase 2** (positional‑depth tax) — independent; good second because it exercises the
   `processTeam` scalar plumbing that Phases 3‑4 reuse.
3. **Phase 3** (scheme fit) — needs Phase 1's plan + Phase 2's `processTeam` pattern.
4. **Phase 4** (chemistry) — independent but heaviest (storage + update loop + UI); do after the
   simpler scalars are proven.
5. **Phase 5** (in‑series AI) — last; depends on Phase 1's defensive sliders.

Each phase is independently shippable behind its own toggle. Land, verify, and update `CLAUDE.md`
after each before starting the next.

## Locked tuning decisions (final — build to these)

- **"No big man" penalty**: ×0.85 to rebounding and interior defense (noticeable but survivable).
- **Chemistry swing range**: ±5% — a tiebreaker between similar‑talent teams, not a talent
  replacement. Use `t.chemistry = 0.95 + (teamSeason.chemistry / 100) * 0.10` → `[0.95, 1.05]`.
- **Applies to AI teams too**: **yes.** Chemistry, positional‑depth tax, and scheme fit all apply to
  every team, not just the user's. Compute the scalars for all tids in `processTeam` regardless of
  `userTids`; do **not** branch on the user. This keeps the league symmetric and stops the AI from
  being trivially exploitable. (In‑series adjustments in Phase 5 are the deliberate exception: those
  are applied only to **AI** teams countering the **user**, since the user sets their own plan.)
  - **Corollary (required):** because the tax/scalars apply to AI teams, the AI must also _avoid
    building the rosters they punish._ Phase 2d makes AI free‑agent signing and roster cuts
    position‑group aware. Without it, the position‑blind AI (`team.ovr`/`value` ignore position) eats
    the tax harder than the user and the feature backfires.

## Open scope decision (recommended default in‑line, confirm before/after first playtest)

- **How far to extend AI position‑awareness?** Phase 2d covers FA signing + roster cuts (the common
  case). AI **trades** and **draft** are also position‑blind for basketball. Recommended: ship FA +
  cuts first; add trade/draft awareness as a fast‑follow only if AI teams still finish seasons bigless
  in testing.
