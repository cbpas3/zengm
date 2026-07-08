// AI game plans (Harder RPD Challenge, Phase 5 revival / F-H in GAME_PLAN_REBALANCE_PLAN.md):
// a deterministic, personnel-driven game plan for AI teams that don't have one stored. Before
// this, the only write site for Team.gamePlan was the user's own updateGamePlan endpoint, so
// every AI team's gamePlan was undefined forever - the user's dials were exploited against
// opponents who could never dial back (F2 in the plan). This gives every AI team a plan of its
// own, and revives the in-series adjustment logic (getInSeriesGamePlan in loadTeams.ts), which
// was dead code for exactly the same reason (it only ever adjusted an already-defined plan).
import { helpers } from "../../util/index.ts";
import type { GamePlan } from "./inSeriesAdjustments.ts";

export type GenAiGamePlanPlayer = {
	compositeRating: {
		shootingThreePointer: number;
		defensePerimeter: number;
		rebounding: number;
		pace: number;
		usage: number;
	};
};

// Same pivot used to calibrate eq() (see gamePlanTuning.ts's EQ_PIVOT comment) - measured against
// a realistically-generated league, and close enough for this heuristic mapping too. SPREAD
// controls how much a composite has to deviate from that pivot to swing a slider across its full
// +/-25 range around neutral.
const PIVOT = 0.62;
const SPREAD = 0.15;

// Contending teams lean harder into their personnel (strengths and weaknesses alike) than
// rebuilding teams, who play it safer/more neutral.
const CONTENDING_AMPLIFICATION = 1.25;

const average = (values: number[]) =>
	values.length === 0
		? 0.5
		: values.reduce((sum, value) => sum + value, 0) / values.length;

// Maps a raw deviation from PIVOT into a slider value, clamped to the plan's ~25-75 target range
// (never maxed out - an AI plan is meant to read as "leans into its roster," not "every dial at an
// extreme").
const deviationToSlider = (
	deviation: number,
	strategy: "rebuilding" | "contending",
) => {
	const base = 50 + (deviation / SPREAD) * 25;
	const amplified =
		strategy === "contending"
			? 50 + (base - 50) * CONTENDING_AMPLIFICATION
			: base;
	return helpers.bound(Math.round(amplified), 25, 75);
};

const compositeToSlider = (
	composite: number,
	strategy: "rebuilding" | "contending",
) => deviationToSlider(composite - PIVOT, strategy);

// players should already be filtered to healthy players (those who will actually get minutes),
// same convention as computeSchemeFit/computeDepthTax - the "who actually plays" proxy.
export const genAiGamePlan = (
	players: GenAiGamePlanPlayer[],
	strategy: "rebuilding" | "contending",
): GamePlan => {
	const threePointComposite = average(
		players.map((p) => p.compositeRating.shootingThreePointer),
	);
	const defensePerimeterComposite = average(
		players.map((p) => p.compositeRating.defensePerimeter),
	);
	const reboundingComposite = average(
		players.map((p) => p.compositeRating.rebounding),
	);
	const paceComposite = average(players.map((p) => p.compositeRating.pace));

	const usages = players.map((p) => p.compositeRating.usage);
	const topUsage = usages.length === 0 ? 0 : Math.max(...usages);
	const usageDominance = topUsage - average(usages);

	const rebounding = compositeToSlider(reboundingComposite, strategy);

	return {
		pace: 50,
		threePointRate: compositeToSlider(threePointComposite, strategy),
		postPlay: 50,
		rimAttack: 50,
		// Inverse: a team built around one dominant usage player leans ISO to feed him; a
		// balanced roster shares the ball more - so higher dominance means *lower* ballMovement.
		ballMovement: 100 - deviationToSlider(usageDominance, strategy),
		transition: compositeToSlider(paceComposite, strategy),
		crashOffensiveGlass: rebounding,
		pickCoverage: 50,
		perimeterPressure: compositeToSlider(defensePerimeterComposite, strategy),
		helpAggression: 50,
		defensiveGlass: rebounding,
	};
};
