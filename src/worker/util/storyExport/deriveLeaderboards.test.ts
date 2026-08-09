import { assert, describe, test } from "vitest";
import { deriveLeaderboards } from "./deriveLeaderboards.ts";
import type { RawPlayer, RawPlayerStatsRow } from "./types.ts";

const row = (
	season: number,
	overrides: Partial<RawPlayerStatsRow> = {},
): RawPlayerStatsRow => ({
	season,
	tid: 0,
	playoffs: false,
	gp: 82,
	min: 2800,
	pts: 1500,
	ast: 300,
	orb: 100,
	drb: 400,
	ows: 6,
	dws: 3,
	per: 20,
	...overrides,
});

const player = (
	pid: number,
	firstName: string,
	stats: RawPlayerStatsRow[],
): RawPlayer => ({
	pid,
	firstName,
	lastName: "Player",
	tid: 0,
	born: { year: 1990 },
	draft: { round: 1, pick: 1, year: 2010 },
	awards: [],
	ratings: [],
	stats,
});

describe("deriveLeaderboards", () => {
	test("career boards sum regular-season totals and rank them", () => {
		const boards = deriveLeaderboards([
			player(1, "Big", [row(2000), row(2001), row(2002)]),
			player(2, "Small", [row(2000, { pts: 500 })]),
		]);
		assert.strictEqual(boards.career.pts![0]!.pid, 1);
		assert.strictEqual(boards.career.pts![0]!.value, 4500);
		assert.strictEqual(boards.career.pts![0]!.rank, 1);
		// Total rebounds are derived from orb + drb, the same as everywhere else.
		assert.strictEqual(boards.career.trb![0]!.value, 1500);
		// Win shares are ows + dws.
		assert.strictEqual(boards.career.ws![0]!.value, 27);
	});

	test("playoff rows never leak into a regular-season board", () => {
		const boards = deriveLeaderboards([
			player(1, "Big", [row(2000), row(2000, { playoffs: true, pts: 400 })]),
		]);
		assert.strictEqual(boards.career.pts![0]!.value, 1500);
	});

	test("a mid-season trade is one season, not two half-seasons", () => {
		const boards = deriveLeaderboards([
			player(1, "Traded", [
				row(2000, { tid: 0, gp: 30, pts: 700 }),
				row(2000, { tid: 5, gp: 52, pts: 1400 }),
			]),
			player(2, "Stayed", [row(2000, { pts: 1900 })]),
		]);
		const top = boards.season.pts![0]!;
		assert.strictEqual(top.pid, 1);
		assert.strictEqual(top.value, 2100);
		// Attributed to whichever team he played the most games for.
		assert.strictEqual(top.tid, 5);
	});

	test("rate stats have a workload floor so a three-game career can't top the list", () => {
		const boards = deriveLeaderboards([
			player(1, "Cup", [row(2000, { gp: 3, min: 60, per: 45 })]),
			player(2, "Real", [
				row(2000, { per: 28 }),
				row(2001, { per: 28 }),
				row(2002, { per: 28 }),
				row(2003, { per: 28 }),
				row(2004, { per: 28 }),
				row(2005, { per: 28 }),
			]),
		]);
		assert.strictEqual(boards.career.per![0]!.pid, 2);
		assert.notExists(boards.season.per!.find((e) => e.pid === 1));
	});

	test("a metric the league never computed produces an empty board, not a board of zeros", () => {
		const boards = deriveLeaderboards([
			player(1, "Old", [
				row(1951, { vorp: undefined, ows: undefined, dws: undefined }),
			]),
		]);
		assert.lengthOf(boards.career.vorp!, 0);
		assert.lengthOf(boards.career.ws!, 0);
	});
});
