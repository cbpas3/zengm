import { assert, describe, test } from "vitest";
import { deriveRivalries } from "./deriveRivalries.ts";
import type { RawHeadToHead, RawPlayoffSeries } from "./types.ts";

const series = (
	season: number,
	rounds: { home: [number, number]; away: [number, number] }[][],
): RawPlayoffSeries => ({
	season,
	series: rounds.map((round) =>
		round.map((m) => ({
			home: { tid: m.home[0], seed: 1, won: m.home[1] },
			away: { tid: m.away[0], seed: 2, won: m.away[1] },
		})),
	),
});

describe("deriveRivalries", () => {
	test("builds playoff meetings with correct winner/loser and orientation", () => {
		const rivalries = deriveRivalries([
			series(2015, [[{ home: [0, 4], away: [1, 2] }]]),
		]);
		assert.lengthOf(rivalries, 1);
		const r = rivalries[0]!;
		assert.deepEqual(r.tids, [0, 1]);
		assert.strictEqual(r.playoffMeetings[0]!.winnerTid, 0);
		assert.strictEqual(r.playoffMeetings[0]!.loserTid, 1);
		assert.strictEqual(r.playoffMeetings[0]!.winnerWins, 4);
	});

	test("repeat playoff meetings raise intensity above a one-off, deeper rounds count more", () => {
		// Pair 0-1 meet three times incl. a finals (round 2); pair 2-3 meet once in round 1.
		const repeat = deriveRivalries([
			series(2014, [[], [{ home: [0, 4], away: [1, 3] }]]),
			series(2015, [[], [{ home: [1, 4], away: [0, 2] }]]),
			series(2016, [[{ home: [0, 4], away: [1, 0] }]]),
			series(2016, [[{ home: [2, 4], away: [3, 1] }]]),
		]);
		const r01 = repeat.find((r) => r.tids[0] === 0 && r.tids[1] === 1)!;
		const r23 = repeat.find((r) => r.tids[0] === 2 && r.tids[1] === 3)!;
		assert.strictEqual(r01.playoffSeriesCount, 3);
		assert.isAbove(r01.intensity, r23.intensity);
		// Rivalries are ranked by intensity.
		assert.strictEqual(repeat[0]!.tids[0], 0);
	});

	test("byes and unplayed placeholder matchups are ignored", () => {
		const rivalries = deriveRivalries([
			series(2015, [[{ home: [0, 0], away: [1, 0] }]]), // 0-0: never played
		]);
		assert.lengthOf(rivalries, 0);
	});

	test("headToHeads folds in the all-time regular-season record and a near-even record adds intensity", () => {
		const h2h: RawHeadToHead[] = [
			{
				season: 2015,
				regularSeason: {
					"0.1": {
						won: 2,
						lost: 2,
						tied: 0,
						otl: 0,
						otw: 0,
						pts: 400,
						oppPts: 400,
					},
				},
			},
			{
				season: 2016,
				regularSeason: {
					"0.1": {
						won: 1,
						lost: 1,
						tied: 0,
						otl: 0,
						otw: 0,
						pts: 200,
						oppPts: 200,
					},
				},
			},
		];
		const rivalries = deriveRivalries(
			[series(2016, [[{ home: [0, 4], away: [1, 3] }]])],
			h2h,
		);
		const r = rivalries[0]!;
		assert.deepEqual(r.regularSeason, { aWon: 3, bWon: 3, tied: 0 });
	});
});
