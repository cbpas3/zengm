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
			stats: [
				{
					tid: 0,
					season: 2000,
					playoffs: false,
					gp: 82,
					pts: 9000,
					oppPts: 8200,
				},
			],
		});
		const goodButOut = team({
			tid: 1,
			seasons: [{ ...teamSeason(2000, 60, 22, 0), tid: 1 }],
			stats: [
				{
					tid: 1,
					season: 2000,
					playoffs: false,
					gp: 82,
					pts: 8800,
					oppPts: 8400,
				},
			],
		});

		const ranked = rankTeamSeasons([goodButOut, champ]);
		assert.strictEqual(ranked[0]!.tid, 0);
		assert.isTrue(ranked[0]!.wonTitle);
		assert.isFalse(ranked.find((r) => r.tid === 1)!.wonTitle);
	});

	test("disabled teams and zero-game seasons are skipped", () => {
		const disabled = team({
			tid: 5,
			disabled: true,
			seasons: [teamSeason(2000, 50, 32, 1)],
		});
		const empty = team({
			tid: 6,
			seasons: [{ ...teamSeason(2000, 0, 0, 0), tid: 6 }],
		});
		assert.lengthOf(rankTeamSeasons([disabled, empty]), 0);
	});
});

describe("rankDraftValue", () => {
	test("a low-WS first-rounder is a bust; a high-WS second-rounder is a steal", () => {
		const players: RawPlayer[] = [
			// First round: two solid, one flop -> the flop is the bust.
			player({
				pid: 1,
				draft: { round: 1, pick: 1, year: 2000 },
				stats: Array.from({ length: 5 }, (_, i) => statRow(2001 + i, 12)),
			}),
			player({
				pid: 2,
				draft: { round: 1, pick: 2, year: 2000 },
				stats: Array.from({ length: 5 }, (_, i) => statRow(2001 + i, 11)),
			}),
			player({
				pid: 3,
				firstName: "Flop",
				draft: { round: 1, pick: 3, year: 2000 },
				stats: Array.from({ length: 5 }, (_, i) => statRow(2001 + i, 1)),
			}),
			// Second round: two nobodies, one star -> the star is the steal.
			player({
				pid: 4,
				draft: { round: 2, pick: 1, year: 2000 },
				stats: Array.from({ length: 5 }, (_, i) => statRow(2001 + i, 1)),
			}),
			player({
				pid: 5,
				draft: { round: 2, pick: 2, year: 2000 },
				stats: Array.from({ length: 5 }, (_, i) => statRow(2001 + i, 1)),
			}),
			player({
				pid: 6,
				firstName: "Gem",
				draft: { round: 2, pick: 3, year: 2000 },
				stats: Array.from({ length: 8 }, (_, i) => statRow(2001 + i, 12)),
			}),
		];

		const { busts, steals } = rankDraftValue(players);
		assert.strictEqual(busts[0]!.pid, 3);
		assert.isBelow(busts[0]!.delta!, 0);
		assert.strictEqual(steals[0]!.pid, 6);
		assert.isAbove(steals[0]!.delta!, 0);
	});

	test("players below the minimum career length are excluded from both lists", () => {
		const cupOfCoffee = player({
			pid: 9,
			draft: { round: 1, pick: 1, year: 2000 },
			stats: [statRow(2001, 0.1)],
		});
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
		const t = team({
			tid: 0,
			seasons: [teamSeason(2000, 60, 22, 4), teamSeason(2001, 58, 24, 4)],
		});
		assert.lengthOf(findDynasties([t]), 0);
	});
});

