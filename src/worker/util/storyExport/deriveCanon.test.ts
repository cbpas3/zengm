import { assert, describe, test } from "vitest";
import {
	deriveCanon,
	findDynasties,
	rankDraftValue,
	rankPlayers,
	rankTeamSeasons,
} from "./deriveCanon.ts";
import type {
	RawPlayer,
	RawPlayerStatsRow,
	RawTeam,
	RawTeamSeason,
} from "./types.ts";

const statRow = (
	season: number,
	ws: number,
	overrides: Partial<RawPlayerStatsRow> = {},
): RawPlayerStatsRow => ({
	season,
	tid: 0,
	playoffs: false,
	gp: 70,
	min: 2000,
	pts: 1500,
	trb: 400,
	ast: 300,
	ws,
	vorp: ws / 2,
	per: 20,
	ewa: ws,
	...overrides,
});

const player = (overrides: Partial<RawPlayer> = {}): RawPlayer => ({
	pid: 1,
	firstName: "Test",
	lastName: "Player",
	tid: 0,
	born: { year: 1990 },
	draft: { round: 1, pick: 1, year: 2010 },
	awards: [],
	ratings: [],
	stats: [],
	...overrides,
});

const teamSeason = (
	season: number,
	won: number,
	lost: number,
	playoffRoundsWon: number,
): RawTeamSeason => ({
	tid: 0,
	season,
	won,
	lost,
	tied: 0,
	otl: 0,
	playoffRoundsWon,
});

const team = (overrides: Partial<RawTeam> = {}): RawTeam => ({
	tid: 0,
	abbrev: "AAA",
	region: "Alpha",
	name: "Aces",
	seasons: [],
	stats: [],
	...overrides,
});

describe("rankPlayers", () => {
	test("a decorated long-career star outranks a compiler with no accolades", () => {
		const star = player({
			pid: 1,
			firstName: "Great",
			stats: Array.from({ length: 12 }, (_, i) => statRow(2000 + i, 12)),
			awards: [
				{ season: 2003, type: "Most Valuable Player" },
				{ season: 2004, type: "Won Championship" },
				{ season: 2004, type: "Finals MVP" },
				{ season: 2003, type: "First Team All-League" },
			],
		});
		const compiler = player({
			pid: 2,
			firstName: "Solid",
			stats: Array.from({ length: 15 }, (_, i) => statRow(2000 + i, 5)),
		});

		const ranked = rankPlayers([compiler, star]);
		assert.strictEqual(ranked[0]!.pid, 1);
		assert.strictEqual(ranked[0]!.rank, 1);
		assert.strictEqual(ranked[0]!.rings, 1);
		assert.include(ranked[0]!.topAwards, "MVP");
	});

	test("playoff stat rows and zero-GP rows don't inflate careerWS", () => {
		const p = player({
			stats: [
				statRow(2001, 10),
				statRow(2001, 8, { playoffs: true }), // playoff -> excluded
				statRow(2002, 0, { gp: 0, ws: 99 }), // didn't play -> excluded
			],
		});
		const [entry] = rankPlayers([p]);
		assert.strictEqual(entry!.careerWS, 10);
		assert.strictEqual(entry!.seasonsPlayed, 1);
	});

	test("peak is weighted so a short brilliant career can beat a longer mediocre one", () => {
		const brilliant = player({
			pid: 1,
			stats: [statRow(2000, 18), statRow(2001, 17), statRow(2002, 16)],
		});
		const long = player({
			pid: 2,
			stats: Array.from({ length: 10 }, (_, i) => statRow(2000 + i, 4)),
		});
		const ranked = rankPlayers([long, brilliant]);
		assert.strictEqual(ranked[0]!.pid, 1);
	});
});

describe("rankTeamSeasons", () => {
	test("orders by a blend of win%, point diff and playoff success; flags the champion", () => {
		const champ = team({
			tid: 0,
			seasons: [teamSeason(2000, 65, 17, 4)],
			stats: [{ tid: 0, season: 2000, playoffs: false, gp: 82, pts: 9000, oppPts: 8200 }],
		});
		const goodButOut = team({
			tid: 1,
			seasons: [{ ...teamSeason(2000, 60, 22, 0), tid: 1 }],
			stats: [{ tid: 1, season: 2000, playoffs: false, gp: 82, pts: 8800, oppPts: 8400 }],
		});

		const ranked = rankTeamSeasons([goodButOut, champ]);
		assert.strictEqual(ranked[0]!.tid, 0);
		assert.isTrue(ranked[0]!.wonTitle);
		assert.isFalse(ranked.find((r) => r.tid === 1)!.wonTitle);
	});

	test("disabled teams and zero-game seasons are skipped", () => {
		const disabled = team({ tid: 5, disabled: true, seasons: [teamSeason(2000, 50, 32, 1)] });
		const empty = team({ tid: 6, seasons: [{ ...teamSeason(2000, 0, 0, 0), tid: 6 }] });
		assert.lengthOf(rankTeamSeasons([disabled, empty]), 0);
	});
});

