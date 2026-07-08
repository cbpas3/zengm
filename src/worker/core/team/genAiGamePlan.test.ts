import { assert, describe, test } from "vitest";
import { genAiGamePlan, type GenAiGamePlanPlayer } from "./genAiGamePlan.ts";

// T-D1 (GAME_PLAN_REBALANCE_PLAN.md section 6, Suite D): unit tests on genAiGamePlan.

const PIVOT = 0.62; // matches gamePlanTuning.ts's EQ_PIVOT / genAiGamePlan.ts's own PIVOT

const makePlayer = (
	overrides: Partial<GenAiGamePlanPlayer["compositeRating"]> = {},
) => ({
	compositeRating: {
		shootingThreePointer: PIVOT,
		defensePerimeter: PIVOT,
		rebounding: PIVOT,
		pace: PIVOT,
		usage: PIVOT,
		...overrides,
	},
});

const averageRoster = (n = 8) => Array.from({ length: n }, () => makePlayer());

describe("genAiGamePlan", () => {
	test("average roster (every composite at the pivot) yields all-50s", () => {
		const plan = genAiGamePlan(averageRoster(), "rebuilding");
		for (const value of Object.values(plan)) {
			assert.strictEqual(value, 50);
		}
	});

	test("sliders correlate with roster strengths - a great shooting roster gets a higher threePointRate, a bad one gets lower", () => {
		const goodShooting = averageRoster().map((p) => ({
			compositeRating: { ...p.compositeRating, shootingThreePointer: 0.9 },
		}));
		const badShooting = averageRoster().map((p) => ({
			compositeRating: { ...p.compositeRating, shootingThreePointer: 0.2 },
		}));

		const goodPlan = genAiGamePlan(goodShooting, "rebuilding");
		const badPlan = genAiGamePlan(badShooting, "rebuilding");

		assert(
			goodPlan.threePointRate > 50,
			"elite shooting roster should lean into threes",
		);
		assert(
			badPlan.threePointRate < 50,
			"bad shooting roster should lean away from threes",
		);
		assert(goodPlan.threePointRate > badPlan.threePointRate);
	});

	test("sliders correlate with roster strengths - perimeter defense, rebounding, and pace each drive their own dial", () => {
		const strongDefense = averageRoster().map((p) => ({
			compositeRating: { ...p.compositeRating, defensePerimeter: 0.9 },
		}));
		assert(
			genAiGamePlan(strongDefense, "rebuilding").perimeterPressure > 50,
			"strong perimeter defense should lean into ball pressure",
		);

		const strongRebounding = averageRoster().map((p) => ({
			compositeRating: { ...p.compositeRating, rebounding: 0.9 },
		}));
		const reboundingPlan = genAiGamePlan(strongRebounding, "rebuilding");
		assert(
			reboundingPlan.crashOffensiveGlass > 50 &&
				reboundingPlan.defensiveGlass > 50,
			"strong rebounding roster should crash both glasses harder",
		);

		const fastRoster = averageRoster().map((p) => ({
			compositeRating: { ...p.compositeRating, pace: 0.9 },
		}));
		assert(
			genAiGamePlan(fastRoster, "rebuilding").transition > 50,
			"high-pace roster should lean into transition",
		);
	});

	test("ballMovement runs inverse to top-player usage dominance", () => {
		const balanced = averageRoster(); // every player at the same usage - no dominance
		const starCentric = averageRoster().map((p, i) => ({
			compositeRating: {
				...p.compositeRating,
				usage: i === 0 ? 0.9 : PIVOT,
			},
		}));

		const balancedPlan = genAiGamePlan(balanced, "rebuilding");
		const starCentricPlan = genAiGamePlan(starCentric, "rebuilding");

		assert.strictEqual(balancedPlan.ballMovement, 50);
		assert(
			starCentricPlan.ballMovement < 50,
			"a team built around one dominant-usage player should lean ISO (low ballMovement)",
		);
	});

	test("contending teams lean harder into their strengths (and weaknesses) than rebuilding teams", () => {
		// A modest deviation, not 0.85+ - a big enough edge already clamps to the 75 ceiling for
		// both strategies, which would hide the amplification this test is checking for.
		const goodShooting = averageRoster().map((p) => ({
			compositeRating: { ...p.compositeRating, shootingThreePointer: 0.72 },
		}));

		const rebuildingPlan = genAiGamePlan(goodShooting, "rebuilding");
		const contendingPlan = genAiGamePlan(goodShooting, "contending");

		assert(
			contendingPlan.threePointRate > rebuildingPlan.threePointRate,
			`contending (${contendingPlan.threePointRate}) should lean harder than rebuilding (${rebuildingPlan.threePointRate})`,
		);
	});

	test("output is always within [0, 100], and within the plan's ~25-75 target range even at extreme inputs", () => {
		const extremeRosters = [
			averageRoster().map(() =>
				makePlayer({
					shootingThreePointer: 1,
					defensePerimeter: 1,
					rebounding: 1,
					pace: 1,
					usage: 1,
				}),
			),
			averageRoster().map(() =>
				makePlayer({
					shootingThreePointer: 0,
					defensePerimeter: 0,
					rebounding: 0,
					pace: 0,
					usage: 0,
				}),
			),
		];

		for (const roster of extremeRosters) {
			for (const strategy of ["rebuilding", "contending"] as const) {
				const plan = genAiGamePlan(roster, strategy);
				for (const value of Object.values(plan)) {
					assert(value >= 0 && value <= 100, `${value} out of [0, 100]`);
					assert(
						value >= 25 && value <= 75,
						`${value} out of the ~25-75 target range`,
					);
				}
			}
		}
	});

	test("empty roster doesn't throw and stays at neutral defaults", () => {
		const plan = genAiGamePlan([], "rebuilding");
		for (const value of Object.values(plan)) {
			assert(value >= 25 && value <= 75);
		}
	});
});