describe("deriveCanon", () => {
	test("returns all five tables", () => {
		const players = [
			player({
				pid: 1,
				stats: [statRow(2000, 10), statRow(2001, 10), statRow(2002, 10)],
			}),
		];
		const teams = [
			team({
				tid: 0,
				seasons: [teamSeason(2000, 50, 32, 1)],
				stats: [
					{
						tid: 0,
						season: 2000,
						playoffs: false,
						gp: 82,
						pts: 8500,
						oppPts: 8400,
					},
				],
			}),
		];
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

// The v1 bug report's SEV-1s: win shares read as zero everywhere, so the greatest-players evidence
// fields were all 0 and the busts/steals sort key had no variance at all (the lists were really the
// lowest player ids matching a round filter). And team-season point differential existed only for
// the seasons the league had simulated, silently costing every earlier team a whole component.
describe("regressions from the v1 export bug report", () => {
	const wsRow = (season: number, ows: number, dws: number) => ({
		...statRow(season, 0),
		ws: undefined,
		ows,
		dws,
	});

	test("careerWS is derived from ows + dws rather than a nonexistent ws column", () => {
		const p = player({
			pid: 1,
			stats: [wsRow(2000, 6, 3), wsRow(2001, 5, 2)],
		});
		const [entry] = rankPlayers([p]);
		assert.strictEqual(entry!.careerWS, 16);
		assert.strictEqual(entry!.valueMetric, "ws");
		assert.isAbove(entry!.greatness, 0);
	});

	test("a league with no win shares falls back to VORP and says so", () => {
		const p = player({
			pid: 1,
			stats: Array.from({ length: 4 }, (_, i) => ({
				...statRow(2000 + i, 0),
				ws: undefined,
				ows: undefined,
				dws: undefined,
				vorp: 5,
			})),
		});
		const [entry] = rankPlayers([p]);
		assert.isNull(entry!.careerWS);
		assert.strictEqual(entry!.valueMetric, "vorp");
		assert.isAbove(entry!.greatness, 0);
	});

	test("busts and steals are actually ranked, not left in insertion order", () => {
		const players: RawPlayer[] = Array.from({ length: 12 }, (_, i) =>
			player({
				pid: i + 1,
				draft: { round: 1, pick: i + 1, year: 2000 },
				stats: Array.from({ length: 5 }, (_, j) => wsRow(2001 + j, i, 0)),
			}),
		);
		const { busts } = rankDraftValue(players);
		const deltas = busts.map((b) => b.delta!);
		assert.isAbove(new Set(deltas).size, 1, "sort key must have variance");
		// Ascending delta: the worst underperformer first.
		assert.deepEqual(
			deltas,
			[...deltas].sort((a, b) => a - b),
		);
	});

	test("expected value is fitted per draft slot, so pick 1 and pick 30 aren't held to one bar", () => {
		// Pick 1s are stars, pick 30s are marginal. A merely-good pick 1 should still read as a bust.
		const players: RawPlayer[] = [];
		for (let i = 0; i < 8; i++) {
			players.push(
				player({
					pid: 100 + i,
					draft: { round: 1, pick: 1, year: 2000 + i },
					stats: Array.from({ length: 5 }, (_, j) =>
						wsRow(2001 + i + j, 15, 0),
					),
				}),
				player({
					pid: 200 + i,
					draft: { round: 1, pick: 30, year: 2000 + i },
					stats: Array.from({ length: 5 }, (_, j) => wsRow(2001 + i + j, 2, 0)),
				}),
			);
		}
		// Same career, two very different slots.
		players.push(
			player({
				pid: 1,
				draft: { round: 1, pick: 1, year: 2010 },
				stats: Array.from({ length: 5 }, (_, j) => wsRow(2011 + j, 6, 0)),
			}),
			player({
				pid: 2,
				draft: { round: 1, pick: 30, year: 2010 },
				stats: Array.from({ length: 5 }, (_, j) => wsRow(2011 + j, 6, 0)),
			}),
		);

		const { busts } = rankDraftValue(players);
		const topPick = busts.find((b) => b.pid === 1)!;
		const latePick = busts.find((b) => b.pid === 2)!;
		assert.strictEqual(topPick.expectedFrom, "slot");
		assert.isBelow(
			topPick.delta!,
			0,
			"a 30-WS career at pick 1 underperforms the slot",
		);
		assert.isAbove(
			latePick.delta!,
			0,
			"the same career at pick 30 overperforms it",
		);
	});

	test("point differential is backfilled from the games when team stat rows are missing", () => {
		const noStats = team({
			tid: 0,
			seasons: [teamSeason(2000, 70, 12, 4)],
			stats: [],
		});
		const ranked = rankTeamSeasons([noStats], {
			pointsFromGames: new Map([
				[0, new Map([[2000, { gp: 82, pts: 9020, oppPts: 8200 }]])],
			]),
		});
		assert.strictEqual(ranked[0]!.pointDiffPerGame, 10);
		assert.isFalse(ranked[0]!.pointDiffImputed);
	});

	test("a season with no differential data anywhere is flagged rather than scored as average", () => {
		// A modern era with box scores, so the win% -> differential relationship can be fitted...
		const modernSeasons = [
			{ won: 70, lost: 12, rounds: 4, pts: 9020, oppPts: 8200 },
			{ won: 60, lost: 22, rounds: 2, pts: 8800, oppPts: 8400 },
			{ won: 50, lost: 32, rounds: 1, pts: 8500, oppPts: 8450 },
			{ won: 41, lost: 41, rounds: 0, pts: 8300, oppPts: 8330 },
			{ won: 30, lost: 52, rounds: -1, pts: 8100, oppPts: 8500 },
			{ won: 20, lost: 62, rounds: -1, pts: 8000, oppPts: 8900 },
		];
		const known = team({
			tid: 0,
			seasons: modernSeasons.map((s, i) =>
				teamSeason(2000 + i, s.won, s.lost, s.rounds),
			),
			stats: modernSeasons.map((s, i) => ({
				tid: 0,
				season: 2000 + i,
				playoffs: false,
				gp: 82,
				pts: s.pts,
				oppPts: s.oppPts,
			})),
		});
		// ...and an imported early era that has records but no box scores at all.
		const unknown = team({
			tid: 1,
			seasons: [{ ...teamSeason(1960, 68, 14, 4), tid: 1 }],
			stats: [],
		});

		const ranked = rankTeamSeasons([known, unknown]);
		const old = ranked.find((r) => r.tid === 1)!;
		assert.isNull(
			old.pointDiffPerGame,
			"the real value is unknown, and says so",
		);
		assert.isTrue(old.pointDiffImputed);
		// A 68-14 title team must not be scored below a 70-12 title team purely because its era has
		// no box scores; the imputed differential keeps the gap down to the record difference.
		const modern = ranked.find((r) => r.tid === 0 && r.season === 2000)!;
		assert.isBelow(Math.abs(modern.greatness - old.greatness), 5);
	});
});
