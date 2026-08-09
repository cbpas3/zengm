// DB loader for the story export (AI Story Export, §7 in AI_STORY_EXPORT_PLAN.md).
//
// The one impure module: reads the league DB (idb), streams games per season to build the index
// without holding them all in memory, then hands the raw arrays to the pure assembler/serializer.
// Everything here is thin glue - the logic lives in the tested pure modules. Not unit-tested (needs
// a real league DB); exercised by running the export in the app.

import { idb } from "../../db/index.ts";
import { g, helpers } from "../index.ts";
import { assembleKnowledgeBase } from "./assembleKnowledgeBase.ts";
import {
	buildGameSeriesLookup,
	projectPlayoffSeries,
} from "./derivePlayoffSeries.ts";
import { accumulateSeasonPoints, buildGameIndexRow } from "./gameIndex.ts";
import { gameScore, type BoxGame } from "./gameNotability.ts";
import { deriveTrb, num } from "./statFields.ts";
import {
	bundleToVirtualFs,
	serializeBundle,
	type BundleFile,
	type SerializeOptions,
} from "./serialize.ts";
import type { SeasonPointTotals } from "./projectEntities.ts";
import type {
	GameIndexRow,
	ProjectedPlayer,
	RawAwardsRow,
	RawEvent,
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

// How many signature games to pre-join onto each player, so a career profile doesn't need to scan
// the whole index.
const HIGHLIGHT_GAMES_PER_PLAYER = 5;

// The transaction types a player's `transactions[].eid` can point at. Loading the whole events store
// for an 80-season league is wasteful when only these carry the other side of a move.
const TRANSACTION_EVENT_TYPES = new Set(["trade", "freeAgent", "reSigned"]);

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

// Keeps the best N games per player, by Hollinger game score, as the box scores stream past. Bounded
// memory: N entries per player who has ever played, nothing else retained.
class HighlightCollector {
	private byPid = new Map<number, ProjectedPlayer["highlightGames"]>();

	add(game: BoxGame, row: GameIndexRow) {
		for (const teamIndex of [0, 1] as const) {
			const team = game.teams[teamIndex]!;
			const oppTid = game.teams[teamIndex === 0 ? 1 : 0]!.tid;
			for (const line of team.players) {
				if (line.min <= 0) {
					continue;
				}
				const gs = Math.round(gameScore(line) * 10) / 10;
				const existing = this.byPid.get(line.pid) ?? [];
				if (
					existing.length >= HIGHLIGHT_GAMES_PER_PLAYER &&
					gs <= existing[existing.length - 1]!.gameScore
				) {
					continue;
				}
				existing.push({
					gid: game.gid,
					season: game.season,
					playoffs: row.playoffs,
					tid: team.tid,
					oppTid,
					gameScore: gs,
					pts: line.pts,
					trb: deriveTrb(line),
					ast: num(line.ast),
				});
				existing.sort((a, b) => b.gameScore - a.gameScore);
				existing.length = Math.min(existing.length, HIGHLIGHT_GAMES_PER_PLAYER);
				this.byPid.set(line.pid, existing);
			}
		}
	}

	result() {
		return this.byPid;
	}
}

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
	const awards = (await idb.getCopies.awards()) as unknown as RawAwardsRow[];
	// Only the move types a player transaction can reference; a trade with no other side is
	// unwritable, and the other side lives here.
	const events = (await idb.getCopies.events({
		filter: (event) => TRANSACTION_EVENT_TYPES.has(event.type),
	})) as unknown as RawEvent[];
	const feats = await idb.getCopies.playerFeats();
	const featGids = new Set(feats.map((f) => f.gid));

	// Playoff structure has to exist before the games stream, so each game-index row can be stamped
	// with its round, series and game number as it goes past.
	const projectedSeries = projectPlayoffSeries(playoffSeries);
	const seriesByGid = buildGameSeriesLookup(projectedSeries);

	// Stream games one season at a time so we never hold the whole box-score bulk in memory. Build
	// the index rows, keep the notable box scores (capped), and optionally the full per-season shards.
	const startingSeason = g.get("startingSeason");
	const currentSeason = g.get("season");
	const gameIndex: GameIndexRow[] = [];
	const notableGids: number[] = [];
	let notableBoxScores: { notability: number; gid: number; game: unknown }[] =
		[];
	const fullGamesBySeason = new Map<number, unknown[]>();
	const pointsFromGames = new Map<number, Map<number, SeasonPointTotals>>();
	const highlights = new HighlightCollector();

	for (let season = startingSeason; season <= currentSeason; season++) {
		const games = await idb.getCopies.games({ season }, "noCopyCache");
		if (games.length === 0) {
			continue;
		}
		if (includeFullGames) {
			fullGamesBySeason.set(season, games);
		}
		for (const game of games) {
			const box = game as unknown as BoxGame;
			const row = buildGameIndexRow(box, {
				hasFeat: featGids.has(game.gid),
				seriesContext: seriesByGid.get(game.gid),
			});
			gameIndex.push(row);
			// Point differential for seasons that have team *season* rows but no team *stat* rows -
			// the backfill that stops imported early history from scoring as if it were average.
			accumulateSeasonPoints(row, pointsFromGames);
			highlights.add(box, row);

			if (row.notable) {
				notableGids.push(row.gid);
				if (includeNotableGames) {
					notableBoxScores.push({
						notability: row.notability,
						gid: row.gid,
						game,
					});
					// Trim periodically rather than accumulating every notable game (which in a long
					// league is most of them) and sorting once at the end.
					if (notableBoxScores.length > MAX_NOTABLE_GAMES * 2) {
						notableBoxScores.sort((a, b) => b.notability - a.notability);
						notableBoxScores.length = MAX_NOTABLE_GAMES;
					}
				}
			}
		}
	}

	notableBoxScores.sort((a, b) => b.notability - a.notability);
	notableBoxScores = notableBoxScores.slice(0, MAX_NOTABLE_GAMES);

	// `notable` is a score threshold; `boxScoreIncluded` is what a consumer can actually open. Stamp
	// it now that the cap has been applied.
	const includedGids = new Set(notableBoxScores.map((n) => n.gid));
	if (includeFullGames) {
		for (const row of gameIndex) {
			row.boxScoreIncluded = true;
		}
	} else {
		for (const row of gameIndex) {
			row.boxScoreIncluded = includedGids.has(row.gid);
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
		awards,
		events,
		confs: g.get("confs"),
		divs: g.get("divs"),
		gameIndex,
		notableGids,
		pointsFromGames,
		highlightGamesByPid: highlights.result(),
		gameLengthMinutes: helpers.effectiveGameLength(),
		leagueName,
		generatedAtSeason: currentSeason,
	});

	const serializeOptions: SerializeOptions = {};
	if (includeNotableGames && notableBoxScores.length > 0) {
		serializeOptions.notableBoxScores = notableBoxScores.map((n) => n.game);
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
