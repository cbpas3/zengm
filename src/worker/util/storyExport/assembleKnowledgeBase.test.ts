import { assert, describe, test } from "vitest";
import { assembleKnowledgeBase } from "./assembleKnowledgeBase.ts";
import { buildReadme, serializeBundle } from "./serialize.ts";
import type { GameIndexRow, RawPlayer, RawTeam } from "./types.ts";

const rawPlayer = (pid: number, ws: number): RawPlayer => ({
	pid,
	firstName: "P",
	lastName: `${pid}`,
	tid: 0,
	born: { year: 1990 },
	draft: { round: 1, pick: pid, year: 2010 },
	awards: [{ season: 2015, type: "Won Championship" }],
	ratings: [{ season: 2011, ovr: 60, pot: 70, pos: "PG" }],
	stats: Array.from({ length: 5 }, (_, i) => ({
		season: 2011 + i,
		tid: 0,
		playoffs: false,
		gp: 70,
		min: 2000,
		pts: 1400,
		trb: 300,
		ast: 250,
		ws,
		vorp: 2,
		per: 18,
		ewa: ws,
	})),
	statsTids: [0],
});

const rawTeam = (): RawTeam => ({
	tid: 0,
	abbrev: "AAA",
	region: "Alpha",
	name: "Aces",
	did: 0,
	seasons: [
		{ tid: 0, season: 2015, won: 60, lost: 22, tied: 0, otl: 0, playoffRoundsWon: 4 },
	],
	stats: [{ season: 2015, playoffs: false, gp: 82, pts: 9000, oppPts: 8500 }],
});

const gameIndexRow = (gid: number): GameIndexRow => ({
	gid,
	season: 2015,
	playoffs: false,
	finals: false,
	tids: [0, 1],
	winnerTid: 0,
	loserTid: 1,
	margin: 8,
	pids: [1, 2],
	topScorerPid: 1,
	notability: 20,
	notable: gid === 2,
	notablePids: [],
});

describe("assembleKnowledgeBase", () => {
	test("produces the full table set with meta counts and stamped titles", () => {
		const kb = assembleKnowledgeBase({
			players: [rawPlayer(1, 10), rawPlayer(2, 4)],
			teams: [rawTeam()],
			gameIndex: [gameIndexRow(1), gameIndexRow(2)],
			notableGids: [2],
			leagueName: "Test League",
			generatedAtSeason: 2016,
		});

		assert.strictEqual(kb.meta.leagueName, "Test League");
		assert.strictEqual(kb.meta.counts.players, 2);
		assert.strictEqual(kb.meta.counts.teams, 1);
		assert.strictEqual(kb.meta.counts.games, 2);
		assert.strictEqual(kb.meta.counts.seasons, 1);

		// Players projected; canon ranks the higher-WS player first.
		assert.strictEqual(kb.players.length, 2);
		assert.strictEqual(kb.canon.players[0]!.pid, 1);

		// Team title stamped (won all 4 rounds, the season's max).
		assert.deepEqual(kb.teams[0]!.titleSeasons, [2015]);
		assert.strictEqual(kb.teams[0]!.titles, 1);

		assert.deepEqual(kb.notableGids, [2]);
	});
});

describe("serializeBundle", () => {
	const kb = assembleKnowledgeBase({
		players: [rawPlayer(1, 10)],
		teams: [rawTeam()],
		gameIndex: [gameIndexRow(1), gameIndexRow(2)],
		notableGids: [2],
		leagueName: "Test League",
	});

	test("emits the core files, all valid JSON where applicable", () => {
		const files = serializeBundle(kb);
		const paths = files.map((f) => f.path);
		for (const required of [
			"meta.json",
			"players.json",
			"teams.json",
			"rankings.json",
			"dynasties.json",
			"rivalries.json",
			"gameIndex.json",
			"README.md",
			"canon-workflow.md",
			"pull_games.py",
		]) {
			assert.include(paths, required);
		}
		// JSON files parse.
		for (const f of files.filter((f) => f.path.endsWith(".json"))) {
			assert.doesNotThrow(() => JSON.parse(f.content));
		}
		// No box-score files unless asked.
		assert.notInclude(paths, "notableGames.json");
		assert.isUndefined(paths.find((p) => p.startsWith("games/")));
	});

	test("box-score layers are opt-in and sharded by season", () => {
		const files = serializeBundle(kb, {
			notableBoxScores: [{ gid: 2 }],
			fullGamesBySeason: new Map([
				[2015, [{ gid: 1 }, { gid: 2 }]],
				[2016, [{ gid: 3 }]],
			]),
		});
		const paths = files.map((f) => f.path);
		assert.include(paths, "notableGames.json");
		assert.include(paths, "games/season-2015.ndjson");
		assert.include(paths, "games/season-2016.ndjson");
		// NDJSON: one game per line.
		const shard = files.find((f) => f.path === "games/season-2015.ndjson")!;
		assert.strictEqual(shard.content.split("\n").length, 2);
	});

	test("README carries the ground-truth preamble and league facts", () => {
		const readme = buildReadme(kb);
		assert.include(readme, "fictional");
		assert.include(readme, "Test League");
		assert.include(readme, "pull_games.py");
	});
});
