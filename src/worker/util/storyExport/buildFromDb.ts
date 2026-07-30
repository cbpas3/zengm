// DB loader for the story export (AI Story Export, Phase 1, §7 in AI_STORY_EXPORT_PLAN.md).
//
// The one impure module: reads the league DB (idb), streams games per season to build the index
// without holding them all in memory, then hands the raw arrays to the pure assembler/serializer.
// Everything here is thin glue - the logic lives in the tested pure modules. Not unit-tested (needs
// a real league DB); exercised by running the export in the app.

import { idb } from "../../db/index.ts";
import { g } from "../index.ts";
import { assembleKnowledgeBase } from "./assembleKnowledgeBase.ts";
import { buildGameIndexRow } from "./gameIndex.ts";
import type { BoxGame } from "./gameNotability.ts";
import {
	bundleToVirtualFs,
	serializeBundle,
	type BundleFile,
	type SerializeOptions,
} from "./serialize.ts";
import type {
	GameIndexRow,
	RawHeadToHead,
	RawPlayer,
	RawPlayoffSeries,
	RawTeam,
} from "./types.ts";

export type StoryExportOptions = {
	// Include the pre-filtered notable-games box scores (default true - it's small and high value).
	includeNotableGames?: boolean;
	// Include the full per-season box-score bulk (default false - the heavy, opt-in layer).
	includeFullGames?: boolean;
};

// Cap the notable-games shard so the default bundle stays reasonable even for a decades-long league;
// keep the most notable if we exceed it.
const MAX_NOTABLE_GAMES = 3000;

const loadTeams = async (): Promise<RawTeam[]> => {
	const baseTeams = await idb.cache.teams.getAll();
	// Read teamSeasons/teamStats straight from the object stores (getCopies.teamSeasons requires a
	// tid or season; we want every team's whole history). The caller flushes the cache first so the
	// stores are current.
	const teamSeasons = (await idb.league.getAll(
		"teamSeasons",
	)) as unknown as RawTeam["seasons"];

	let teamStats: RawTeam["stats"] = [];
	try {
		teamStats = (await idb.league.getAll(
			"teamStats",
		)) as unknown as RawTeam["stats"];
	} catch {
		teamStats = [];
	}

	const seasonsByTid = new Map<number, RawTeam["seasons"]>();
	for (const ts of teamSeasons) {
		const arr = seasonsByTid.get(ts.tid) ?? [];
		arr.push(ts);
		seasonsByTid.set(ts.tid, arr);
	}
	const statsByTid = new Map<number, RawTeam["stats"]>();
	for (const stat of teamStats) {
		const arr = statsByTid.get(stat.tid) ?? [];
		arr.push(stat);
		statsByTid.set(stat.tid, arr);
	}

	return baseTeams.map((t) => ({
		tid: t.tid,
		abbrev: t.abbrev,
		region: t.region,
		name: t.name,
		cid: t.cid,
		did: t.did,
		disabled: t.disabled,
		seasons: seasonsByTid.get(t.tid) ?? [],
		stats: statsByTid.get(t.tid) ?? [],
	}));
};

export const buildStoryExportFromDb = async (
	options: StoryExportOptions = {},
): Promise<{ virtualFs: Record<string, unknown>; filename: string }> => {
	const { includeNotableGames = true, includeFullGames = false } = options;

	// Flush the cache so the raw object-store reads below (teamSeasons, teamStats) see current data,
	// same as makeExportStream does before a league export.
	await idb.cache.flush();

	const players = (await idb.getCopies.players(
		{ activeAndRetired: true },
		"noCopyCache",
	)) as unknown as RawPlayer[];
	const teams = await loadTeams();
	const playoffSeries = (await idb.getCopies.playoffSeries(
		undefined,
		"noCopyCache",
	)) as unknown as RawPlayoffSeries[];
	const headToHeads =
		(await idb.getCopies.headToHeads()) as unknown as RawHeadToHead[];
	const feats = await idb.getCopies.playerFeats();
	const featGids = new Set(feats.map((f) => f.gid));

	// Stream games one season at a time so we never hold the whole box-score bulk in memory. Build
	// the index rows, keep the notable box scores (capped), and optionally the full per-season shards.
	const startingSeason = g.get("startingSeason");
	const currentSeason = g.get("season");
	const gameIndex: GameIndexRow[] = [];
	const notableGids: number[] = [];
	const notableBoxScores: { notability: number; game: unknown }[] = [];
	const fullGamesBySeason = new Map<number, unknown[]>();

	for (let season = startingSeason; season <= currentSeason; season++) {
		const games = await idb.getCopies.games({ season }, "noCopyCache");
		if (games.length === 0) {
			continue;
		}
		if (includeFullGames) {
			fullGamesBySeason.set(season, games);
		}
		for (const game of games) {
			const row = buildGameIndexRow(game as unknown as BoxGame, {
				hasFeat: featGids.has(game.gid),
			});
			gameIndex.push(row);
			if (row.notable) {
				notableGids.push(row.gid);
				if (includeNotableGames) {
					notableBoxScores.push({ notability: row.notability, game });
				}
			}
		}
	}

	const lid = g.get("lid");
	let leagueName: string | undefined;
	try {
		const meta = await idb.meta.get("leagues", lid);
		leagueName = meta?.name;
	} catch {
		leagueName = undefined;
	}

	const kb = assembleKnowledgeBase({
		players,
		teams,
		playoffSeries,
		headToHeads,
		gameIndex,
		notableGids,
		leagueName,
		generatedAtSeason: currentSeason,
	});

	const serializeOptions: SerializeOptions = {};
	if (includeNotableGames && notableBoxScores.length > 0) {
		notableBoxScores.sort((a, b) => b.notability - a.notability);
		serializeOptions.notableBoxScores = notableBoxScores
			.slice(0, MAX_NOTABLE_GAMES)
			.map((n) => n.game);
	}
	if (includeFullGames && fullGamesBySeason.size > 0) {
		serializeOptions.fullGamesBySeason = fullGamesBySeason;
	}

	const files: BundleFile[] = serializeBundle(kb, serializeOptions);
	const safeName = (leagueName ?? "league").replaceAll(/[^\da-z]/gi, "_");

	return {
		virtualFs: bundleToVirtualFs(files),
		filename: `ZenGM_Story_Export_${safeName}_${currentSeason}.json`,
	};
};
