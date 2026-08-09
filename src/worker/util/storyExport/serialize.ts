// Bundle serialization (AI Story Export, §6 in AI_STORY_EXPORT_PLAN.md).
//
// Turns an assembled KnowledgeBase (+ static workflow assets + optional box scores) into the set of
// bundle files: normalized ID-linked JSON tables, the game index, the README + canon-workflow doc,
// and pull_games.py. Compact JSON (no pretty-printing) since the payload is machine-consumed and
// token-sensitive.
//
// The README is *generated from the file list*, not written by hand. v1's README documented
// `games/season-<year>.ndjson` shards and told the reader to run `python pull_games.py --pid <id>`
// against a bundle that, by default, contained neither - three of the workflow's named data sources
// did not exist. Nothing here may claim a file that `files` does not contain, and validate.ts
// enforces that.

import {
	CANON_INDEX_NOTE,
	DEPENDENT_PROMPTS,
	documentedReadsFor,
	FOUNDATIONAL_PROMPTS,
	GROUND_TRUTH_PREAMBLE,
	PULL_GAMES_PY,
	type StoryPromptTemplate,
} from "../../../common/storyWorkflow.ts";
import { sanitizeBoxScore } from "./sanitizeBoxScore.ts";
import { validateKnowledgeBase } from "./validate.ts";
import type { KnowledgeBase } from "./types.ts";

export type BundleFile = { path: string; content: string };

export type SerializeOptions = {
	// The pre-filtered notable-games shard: full box scores for the notable gids that made the cap.
	notableBoxScores?: unknown[];
	// The opt-in bulk: full box scores grouped by season -> games/season-<yyyy>.ndjson. Omit to skip.
	fullGamesBySeason?: Map<number, unknown[]>;
};

const json = (value: unknown) => JSON.stringify(value);

const promptBlock = (p: StoryPromptTemplate) =>
	`### ${p.title}\n\n_Reads: ${p.inputs.join(", ")}_\n\n> ${p.prompt}\n`;

// One line per file, so the README's contents list is derived rather than asserted.
const FILE_DESCRIPTIONS: { path: string; describe: string }[] = [
	{
		path: "meta.json",
		describe:
			"League counts, the exact file list, `dataCoverage` (what's trustworthy and from which season), and the pre-export validation report. **Read this first.**",
	},
	{
		path: "players.json",
		describe:
			"Per-season stat lines (full counting stats, shooting, shot-location splits, advanced metrics), ratings + ZenGM skill labels per season, awards, injuries, transactions with both sides of each trade, career totals and highs, and pre-joined signature games. Keyed by `pid`.",
	},
	{
		path: "teams.json",
		describe:
			"Per-season record *and context* (points for/against, pace, offensive/defensive rating, conference and division finish, playoff seed), title seasons, drought, all-time record, division rivals, relocations. Keyed by `tid`. Includes defunct franchises (`disabled: true`).",
	},
	{
		path: "league.json",
		describe: "Conference and division names, so `cid`/`did` are readable.",
	},
	{
		path: "rankings.json",
		describe:
			"The derived canon: greatest players, greatest team-seasons, biggest busts and steals — each with the evidence fields the argument should be built from.",
	},
	{
		path: "dynasties.json",
		describe:
			"Clustered title runs, one entry per franchise's qualifying window.",
	},
	{
		path: "rivalries.json",
		describe:
			"Ranked rivalries: all-time head-to-head plus every playoff meeting, each linked to its series and its gids.",
	},
	{
		path: "playoffSeries.json",
		describe:
			"Every postseason series as a first-class record: season, round, seeds, series score, winner, and the gids of the games played.",
	},
	{
		path: "awards.json",
		describe:
			"Per-season award winners and the All-League / All-Defensive / All-Rookie teams. (ZenGM has no award voting, so there are no vote shares — see `meta.dataCoverage.unavailable`.)",
	},
	{
		path: "leaderboards.json",
		describe:
			'All-time career and single-season top 25 for the counting stats and advanced metrics, so "fourth-most points in league history" is a lookup.',
	},
	{
		path: "gameIndex.json",
		describe:
			"One compact row per game: final score, margin, who played, playoff round and series, notability, and `boxScoreIncluded` (whether this game's full box score is in the bundle). The queryable spine over the box-score bulk.",
	},
	{
		path: "notableGames.json",
		describe:
			"Full box scores for the standout games, capped. Cross-reference `gameIndex.boxScoreIncluded` to know what's retrievable.",
	},
	{
		path: "canon-workflow.md",
		describe: "The tiered prompt library. Start here after meta.json.",
	},
	{
		path: "pull_games.py",
		describe:
			"Filter the game index and pull matching box scores out of this bundle without scanning it whole. `python pull_games.py --bundle <file.json> --pid <id> --notable`.",
	},
	{
		path: "README.md",
		describe: "This file.",
	},
];

