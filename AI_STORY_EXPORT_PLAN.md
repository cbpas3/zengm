# AI Story Export — Design & Build Plan

Status: **Phase 1 implemented 2026-07-29; schema v2 (correctness + enrichment pass) 2026-08-09.**
See CLAUDE.md's "Feature 10: AI Story Export (Phase 1, v2 schema)" for the as-built summary, the
full v1 bug-report table, and key files. Deviations from this doc worth knowing before reading it as
ground truth:

- **The v1 bundle was used to write real articles against an 80-season league and produced a
  detailed bug report.** Everything below §1 still describes the intended architecture correctly,
  but the _field-level_ specifics are superseded by the v2 schema: `meta.version` is now `2`, six
  new tables ship (`playoffSeries.json`, `awards.json`, `leaderboards.json`, `league.json`, plus
  `meta.dataCoverage` and `meta.validation`), every projected field is `T | null` rather than
  possibly-undefined, derived stats (`ws = ows + dws`, `trb = trb + orb + drb`) go through
  `statFields.ts`, and the README is generated from the bundle's own file manifest instead of being
  written by hand. The report's headline finding is worth internalising before touching this code:
  **it read display stat names off storage records**, and `undefined ?? 0` produced fields that were
  present, numeric, and uniformly wrong — including `ws`, on which the entire greatest-players and
  busts/steals canon depended.

- **Delivery is a single navigable JSON** (a virtual-filesystem object keyed by path via
  `bundleToVirtualFs`), not a multi-file zip — the repo has no zip dependency, and one file is
  simplest to hand to a model. §6's bundle layout still describes the logical contents (they are the
  keys of that object); the opt-in per-season NDJSON box-score bulk is embedded inline when
  requested (`includeFullGames`).
- **Two bugs surfaced during in-app + deploy testing**, both fixed: `idb.getCopies.teamSeasons`
  can't be called without a `tid`/`season` (the loader reads the store directly after a cache
  flush), and a production-build fingerprint/chunk bug in `buildJs.ts` (see CLAUDE.md's Deployment
  section) that 404'd `real-player-data` in any production build.
- Deployed to https://basketballgm.vercel.app (Vercel project `basketballgm`, scope
  `cbpas-projects`); see CLAUDE.md's Deployment section.

Phases 2–3 (scoped Tier-2 exports + canon feedback; league-DB persistence/dynasty pieces) remain as
specced below.

## 0. Motivation

Features 3a/3b (AI game recaps + season retrospectives) call a small free OpenRouter model
on-device. The writing quality ceiling is the model, and the free tier isn't good enough for the
kind of narrative the user actually wants to read. This feature inverts the approach: **instead of
generating text on-device, export a rich, interconnected knowledge base and hand it to a stronger
external model (or a swarm of agents) that acts as an investigative sportswriter.** The fork's job
becomes producing _facts + structure + prompts_; the writing happens off-device with a frontier
model the user brings.

Two hard requirements shaped by the design conversation:

1. **Historical/relational context is the whole point.** A flat dump of one season or one career is
   data, not a story. What makes a title mean something is the web around it — the opponent's
   all-time standing, a prior Finals loss to that same team, a franchise's title drought, a player's
   career arc across teams. The export must carry that web, not just the focal facts.
2. **The consumer is an agent swarm.** The export must be _navigable_ (start at an entity, traverse
   to related ones by ID), which means normalized ID-linked tables, not one prose blob. And
   **foundational canon comes first** — "greatest players / teams / busts" get written before
   dependent pieces, so later articles reference an established, self-consistent canon.

## 1. Reality check against a real export

Validated against the user's actual save: `BBGM_League_23_2022_regular_season` — a ~75-season
league, **390 MB** uncompressed (60 MB gzipped), schema extracted via constant-memory streaming
(`jq --stream` / `ijson`). Findings that drive every decision below:

### 1a. Where the 390 MB lives

From leaf-token counts (~35.9M total):

