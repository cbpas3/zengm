# CLAUDE.md — ZenGM Custom Features

This file documents the custom features added on top of the upstream ZenGM basketball simulation. Use it to orient a new chat session without re-reading the full conversation history.

---

## Project Overview

ZenGM is an open-source sports management simulation. This fork adds:

1. **Player Development System** — archetype-based training, breakthrough seasons, regression floors
2. **Gemini AI Trade Engine** — Gemini Flash powers the trading block, acting as all opposing GMs
3. **AI Article Generation** — Gemini-written game recaps ("Way 1") and team season retrospectives ("Way 3")
4. **Game Plan (Harder RPD Challenge, Phase 1)** — expanded offense/defense sliders (no LLM calls) that make converting foreknowledge into a dynasty require actual roster/scheme decisions, not just stacking stars
5. **Game Plan Rebalance** — talent-gates every possession-economy dial (F-A's `eq()` execution-quality helper) so cranking a slider without the personnel to back it up is neutral-to-negative EV instead of a free win, fixes the exploit that let a 24 OVR team with every dial maxed go 71-11, and gives AI teams their own personnel-driven game plans

---

## Feature 1: Player Development System

### What it does

Three per-player coaching levers let the user shape development without god-mode edits:

- **Dev Override** — exempts a player from Real Player Determinism (RPD), letting them develop via sim math instead of following their historical rating path
- **Development Focus** — pick an archetype to emphasize; archetype ratings grow more aggressively, and they can never regress below their value when the focus was set (guaranteed floor)
- **Mentorship** — assign a veteran (28+) to a young player (≤23); young player gets a bonus toward the mentor's top 4 skill ratings

### Archetypes (DevFocusType)

| Archetype     | Ratings boosted              |
| ------------- | ---------------------------- |
| Sharpshooter  | `tp`, `fg`, `ft`             |
| Slasher       | `dnk`, `spd`, `jmp`          |
| Post Scorer   | `ins`, `stre`, `reb`         |
| Playmaker     | `pss`, `drb`, `oiq`          |
| 3-and-D       | `tp`, `diq`, `spd`           |
| Lockdown      | `diq`, `stre`, `spd`, `jmp`  |
| Athletic      | `spd`, `jmp`, `endu`, `stre` |
| Floor General | `oiq`, `pss`, `drb`          |

### Breakthrough seasons

Players aged ≤24 with a dev focus have a **15% per-season chance** of a breakthrough: all focus-archetype ratings jump +12–22 instead of the normal +4 bonus.

### Guaranteed floor

Before each development season, archetype ratings are snapshotted. After development runs, ratings are clamped to `Math.max(newVal, snapshot)` — focus ratings can never drop below where they started.

### RPD exemption

Focus and mentor rating keys are **skipped in the RPD blend loop** (step 2 of `developSeason.ts`), so RPD cannot overwrite the archetype bonuses.

### Key files

| File                                                | Role                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/common/types.ts`                               | `DevFocusType` union type; `devOverride`, `devFocus`, `mentorPid` on `PlayerWithoutKey`; `geminiApiKey` on `Options` |
| `src/worker/core/player/developSeason.ts`           | Snapshot → RPD exemption → breakthrough + floor logic                                                                |
| `src/worker/core/player/develop.ts`                 | Resolves mentor, passes `devOptions` into `developSeason`                                                            |
| `src/worker/api/index.ts`                           | `updatePlayerDevelopment` API endpoint                                                                               |
| `src/worker/views/roster.ts`                        | Exposes `devOverride`, `devFocus`, `mentorPid` to UI                                                                 |
| `src/ui/views/Roster/PlayerDevelopmentControls.tsx` | Dev Override checkbox, Focus select, Mentor select                                                                   |
| `src/ui/views/Roster/index.tsx`                     | Adds "Dev" column to roster table                                                                                    |
| `src/common/getCols.ts`                             | Added `Dev` column definition (required to avoid "Unknown column" crash)                                             |

---

## Feature 2: Gemini AI Trade Engine

### What it does

Replaces the dumb value-matching trading block with **Google Gemini Flash** acting as all 29 opposing GMs simultaneously. Gemini uses NBA historical knowledge (player reputation, attitude, team culture, roster needs as of the current sim season) to generate realistic trade proposals.

### Architecture

- **Single API call** covers all 29 teams (respects the 15 RPM free-tier rate limit)
- **`makeItWork`** is called post-Gemini to balance trade value after Gemini's player selections
- **Franchise player protection** is enforced at two levels: prompt tag `[FRANCHISE — DO NOT OFFER]` on each team's #1 player, and code exclusion from the `playerNameToPid` lookup map
- **Fallback**: if Gemini fails or returns nothing, standard offers are generated and a yellow warning banner is shown in the UI

### AI-to-AI veto

When two AI teams trade, Gemini evaluates whether the deal is realistic before it processes. Triggered only when trade value delta < 15 and at least one player has OVR ≥ 70.

### API key storage

Stored in Global Settings under "AI Trade Realism" (basketball only). Saved to `options.geminiApiKey` in the database.

### Model

`gemini-3.5-flash` (Stable/GA, released May 19, 2026 — most intelligent model available on the free tier). Switched from `gemini-3.1-flash-lite` on 2026-07-07 for better trade-realism reasoning; `gemini-3.1-flash-lite` remains the recommended fallback if free-tier daily limits are hit. Note: `gemini-3.1-pro-preview` is NOT free-tier eligible.

**⚠️ Thinking-model gotcha:** unlike Flash-Lite, `gemini-3.5-flash` has thinking ON by default (`medium`), and thinking tokens are drawn from `maxOutputTokens`. A small cap (the old 80/1200 values) is entirely consumed by thinking → `finishReason: MAX_TOKENS` → empty `text` → silent fallback. Both calls therefore set `generationConfig.thinkingConfig.thinkingLevel: "low"` and raise `maxOutputTokens` (veto 2048, offers 8192). REST shape: `generationConfig: { thinkingConfig: { thinkingLevel: "low" } }` (values: `minimal | low | medium | high`).

**API endpoint:**

```
https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=<KEY>
```

### Key files

| File                                      | Role                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/worker/util/gemini.ts`               | `evaluateTrade` (AI veto), `generateTradingBlockOffers` (offer generation), `callGemini` (shared fetch wrapper)                             |
| `src/worker/api/index.ts`                 | `getTradingBlockOffers` — tries Gemini first, falls back to standard; `augmentOffers` adds `reasoning` field; `updateOptions` saves API key |
| `src/worker/core/trade/betweenAiTeams.ts` | Calls `evaluateTrade` veto before processing AI-to-AI trades                                                                                |
| `src/ui/views/TradingBlock/index.tsx`     | Unpacks `{ offers, usedFallback }`, shows fallback banner, renders GM reasoning                                                             |
| `src/ui/views/GlobalSettings/index.tsx`   | Password input for Gemini API key                                                                                                           |
| `src/worker/views/globalSettings.ts`      | Returns `geminiApiKey` to UI                                                                                                                |

### Return shape from `getTradingBlockOffers`

```typescript
{ offers: TradeTeams[], usedFallback: boolean }
```

### Prompt instructions (critical constraints)

1. ROSTER DATA IS GROUND TRUTH — Gemini must not assume trades or departures not in the data
2. NEVER offer a `[FRANCHISE — DO NOT OFFER]` player
3. NEVER offer a player cited as the pairing reason (e.g. "to pair with X" → X cannot be in the offer)
4. Only name players from that team's exact roster
5. Use NBA knowledge as of the current sim season year

### iOS Safari fix

`AbortSignal.timeout()` is not reliably supported on iOS Safari. Both fetch calls in `gemini.ts` use the compatible pattern instead:

```typescript
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15000);
try {
    const res = await fetch(url, { ..., signal: controller.signal });
} finally {
    clearTimeout(timer);
}
```

---

## Feature 3: AI Article Generation

Two on-demand, ephemeral (render-don't-persist, nothing saved to the DB) long-form writing features. Both are built on the shared `callGemini` wrapper from Feature 2 and the same UI pattern: an `ActionButton` ("Generate ...") + a yellow fallback banner if Gemini is unavailable + a plain paragraph renderer.

### 3a. Game Recap ("Way 1")

One Gemini call per game. Writes a 3–5 paragraph recap from a single game's box score.

- Worker: `generateGameArticle({ gid })` in `src/worker/api/index.ts`. Reuses `boxScore` from `src/worker/views/gameLog.ts` (exported specifically for this) as its data source — no separate DB queries.
- UI: `GameRecap` component in `src/ui/views/GameLog.tsx`, "Generate recap" button under the box score.
- Prompt persona: beat writer for the winning team's city.

### 3b. Season Retrospective ("Way 3")

One team's one season, told as a story — identity, turning point, how it ended — via **two sequential Gemini calls** instead of one. A season is dozens of games; getting a coherent arc (not a bulleted summary) out of it needs (1) aggregating to the right granularity in code and (2) planning the story before writing it.

**Aggregation** — `buildSeasonGroundTruth(tid, season)` in `src/worker/util/seasonGroundTruth.ts` builds a compact ground-truth object from **season-level data**, which is always present regardless of box-score retention:

- Final record, seed, and how the season ended (via `helpers.roundsWonText`), from `teamSeasons` + `playoffSeries`
- Playoff series results, per round
- Regular-season arc — longest win/loss streaks, up to 8 signature games (scored by opponent quality + margin + OT), and record by quarter of the season (chronological game order, since the sim doesn't track calendar months) — queried **opportunistically** from `idb.getCopies.games({ season })`; silently omitted (not an error) if box scores were pruned per `saveOldBoxScores.pastSeasons`
- Team stat leaders (top 4 by pts) + that season's awards, via `playersPlus`
- In-season trades, from `idb.getCopies.events({ season })` filtered to `type: "trade"`
- Dev-system texture: breakthrough-caliber rating jumps (age ≤24, OVR delta ≥8 year-over-year) — **not** the live `devFocus`/`mentorPid` fields, since those aren't stored historically per season and only reliably describe the _current_ season

**Mid-season awareness** — the button works on the in-progress season too (not just completed ones), and the ground truth explicitly flags this via `seasonProgress: { isComplete, gamesPlayed, numGamesRegularSeason, description }` computed from `g.get("season")`/`g.get("phase")` vs. the requested season (`phase >= PHASE.DRAFT_LOTTERY` = that season is fully done, including any playoffs). When `isComplete` is `false`:

- `howSeasonEnded`/seed/"final record" framing is swapped for "current record" + an explicit `Season status: IN PROGRESS — …` line, so Gemini isn't handed a `showMissedPlayoffs`-flavored fact for a team that's simply 40 games from finding out
- Both prompts drop the "climax → resolution" framing for "where things stand right now," and the prose pass is told to close with 2–3 forward-looking sentences (trending strengths/weaknesses, hot/cold streaks) instead of a wrap-up
- The prose pass is also nudged to weave in a `devNotes` entry when present (breakthrough jumps, mentorship) — this is the "highlight player growth" angle for a season that hasn't produced a real ending yet

**Two-pass generation** — `generateSeasonStoryArticle(tid, season)` in `gemini.ts`:

1. **Outline pass** — ground truth → JSON `{ title, angle, beats: [{ when, what, why_it_mattered }] }` (4–6 beats, 3–5 if in progress), `thinkingLevel: "low"`
2. **Prose pass** — ground truth + the approved outline → 600–900 word retrospective, `thinkingLevel: "medium"` for coherence over the longer arc

`callGemini` was extended to accept `thinkingLevel`, `maxOutputTokens`, and `timeoutMs` in its options (previously hardcoded to `"low"` / `8192` / `20000`).

**Timeout/retry:** this feature's two prompts (full ground-truth block + a long-form prose ask) run close enough to the default 20s abort that a single slow/cold-start response would trip the fallback banner and force the user to click twice. Both passes now use `timeoutMs: 30000` and go through `callGeminiWithRetry` (one silent retry on a `null` result) instead of a bare `callGemini` call — scoped to this feature only, not the shared `callGemini` default, since a trade veto/offer call is small enough that 20s was never the bottleneck there. Note this doubles worst-case Gemini calls per click (up to 4 instead of 2) — worth revisiting if free-tier quota cost becomes a concern.

**Error differentiation (rate limit vs. everything else):** `callGemini` takes an optional `onError?: (info: { status?: number; body?: string }) => void` so a caller can inspect _why_ a call failed without changing its `string | null` return contract for other callers (trade veto/offers/game recap are unaffected). `callGeminiWithRetry` uses this to detect HTTP 429 (free-tier rate limit) specifically; `generateSeasonStoryArticle` now returns `{ article, errorReason?: "rate_limited" | "other" }` instead of a bare string, threaded through `generateSeasonStory`'s `rateLimited` field to `SeasonStory.tsx`, which shows a distinct "rate limit hit, wait a minute" message instead of the generic "check your API key" banner when that's the actual cause.

### Key files (3b)

| File                                       | Role                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `src/worker/util/seasonGroundTruth.ts`     | `buildSeasonGroundTruth`, `formatGroundTruthText` — all the DB aggregation          |
| `src/worker/util/gemini.ts`                | `generateSeasonStoryArticle` — the two Gemini passes                                |
| `src/worker/api/index.ts`                  | `generateSeasonStory({ tid, season })` endpoint, modeled on `getTradingBlockOffers` |
| `src/ui/views/TeamHistory/SeasonStory.tsx` | Button + loading state + fallback banner, one instance per season row               |
| `src/ui/views/TeamHistory/Seasons.tsx`     | Renders `SeasonStory` under each season the team actually played games in           |

### Return shape from `generateSeasonStory`

```typescript
{ article: string | null, usedFallback: boolean, rateLimited: boolean }
```

### Scope

Ephemeral only — a saved archive needs a new league-DB object store + schema migration, deferred until narrative quality is proven. Multi-season/dynasty pieces, player-career pieces, and league-in-review are separate future phases reusing the same aggregation + two-pass machinery (the dynasty version is where box-score pruning across older seasons in the window matters most).

---

## Feature 4: Game Plan (Harder RPD Challenge, Phase 1)

### What it does

Part of a multi-phase plan (see `CHALLENGE_FEATURES_PLAN.md`) to make an RPD-100 / `rpdPot=false`
save harder **without any Gemini/LLM calls**. The player still knows who becomes good; the
difficulty comes from making it hard to _convert_ that foreknowledge into an unstoppable dynasty.
Phase 1 expands the per-team `gamePlan` sliders from 5 (offense-only) to 11 (offense + a brand-new
defense half), all still 0–100 with 50 = neutral/no-op. Applies to every team (user and AI alike) —
`processTeam` just forwards whatever `gamePlan` is stored on the team, so AI teams get whatever the
league's difficulty/AI logic sets for them.

### Sliders

**Offense** (pre-existing: `pace`, `threePointRate`, `postPlay`, `rimAttack`, `ballMovement`; new
this phase: `transition`, `crashOffensiveGlass`):

| Slider                | 0                            | 100                                 |
| --------------------- | ---------------------------- | ----------------------------------- |
| `transition`          | Walk it up in the half court | Push every miss/make                |
| `crashOffensiveGlass` | Get back on D                | Send bodies to the offensive boards |

**Defense** (all new — the sim previously had no defensive plan at all):

| Slider              | 0                     | 100                     |
| ------------------- | --------------------- | ----------------------- |
| `pickCoverage`      | Drop/conservative     | Switch/blitz everything |
| `perimeterPressure` | Sag off               | Pressure the ball       |
| `helpAggression`    | Stay home on shooters | Collapse on drives      |
| `defensiveGlass`    | Leak out for offense  | Crash defensive boards  |

### Sim wiring (`GameSim.basketball/index.ts`)

- **`transition`**: in `getPossessionOutcome`, a make or a defensive rebound is a transition
  opportunity; whether it actually becomes a fast break is a coin flip scaled by
  `0.5 + transition/100`. A fast break shrinks the frontcourt-advance `dt` (ball pushed upcourt
  fast) and, in `getShotInfo`, multiplies the at-rim shot-selection term by `1.4`.
- **`crashOffensiveGlass`**: in `doReb`, scales the offense's rebound weight by `0.7 + crash/100 *
0.6`. Cost: if the shot is missed and the defense gets the drb anyway, that drb'ing team is now
  on offense next possession and gets a bonus fast-break chance proportional to how hard its
  _opponent_ (the team that just crashed) had `crashOffensiveGlass` set — poor floor balance leaking
  out in transition against them.
- **`pickCoverage`** (read from the _defending_ team): dampens the offense's `usagePower` (blunts
  star-heavy ISO ball), reduces at-rim/low-post `probMake` by up to 10%, and raises three-point
  shot-selection frequency slightly (kick-outs off a switch).
- **`perimeterPressure`** (defending team): raises `probTov` and the non-shooting foul roll by up
  to 15%; costs the defending team a rebounding penalty (out of position) applied in `doReb`.
- **`helpAggression`** (defending team): cuts at-rim `probMake` by up to 12%, raises three-point
  shot-selection frequency and three-point `probMake` (open kick-out threes) by up to 8–10%.
- **`defensiveGlass`** (defending team): mirrors `crashOffensiveGlass` in `doReb`, scaling the
  defense's rebound weight by `0.7 + defensiveGlass/100 * 0.6`.

All defense-slider effects are read via `this.team[this.d].gamePlan` (i.e. they modify the
_opponent's_ offense while a team is on defense). Every effect no-ops at 50 and when
`gamePlan === undefined` or a field is missing — old saves with only the original 5 offense keys
still simulate correctly (`?? 50` default on every new field read).

### UI (`GamePlanEditor.tsx`)

Sliders are now split into "Offense" and "Defense" subheadings. `DEFAULT_GAME_PLAN` has all 11 keys
at 50; on mount the editor merges `{ ...DEFAULT_GAME_PLAN, ...t.gamePlan }` so a team with an
old 5-key `gamePlan` in the DB doesn't render `undefined`/`NaN` sliders for the new fields.

### Key files

| File                                          | Role                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/common/types.ts`                         | `Team.gamePlan` — all 11 fields                                                                                    |
| `src/worker/core/game/loadTeams.ts`           | `processTeam` `teamInput.gamePlan` type; forwards to `t.gamePlan` unchanged                                        |
| `src/worker/core/GameSim.basketball/index.ts` | `TeamGameSim.gamePlan` type + all sim wiring (`getPossessionOutcome`, `getShotInfo`, `doShot`, `probTov`, `doReb`) |
| `src/worker/api/index.ts`                     | `updateGamePlan` param type                                                                                        |
| `src/ui/views/Roster/GamePlanEditor.tsx`      | `GamePlan` type, `DEFAULT_GAME_PLAN`, `OFFENSE_SLIDER_CONFIG` / `DEFENSE_SLIDER_CONFIG`                            |

### Future phases

Phases 2–5 (positional-depth tax, scheme fit, team chemistry, in-series AI adjustments) have all
since been built — see Features 5–8 below (and `CHALLENGE_FEATURES_PLAN.md` for the original plan).
Phase 3 (scheme fit) and Phase 5 (in-series AI adjustments) both depend on the sliders added here.

**Playtest found these sliders exploitable** (a 24 OVR team with every dial maxed went 71-11,
since every possession-economy dial read zero player ratings) — see Feature 9 below for the
talent-gated execution-quality rebalance that fixed this.

---

## Feature 5: Positional-Depth Tax (Harder RPD Challenge, Phase 2)

### What it does

Punishes rosters that don't cover the position spectrum — the "stack five stars, ignore the
center" min-maxing the RPD challenge is supposed to make hard. Gated behind the
`positionalDepthTax` game attribute (default `false`); a neutral/no-op when off, so old saves and
existing sims are unaffected. Applies to **every** team, user and AI alike (`processTeam` computes
it for whichever `tid` it's given, no branch on `userTids`) — which is why Phase 2d (AI
position-awareness) had to ship in the same phase: without it, the AI's already position-blind
free-agent signing and roster-cut logic would eat the tax harder than the user ever would.

### Position groups

Read from the **top 8 healthy players by `rosterOrder`** (the same post-auto-sort set the sim
actually plays), not a separate sort. Deliberately narrower than `rosterAutoSort.basketball.ts`'s
`findStarters` "F/C" bucket (which also counts `SF`/`GF`), so a wing-heavy small-ball team still
gets dinged on the glass even when auto-sort's 2-G/2-F-C requirement is satisfied:

| Group  | Positions       |
| ------ | --------------- |
| Bigs   | `C`, `FC`, `PF` |
| Wings  | `SF`, `GF`, `F` |
| Guards | `PG`, `G`, `SG` |

### Tax rules (locked tuning)

Computed once per team per game in `processTeam`, attached as `t.depthTax` (all fields default `1`
= no-op):

- **No healthy big in the top 8** → `rebounding` and `interiorD` multipliers ×0.85 (folded into the
  `rebounding` and `blocking` composite ratings — `blocking`'s weights are height-heavy, the
  closest existing team-level proxy for rim protection), plus `oppRim` ×1.1 (opponents shoot better
  at the rim against this team).
- **No healthy guard in the top 8** → `ballHandling` ×0.9, folded into the `passing` composite
  rating (raises `probTov`/`probStl` via the existing formulas — no new sim code needed there).
- **Extreme imbalance** (6+ of the top 8 in one group) → small `overall` ×0.97 across all six
  composite ratings `updateTeamCompositeRatings` recomputes per possession.

### Sim wiring

- `updateTeamCompositeRatings` (`GameSim.basketball/index.ts`) multiplies `rebounding` / `blocking`
  / `passing` by the matching `depthTax` scalar, then all six recomputed composites by `overall`,
  right after synergy is folded in.
- `getShotInfo`'s `atRim` branch multiplies `probMake` by `this.team[this.d].depthTax?.oppRim ?? 1`
  (the defending team's tax affects the shooter's efficiency).

### AI position-awareness (required companion fix)

Basketball AI roster-building was completely position-blind before this phase (`team.ovr` ignores
position, `DRAFT_BY_TEAM_OVR` is `false` for basketball so FA signing goes by raw value,
`KEY_POSITIONS_NEEDED` was `undefined` for basketball, and `dropPlayers`' position-count logic was
`basketball: false`). Fixed narrowly, gated behind the same `positionalDepthTax` attribute:

- `src/worker/core/team/positionalDepthTax.ts` — shared `POSITION_GROUPS`, `getPositionGroup`,
  `countTopPositionGroups`, `computeDepthTax`. Single source of truth for the sim, the AI fixes
  below, and the UI readout.
- `src/worker/core/freeAgents/getBest.ts` — `shouldAddPlayerPosition` now also fires when the
  signing team has zero healthy bigs or zero healthy guards anywhere on the roster (not just the
  top 8), expressed as groups since `KEY_POSITIONS_NEEDED`'s exact-position model can't say "any
  big."
- `src/worker/core/team/checkRosterSizes.ts` (`dropPlayers`) — won't release a team's last healthy
  big or guard while cutting down to `maxRosterSize`, mirroring the existing
  football/hockey "don't cut your only kicker/goalie" guard.
- **Known gap, deferred**: AI trade evaluation and draft picks are still position-blind (both lean
  on the position-blind `team.ovr`/`value`). Ship FA + cuts first; add trade/draft awareness only
  if AI teams still finish seasons bigless in testing.

### UI (`Roster/RosterBalance.tsx`)

A small warning box next to `RosterComposition` (which itself renders `null` on basketball) in
`TopStuff.tsx`, reusing `countTopPositionGroups` server-side. `src/worker/views/roster.ts` computes
`t2.rosterBalance` only when `positionalDepthTax` is on and the season being viewed is the current
one (this is a "your active roster" readout, not historical). Renders nothing if there's no gap.

### Key files

| File                                          | Role                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/common/types.ts`                         | `GameAttributesLeague.positionalDepthTax`                                                 |
| `src/common/defaultGameAttributes.ts`         | Registers the attribute for basketball, default `false`                                   |
| `src/ui/views/Settings/settings.tsx`          | "Positional Depth Tax" toggle under Challenge Modes                                       |
| `src/worker/core/team/positionalDepthTax.ts`  | Shared position-group + tax-computation helpers                                           |
| `src/worker/core/game/loadTeams.ts`           | `processTeam` computes `t.depthTax`, gated on the attribute                               |
| `src/worker/core/GameSim.basketball/index.ts` | `TeamGameSim.depthTax` type; applies it in `updateTeamCompositeRatings` and `getShotInfo` |
| `src/worker/core/freeAgents/getBest.ts`       | Basketball position-group need check for FA signing                                       |
| `src/worker/core/team/checkRosterSizes.ts`    | Protects last healthy big/guard from `dropPlayers`                                        |
| `src/worker/views/roster.ts`                  | Computes `t2.rosterBalance` for the UI                                                    |
| `src/ui/views/Roster/RosterBalance.tsx`       | Warning box rendered in `TopStuff.tsx`                                                    |

### Future phases

Phase 5 (in-series AI adjustments) has since been built — see Feature 8 below.

---

## Feature 6: Scheme Fit (Harder RPD Challenge, Phase 3)

### What it does

Punishes setting a game plan that doesn't match your personnel — cranking `threePointRate` with
no shooters, or `postPlay` with no post scorers, actively hurts shooting efficiency instead of
just being a wasted slider. Gated behind the `schemeFit` game attribute (default `false`); a
neutral/no-op when off. Applies to **every** team, user and AI alike, same as the positional-depth
tax (Feature 5) — `processTeam` computes it for whichever `tid` it's given, no branch on
`userTids`.

Primary signal is **actual ratings** (works for every player, dev-focus or not); `devFocus`
archetypes are an optional bonus layer on top.

### Compute (`src/worker/core/team/schemeFit.ts`)

`computeSchemeFit(players, gamePlan)` takes the same "top 8 healthy players by `rosterOrder`" set
the positional-depth tax uses (see `processTeam` in `loadTeams.ts` — the two features share the
healthy-player loop pattern, just with different fields collected: composite ratings + `devFocus`
here instead of position). For each of three shot types it averages the relevant composite rating
across that set — `shootingThreePointer`, `shootingAtRim`, `shootingLowPost` (all already computed
per-player in `processTeam`'s `COMPOSITE_WEIGHTS` loop, range `[0, 1]`) — and compares it to the
matching game-plan slider:

```
fit = 1 + k * (capability - 0.5) * (sliderValue/100 - 0.5)     // k = 0.3, so ~±7.5% at the extremes
```

The term vanishes (multiplier ≈ 1) when capability is average (0.5) or the slider is neutral (50).
Leaning a slider into a real strength is a bonus; leaning it into a weakness is a penalty — either
direction, symmetric.

**Optional dev-focus bonus** — `DEV_FOCUS_GAMEPLAN_AFFINITY` (`developSeason.ts`, exported next to
`DEV_FOCUS_RATINGS`) maps each archetype to the offense slider it lines up with: `Sharpshooter` and
`3-and-D` → `threePointRate`, `Slasher` and `Athletic` → `rimAttack`, `Post Scorer` → `postPlay`.
`Playmaker`, `Lockdown`, and `Floor General` have no offense-slider counterpart and map to `{}`.
When the plan leans into a slider (`sliderValue > 50`) and matching `devFocus` players are on the
healthy top 8, a small additive bonus (`+0.02` per matching player, capped at `+0.06` total) stacks
on top of the ratings-based fit above. This is a bonus only, not a symmetric penalty — it doesn't
fire when the slider leans away from the archetype.

### Apply (`GameSim.basketball/index.ts`, `getShotInfo`)

`t.schemeFit = { threePointer, atRim, lowPost }` multiplies the shooting team's own `probMake` in
the three matching branches of the shot-type if/else chain:

- Three-pointer branch (after `helpAggressionThreeEfficiencyFactor`) × `schemeFit.threePointer`
- `atRim` branch (after the positional-depth-tax `oppRim` read) × `schemeFit.atRim`
- `lowPost` branch (after `pickCoverageInteriorFactor`) × `schemeFit.lowPost`

Read via `this.team[this.o]!.schemeFit?.threePointer/atRim/lowPost ?? 1` (the **offense** team's
own fit, unlike `depthTax.oppRim` which reads the opponent) — this deliberately pairs with the frequency effects
the Phase 1 sliders already have: the slider makes you _take_ more of a shot, scheme fit decides
whether taking more of it actually _helps_. `tipIn`/`putBack` shot types are unaffected (opportunistic,
not plan-driven shot selection).

### Key files

| File                                          | Role                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/common/types.ts`                         | `GameAttributesLeague.schemeFit`                                                     |
| `src/common/defaultGameAttributes.ts`         | Registers the attribute for basketball, default `false`                              |
| `src/ui/views/Settings/settings.tsx`          | "Scheme Fit" toggle under Challenge Modes                                            |
| `src/worker/core/team/schemeFit.ts`           | `computeSchemeFit` — capability averaging + fit/affinity formulas                    |
| `src/worker/core/player/developSeason.ts`     | `DEV_FOCUS_GAMEPLAN_AFFINITY` export, alongside `DEV_FOCUS_RATINGS`                  |
| `src/worker/core/game/loadTeams.ts`           | `processTeam` computes `t.schemeFit`, gated on the attribute                         |
| `src/worker/core/GameSim.basketball/index.ts` | `TeamGameSim.schemeFit` type; applies it in `getShotInfo`'s three shot-type branches |

### Future phases

Phase 5 (in-series AI adjustments) has since been built — see Feature 8 below.

---

## Feature 7: Team Chemistry (Harder RPD Challenge, Phase 4)

### What it does

A stored, slowly-drifting per-team value (0–100, neutral 50) that rewards continuity and recent
winning, and punishes stacking high-usage stars or churning the roster — so a superteam assembled
overnight underperforms until it gels, and blowing up a roster every offseason has a cost. Gated
behind the `teamChemistry` game attribute (default `false`); a neutral no-op (`chemistry` stays
`undefined`, treated as 50) when off. Applies to **every** team, user and AI alike, same as
positional-depth tax and scheme fit — `processTeam` reads whatever is stored on that team's
`teamSeason`, no branch on `userTids`.

### Storage

`TeamSeason.chemistry?: number` (`src/common/types.ts`) — optional, so no migration needed, same
approach as `Team.gamePlan`.

### Update loop (`src/worker/core/team/updateChemistry.ts`)

Two update points:

- **Per-game drift** — `updateTeamChemistry(teamSeason, players)`, called once per team per game
  from `writeTeamStats.ts` (right after the win/loss/streak block is updated, so `streak` is
  current; runs in the regular season **and** playoffs, since `writeTeamStats` itself isn't
  phase-gated). Drifts `teamSeason.chemistry` toward a `computeChemistryTarget` value by
  `CHEMISTRY_DRIFT_RATE` (0.03/game, ~a month of games to converge):
  - **Recent results**: `teamSeason.streak` (win streak up, losing streak down), capped at ±15.
  - **Star density** ("can't just stack stars" lever): counts healthy players with `value ≥ 75`
    (same 0–100 scale as ovr/pot); the first two are free, each additional star costs 4, capped at
    a 20-point penalty.
  - **In-season churn**: reuses `teamSeason.numPlayersTradedAway` (already tracked, sigmoid-weighted
    by trade value — see `processTrade.ts`) rather than re-deriving roster overlap, capped at a
    20-point penalty.
- **Season-rollover seed** — `seedSeasonChemistry(prevChemistry, continuityFraction)`, called once
  per team from `newPhasePreseason.ts`, **after** the players array's `tid`s are fully finalized
  for the new season (including the `forceHistoricalRosters` reassignment loop — this must run
  after that, not alongside the per-team `genSeasonRow` loop earlier in the same function, or
  continuity would be computed against not-yet-final rosters). `continuityFraction` is the share of
  the new season's opening roster (by headcount) whose `p.stats` already has a row with
  `season === newSeason - 1` and `tid` equal to their current team — i.e. "played for this team last
  season," read straight off in-memory player objects with no extra DB query. Even at full
  continuity there's some natural offseason regression toward neutral
  (`OFFSEASON_RETENTION = 0.8`); zero continuity resets to neutral outright. First-ever season for a
  team (no `prevChemistry`) seeds at neutral 50.

### Apply (`processTeam` → `GameSim.basketball`)

```
t.chemistry = 0.95 + (teamSeason.chemistry / 100) * 0.10   // [0.95, 1.05], ±5%
```

computed in `processTeam` (`loadTeams.ts`) when `g.get("teamChemistry")` is on, falling back to the
neutral 50 when `teamSeason.chemistry` is unset (e.g. All-Star games, or a save that just enabled
the toggle). Applied in `updateTeamCompositeRatings` (`GameSim.basketball/index.ts`), right after
the positional-depth tax, at **full** swing on offense (`dribbling`, `passing` — the same ratings
`synergy.off` was just folded into) and **half** swing on defense (`defense`, `defensePerimeter`,
`blocking`, via `1 + (chemistry - 1) * 0.5`) — a tiebreaker between similarly-talented teams, not a
talent replacement.

### UI

`ChemistryMeter.tsx` — a small labeled progress bar ("Gelling" ≥65, "Discord" ≤35, else "Neutral"),
rendered in `TopStuff.tsx` next to the MOV/Age row. Reads `t.seasonAttrs.chemistry`, added to the
`seasonAttrs` list in `src/worker/views/roster.ts`; renders `null` and is skipped entirely when
`chemistry` is `undefined` (toggle off, or a sport/build where it was never tracked), so no separate
UI flag needs to be threaded through. Shown for historical seasons too, not just the current one
(unlike `RosterBalance`, which is scoped to "your active roster right now").

### Key files

| File                                          | Role                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `src/common/types.ts`                         | `GameAttributesLeague.teamChemistry`; `TeamSeason.chemistry`             |
| `src/common/defaultGameAttributes.ts`         | Registers the attribute for basketball, default `false`                  |
| `src/ui/views/Settings/settings.tsx`          | "Team Chemistry" toggle under Challenge Modes                            |
| `src/worker/views/newLeague.ts`               | Default value plumbed into `NewLeagueSettings`                           |
| `src/worker/core/team/updateChemistry.ts`     | `computeChemistryTarget`, `updateTeamChemistry`, `seedSeasonChemistry`   |
| `src/worker/core/game/writeTeamStats.ts`      | Calls `updateTeamChemistry` once per team per game                       |
| `src/worker/core/phase/newPhasePreseason.ts`  | Calls `seedSeasonChemistry` once per team at season rollover             |
| `src/worker/core/game/loadTeams.ts`           | `processTeam` computes `t.chemistry`, gated on the attribute             |
| `src/worker/core/GameSim.basketball/index.ts` | `TeamGameSim.chemistry` type; applies it in `updateTeamCompositeRatings` |
| `src/worker/views/roster.ts`                  | Adds `"chemistry"` to the `seasonAttrs` list                             |
| `src/ui/views/Roster/ChemistryMeter.tsx`      | The meter component                                                      |
| `src/ui/views/Roster/TopStuff.tsx`            | Renders `ChemistryMeter`                                                 |

### Future phases

Phase 5 (in-series AI adjustments) has since been built — see Feature 8 below.

---

## Feature 8: In-Series AI Adjustments (Harder RPD Challenge, Phase 5)

### What it does

During a playoff **series**, the AI opponent's coach reads the user's shot profile from the games
already played _in that series_ and nudges its own defensive game-plan sliders (Phase 1) to
counter it — so a superior-but-predictable team can get out-schemed instead of running the same
plan for seven games. Pure heuristic, no LLM calls. Gated behind the `inSeriesAdjustments` game
attribute (default `false`); a neutral no-op when off. Unlike Phases 2–4, this is the deliberate
exception to "applies to every team" — it only ever adjusts an **AI** team's plan, and only to
counter the **user**, since the user already chooses their own plan.

### Where it hooks in (`processTeam`, `loadTeams.ts`)

Right after `playoffs` is computed, `processTeam` builds a local `gamePlan` variable (starting as
`teamInput.gamePlan`) and, only when the team being processed is an AI team
(`!g.get("userTids").includes(teamInput.tid)`), it's the playoffs, it's not the All-Star game, and
`inSeriesAdjustments` is on, calls `getInSeriesGamePlan(tid, gamePlan)` to (possibly) override it.
Every other read that used to say `teamInput.gamePlan` (the `t.gamePlan` assignment, the pace
modifier, the scheme-fit slider reads) now reads this local `gamePlan` instead — one source of
truth, and `teamInput`/`t.tid`'s actual stored `Team.gamePlan` is never mutated, so the adjustment
only ever affects the game being loaded, never persisted.

### Finding the series + prior games (`getInSeriesGamePlan`, `loadTeams.ts`)

Mirrors the existing `isGame6EliminationGameOrGame7` lookup pattern in the same file: pulls
`idb.cache.playoffSeries.get(season)`, finds the `series` entry in the current round where this
tid is home or away, and reads `series.gids` — the list of gids **already played in this exact
series** (pushed by `updatePlayoffSeries.ts` after each game, so by the time `processTeam` runs for
game _N_, `gids` holds games `1..N-1`). No `gids` yet (game 1, or team not in an active series) is
a no-op — nothing to learn from. Prior box scores are fetched with `idb.getCopy.games({ gid })` per
gid (always in `idb.cache` for the current season, since box-score pruning only touches past
seasons — see `saveOldBoxScores` in Feature 3b).

### Building the shot profile

From each prior series game's `GameTeam` box score for the **opponent** (the user's team), sums
`fga`, `tpa`, `tp`, `fgaAtRim`, `orb`, `pts`, and the leading scorer's `pts` (`Math.max` over
`opp.players`) — all raw team/player stats already recorded by the sim (see
`src/worker/core/team/stats.basketball.ts`), no new tracking needed. Averaged into an
`OpponentSeriesShotProfile`: `threePointRate` (`tpa/fga`), `threePointAccuracy` (`tp/tpa`),
`rimRate` (`fgaAtRim/fga`), `orbPerGame`, `starUsageShare` (leading scorer's share of team points).

### The heuristic (`src/worker/core/team/inSeriesAdjustments.ts`, pure)

Mirrors `positionalDepthTax.ts` / `schemeFit.ts`: a pure, DB-free compute module. Each signal is a
deviation from a roughly-league-average neutral baseline (e.g. `NEUTRAL_THREE_POINT_RATE = 0.38`),
not a hard threshold — a team that's exactly average on a signal contributes nothing:

- `threePointThreat = (threePointRate − 0.38) + (threePointAccuracy − 0.36) × 2` → lowers
  `helpAggression` (stay home on shooters) and raises `perimeterPressure` (contest the ball) against
  a hot, high-volume three-point series.
- `paintThreat = (rimRate − 0.35) + (orbPerGame − 10) × 0.04` → raises `pickCoverage`
  (switch/blitz) and `defensiveGlass` against a series opponent living in the paint or crashing the
  offensive glass.
- `starThreat = starUsageShare − 0.28` → also raises `pickCoverage` (switch/blitz the ball-dominant
  star) on top of the paint contribution.

`computeSeriesEscalation` scales every adjustment by series progress (`gamesPlayed /
(numGamesSeries − 1)`, so games 5–7 of a 7-game series hit harder than game 2) × `1.3` if the AI is
trailing the series. Each slider's final delta is capped at ±25 from its stored value
(`MAX_ADJUSTMENT`) so the AI plan stays coherent even against an extreme profile, then the result
is bounded back to `[0, 100]`.

### Key files

| File                                          | Role                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/common/types.ts`                         | `GameAttributesLeague.inSeriesAdjustments`                                            |
| `src/common/defaultGameAttributes.ts`         | Registers the attribute for basketball, default `false`                               |
| `src/ui/views/Settings/settings.tsx`          | "In-Series AI Adjustments" toggle under Challenge Modes                               |
| `src/worker/core/team/inSeriesAdjustments.ts` | `computeInSeriesAdjustments`, `computeSeriesEscalation` — the pure heuristic          |
| `src/worker/core/game/loadTeams.ts`           | `getInSeriesGamePlan` (series/box-score lookup) + `processTeam`'s `gamePlan` override |

No `GameSim.basketball` changes — Phase 5 only chooses different values for the Phase 1 defensive
sliders, which are already wired into the sim.

### Future phases

None planned — Phase 5 was the last item in `CHALLENGE_FEATURES_PLAN.md`'s original scope. The
plan's optional "5d" polish (logging a play-by-play/news note when the AI adjusts, e.g. "Opponent
adjusted: switching everything on your pick-and-roll") was deliberately skipped: it needs a
`Conditions` object threaded from `loadTeams` into `processTeam` (which doesn't currently receive
one), a bigger plumbing change than the heuristic itself. Worth adding as a fast-follow if the
adjustment ends up feeling invisible in practice.

---

## Feature 9: Game Plan Rebalance (Talent-Gated Execution)

### What it does

Fixes the exploit documented in `GAME_PLAN_REBALANCE_PLAN.md`: a 24 OVR team with every Game Plan
dial (Feature 4) cranked went 71-11, because every possession-economy slider read zero player
ratings — the sliders were power dials, not coaching decisions. This rebalance makes a dial's
_benefit_ scale with whether the roster can actually execute it, while every dial's _cost_ stays
ungated (design principle: "aggression is free to call, expensive to execute badly"). It also
fixes the corollary bug that every AI team had `gamePlan === undefined` forever (the only write
site was the user's own `updateGamePlan` endpoint), meaning the user's dials were being exploited
against opponents who could never dial back and never paid the sliders' costs.

Shipped as 5 independently-mergeable PRs, all landed:

- **PR-1 — Stop the bleeding**: rebound contest rewrite (additive, not multiplicative — the old
  factor-ratio math squared the intended swing into a ~25pp ORB% exploit), turnover-pressure
  resize, transition fast-break magnitude cap, shot-mix slider ranges narrowed, `threePointRate`
  now modulates the era factor instead of replacing it.
- **PR-2 — Execution quality**: the `eq()` helper (F-A) wired into every possession dial;
  `pickCoverage`/`helpAggression` restructured to be two-sided (both ends priced, both ends gated
  by the composite they actually depend on); scheme-fit `K` raised 0.3 → 0.5.
- **PR-3 — Usage curve** (the "Cade fix"): running ISO ball costs the shooter probMake and extra
  energy drain, scaled by how far his usage-composite talent falls short of a true #1 option's.
- **PR-4 — AI game plans**: every AI team gets a personnel-driven plan (`genAiGamePlan`) instead of
  `gamePlan === undefined` forever; revives Phase 5 in-series adjustments (Feature 8), which were
  dead code for AI teams for exactly that reason.
- **PR-5 — UI honesty**: small execution-quality badges ("Elite execution" / "Average execution" /
  "Poor execution") next to the possession-economy sliders in `GamePlanEditor.tsx`, so a dial that
  silently underperforms doesn't just feel broken.

### The `eq()` helper (F-A)

```
intent(slider) = (slider − 50) / 50                          // ∈ [−1, +1]
eq(composite)  = bound(0.5 + 1.7 × (composite − 0.62), 0.25, 1.0)
```

`EQ_PIVOT = 0.62` (not the naively-expected 0.5) is empirically measured, not assumed: a raw
`player.generate()` call produces an undeveloped ~19-year-old draft-prospect-quality player, and
even a textbook-neutral "every rating = 50" synthetic roster produces wildly unrealistic game
stats (25–30% FG, 30+ TOV/game) despite hitting composite = 0.5 exactly — this sim's actual
in-game team composites (rebounding/defense/defensePerimeter/dribbling/passing/blocking, as
`updateTeamCompositeRatings` computes them) cluster around 0.62 for a _realistically-generated_
league-average roster (see `gamePlan.test.ts`'s harness, which builds rosters via the real
`createRandomPlayers` league-creation pipeline specifically because of this). `EQ_SLOPE = 1.7`
means an elite unit (composite ≳0.62 + 0.22) hits the `eq = 1.0` ceiling and an awful one (composite
≲0.62 − 0.22) hits the `eq = 0.25` floor.

Every possession dial's benefit multiplies by `eq()` of the composite it depends on; every dial's
cost is ungated. All tuning constants (slopes, thresholds, the pivot) live in one file,
`GAME_PLAN_TUNING`, so retuning is a one-file edit — see `gamePlanTuning.ts`'s per-constant
comments for the reasoning behind each number, several of which needed real recalibration against
measured sim behavior rather than the plan doc's initial guesses (e.g. `USAGE_THRESHOLD` and
`USAGE_ISO_PENALTY_SLOPE` for F-F, both measured against the actual post-`**1.9` usage-composite
distribution of a realistic league, not assumed).

### Key mechanics by dial

- **Rebounds** (`doReb`): additive delta on drb probability — `defensiveGlass`/`crashOffensiveGlass`
  benefits gated by `eq(rebounding)` of the relevant team; `perimeterPressure`'s rebounding cost and
  `pickCoverage`'s below-50 rebounding bonus stay ungated. Bounded to ±6pp total.
- **Turnovers** (`probTov`, `getShotInfo`): `perimeterPressure`'s TOV benefit gated by
  `eq(defensePerimeter)`; the foul-rate cost and a new "blown by the dribble → more rim attacks"
  frequency cost stay ungated.
- **Transition** (`getPossessionOutcome`, `doShot`): fast-break generation gated by `eq()` of the
  on-court pace composite; ungated costs are an extra live-ball TOV roll (scaled by
  `1 − eq(ballHandling)`) and extra shooter energy drain.
- **`pickCoverage`/`helpAggression`** (`getShotInfo`, `usagePower`): fully two-sided now — e.g.
  `pickCoverage` above 50 (switch/blitz) gates interior efficiency + usage dampening by
  `eq(defensePerimeter)`, conceding 3PT frequency ungated; below 50 (drop) gates atRim efficiency by
  `eq(blocking)`, conceding midrange frequency/efficiency ungated.
- **Usage curve** (`getShotInfo`, `doShot`): `probMake -= USAGE_ISO_PENALTY_SLOPE × isoIntent ×
max(0, USAGE_THRESHOLD − usageComposite)` when `ballMovement < 50` — a true #1 option
  (usage composite at the league's real ceiling, ~0.55–0.59) pays ~nothing; a good-but-not-special
  player pays a real efficiency cost. Plus a flat extra energy-drain cost on the shooter.
- **Shot-mix sliders** (`threePointRate`/`rimAttack`/`postPlay`): frequency ranges narrowed to
  0.6×–1.5× (was up to 12.5× for `threePointRate`); efficiency judged by scheme fit (Feature 6),
  whose `K` is now 0.5.

### AI game plans (`genAiGamePlan`, F-H)

Pure function, `src/worker/core/team/genAiGamePlan.ts`: maps a team's composite ratings
(`shootingThreePointer`, `defensePerimeter`, `rebounding`, `pace`, top-player `usage` dominance) to
slider values via `50 + ((composite − EQ_PIVOT) / SPREAD) × 25`, clamped to ~25–75 (never an
extreme — an AI plan reads as "leans into its roster," not "every dial maxed"). Contending teams
amplify the deviation ×1.25 vs rebuilding teams. Only `threePointRate`, `perimeterPressure`,
`crashOffensiveGlass`/`defensiveGlass`, `transition`, and `ballMovement` have explicit formulas;
`pace`, `postPlay`, `rimAttack`, `pickCoverage`, `helpAggression` stay neutral 50 — deliberately
conservative scope, matching exactly what the plan doc specified rather than inventing untested
extra heuristics.

Called from `processTeam` (`loadTeams.ts`) when `teamInput.gamePlan === undefined` for an AI team,
gated behind the new `aiGamePlans` game attribute (default **on** — this is a fairness fix, not a
difficulty toggle; without it AI teams stay exploitable regardless of the other Challenge Mode
settings). The Phase 5 in-series-adjustment guard (Feature 8) no longer requires
`gamePlan !== undefined` — every AI team now has _some_ plan (stored or AI-generated) to adjust, so
Phase 5 is no longer dead code for AI teams.

### UI (`GamePlanEditor.tsx`, F-J)

`gamePlanExecution.ts` recomputes the same 4 team composites (rebounding/defense/defensePerimeter/
blocking) plus pace from the current roster's top-8-healthy-by-rosterOrder players (raw ratings →
`player.compositeRating`, since this view doesn't go through `processTeam`), maps each through
`eq()` to a "Poor"/"Average"/"Elite" label, and plumbs it through `views/roster.ts` as
`t2.gamePlanExecution` (current season only, same scoping as Feature 5's `RosterBalance`). Rendered
as small colored badges next to the 6 possession-economy sliders whose benefit is `eq()`-gated
(`transition`, `crashOffensiveGlass`, `pickCoverage`, `perimeterPressure`, `helpAggression`,
`defensiveGlass`).

### Test suite

`src/worker/core/GameSim.basketball/gamePlan.test.ts` — the permanent statistical harness (Suites
A–D from the plan doc's §6). Notable design decisions, all born from real flakiness/inaccuracy
hit while building this:

- Rosters are generated via the real `createRandomPlayers` league-creation pipeline (20 simulated
  draft classes + `player.develop`), not raw `player.generate()` or synthetic uniform ratings —
  both of the latter produce wildly unrealistic game stats even at "textbook average" composite
  values (see EQ_PIVOT's derivation above).
- Roster generation is seeded (a tiny `mulberry32` PRNG temporarily swapped in for `Math.random`)
  so the file's calibration bands don't flake across separate test-process runs; game-simulation
  randomness itself is deliberately left unseeded (that's the thing being statistically sampled).
- Team 1 is a clone of team 0's roster (not independently generated) for the average-vs-average
  suites, so gamePlan-only comparisons aren't confounded by roster asymmetry.
- Suite C's "elite"/"awful"/"mid-tier" tids are picked by the _actual in-game value_ of the specific
  composite a test cares about (constructing a real `GameSim` and reading
  `compositeRating[key]`), not a generic OVR ranking or a static raw-ratings approximation — both
  were tried first and found not to correlate reliably with what `eq()` actually reads.
- `aiGamePlans` is forced off in the shared test harness (`resetG`'s `userTids: [0]` makes tid 1
  an "AI team," which would otherwise get an F-H-generated plan instead of actually staying
  `gamePlan: undefined`) — Suite D's tests turn it back on explicitly to test F-H itself.
- T-D2 (a full-league season script: Spearman corr(OVR, wins) ≥ 0.65, etc.) is intentionally not
  implemented — it needs hundreds of games across 30 teams, out of place in an otherwise-fast unit
  suite. Follow the `genRatings.test.ts` `describe.skip` pattern if it gets built out later.

`src/worker/core/team/genAiGamePlan.test.ts` — pure unit tests on the AI plan generator itself (no
roster/GameSim harness needed).

### Key files

| File                                                   | Role                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `GAME_PLAN_REBALANCE_PLAN.md`                          | The original investigation + fix spec this feature implements                                         |
| `src/worker/core/GameSim.basketball/gamePlanTuning.ts` | `GAME_PLAN_TUNING`, `eq`, `intent`, `clampScheme` — the F-A helper + F-I rails                        |
| `src/worker/core/GameSim.basketball/index.ts`          | `doReb`, `probTov`, `getPossessionOutcome`, `getShotInfo`, `doShot` — all the talent-gated sim wiring |
| `src/worker/core/team/schemeFit.ts`                    | `K` raised 0.3 → 0.5                                                                                  |
| `src/worker/core/team/genAiGamePlan.ts`                | F-H — the pure AI game-plan generator                                                                 |
| `src/worker/core/team/gamePlanExecution.ts`            | F-J — execution-quality labels for the UI                                                             |
| `src/worker/core/team/inSeriesAdjustments.ts`          | `NEUTRAL_GAME_PLAN` export (fallback for Phase 5 when `aiGamePlans` is off)                           |
| `src/worker/core/game/loadTeams.ts`                    | `processTeam` — AI-gen + Phase 5 resolution order; revived guard                                      |
| `src/common/types.ts` / `defaultGameAttributes.ts`     | `aiGamePlans` game attribute (default `true`)                                                         |
| `src/ui/views/Roster/GamePlanEditor.tsx`               | Execution-quality badges                                                                              |
| `src/worker/views/roster.ts`                           | `t2.gamePlanExecution` plumbing                                                                       |
| `src/worker/core/GameSim.basketball/gamePlan.test.ts`  | Suites A–D                                                                                            |
| `src/worker/core/team/genAiGamePlan.test.ts`           | T-D1                                                                                                  |

### Future work

T-D2 (full-league tuning-pass script) and further magnitude tuning against it — several constants
in `GAME_PLAN_TUNING` were calibrated against two real rosters rather than a full 30-team season,
and the plan doc's own aspirational targets (e.g. all-dials-maxed swing ≤ +3 pts/100, currently
tighter than the pre-rebalance state but still measured at ≤ +8) call for a proper tuning pass once
that script exists.

---

## Key Concepts / Gotchas

- **Rating keys**: `tp` = three-point shooting, `fg` = mid-range, `ft` = free throw, `ins` = inside scoring, `dnk` = dunking, `diq` = defensive IQ, `oiq` = offensive IQ, `pss` = passing, `drb` = dribbling, `reb` = rebounding, `stre` = strength, `spd` = speed, `jmp` = jumping, `endu` = endurance
- **RPD (Real Player Determinism)**: when set to 100%, all player development follows historical NBA data. Dev Override exempts a player from this.
- **`developSeason.ts` vs `developSeason.basketball.ts`**: the `.ts` wrapper handles RPD, override, floor, breakthrough. The `.basketball.ts` handles base rating math per key.
- **SharedWorker**: the game runs its simulation in a web worker. All DB access (`idb.cache.*`, `idb.getCopies.*`) happens in worker context. Gemini API calls are made from the worker, not the UI thread.
- **`makeItWork`**: core trade utility that adds/removes assets to balance trade value. Called with `holdUserConstant: true` so the user's offered players stay fixed.
