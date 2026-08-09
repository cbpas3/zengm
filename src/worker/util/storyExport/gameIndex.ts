// Game index (AI Story Export, §4a in AI_STORY_EXPORT_PLAN.md).
//
// The queryable spine over the box-score bulk. One compact row per game lets an agent (or
// pull_games.py) find exactly the games an article needs - "all of a player's games", "only his
// notable ones", "every game of the 2016 Finals" - by filtering the index, then fetch just those
// gids, never scanning the bulk. Pure.
//
// Three v1 bugs fixed here:
//   - `playoffs` came straight off the stored Game, where it is *optional* and therefore undefined
//     for regular-season games. JSON.stringify dropped the key, so the whole flag vanished from the
//     bundle and postseason games were indistinguishable from January.
//   - No absolute score, only a margin. A recap needs the final score.
//   - `notable` named two different things: the scoring threshold (72% of games) and membership of
//     the exported shard (3,000 games). `boxScoreIncluded` is now the second question, stamped after
//     the cap is applied.

import { computeGameNotability, type BoxGame } from "./gameNotability.ts";
import type { GameSeriesContext } from "./derivePlayoffSeries.ts";
import type { GameIndexRow } from "./types.ts";

const playedPids = (game: BoxGame): number[] => {
	const pids: number[] = [];
	for (const team of game.teams) {
		for (const p of team.players) {
			if (p.min > 0) {
				pids.push(p.pid);
			}
		}
	}
	return pids;
};

export const buildGameIndexRow = (
	game: BoxGame,
	{
		hasFeat = false,
		seriesContext,
	}: { hasFeat?: boolean; seriesContext?: GameSeriesContext } = {},
): GameIndexRow => {
	const notability = computeGameNotability(game, { hasFeat });

	const [t0, t1] = game.teams;
	const t0Won = t0.pts >= t1.pts;
	const winnerTid = t0Won ? t0.tid : t1.tid;
	const loserTid = t0Won ? t1.tid : t0.tid;

	// A game found in the playoffSeries store is a playoff game regardless of what the stored flag
	// says, and vice versa - `playoffs` is optional on Game, so it must be coerced, not passed on.
	const playoffs = !!game.playoffs || seriesContext !== undefined;

	return {
		gid: game.gid,
		season: game.season,
		playoffs,
		finals: !!game.finals || !!seriesContext?.finals,
		round: seriesContext?.round ?? null,
		seriesId: seriesContext?.seriesId ?? null,
		seriesGameNumber: seriesContext?.seriesGameNumber ?? null,
		tids: [t0.tid, t1.tid],
		scores: [t0.pts, t1.pts],
		winnerTid,
		loserTid,
		margin: Math.abs(t0.pts - t1.pts),
		overtimes: game.overtimes ?? 0,
		pids: playedPids(game),
		topScorerPid: notability.topScorerPid ?? null,
		notability: notability.notability,
		notable: notability.notable,
		// Provisional: the exported shard is capped, so buildFromDb stamps the truth once it knows
		// which games actually made the cut.
		boxScoreIncluded: false,
		notablePids: notability.notablePids,
	};
};

// featGids: gids that produced a playerFeat (from the feats store); those games are always notable.
export const buildGameIndex = (
	games: BoxGame[],
	featGids: Set<number> = new Set(),
	seriesByGid: Map<number, GameSeriesContext> = new Map(),
): { index: GameIndexRow[]; notableGids: number[] } => {
	const index = games.map((game) =>
		buildGameIndexRow(game, {
			hasFeat: featGids.has(game.gid),
			seriesContext: seriesByGid.get(game.gid),
		}),
	);
	index.sort((a, b) => a.gid - b.gid);
	const notableGids = index.filter((r) => r.notable).map((r) => r.gid);
	return { index, notableGids };
};

// Per-team, per-season points scored/allowed, summed from the games themselves. This is the
// backfill for point differential in leagues whose early seasons were imported rather than
// simulated, and so have team *season* rows (won/lost) but no team *stat* rows.
export const accumulateSeasonPoints = (
	row: Pick<GameIndexRow, "season" | "playoffs" | "tids" | "scores">,
	into: Map<number, Map<number, { gp: number; pts: number; oppPts: number }>>,
): void => {
	if (row.playoffs) {
		return; // regular-season differential only, to match the team stat rows it stands in for
	}
	for (const i of [0, 1] as const) {
		const tid = row.tids[i]!;
		const bySeason = into.get(tid) ?? new Map();
		const cur = bySeason.get(row.season) ?? { gp: 0, pts: 0, oppPts: 0 };
		cur.gp += 1;
		cur.pts += row.scores[i]!;
		cur.oppPts += row.scores[i === 0 ? 1 : 0]!;
		bySeason.set(row.season, cur);
		into.set(tid, bySeason);
	}
};