export const buildCanonWorkflow = (files: string[]): string => {
	const available = new Set(files);
	const applicable = (p: StoryPromptTemplate) =>
		p.inputs.every((input) => {
			const file = input.split(".")[0]!;
			// Non-file inputs ("canon claims") are always fine.
			return !file.endsWith("json") || available.has(file);
		});

	return [
		"# Story Export — Canon Workflow",
		"",
		GROUND_TRUTH_PREAMBLE,
		"",
		"Before writing anything, read `meta.json`'s `dataCoverage` block. It tells you which metrics",
		"exist for which seasons and which fields are null throughout this particular league — a",
		"metric that is `null` means *not computable*, never *replacement level*. `meta.validation`",
		"lists anything the exporter itself flagged as suspect.",
		"",
		"Write in two tiers. Do the **foundational** pieces first — they establish the canon the",
		"dependent pieces reference, which is what keeps a whole corpus self-consistent.",
		"",
		"## Tier 1 — Foundational (write these first)",
		"",
		...FOUNDATIONAL_PROMPTS.filter(applicable).map(promptBlock),
		"## The canon index",
		"",
		CANON_INDEX_NOTE,
		"",
		"## Tier 2 — Dependent (write these after Tier 1, with the canon index loaded)",
		"",
		...DEPENDENT_PROMPTS.filter(applicable).map(promptBlock),
	].join("\n");
};

export const buildReadme = (kb: KnowledgeBase, files: string[]): string => {
	const c = kb.meta.counts;
	const available = new Set(files);

	const coverageNotes = Object.entries(kb.meta.dataCoverage.metrics)
		.filter(([, m]) => m.rowsTotal > 0 && m.coverage < 0.995)
		.sort((a, b) => a[1].coverage - b[1].coverage)
		.slice(0, 12)
		.map(
			([key, m]) =>
				`- \`${key}\` — ${Math.round(m.coverage * 100)}% of rows${
					m.earliestSeason === null
						? " (never populated)"
						: `, first populated season ${m.earliestSeason}`
				}.`,
		);

	const validationLines =
		kb.meta.validation.issues.length === 0
			? ["The pre-export validation pass found no issues."]
			: [
					"**The pre-export validation pass flagged the following. Read these before trusting the affected tables.**",
					"",
					...kb.meta.validation.issues.map(
						(i) => `- _${i.severity}_ (${i.check}): ${i.message}`,
					),
				];

	return [
		"# ZenGM Story Export",
		"",
		GROUND_TRUTH_PREAMBLE,
		"",
		`League: ${kb.meta.leagueName ?? "(unnamed)"} · ${c.seasons} seasons · ${c.players} players · ${c.teams} active franchises (${c.teamsIncludingDisabled} including defunct) · ${c.games} games indexed, ${c.gamesWithBoxScores} with full box scores · ${c.playoffSeries} playoff series.`,
		kb.meta.generatedAtSeason !== null
			? `Exported as of season ${kb.meta.generatedAtSeason}.`
			: "",
		"",
		"## What's in here",
		"",
		"Normalized, ID-linked tables. Records cross-reference each other by id (`pid`, `tid`,",
		"`gid`, `season`, `seriesId`) so an agent can start at one entity and traverse to related ones.",
		"This list is generated from the bundle's actual contents — if a file isn't listed, it isn't here.",
		"",
		...FILE_DESCRIPTIONS.filter((f) => available.has(f.path)).map(
			(f) => `- \`${f.path}\` — ${f.describe}`,
		),
		files.some((f) => f.startsWith("games/"))
			? "- `games/season-<year>.ndjson` — the full box-score bulk, one game per line, sharded by season."
			: "",
		"",
		"## Reading the data honestly",
		"",
		"- **`null` means not computable, not zero.** Whole eras of an imported league predate the",
		'  advanced metrics, and a 0 there would read as "replacement level".',
		"- **Sentinels** (documented in full in `meta.dataCoverage.sentinels`): `playoffRoundsWon: -1`",
		"  means missed the playoffs; a `draft` of round 0 / pick 0 means undrafted (also flagged as",
		"  `draft.undrafted`); player stat rows with `tid` below 0 are free-agent/retired rows.",
		"- **Win shares are derived** as `ows + dws`; there is no stored `ws` column in ZenGM.",
		"- **`notable` is a score threshold, `boxScoreIncluded` is what shipped.** Many more games are",
		"  flagged notable than have box scores in the bundle; filter on the latter to know what you",
		"  can actually read.",
		...(coverageNotes.length > 0
			? [
					"",
					"### Partial coverage in this particular league",
					"",
					...coverageNotes,
					"",
					"Full detail, including the earliest reliable season per metric, is in `meta.dataCoverage`.",
				]
			: []),
		"",
		"## Validation",
		"",
		...validationLines,
		"",
		"## How to use it",
		"",
		"1. Read `meta.json` (coverage + validation), then `canon-workflow.md`.",
		"2. Write the **foundational** pieces first (greatest players/teams/busts/rivalries/dynasties)",
		"   — they run off the small `rankings.json` / `rivalries.json` / `dynasties.json` tables and",
		"   establish the canon.",
		"3. Collect the canonical claims those pieces emit into a canon index.",
		"4. Write **dependent** pieces (season retrospectives, player careers, game recaps), handing",
		"   each the scoped facts plus the relevant canon-index claims so they stay consistent.",
		"5. For game-level detail, filter `gameIndex.json` (or use `pull_games.py`) to the exact games",
		"   you need, then read those box scores — never load the whole bulk.",
	]
		.filter((line) => line !== "")
		.join("\n");
};

