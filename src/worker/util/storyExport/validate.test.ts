import { assert, describe, test } from "vitest";
import { assembleKnowledgeBase } from "./assembleKnowledgeBase.ts";
import { validateKnowledgeBase } from "./validate.ts";
import type { KnowledgeBase, RawPlayer, RawTeam } from "./types.ts";

const player = (pid: number, ows: number): RawPlayer => ({
	pid,
	firstName: `P${pid}`,
	lastName: "Player",
	tid: 0,
	born: { year: 1990 },
	draft: { round: 1, pick: pid, year: 2010 },
	awards: [],
	ratings: [{ season: 2015, ovr: 60, pot: 70, pos: "SF", skills: ["3"] }],
	stats: [
		{
			season: 2015,
			tid: 0,
			playoffs: false,
			gp: 82,
			min: 2800,
			pts: 1200 + pid,
			ast: 300,
			orb: 100,
			drb: 300,
			ows,
			dws: 2,
			per: 18,
			vorp: 3,
		},
	],
});

const team = (): RawTeam => ({
	tid: 0,
	abbrev: "AAA",
	region: "Alpha",
	name: "Aces",
	did: 0,
	seasons: [
		{
			tid: 0,
			season: 2015,
			won: 60,
			lost: 22,
			tied: 0,
			otl: 0,
			playoffRoundsWon: 4,
		},
	],
	stats: [
		{ tid: 0, season: 2015, playoffs: false, gp: 82, pts: 9000, oppPts: 8500 },
	],
});

const kbFor = (players: RawPlayer[]): KnowledgeBase =>
	assembleKnowledgeBase({
		players,
		teams: [team()],
		leagueName: "Test League",
		generatedAtSeason: 2016,
	});

const FILES = [
	"meta.json",
	"players.json",
	"teams.json",
	"league.json",
	"rankings.json",
	"dynasties.json",
	"rivalries.json",
	"playoffSeries.json",
	"awards.json",
	"leaderboards.json",
	"gameIndex.json",
	"README.md",
	"canon-workflow.md",
	"pull_games.py",
];

const NO_DOCS = { files: [], claims: [] };

describe("validateKnowledgeBase", () => {
	test("a healthy bundle produces no issues", () => {
		const kb = kbFor([player(1, 8), player(2, 5), player(3, 2)]);
		assert.deepEqual(validateKnowledgeBase(kb, FILES, NO_DOCS), []);
	});

	test("catches an all-zero numeric column - the shape of the win-shares bug", () => {
		// 25 players whose ows/dws sum to exactly 0: `ws` is present, numeric, and meaningless.
		const players = Array.from({ length: 25 }, (_, i) => ({
			...player(i + 1, 0),
			stats: [{ ...player(i + 1, 0).stats[0]!, ows: 0, dws: 0 }],
		}));
		const issues = validateKnowledgeBase(kbFor(players), FILES, NO_DOCS);
		const issue = issues.find((i) => i.check === "all-zero-column");
		assert.exists(issue);
		assert.include(issue!.message, "ws");
		assert.strictEqual(issue!.severity, "error");
	});

	test("catches a ranking whose sort key has no variance", () => {
		const kb = kbFor([player(1, 5)]);
		// Every entry identical: the list is insertion order wearing a rank field.
		kb.canon.players = Array.from({ length: 10 }, (_, i) => ({
			...kb.canon.players[0]!,
			pid: i + 1,
			rank: i + 1,
			greatness: 0,
		}));
		const issues = validateKnowledgeBase(kb, FILES, NO_DOCS);
		const issue = issues.find((i) => i.check === "unranked-list");
		assert.exists(issue);
		assert.include(issue!.message, "canon.players.greatness");
	});

	test("catches docs that reference a file or a field the bundle doesn't contain", () => {
		const kb = kbFor([player(1, 5)]);
		const issues = validateKnowledgeBase(kb, FILES, {
			files: ["seasons.json"],
			claims: [{ path: "canon.players.trueShooting", describe: "made up" }],
		});
		assert.exists(issues.find((i) => i.check === "documented-file-missing"));
		assert.exists(issues.find((i) => i.check === "documented-field-missing"));
	});

	test("catches a record whose schema differs from its neighbours'", () => {
		const kb = kbFor([player(1, 5), player(2, 4)]);
		// The v1 failure mode exactly: 114 players simply had no `pos` key, because JSON.stringify
		// drops undefined.
		delete (kb.players[1] as unknown as Record<string, unknown>).pos;
		const issues = validateKnowledgeBase(kb, FILES, NO_DOCS);
		const issue = issues.find((i) => i.check === "non-uniform-schema");
		assert.exists(issue);
		assert.include(issue!.message, "pos");
	});
});