describe("rankDraftValue", () => {
	test("a low-WS first-rounder is a bust; a high-WS second-rounder is a steal", () => {
		const players: RawPlayer[] = [
			// First round: two solid, one flop -> the flop is the bust.
			player({ pid: 1, draft: { round: 1, pick: 1, year: 2000 }, stats: Array.from({ length: 5 }, (_, i) => statRow(2001 + i, 12)) }),
			player({ pid: 2, draft: { round: 1, pick: 2, year: 2000 }, stats: Array.from({ length: 5 }, (_, i) => statRow(2001 + i, 11)) }),
			player({ pid: 3, firstName: "Flop", draft: { round: 1, pick: 3, year: 2000 }, stats: Array.from({ length: 5 }, (_, i) => statRow(2001 + i, 1)) }),
			// Second round: two nobodies, one star -> the star is the steal.
			player({ pid: 4, draft: { round: 2, pick: 1, year: 2000 }, stats: Array.from({ length: 5 }, (_, i) => statRow(2001 + i, 1)) }),
			player({ pid: 5, draft: { round: 2, pick: 2, year: 2000 }, stats: Array.from({ length: 5 }, (_, i) => statRow(2001 + i, 1)) }),
			player({ pid: 6, firstName: "Gem", draft: { round: 2, pick: 3, year: 2000 }, stats: Array.from({ length: 8 }, (_, i) => statRow(2001 + i, 12)) }),
		];

		const { busts, steals } = rankDraftValue(players);
		assert.strictEqual(busts[0]!.pid, 3);
		assert.isBelow(busts[0]!.delta, 0);
		assert.strictEqual(steals[0]!.pid, 6);
		assert.isAbove(steals[0]!.delta, 0);
	});

	test("players below the minimum career length are excluded from both lists", () => {
		const cupOfCoffee = player({ pid: 9, draft: { round: 1, pick: 1, year: 2000 }, stats: [statRow(2001, 0.1)] });
		const { busts, steals } = rankDraftValue([cupOfCoffee]);
		assert.notExists(busts.find((b) => b.pid === 9));
		assert.notExists(steals.find((s) => s.pid === 9));
	});
});

describe("findDynasties", () => {
	test("detects a cluster of titles within the window and ignores scattered ones", () => {
		const dynasty = team({
			tid: 0,
			seasons: [
				teamSeason(2000, 60, 22, 4),
				teamSeason(2001, 58, 24, 4),
				teamSeason(2002, 62, 20, 4),
				teamSeason(2010, 55, 27, 4), // isolated later title
			],
		});
		// Opponents that lost the Finals those years (so max rounds is defined and the dynasty wins).
		const foil = team({
			tid: 1,
			seasons: [
				{ ...teamSeason(2000, 55, 27, 3), tid: 1 },
				{ ...teamSeason(2001, 54, 28, 3), tid: 1 },
				{ ...teamSeason(2002, 53, 29, 3), tid: 1 },
			],
		});

		const result = findDynasties([dynasty, foil]);
		assert.lengthOf(result, 1);
		assert.strictEqual(result[0]!.tid, 0);
		assert.deepEqual(result[0]!.titleSeasons, [2000, 2001, 2002]);
		assert.strictEqual(result[0]!.titles, 3);
	});

	test("two titles in the window is not a dynasty", () => {
		const t = team({ tid: 0, seasons: [teamSeason(2000, 60, 22, 4), teamSeason(2001, 58, 24, 4)] });
		assert.lengthOf(findDynasties([t]), 0);
	});
});

describe("deriveCanon", () => {
	test("returns all five tables", () => {
		const players = [player({ pid: 1, stats: [statRow(2000, 10), statRow(2001, 10), statRow(2002, 10)] })];
		const teams = [team({ tid: 0, seasons: [teamSeason(2000, 50, 32, 1)], stats: [{ tid: 0, season: 2000, playoffs: false, gp: 82, pts: 8500, oppPts: 8400 }] })];
		const canon = deriveCanon(players, teams);
		assert.hasAllKeys(canon, [
			"players",
			"teamSeasons",
			"busts",
			"steals",
			"dynasties",
			"rivalries",
		]);
		assert.isAbove(canon.players.length, 0);
		assert.isAbove(canon.teamSeasons.length, 0);
	});
});
