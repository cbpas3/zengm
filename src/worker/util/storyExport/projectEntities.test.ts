import { assert, describe, test } from "vitest";
import {
	attachTitles,
	projectPlayer,
	projectTeams,
} from "./projectEntities.ts";
import type { RawPlayer, RawTeam } from "./types.ts";

const rawPlayer = (overrides: Partial<RawPlayer> = {}): RawPlayer => ({
	pid: 1,
	firstName: "Test",
	lastName: "Player",
	tid: 3,
	born: { year: 1990, loc: "USA" },
	draft: { round: 1, pick: 5, year: 2010, originalTid: 7, ovr: 55, pot: 70 },
	awards: [],
	ratings: [],
	stats: [],
	...overrides,
});

const rawTeam = (overrides: Partial<RawTeam> = {}): RawTeam => ({
	tid: 0,
	abbrev: "AAA",
	region: "Alpha",
	name: "Aces",
	did: 0,
	seasons: [],
	stats: [],
	...overrides,
});

describe("projectPlayer", () => {
	test("trims to narrative fields, sums regular-season career totals, and surfaces cross-refs", () => {
		const p = rawPlayer({
			statsTids: [3, 8],
			relatives: [{ type: "brother", pid: 99, name: "Sib Player" }],
			transactions: [
				{ type: "draft", season: 2010, phase: 6, tid: 7 },
				{ type: "trade", season: 2014, phase: 3, tid: 3, fromTid: 7 },
			],
			awards: [
				{ season: 2015, type: "Won Championship" },
				{ season: 2016, type: "All-Star" },
			],
			stats: [
				{
					season: 2011,
					tid: 7,
					playoffs: false,
					gp: 70,
					min: 2000,
					pts: 1000,
					trb: 300,
					ast: 200,
					ws: 6,
					vorp: 2,
					per: 18,
					ewa: 6,
				},
				{
					season: 2011,
					tid: 7,
					playoffs: true,
					gp: 10,
					min: 350,
					pts: 180,
					trb: 50,
					ast: 30,
					ws: 1,
					vorp: 0.5,
					per: 19,
					ewa: 1,
				},
				{
					season: 2012,
					tid: 3,
					playoffs: false,
					gp: 0,
					min: 0,
					pts: 0,
					trb: 0,
					ast: 0,
					ws: 99,
					vorp: 0,
					per: 0,
					ewa: 0,
				},
			],
		});
		const proj = projectPlayer(p);

		assert.strictEqual(proj.name, "Test Player");
		assert.deepEqual(proj.teamsPlayedFor, [3, 8]);
		assert.strictEqual(proj.rings, 1);
		assert.strictEqual(proj.relatives[0]!.pid, 99);
		assert.strictEqual(proj.transactions.length, 2);
		// Career totals: regular season only, gp>0 only -> just the 2011 regular row.
		assert.strictEqual(proj.careerTotals.gp, 70);
		assert.strictEqual(proj.careerTotals.ws, 6);
		assert.strictEqual(proj.careerTotals.seasons, 1);
		// The zero-GP row is excluded from stats lines; the playoff row is kept.
		assert.strictEqual(proj.stats.length, 2);
	});

	test("hof and retiredYear normalize to clean types", () => {
		const active = projectPlayer(
			rawPlayer({ hof: undefined, retiredYear: null }),
		);
		assert.isFalse(active.hof);
		// null, not undefined: JSON.stringify drops undefined keys, which is how v1 shipped records
		// with a non-uniform schema.
		assert.isNull(active.retiredYear);
		const legend = projectPlayer(rawPlayer({ hof: 1, retiredYear: 2025 }));
		assert.isTrue(legend.hof);
		assert.strictEqual(legend.retiredYear, 2025);
	});

	test("win shares are derived from ows + dws, not read off a nonexistent ws column", () => {
		const p = projectPlayer(
			rawPlayer({
				stats: [
					{
						season: 2011,
						tid: 7,
						playoffs: false,
						gp: 70,
						min: 2000,
						pts: 1000,
						ast: 200,
						ows: 4.5,
						dws: 2.5,
					},
					{
						season: 2012,
						tid: 7,
						playoffs: false,
						gp: 70,
						min: 2000,
						pts: 900,
						ast: 180,
						ows: 3,
						dws: 2,
					},
				],
			}),
		);
		assert.strictEqual(p.stats[0]!.ws, 7);
		assert.strictEqual(p.careerTotals.ws, 12);
	});

	test("a season with no win-share components is null, never zero", () => {
		const p = projectPlayer(
			rawPlayer({
				stats: [
					{
						season: 1951,
						tid: 7,
						playoffs: false,
						gp: 66,
						min: 2000,
						pts: 900,
						ast: 300,
					},
				],
			}),
		);
		assert.isNull(p.stats[0]!.ws);
		assert.isNull(p.stats[0]!.vorp);
		assert.isNull(p.careerTotals.ws);
	});

	test("total rebounds come from orb + drb on modern rows and from trb on historical ones", () => {
		const modern = projectPlayer(
			rawPlayer({
				stats: [
					{
						season: 2011,
						tid: 7,
						playoffs: false,
						gp: 70,
						min: 2000,
						pts: 1000,
						ast: 200,
						orb: 120,
						drb: 380,
					},
				],
			}),
		);
		assert.strictEqual(modern.stats[0]!.trb, 500);
		assert.strictEqual(modern.careerTotals.trb, 500);

		const historical = projectPlayer(
			rawPlayer({
				stats: [
					{
						season: 1961,
						tid: 7,
						playoffs: false,
						gp: 79,
						min: 3000,
						pts: 2000,
						ast: 300,
						trb: 1500,
					},
				],
			}),
		);
		assert.strictEqual(historical.stats[0]!.trb, 1500);
	});

	test("shot-location shares describe a player's style", () => {
		const p = projectPlayer(
			rawPlayer({
				stats: [
					{
						season: 2016,
						tid: 7,
						playoffs: false,
						gp: 80,
						min: 2800,
						pts: 1800,
						ast: 300,
						fga: 1000,
						fgaAtRim: 300,
						fgaLowPost: 100,
						fgaMidRange: 200,
						tpa: 400,
					},
				],
			}),
		);
		assert.deepEqual(p.stats[0]!.shotDist, {
			atRim: 0.3,
			lowPost: 0.1,
			midRange: 0.2,
			threes: 0.4,
		});
	});

	test("position falls back to the last rated season, and undrafted is flagged", () => {
		const p = projectPlayer(
			rawPlayer({
				pos: undefined,
				draft: { round: 0, pick: 0, year: 2010, originalTid: -1 },
				ratings: [
					{ season: 2010, ovr: 40, pot: 60, pos: "SG" },
					{ season: 2011, ovr: 50, pot: 60, pos: "SF", skills: ["3", "Dp"] },
				],
			}),
		);
		assert.strictEqual(p.pos, "SF");
		assert.isTrue(p.draft.undrafted);
		assert.isNull(p.draft.originalTid);
		assert.deepEqual(p.ratings[1]!.skills, ["3", "Dp"]);
	});

	test("a trade transaction carries the other side of the deal", () => {
		const p = projectPlayer(
			rawPlayer({
				pid: 1,
				transactions: [
					{
						type: "trade",
						season: 2014,
						phase: 3,
						tid: 3,
						fromTid: 7,
						eid: 42,
					},
				],
			}),
			{
				eventsByEid: new Map([
					[
						42,
						{
							eid: 42,
							type: "trade",
							season: 2014,
							tids: [3, 7],
							teams: [
								{ assets: [{ pid: 1, name: "Test Player" }] },
								{
									assets: [{ dpid: 9, season: 2015, round: 1, originalTid: 3 }],
								},
							],
						},
					],
				]),
			},
		);
		const t = p.transactions[0]!;
		assert.strictEqual(t.counterpartyTid, 7);
		assert.deepEqual(t.assetsAcquired, [
			{ kind: "player", pid: 1, name: "Test Player" },
		]);
		assert.deepEqual(t.assetsSurrendered, [
			{ kind: "pick", dpid: 9, season: 2015, round: 1, originalTid: 3 },
		]);
	});
});

