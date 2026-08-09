// Playoff series projection (AI Story Export).
//
// v1 exported no series table at all: the workflow doc told the writer to read `playoffSeries` for
// two different prompts, and the only postseason structure that actually shipped was a `finals`
// boolean on 122 game-index rows. A first-round Game 7 was indistinguishable from a January road
// game, and Finals matchups had to be inferred by counting flags.
//
// The playoffSeries store already has everything needed - per-round matchups with seeds, series
// score, and the gids of the games played - so this is projection, not derivation. Pure, DB-free.

import type { ProjectedPlayoffSeries, RawPlayoffSeries } from "./types.ts";

export const seriesId = (
	season: number,
	round: number,
	tids: [number, number],
) => `${season}-R${round}-${Math.min(...tids)}v${Math.max(...tids)}`;

export const projectPlayoffSeries = (
	playoffSeries: RawPlayoffSeries[],
): ProjectedPlayoffSeries[] => {
	const out: ProjectedPlayoffSeries[] = [];

	for (const record of playoffSeries) {
		const numRounds = record.series.length;
		for (let roundIndex = 0; roundIndex < numRounds; roundIndex++) {
			for (const matchup of record.series[roundIndex]!) {
				const { home, away } = matchup;
				// A bye or a not-yet-populated slot has no opponent; a placeholder has no games played.
				if (!away || home.tid < 0 || away.tid < 0) {
					continue;
				}
				if (home.won === 0 && away.won === 0) {
					continue;
				}

				const round = roundIndex + 1;
				const tids: [number, number] = [home.tid, away.tid];
				const homeWon = home.won >= away.won;

				out.push({
					seriesId: seriesId(record.season, round, tids),
					season: record.season,
					round,
					numRoundsThisSeason: numRounds,
					finals: round === numRounds,
					tids,
					seeds: [home.seed ?? null, away.seed ?? null],
					wins: [home.won, away.won],
					winnerTid: homeWon ? home.tid : away.tid,
					loserTid: homeWon ? away.tid : home.tid,
					seriesScore: homeWon
						? `${home.won}-${away.won}`
						: `${away.won}-${home.won}`,
					gids: [...(matchup.gids ?? [])],
				});
			}
		}
	}

	return out.sort(
		(a, b) => a.season - b.season || a.round - b.round || a.tids[0] - b.tids[0],
	);
};

export type GameSeriesContext = {
	round: number;
	seriesId: string;
	seriesGameNumber: number;
	finals: boolean;
};

// gid -> which series it belonged to and which game of that series it was. `gids` is pushed in play
// order by updatePlayoffSeries.ts, so the array index is the game number.
export const buildGameSeriesLookup = (
	series: ProjectedPlayoffSeries[],
): Map<number, GameSeriesContext> => {
	const lookup = new Map<number, GameSeriesContext>();
	for (const s of series) {
		for (const [i, gid] of s.gids.entries()) {
			lookup.set(gid, {
				round: s.round,
				seriesId: s.seriesId,
				seriesGameNumber: i + 1,
				finals: s.finals,
			});
		}
	}
	return lookup;
};

// tid -> season -> seed, for the team-season context block.
export const buildSeedLookup = (
	playoffSeries: RawPlayoffSeries[],
): Map<number, Map<number, number>> => {
	const lookup = new Map<number, Map<number, number>>();
	const set = (tid: number, season: number, seed: number | undefined) => {
		if (tid < 0 || seed === undefined) {
			return;
		}
		const bySeason = lookup.get(tid) ?? new Map<number, number>();
		// First round is the authoritative seeding; later rounds repeat it.
		if (!bySeason.has(season)) {
			bySeason.set(season, seed);
		}
		lookup.set(tid, bySeason);
	};

	for (const record of playoffSeries) {
		for (const matchups of record.series) {
			for (const matchup of matchups) {
				set(matchup.home.tid, record.season, matchup.home.seed);
				if (matchup.away) {
					set(matchup.away.tid, record.season, matchup.away.seed);
				}
			}
		}
	}

	return lookup;
};