| Store                    | Share of payload | Role                                                           |
| ------------------------ | ---------------- | -------------------------------------------------------------- |
| **`games`**              | **~89%** (31.9M) | Full per-player box scores for every game. This _is_ the file. |
| `players`                | ~9% (3.26M)      | Career data — much of which is itself cosmetic/financial noise |
| everything else combined | ~2% (0.65M)      | teams, events, awards, playoffSeries, headToHeads, …           |

**The entire narrative knowledge base — everything except game box scores — is ~11% of the file,
and much smaller after trimming noise.** This is the single most important fact in this plan: the
history-writing layer is small; the box-score bulk is big but rarely needed whole.

### 1b. The interconnections are already latent in the data

Several things originally scoped as "derive it" are already present, which is why enrichment
happens at the **export-projection layer, never the live IndexedDB schema** (no migrations, no
upstream-merge risk, no staleness):

- `players[].transactions[]` — every draft/trade/FA move (`type`, `fromTid`, `tid`, `season`,
  `phase`, `eid`). The career-movement timeline ("left, won elsewhere, came back") is prebuilt.
- `players[].stats[]` per season, tagged with `tid` + `playoffs`, incl. advanced stats
  (`per`, `ows`/`dws`, `vorp`, `obpm`/`dbpm`, `ortg`, `usgp`) and per-season game highs
  (`ptsMax`, …). **Careful:** this claim originally read "`ws` … `bpm`", and it is wrong — those are
  _display_ names assembled at read time by `common/processPlayerStats.basketball.ts`
  (`ws = ows + dws`, `bpm = obpm + dbpm`), not stored columns. So is `trb`, which modern rows
  express as `orb` + `drb`. Believing the original line is what produced the v1 export's
  all-zero win-share columns; `statFields.ts` now owns these rules.
- `players[].ratings[]` per season (full trajectory); `hof`, `retiredYear`, `diedYear`,
  `relatives[]`, `draft` (pick/round/year/`originalTid`), `value`, `college`, `born`, `statsTids[]`.
- `headToHeads` — pairwise franchise W/L for **both** regular season and playoffs, already
  aggregated. Rivalry data is mostly pre-computed (see §4 for the key-explosion caveat).
- `teams[].seasons[]` — full franchise history incl. `playoffRoundsWon` (title detection),
  div/conf splits, `ovrStart/End`, `streak`, `avgAge`.
- `playoffSeries[]` — complete brackets with per-series `gids`, seeds, `winp`.
- `awards[]` — every league award per season (MVP, DPOY, Finals MVP, All-League, All-Defensive,
  All-Rookie, best record, …).
- The fork's dev-system fields survive the export (`devFocus`, `devOverride`, `devProfile`,
  `focusFloor`) — breakthrough/mentorship texture is available.

### 1c. Positioning vs. the existing raw export