describe("projectTeams + attachTitles", () => {
	const dynasty = rawTeam({
		tid: 0,
		did: 0,
		seasons: [
			{
				tid: 0,
				season: 2000,
				won: 60,
				lost: 22,
				tied: 0,
				otl: 0,
				playoffRoundsWon: 4,
			},
			{
				tid: 0,
				season: 2001,
				won: 58,
				lost: 24,
				tied: 0,
				otl: 0,
				playoffRoundsWon: 4,
			},
			{
				tid: 0,
				season: 2002,
				won: 40,
				lost: 42,
				tied: 0,
				otl: 0,
				playoffRoundsWon: 1,
			},
		],
	});
	const rival = rawTeam({
		tid: 1,
		did: 0,
		seasons: [
			{
				tid: 1,
				season: 2000,
				won: 55,
				lost: 27,
				tied: 0,
				otl: 0,
				playoffRoundsWon: 3,
			},
			{
				tid: 1,
				season: 2001,
				won: 54,
				lost: 28,
				tied: 0,
				otl: 0,
				playoffRoundsWon: 3,
			},
			{
				tid: 1,
				season: 2002,
				won: 50,
				lost: 32,
				tied: 0,
				otl: 0,
				playoffRoundsWon: 4,
			},
		],
	});
	const otherDiv = rawTeam({
		tid: 2,
		did: 1,
		seasons: [
			{
				tid: 2,
				season: 2002,
				won: 41,
				lost: 41,
				tied: 0,
				otl: 0,
				playoffRoundsWon: 0,
			},
		],
	});

	test("division rivals are grouped by did, excluding self", () => {
		const projected = projectTeams([dynasty, rival, otherDiv]);
		const t0 = projected.find((t) => t.tid === 0)!;
		assert.deepEqual(t0.divisionRivalTids, [1]);
		assert.deepEqual(projected.find((t) => t.tid === 2)!.divisionRivalTids, []);
	});

	test("attachTitles marks champions (league-max rounds/season) and computes drought", () => {
		const projected = projectTeams([dynasty, rival, otherDiv]);
		attachTitles([dynasty, rival, otherDiv], projected);

		const t0 = projected.find((t) => t.tid === 0)!;
		const t1 = projected.find((t) => t.tid === 1)!;
		// 2000 & 2001: team 0 has max rounds (4). 2002: team 1 has max (4).
		assert.deepEqual(t0.titleSeasons, [2000, 2001]);
		assert.strictEqual(t0.titles, 2);
		assert.deepEqual(t1.titleSeasons, [2002]);
		// Team 0's latest season is 2002; last title 2001 -> drought 1.
		assert.strictEqual(t0.titleDrought, 1);
		assert.isFalse(t0.neverWonTitle);
	});

	test("a team that never won has neverWonTitle and drought spanning its history", () => {
		const projected = projectTeams([otherDiv]);
		attachTitles([otherDiv], projected);
		const t2 = projected.find((t) => t.tid === 2)!;
		assert.isTrue(t2.neverWonTitle);
		assert.strictEqual(t2.titleDrought, 0); // single season 2002 -> latest === first
	});
});
