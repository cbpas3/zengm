import { assert, describe, test } from "vitest";
import {
	computeGameNotability,
	gameScore,
	STORY_NOTABILITY,
	type BoxGame,
	type BoxPlayerLine,
} from "./gameNotability.ts";

const line = (overrides: Partial<BoxPlayerLine> = {}): BoxPlayerLine => ({
	pid: 1,
	min: 30,
	pts: 0,
	fg: 0,
	fga: 0,
	ft: 0,
	fta: 0,
	orb: 0,
	drb: 0,
	ast: 0,
	stl: 0,
	blk: 0,
	tov: 0,
	pf: 0,
	...overrides,
});

const game = (overrides: Partial<BoxGame> = {}): BoxGame => ({
	gid: 1,
	season: 2022,
	playoffs: false,
	overtimes: 0,
	teams: [
		{ tid: 0, pts: 100, players: [line({ pid: 1 })] },
		{ tid: 1, pts: 98, players: [line({ pid: 2 })] },
	],
	...overrides,
});

describe("gameScore", () => {
	test("a clean 40-10-10 line scores far above an empty line", () => {
		const star = line({
			pts: 40,
			fg: 15,
			fga: 25,
			ft: 8,
			fta: 9,
			orb: 2,
			drb: 8,
			ast: 10,
			stl: 2,
			blk: 1,
			tov: 3,
			pf: 2,
		});
		assert.isAbove(gameScore(star), 30);
		assert.isBelow(gameScore(line()), 1);
	});

	test("turnovers and missed shots drag the score down", () => {
		const inefficient = line({ pts: 10, fg: 5, fga: 25, tov: 8 });
		const efficient = line({ pts: 10, fg: 4, fga: 6, tov: 0 });
		assert.isAbove(gameScore(efficient), gameScore(inefficient));
	});
});

describe("computeGameNotability", () => {
	test("a dull average blowout-adjacent game is not notable", () => {
		const g = game({
			teams: [
				{
					tid: 0,
					pts: 100,
					players: [line({ pid: 1, pts: 12, fg: 5, fga: 11 })],
				},
				{
					tid: 1,
					pts: 88,
					players: [line({ pid: 2, pts: 10, fg: 4, fga: 12 })],
				},
			],
		});
		const n = computeGameNotability(g);
		assert.isFalse(n.notable);
	});

	test("an elite individual game flags the whole game notable and lists the player", () => {
		const star = line({
			pid: 7,
			pts: 55,
			fg: 20,
			fga: 30,
			ft: 12,
			fta: 13,
			drb: 6,
			ast: 5,
			stl: 2,
		});
		const g = game({
			teams: [
				{ tid: 0, pts: 130, players: [star] },
				{ tid: 1, pts: 120, players: [line({ pid: 2, pts: 20 })] },
			],
		});
		const n = computeGameNotability(g);
		assert.isTrue(n.notable);
		assert.include(n.notablePids, 7);
		assert.strictEqual(n.topScorerPid, 7);
	});

	test("playoff and finals games are always notable, and finals score higher", () => {
		const reg = computeGameNotability(game({ playoffs: false }));
		const playoff = computeGameNotability(game({ playoffs: true }));
		const finals = computeGameNotability(
			game({ playoffs: true, finals: true }),
		);
		assert.isTrue(playoff.notable);
		assert.isTrue(finals.notable);
		assert.isAbove(finals.notability, playoff.notability);
		assert.isAbove(playoff.notability, reg.notability);
	});

	test("a feat forces notability even on an otherwise dull game", () => {
		const dull = game();
		assert.isFalse(computeGameNotability(dull).notable);
		assert.isTrue(computeGameNotability(dull, { hasFeat: true }).notable);
	});

	test("players who didn't play (min 0) are ignored", () => {
		const g = game({
			teams: [
				{
					tid: 0,
					pts: 100,
					players: [
						line({ pid: 1, pts: 30, min: 30 }),
						line({ pid: 9, pts: 0, min: 0 }),
					],
				},
				{ tid: 1, pts: 98, players: [line({ pid: 2, pts: 25, min: 25 })] },
			],
		});
		const n = computeGameNotability(g);
		assert.strictEqual(n.topScorerPid, 1);
		assert.notInclude(n.notablePids, 9);
	});

	test("close games and overtime add notability over the same game decided comfortably", () => {
		const comfortable = computeGameNotability(
			game({
				teams: [
					{ tid: 0, pts: 110, players: [line({ pid: 1, pts: 20 })] },
					{ tid: 1, pts: 96, players: [line({ pid: 2, pts: 18 })] },
				],
			}),
		);
		const nailbiter = computeGameNotability(
			game({
				overtimes: 1,
				teams: [
					{ tid: 0, pts: 110, players: [line({ pid: 1, pts: 20 })] },
					{ tid: 1, pts: 108, players: [line({ pid: 2, pts: 18 })] },
				],
			}),
		);
		assert.isAbove(nailbiter.notability, comfortable.notability);
	});

	test("the player-notability threshold constant governs notablePids membership", () => {
		const justUnder = line({
			pid: 3,
			pts: STORY_NOTABILITY.PLAYER_GAME_SCORE - 5,
			fg: 4,
			fga: 8,
		});
		const n = computeGameNotability(
			game({
				teams: [
					{ tid: 0, pts: 90, players: [justUnder] },
					{ tid: 1, pts: 88, players: [line({ pid: 2, pts: 10 })] },
				],
			}),
		);
		assert.notInclude(n.notablePids, 3);
	});
});
