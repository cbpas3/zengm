// Bundle serialization (AI Story Export, Phase 1, §6 in AI_STORY_EXPORT_PLAN.md).
//
// Turns an assembled KnowledgeBase (+ static workflow assets + optional box scores) into the set of
// bundle files: normalized ID-linked JSON tables, the game index, the README + canon-workflow doc,
// and pull_games.py. Compact JSON (no pretty-printing) since the payload is machine-consumed and
// token-sensitive. The heavy box-score layer is opt-in: pass notableBoxScores for the pre-filtered
// shard, and/or fullGamesBySeason for the sharded bulk.

import {
	CANON_INDEX_NOTE,
	DEPENDENT_PROMPTS,
	FOUNDATIONAL_PROMPTS,
	GROUND_TRUTH_PREAMBLE,
	PULL_GAMES_PY,
	type StoryPromptTemplate,
} from "../../../common/storyWorkflow.ts";
import type { KnowledgeBase } from "./types.ts";

export type BundleFile = { path: string; content: string };

export type SerializeOptions = {
	// The pre-filtered notable-games shard: full box scores for notable gids. Omit to skip it.
	notableBoxScores?: unknown[];
	// The opt-in bulk: full box scores grouped by season -> games/season-<yyyy>.ndjson. Omit to skip.
	fullGamesBySeason?: Map<number, unknown[]>;
};

const json = (value: unknown) => JSON.stringify(value);

const promptBlock = (p: StoryPromptTemplate) =>
	`### ${p.title}\n\n_Reads: ${p.inputs.join(", ")}_\n\n> ${p.prompt}\n`;

export const buildCanonWorkflow = (): string =>
	[
		"# Story Export — Canon Workflow",
		"",
		GROUND_TRUTH_PREAMBLE,
		"",
		"Write in two tiers. Do the **foundational** pieces first — they establish the canon the",
		"dependent pieces reference, which is what keeps a whole corpus self-consistent.",
		"",
		"## Tier 1 — Foundational (write these first)",
		"",
		...FOUNDATIONAL_PROMPTS.map(promptBlock),
		"## The canon index",
		"",
		CANON_INDEX_NOTE,
		"",
		"## Tier 2 — Dependent (write these after Tier 1, with the canon index loaded)",
		"",
		...DEPENDENT_PROMPTS.map(promptBlock),
	].join("\n");

export const buildReadme = (kb: KnowledgeBase): string => {
	const c = kb.meta.counts;
	return [
		"# ZenGM Story Export",
		"",
		GROUND_TRUTH_PREAMBLE,
		"",
		`League: ${kb.meta.leagueName ?? "(unnamed)"} · ${c.seasons} seasons · ${c.players} players · ${c.teams} teams · ${c.games} games indexed.`,
		kb.meta.generatedAtSeason !== undefined
			? `Exported as of season ${kb.meta.generatedAtSeason}.`
			: "",
		"",
		"## What's in here",
		"",
		"Normalized, ID-linked tables. Records cross-reference each other by id (`pid`, `tid`,",
		"`gid`, `season`) so an agent can start at one entity and traverse to related ones.",
		"",
		"- `players.json` — career stat/ratings lines, awards, transactions (career movement),",
		"  relatives, teamsPlayedFor, rings. Keyed by `pid`.",
		"- `teams.json` — per-season records, titleSeasons, titleDrought, all-time record, division",
		"  rivals. Keyed by `tid`.",
		"- `rankings.json` — the derived canon: greatest players, greatest team-seasons, biggest",
		"  busts and steals (with evidence).",
		"- `dynasties.json`, `rivalries.json` — clustered titles; ranked rivalries with playoff",
		"  meetings and all-time head-to-head.",
		"- `gameIndex.json` — one compact row per game (winner, margin, who played, notability). The",
		"  queryable spine over the box-score bulk.",
		"- `notableGames.json` — full box scores for the standout games (present only if exported).",
		"- `games/season-<year>.ndjson` — the full box-score bulk, one game per line, sharded by",
		"  season (present only if exported with full game detail).",
		"- `canon-workflow.md` — the tiered prompt library. Start here.",
		"- `pull_games.py` — fetch specific box scores by pid/season/notable without scanning the",
		"  bulk. `python pull_games.py --pid <id> --notable`.",
		"",
		"## How to use it",
		"",
		"1. Read `canon-workflow.md`. Write the **foundational** pieces first (greatest players/",
		"   teams/busts/rivalries/dynasties) — they run off the small `rankings.json` /",
		"   `rivalries.json` / `dynasties.json` tables and establish the canon.",
		"2. Collect the canonical claims those pieces emit into a canon index.",
		"3. Write **dependent** pieces (season retrospectives, player careers, game recaps), handing",
		"   each the scoped facts plus the relevant canon-index claims so they stay consistent.",
		"4. For game-level detail, filter `gameIndex.json` (or use `pull_games.py`) to the exact",
		"   games you need, then read those box scores — never load the whole bulk.",
	]
		.filter((line) => line !== "")
		.join("\n");
};

export const serializeBundle = (
	kb: KnowledgeBase,
	options: SerializeOptions = {},
): BundleFile[] => {
	const files: BundleFile[] = [
		{ path: "meta.json", content: json(kb.meta) },
		{ path: "players.json", content: json(kb.players) },
		{ path: "teams.json", content: json(kb.teams) },
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
		{ path: "gameIndex.json", content: json(kb.gameIndex) },
		{ path: "README.md", content: buildReadme(kb) },
		{ path: "canon-workflow.md", content: buildCanonWorkflow() },
		{ path: "pull_games.py", content: PULL_GAMES_PY },
	];

	if (options.notableBoxScores) {
		files.push({
			path: "notableGames.json",
			content: json(options.notableBoxScores),
		});
	}

	if (options.fullGamesBySeason) {
		for (const [season, games] of options.fullGamesBySeason) {
			files.push({
				path: `games/season-${season}.ndjson`,
				content: games.map((g) => JSON.stringify(g)).join("\n"),
			});
		}
	}

	return files;
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
