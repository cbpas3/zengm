import { assert, describe, test } from "vitest";
import {
	buildGameSeriesLookup,
	buildSeedLookup,
	projectPlayoffSeries,
} from "./derivePlayoffSeries.ts";
import type { RawPlayoffSeries } from "./types.ts";

const bracket = (): RawPlayoffSeries[] => [
	{
		season: 2016,
		series: [
			// Round 1
			[
				{
					home: { tid: 0, seed: 1, won: 4 },
					away: { tid: 7, seed: 8, won: 1 },
					gids: [10, 11, 12, 13, 14],
				},
				{
					home: { tid: 3, seed: 2, won: 4 },
					away: { tid: 5, seed: 7, won: 3 },
					gids: [20, 21, 22, 23, 24, 25, 26],
				},
				// A bye: no opponent, no games.
				{ home: { tid: 9, seed: 3, won: 0 } },
			],
			// Round 2 (the finals of this two-round bracket)
			[
				{
					home: { tid: 0, seed: 1, won: 2 },
					away: { tid: 3, seed: 2, won: 4 },
					gids: [30, 31, 32, 33, 34, 35],
				},
			],
		],
	},
];

describe("projectPlayoffSeries", () => {
	test("every completed matchup becomes a first-class record with a stable id", () => {
		const series = projectPlayoffSeries(bracket());
		assert.lengthOf(series, 3, "the bye is skipped");

		const finals = series.find((s) => s.finals)!;
		assert.strictEqual(finals.seriesId, "2016-R2-0v3");
		assert.strictEqual(finals.round, 2);
		assert.strictEqual(finals.numRoundsThisSeason, 2);
		assert.strictEqual(finals.winnerTid, 3);
		assert.strictEqual(finals.loserTid, 0);
		assert.strictEqual(finals.seriesScore, "4-2");
		assert.deepEqual(finals.seeds, [1, 2]);
		assert.lengthOf(finals.gids, 6);
	});

	test("only the last round of a season is the finals", () => {
		const series = projectPlayoffSeries(bracket());
		assert.deepEqual(
			series.map((s) => s.finals),
			[false, false, true],
		);
	});
});

describe("buildGameSeriesLookup", () => {
	test("resolves a gid to its round, series and game number", () => {
		const lookup = buildGameSeriesLookup(projectPlayoffSeries(bracket()));
		// v1 could not answer this at all: a first-round Game 7 looked exactly like a January game.
		assert.deepEqual(lookup.get(26), {
			round: 1,
			seriesId: "2016-R1-3v5",
			seriesGameNumber: 7,
			finals: false,
		});
		assert.strictEqual(lookup.get(30)!.seriesGameNumber, 1);
		assert.isUndefined(lookup.get(999));
	});
});

describe("buildSeedLookup", () => {
	test("a team's seed comes from its first-round matchup, not a later one", () => {
		const seeds = buildSeedLookup(bracket());
		assert.strictEqual(seeds.get(0)!.get(2016), 1);
		assert.strictEqual(seeds.get(5)!.get(2016), 7);
	});
});
