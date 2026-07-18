// Game index (AI Story Export, Phase 1, §4a in AI_STORY_EXPORT_PLAN.md).
//
// The queryable spine over the ~340 MB box-score bulk. One compact row per game lets an agent (or
// pull_games.py) find exactly the games an article needs - "all of a player's games", "only his
// notable ones" - by filtering the index, then fetch just those gids from the season shards, never
// scanning the bulk. Also selects which games go in the pre-filtered notable-games shard. Pure.

import { computeGameNotability, type BoxGame } from "./gameNotability.ts";
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
	{ hasFeat = false }: { hasFeat?: boolean } = {},
): GameIndexRow => {
	const notability = computeGameNotability(game, { hasFeat });

	const [t0, t1] = game.teams;
	const t0Won = t0.pts >= t1.pts;
	const winnerTid = t0Won ? t0.tid : t1.tid;
	const loserTid = t0Won ? t1.tid : t0.tid;

	return {
		gid: game.gid,
		season: game.season,
		playoffs: game.playoffs,
		finals: !!game.finals,
		tids: [t0.tid, t1.tid],
		winnerTid,
		loserTid,
		margin: Math.abs(t0.pts - t1.pts),
		pids: playedPids(game),
		topScorerPid: notability.topScorerPid,
		notability: notability.notability,
		notable: notability.notable,
		notablePids: notability.notablePids,
	};
};

// featGids: gids that produced a playerFeat (from the feats store); those games are always notable.
export const buildGameIndex = (
	games: BoxGame[],
	featGids: Set<number> = new Set(),
): { index: GameIndexRow[]; notableGids: number[] } => {
	const index = games.map((game) =>
		buildGameIndexRow(game, { hasFeat: featGids.has(game.gid) }),
	);
	index.sort((a, b) => a.gid - b.gid);
	const notableGids = index.filter((r) => r.notable).map((r) => r.gid);
	return { index, notableGids };
};
