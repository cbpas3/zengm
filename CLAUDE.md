# CLAUDE.md — ZenGM Custom Features

This file documents the custom features added on top of the upstream ZenGM basketball simulation. Use it to orient a new chat session without re-reading the full conversation history.

---

## Project Overview

ZenGM is an open-source sports management simulation. This fork adds:

1. **Player Development System** — archetype-based training, breakthrough seasons, regression floors
2. **Gemini AI Trade Engine** — Gemini Flash powers the trading block, acting as all opposing GMs
3. **AI Article Generation** — Gemini-written game recaps ("Way 1") and team season retrospectives ("Way 3")

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

**Two-pass generation** — `generateSeasonStoryArticle(tid, season)` in `gemini.ts`:

1. **Outline pass** — ground truth → JSON `{ title, angle, beats: [{ when, what, why_it_mattered }] }` (4–6 beats), `thinkingLevel: "low"`
2. **Prose pass** — ground truth + the approved outline → 600–900 word retrospective (setup → turning point → climax → resolution), `thinkingLevel: "medium"` for coherence over the longer arc

`callGemini` was extended to accept `thinkingLevel` and `maxOutputTokens` in its options (previously hardcoded to `"low"` / `8192`).

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
{ article: string | null, usedFallback: boolean }
```

### Scope

Ephemeral only — a saved archive needs a new league-DB object store + schema migration, deferred until narrative quality is proven. Multi-season/dynasty pieces, player-career pieces, and league-in-review are separate future phases reusing the same aggregation + two-pass machinery (the dynasty version is where box-score pruning across older seasons in the window matters most).

---

## Key Concepts / Gotchas

- **Rating keys**: `tp` = three-point shooting, `fg` = mid-range, `ft` = free throw, `ins` = inside scoring, `dnk` = dunking, `diq` = defensive IQ, `oiq` = offensive IQ, `pss` = passing, `drb` = dribbling, `reb` = rebounding, `stre` = strength, `spd` = speed, `jmp` = jumping, `endu` = endurance
- **RPD (Real Player Determinism)**: when set to 100%, all player development follows historical NBA data. Dev Override exempts a player from this.
- **`developSeason.ts` vs `developSeason.basketball.ts`**: the `.ts` wrapper handles RPD, override, floor, breakthrough. The `.basketball.ts` handles base rating math per key.
- **SharedWorker**: the game runs its simulation in a web worker. All DB access (`idb.cache.*`, `idb.getCopies.*`) happens in worker context. Gemini API calls are made from the worker, not the UI thread.
- **`makeItWork`**: core trade utility that adds/removes assets to balance trade value. Called with `holdUserConstant: true` so the user's offered players stay fixed.
