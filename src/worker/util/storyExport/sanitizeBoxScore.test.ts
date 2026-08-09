import { assert, describe, test } from "vitest";
import { parseClutchPlay, sanitizeBoxScore } from "./sanitizeBoxScore.ts";

describe("parseClutchPlay", () => {
	test("strips the league-relative HTML and recovers the entities it linked to", () => {
		const parsed = parseClutchPlay(
			'<a href="/l/3/player/4177">Buddy Hield</a> made a three-pointer at the buzzer.',
		);
		assert.strictEqual(
			parsed.text,
			"Buddy Hield made a three-pointer at the buzzer.",
		);
		assert.deepEqual(parsed.pids, [4177]);
	});

	test("recovers both sides of a two-player play, and team links", () => {
		const parsed = parseClutchPlay(
			'<a href="/l/3/player/1">A One</a> (<a href="/l/3/roster/PHI/2016">PHI</a>) defeated <a href="/l/3/player/2">B Two</a> in a shootout',
		);
		assert.deepEqual(parsed.pids, [1, 2]);
		assert.deepEqual(parsed.teamAbbrevs, ["PHI"]);
		assert.strictEqual(parsed.text, "A One (PHI) defeated B Two in a shootout");
	});
});

describe("sanitizeBoxScore", () => {
	test("rounds minutes to one decimal for teams and players", () => {
		const out = sanitizeBoxScore({
			gid: 1,
			teams: [
				{
					tid: 0,
					min: 240.00000000001,
					players: [{ pid: 1, min: 35.164555269229595 }],
				},
				{ tid: 1, min: 240, players: [{ pid: 2, min: 12 }] },
			],
		}) as any;
		assert.strictEqual(out.teams[0].min, 240);
		assert.strictEqual(out.teams[0].players[0].min, 35.2);
		assert.strictEqual(out.teams[1].players[0].min, 12);
	});

	test("clutchPlays become plain text plus a structured detail array", () => {
		const out = sanitizeBoxScore({
			gid: 1,
			clutchPlays: ['<a href="/l/3/player/9">C Three</a> hit the game winner.'],
			teams: [],
		}) as any;
		assert.deepEqual(out.clutchPlays, ["C Three hit the game winner."]);
		assert.deepEqual(out.clutchPlaysDetail, [
			{
				text: "C Three hit the game winner.",
				pids: [9],
				teamAbbrevs: [],
			},
		]);
	});

	test("the source object is not mutated", () => {
		const game = {
			gid: 1,
			clutchPlays: ['<a href="/l/3/player/9">C</a> scored.'],
			teams: [{ tid: 0, min: 240.5, players: [{ pid: 1, min: 1.23456 }] }],
		};
		sanitizeBoxScore(game);
		assert.strictEqual(game.teams[0]!.players[0]!.min, 1.23456);
		assert.include(game.clutchPlays[0]!, "<a href");
	});
});