export const serializeBundle = (
	kb: KnowledgeBase,
	options: SerializeOptions = {},
): BundleFile[] => {
	// Data files first: the docs and the validation report both describe this exact set.
	const dataFiles: BundleFile[] = [
		{ path: "players.json", content: json(kb.players) },
		{ path: "teams.json", content: json(kb.teams) },
		{
			path: "league.json",
			content: json({
				conferences: kb.conferences,
				divisions: kb.divisions,
			}),
		},
		{
			path: "rankings.json",
			content: json({
				players: kb.canon.players,
				teamSeasons: kb.canon.teamSeasons,
				busts: kb.canon.busts,
				steals: kb.canon.steals,
			}),
		},
		{ path: "dynasties.json", content: json(kb.canon.dynasties) },
		{ path: "rivalries.json", content: json(kb.canon.rivalries) },
		{ path: "playoffSeries.json", content: json(kb.playoffSeries) },
		{ path: "awards.json", content: json(kb.awards) },
		{ path: "leaderboards.json", content: json(kb.leaderboards) },
		{ path: "gameIndex.json", content: json(kb.gameIndex) },
	];

	if (options.notableBoxScores) {
		dataFiles.push({
			path: "notableGames.json",
			content: json(options.notableBoxScores.map(sanitizeBoxScore)),
		});
	}

	if (options.fullGamesBySeason) {
		for (const [season, games] of options.fullGamesBySeason) {
			dataFiles.push({
				path: `games/season-${season}.ndjson`,
				content: games
					.map((g) => JSON.stringify(sanitizeBoxScore(g)))
					.join("\n"),
			});
		}
	}

	const files = [
		...dataFiles.map((f) => f.path),
		"meta.json",
		"README.md",
		"canon-workflow.md",
		"pull_games.py",
	];

	// Validate against what is actually being written, then ship the result inside the bundle.
	const issues = validateKnowledgeBase(kb, files, documentedReadsFor(files));
	kb.meta.files = files;
	kb.meta.validation = {
		passed: !issues.some((i) => i.severity === "error"),
		issues,
	};

	return [
		{ path: "meta.json", content: json(kb.meta) },
		...dataFiles,
		{ path: "README.md", content: buildReadme(kb, files) },
		{ path: "canon-workflow.md", content: buildCanonWorkflow(files) },
		{ path: "pull_games.py", content: PULL_GAMES_PY },
	];
};

// Single-file convenience: everything (except the opt-in box-score bulk) in one JSON object.
export const serializeSingleFile = (kb: KnowledgeBase): string => json(kb);

// Virtual filesystem: fold the bundle files into one JSON object keyed by path, so the whole bundle
// can be delivered as a single download without a zip dependency. .json files are embedded as parsed
// objects (so the result is one navigable JSON); text files (.md/.py/.ndjson) stay strings.
export const bundleToVirtualFs = (
	files: BundleFile[],
): Record<string, unknown> => {
	const out: Record<string, unknown> = {};
	for (const f of files) {
		out[f.path] = f.path.endsWith(".json") ? JSON.parse(f.content) : f.content;
	}
	return out;
};