`ExportLeague` (`makeExportStream.ts`) already streams the whole DB, but it emits the **internal
storage schema verbatim** — verbose, full of narrative-irrelevant fields, and _flat_ (a record
doesn't know what it relates to). This feature is a **narrative-optimized projection**: trimmed to
what matters for writing, enriched with computed cross-references and rankings, ID-linked for agent
traversal. We reuse its cursor/streaming plumbing for the bulk layer, not its output shape.

## 2. Architecture — focal subject + concentric context, over a normalized KB

The export is one knowledge base plus a canon-first article pipeline. Not five separate exporters —
one context engine with different focal seeds.

```
        Ring 3: League-historical benchmarks     "is this number notable?"  (all-time ranks)
          Ring 2: Relational dossiers            opponent history, rivalries, prior meetings,
            Ring 1: Continuity                    key players' arcs, relatives, division context
              FOCAL SUBJECT (full fidelity)       the game / season / career / league-year
```

- **Focal subject** → full fidelity.
- **Rings 1–2 (directly related entities)** → rich but capsule-form (opponent gets a history
  paragraph, not their whole box-score archive; a key player gets a career timeline, not every game).
- **Ring 3 (league-historical)** → only the comparisons that make a focal number mean something
  ("4th-best win total in franchise history, 12th league-wide"), not raw leaderboards.

Relevance selection — _what_ each ring includes — is also the token-control lever (see §6).

## 3. The table set

### 3a. Entity tables (projected + cross-linked)

Each carries: a **stable id**, **foreign keys** to related entities, and **derived rollups**.

| Table           | Source                     | Added cross-refs / rollups                                                                                               |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `players`       | `players` (trimmed)        | `teamsPlayedFor[]`, `seasonsByTeam`, `relativePids[]`, `careerTitles`, `allTimeRank{}`, `peakSeason`, dev-system texture |
| `teams`         | `teams` (minus financials) | `titleSeasons[]`, `titleDrought`, `allTimeWinRankSingleSeason`, `divisionRivalTids[]`                                    |
| `teamSeasons`   | `teams[].seasons`          | link to `playoffSeriesId`, `rosterPids[]`                                                                                |
| `seasons`       | `awards` + league attrs    | champion tid, award winners, statistical leaders                                                                         |
| `games`         | `games` (**bulk layer**)   | `winnerTid`/`loserTid`, `playoffSeriesId`, `notablePerformancePids[]` — sharded by season                                |
| `playoffSeries` | `playoffSeries`            | `gids[]`, participant links                                                                                              |
| `awards`        | `awards`                   | winner pids/tids                                                                                                         |
| `events`        | `events` (type: trade/…)   | participant tids/pids                                                                                                    |

### 3b. Derived tables (the interconnection payload + canon seeds)

Tiny (<1–2 MB total), computed by a full-league aggregation pass. These are the fuel for the
foundational articles.

| Table                  | Computed from                                             | Seeds foundational article     |
| ---------------------- | --------------------------------------------------------- | ------------------------------ |
| `rankings.players`     | `value`/`hofFactor` + titles + awards + peak              | "Greatest Players of All Time" |
| `rankings.teamSeasons` | wins + `playoffRoundsWon` + margin + roster               | "Greatest Teams Ever"          |
| `rankings.busts`       | `draft.pick`/`round` vs career value delta                | "Biggest Busts"                |
| `rankings.steals`      | inverse of busts                                          | "Biggest Steals"               |
| `dynasties`            | clustered/consecutive `titleSeasons`                      | "Dynasties"                    |
| `rivalries`            | `headToHeads` + `playoffSeries` (close/frequent meetings) | "Great Rivalries"              |
| `relationships`        | `relatives[]`, mentorships (dev system), reunions         | player features / texture      |

## 4. Keep / trim / bulk classification (from the real schema)

| Bucket                                                            | Contents                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **KEEP** (compact layer)                                          | `players` (minus noise below), `teams[].seasons`, `teams[].stats`, `awards`, `playoffSeries`, `events`, `playerFeats`, `seasonLeaders`, `draftPicks`, `draftLotteryResults`, `scheduledEvents` (franchise renames/relocations), `headToHeads` (compressed — see below)                                                                                                                       |
| **TRIM** (drop as pure noise)                                     | all `players[].face.*` (~40 cosmetic fields), `ratings[].fuzz`/`injuryIndex`, all financials (`revenues`, `expenses`, `expenseLevels`, `budget`, `cash`, `hype`, `att`, `stadiumCapacity`, `ownerMood`, `salaries`, `payroll`), `valueFuzz`/`valueNoPotFuzz`, `numPlayersTradedAwayNormalized` (36 internal fields), `messages`, `savedTradingBlock`, `trade`, `schedule`, `releasedPlayers` |
| **BULK** (separate, sharded by `games[].season`, drill-down only) | `games[]` full box scores                                                                                                                                                                                                                                                                                                                                                                    |

**`headToHeads` caveat:** stored as an object keyed by every `tidA.tidB` pair with `regularSeason`
and `playoffs` sub-objects — a ~60k-leaf key-explosion that's schema-noisy but byte-small.
Don't pass it through raw; compress each pair to a compact `rivalries`-table summary
(all-time W/L, playoff series meetings, closest/most-recent) an agent can actually read.

### Resulting layer sizes (real numbers)

- **Compact interconnected KB** (KEEP, trimmed): ~15–25 MB raw, less after field-trimming. An agent
  can hold large slices at once.
- **Derived canon tables**: <1–2 MB. Trivially loadable — foundational-article fuel.
- **Bulk box-score layer**: ~340 MB, sharded per season, fetched only on drill-in.

### 4a. Game-access model — index + notable shard + filter script

Nobody wants the 340 MB box-score bulk loaded whole, but articles do need _specific_ games
("all of Yao's games," "just his notable ones"). Three pieces make that cheap:

- **Game index** (`gameIndex.json`, a few MB): one compact row per game —
  `gid, season, playoffs, tids, winnerTid, margin, pids[], notability, topScorerPid`. This is the
  queryable spine: an agent filters the index (e.g. `pids` contains a pid, `notability ≥ t`), gets a
  gid list, then fetches only those gids from the season shards. It never scans the box-score bulk.
- **Notable-games shard** (ships in the compact bundle): the subset of full box scores flagged
  notable, so most articles get game-level color with **no scripting**. Notability =
  produced a `playerFeat` ∪ any player's per-game "game score" ≥ threshold ∪ playoff
  clincher/elimination ∪ statement margin vs. a strong team. All thresholds live in one tunable
  constant. Per-_player_ notable games = games where that player's own game score is high or he
  recorded a feat / season career-high.
- **Filter script** (`pull_games.py`, shipped in the bundle): the "agent runs a script to grab the
  games it needs" path. `pull_games --pid <yao> [--notable] [--season …] [--playoffs]` reads the
  index, resolves matching gids, and streams just those box scores out of the sharded bulk in
  constant memory (same `ijson`/streaming pattern used to derive this plan's schema). Works whether
  the agent wants _all_ Yao games or only his notable ones.

So the box-score dilemma resolves as: the **default bundle is compact KB + canon + game index +
notable-games shard + `pull_games.py`** (~20-something MB). The full per-season box-score bulk is an
**opt-in "include full game detail"** download the script reaches into on demand.

## 5. The canon-first pipeline

A swarm writing hundreds of pieces will contradict itself without a shared canon. The pipeline is
tiered by dependency; consistency is enforced by a **canon index**.

- **Tier 0 — Facts.** The KB above. Data only, no opinions.
- **Tier 1 — Foundational canon** (no dependencies). Seeded by the `rankings.*` / `dynasties` /
  `rivalries` tables (computed ranking + evidence). The swarm writes "All-Time Greats," "Greatest
  Teams," "Busts/Steals," "Franchise Histories," "Rivalries." **Tier 1 emits structured canonical
  claims**, not just prose — e.g. `{subject: pid 42, claim: "3rd-greatest player ever", source:
"greats-01"}`. That set of claims is the canon index.
- **Tier 2 — Dependent pieces.** Season retrospectives, player features, game recaps. Each prompt
  gets Tier-0 facts (scoped to the subject) **plus the relevant Tier-1 canon claims**, so a title
  recap already "knows" it's the underdog's first ring against a chronicled dynasty and says so
  consistently with the franchise-history piece.

**Division of labor:** the fork produces Tier 0 (facts), the Tier-1 _seeds_ (ranked lists +
evidence), and a shipped **workflow spec + tiered prompt templates**. The external model/swarm does
the writing and emits the canon index. Re-importing generated canon as context (and optionally
persisting articles in a new league-DB store) is deferred to Phase 3.

## 6. Format & packaging

- **Bundle of normalized, ID-linked JSON tables** — `players.json`, `teams.json`, `seasons.json`,
  `playoffSeries.json`, `awards.json`, `events.json`, `rankings.json`, `relationships.json`,
  `gameIndex.json`, a `notableGames.json` shard, and `pull_games.py` (§4a) — plus, opt-in, a sharded
  `games/season-<yyyy>.ndjson` bulk dir — plus `README.md` + `canon-workflow.md` (prompt library +
  tier ordering). Compact JSON; the bulk shards are NDJSON (line-addressable/streamable). A
  single-file option for convenience.
- **Ground-truth preamble** in the README: "these are fictional simulated players; the data here is
  the complete and authoritative record; do not import real-world facts." (Same constraint that
  Feature 2's prompts lean on — it matters just as much for a strong model.)
- **Token control is relevance selection, not JSON-vs-Markdown.** JSON earns its place here because
  the payload is a _graph_ and cross-references must stay unambiguous. No one ever loads the whole
  390 MB; Tier-1 runs off the <2 MB canon tables, Tier-2 off scoped slices.

## 7. Files

**New `src/worker/util/storyExport/`:**

- `projectEntities.ts` — narrative projections (trim per §4, attach foreign keys).
- `deriveCanon.ts` — the full-league aggregation pass: `rankings.*`, `dynasties`, `rivalries`,
  `relationships`. (Needs a whole-league pass, like `buildSeasonGroundTruth` but league-wide/all-time
  — the streaming one-record model can't do global ranking.)
- `buildKnowledgeBase.ts` — orchestrates project + derive → the table set.
- `gameNotability.ts` — per-game "game score" + notability flags (§4a); builds `gameIndex` and the
  `notableGames` shard. Single tunable thresholds constant.
- `serialize.ts` — emit multi-file bundle (zip) or single JSON + the workflow docs + `pull_games.py`.
- `context.ts` — the ring walk: given a focal seed, pull the relevant dossiers.

**Shipped in the bundle (not app source):** `pull_games.py` — the index-driven, constant-memory
box-score filter (§4a), emitted verbatim by `serialize.ts`.

**New:** `src/common/storyWorkflow.ts` (tiered prompts + canon-index schema, shipped as data);
`src/ui/views/ExportStory.tsx` + `src/worker/views/exportStory.ts` (options: full-league KB vs
scoped; which derived tables; bundle vs single file), modeled on `ExportStats.tsx`.

**Reused:** `makeExportStream`'s cursor/streaming plumbing for the bulk `games` layer;
`buildSeasonGroundTruth` / `boxScore` as focal builders for Tier-2 scoped exports;
`downloadFile` / `downloadFileStream` for delivery.

**Wiring:** one worker endpoint (`exportStoryData`) + view/route/menu registration
(`worker/views/index.ts`, `ui/views/index.ts`, `ui/util/routeInfos.ts`, `ui/util/menuItems.tsx`);
inline "Export for AI" buttons next to the existing generate buttons in `GameLog.tsx` and
`TeamHistory/SeasonStory.tsx`.

## 8. Phasing

1. **Phase 1 — Knowledge base + canon seeds.** Entity projections with cross-refs (§3a) + derived
   ranking/relationship tables (§3b) + the game index, notable-games shard, and `pull_games.py`
   (§4a) + serialization (§6) + the Tier-1 workflow/prompts. The default bundle is the compact
   KB + canon + index + notable shard (~20-something MB); the full box-score bulk is the opt-in
   "include full game detail" download. This is "export as much interconnected info as possible" and
   directly produces the foundational-article seeds — with Phase 1 alone the user can run the
   foundational stage through their swarm.
2. **Phase 2 — Tier-2 scoped exports + canon feedback.** Season/player/game/league-year bundles that
   include relevant Tier-1 canon; define + support canon-index re-import for consistency.
3. **Phase 3 — Persistence / niceties.** Optional league-DB store for generated articles + in-app
   browser; dynasty/multi-season pieces reusing the same engine.

## 9. Resolved decisions

Settled 2026-07-18:

- **Bulk-layer delivery → index + notable shard + on-demand script (§4a).** Phase 1's default bundle
  ships the compact KB + canon + `gameIndex.json` + `notableGames.json` + `pull_games.py`, not the
  340 MB of box scores. Full per-season box-score shards are an opt-in "include full game detail"
  download; the script reaches into them to pull exactly the games an article needs (all of a
  player's games, or only the notable ones), driven by the index in constant memory.
- **`headToHeads` → reuse, don't recompute.** Use the pre-aggregated store for raw pair W/L
  (regular season + playoffs); compute only the "closeness/drama" ranking on top for the `rivalries`
  table.
- **User-authored context → no.** Everything foundational is derivable; no manual-tag stored field.
  (The Phase 3 "user tags" idea is dropped, not merely deferred.)
