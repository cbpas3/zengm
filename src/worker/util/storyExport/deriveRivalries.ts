// Rivalry derivation (AI Story Export, Phase 1, §3b in AI_STORY_EXPORT_PLAN.md).
//
// Rivalries are the load-bearing "historical context" signal (the plan's Cavs-2016 example: the
// title means more because of the prior Finals loss to the same team). Per the resolved decision in
// §9: reuse the pre-aggregated headToHeads store for raw regular-season pair W/L, but derive the
// meaty part - playoff meetings - from playoffSeries, which is unambiguous (round, sides, series
// score). Compute only the "intensity/drama" ranking on top. Pure, DB-free.

import { seriesId as makeSeriesId } from "./derivePlayoffSeries.ts";
import type {
	PlayoffMeeting,
	ProjectedPlayoffSeries,
	RawHeadToHead,
	RawPlayoffSeries,
	RivalryEntry,
} from "./types.ts";

export const RIVALRY_TUNING = {
	// Intensity = playoff meetings dominate, close series add drama, regular-season volume is a mild
	// contributor. Weights are a first cut, recalibrated against a real league later.
	PLAYOFF_MEETING_WEIGHT: 10,
	CLOSE_SERIES_BONUS: 4, // a series decided by 1 game
	DEEP_ROUND_WEIGHT: 2, // later rounds (finals) matter more; multiplied by round number
	REGULAR_GAMES_WEIGHT: 0.05,
	CLOSE_ALLTIME_BONUS: 6, // near-even all-time record
	TOP_RIVALRIES: 60,
	// Only surface pairs with at least this much shared history.
	MIN_PLAYOFF_MEETINGS: 1,
} as const;

const pairKey = (a: number, b: number) => `${Math.min(a, b)}.${Math.max(a, b)}`;

type Accum = {
	tids: [number, number];
	regA: number; // wins for the lower tid
	regB: number;
	regTied: number;
	regGames: number;
	meetings: PlayoffMeeting[];
};

// Build playoff meetings from playoffSeries: each completed matchup (both sides present) between two
// real teams is one meeting.
const collectPlayoffMeetings = (
	playoffSeries: RawPlayoffSeries[],
): Map<string, PlayoffMeeting[]> => {
	const byPair = new Map<string, PlayoffMeeting[]>();
	for (const record of playoffSeries) {
		for (let round = 0; round < record.series.length; round++) {
			for (const matchup of record.series[round]!) {
				const { home, away } = matchup;
				if (!away || home.tid < 0 || away.tid < 0) {
					continue;
				}
				// Skip series that never actually happened (both 0 wins = placeholder/bye).
				if (home.won === 0 && away.won === 0) {
					continue;
				}
				const homeWon = home.won >= away.won;
				const meeting: PlayoffMeeting = {
					season: record.season,
					round: round + 1,
					winnerTid: homeWon ? home.tid : away.tid,
					loserTid: homeWon ? away.tid : home.tid,
					winnerWins: homeWon ? home.won : away.won,
					loserWins: homeWon ? away.won : home.won,
					// Link out to playoffSeries.json / the game index, so "every playoff meeting" is
					// traversable down to the individual games rather than a dead-end summary.
					seriesId: makeSeriesId(record.season, round + 1, [
						home.tid,
						away.tid,
					]),
					gids: [...(matchup.gids ?? [])],
				};
				const key = pairKey(home.tid, away.tid);
				const arr = byPair.get(key) ?? [];
				arr.push(meeting);
				byPair.set(key, arr);
			}
		}
	}
	return byPair;
};

// Fold cumulative regular-season pair records out of headToHeads (optional input).
const collectRegularSeason = (
	headToHeads: RawHeadToHead[],
): Map<string, { a: number; b: number; tied: number }> => {
	const byPair = new Map<string, { a: number; b: number; tied: number }>();
	for (const record of headToHeads) {
		for (const [key, rec] of Object.entries(record.regularSeason ?? {})) {
			// key is "lowTid.highTid"; won/lost are from the low tid's perspective.
			const cur = byPair.get(key) ?? { a: 0, b: 0, tied: 0 };
			cur.a += rec.won + (rec.otw ?? 0);
			cur.b += rec.lost + (rec.otl ?? 0);
			cur.tied += rec.tied ?? 0;
			byPair.set(key, cur);
		}
	}
	return byPair;
};

export type DeriveRivalriesOptions = {
	// Already-projected series, used to fill in gids when the raw records are missing them.
	projectedPlayoffSeries?: ProjectedPlayoffSeries[];
};

export const deriveRivalries = (
	playoffSeries: RawPlayoffSeries[],
	headToHeads: RawHeadToHead[] = [],
	options: DeriveRivalriesOptions = {},
): RivalryEntry[] => {
	const meetingsByPair = collectPlayoffMeetings(playoffSeries);

	const gidsBySeriesId = new Map(
		(options.projectedPlayoffSeries ?? []).map((s) => [s.seriesId, s.gids]),
	);
	const regularByPair = collectRegularSeason(headToHeads);

	// Union of pairs that have any playoff meetings (the rivalry-worthy set).
	const accums = new Map<string, Accum>();
	for (const [key, meetings] of meetingsByPair) {
		const [a, b] = key.split(".").map(Number) as [number, number];
		accums.set(key, {
			tids: [a, b],
			regA: 0,
			regB: 0,
			regTied: 0,
			regGames: 0,
			meetings,
		});
	}
	for (const [key, accum] of accums) {
		const reg = regularByPair.get(key);
		if (reg) {
			accum.regA = reg.a;
			accum.regB = reg.b;
			accum.regTied = reg.tied;
			accum.regGames = reg.a + reg.b + reg.tied;
		}
	}

	const entries: RivalryEntry[] = [];
	for (const accum of accums.values()) {
		if (accum.meetings.length < RIVALRY_TUNING.MIN_PLAYOFF_MEETINGS) {
			continue;
		}

		let intensity =
			accum.meetings.length * RIVALRY_TUNING.PLAYOFF_MEETING_WEIGHT;
		for (const m of accum.meetings) {
			intensity += m.round * RIVALRY_TUNING.DEEP_ROUND_WEIGHT;
			if (m.winnerWins - m.loserWins === 1) {
				intensity += RIVALRY_TUNING.CLOSE_SERIES_BONUS;
			}
		}
		intensity += accum.regGames * RIVALRY_TUNING.REGULAR_GAMES_WEIGHT;
		if (accum.regGames > 0) {
			// Near-even all-time record => hotter rivalry.
			const evenness = 1 - Math.abs(accum.regA - accum.regB) / accum.regGames;
			intensity += evenness * RIVALRY_TUNING.CLOSE_ALLTIME_BONUS;
		}

		entries.push({
			tids: accum.tids,
			regularSeason:
				accum.regGames > 0
					? { aWon: accum.regA, bWon: accum.regB, tied: accum.regTied }
					: null,
			playoffMeetings: [...accum.meetings]
				.sort((x, y) => x.season - y.season || x.round - y.round)
				.map((m) => ({
					...m,
					gids:
						m.gids.length > 0
							? m.gids
							: ((m.seriesId === null
									? undefined
									: gidsBySeriesId.get(m.seriesId)) ?? []),
				})),
			playoffSeriesCount: accum.meetings.length,
			intensity: Math.round(intensity * 10) / 10,
		});
	}

	return entries
		.sort((a, b) => b.intensity - a.intensity)
		.slice(0, RIVALRY_TUNING.TOP_RIVALRIES);
};
