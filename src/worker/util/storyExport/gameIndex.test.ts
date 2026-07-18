import { assert, describe, test } from "vitest";
import { buildGameIndex, buildGameIndexRow } from "./gameIndex.ts";
import type { BoxGame, BoxPlayerLine } from "./gameNotability.ts";

const line = (pid: number, overrides: Partial<BoxPlayerLine> = {}): BoxPlayerLine => ({
	pid,
	min: 30,
	pts: 10,
	fg: 4,
	fga: 9,
	ft: 2,
	fta: 2,
	orb: 1,
	drb: 3,
	ast: 2,
	stl: 1,
	blk: 0,
	tov: 2,
	pf: 2,
	...overrides,
});

const game = (gid: number, overrides: Partial<BoxGame> = {}): BoxGame => ({
	gid,
	season: 2022,
	playoffs: false,
	overtimes: 0,
	teams: [
		{ tid: 0, pts: 110, players: [line(1), line(2)] },
		{ tid: 1, pts: 100, players: [line(3), line(4, { min: 0 })] },
	],
	...overrides,
});

describe("buildGameIndexRow", () => {
	test("captures winner/loser, margin, and only players who played", () => {
		const row = buildGameIndexRow(game(5));
		assert.strictEqual(row.winnerTid, 0);
		assert.strictEqual(row.loserTid, 1);
		assert.strictEqual(row.margin, 10);
		assert.deepEqual(row.tids, [0, 1]);
		// pid 4 had 0 minutes -> excluded.
		assert.deepEqual(row.pids.sort(), [1, 2, 3]);
	});

	test("a feat forces the row notable", () => {
		assert.isFalse(buildGameIndexRow(game(5)).notable);
		assert.isTrue(buildGameIndexRow(game(5), { hasFeat: true }).notable);
	});
});

describe("buildGameIndex", () => {
	test("sorts by gid and lists notable gids; feat gids are marked notable", () => {
		const games = [
			game(3),
			game(1, { playoffs: true }), // playoff -> notable
			game(2),
		];
		const { index, notableGids } = buildGameIndex(games, new Set([3]));
		assert.deepEqual(index.map((r) => r.gid), [1, 2, 3]);
		// gid 1 notable (playoff), gid 3 notable (feat), gid 2 not.
		assert.include(notableGids, 1);
		assert.include(notableGids, 3);
		assert.notInclude(notableGids, 2);
	});

	test("a standout individual game lands the scorer in notablePids and flags the game", () => {
		const bigGame = game(9, {
			teams: [
				{
					tid: 0,
					pts: 130,
					players: [line(7, { pts: 50, fg: 18, fga: 28, ft: 10, fta: 11, drb: 8, ast: 6 })],
				},
				{ tid: 1, pts: 120, players: [line(8, { pts: 22 })] },
			],
		});
		const { index } = buildGameIndex([bigGame]);
		assert.isTrue(index[0]!.notable);
		assert.include(index[0]!.notablePids, 7);
		assert.strictEqual(index[0]!.topScorerPid, 7);
	});
});
