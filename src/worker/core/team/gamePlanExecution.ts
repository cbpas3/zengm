// F-J (GAME_PLAN_REBALANCE_PLAN.md): a small "how good is my roster at X" readout for the Roster
// page's GamePlanEditor - a dial that silently executes at the eq() floor (25%) feels broken
// without some indication of why. Reuses the exact eq() gate the sim itself reads, and the same
// "top 8 healthy players by rosterOrder" convention as positionalDepthTax/schemeFit.
import { player } from "../index.ts";
import { COMPOSITE_WEIGHTS } from "../../../common/constants.ts";
import { eq } from "../GameSim.basketball/gamePlanTuning.ts";

export type GamePlanExecutionLabel = "Poor" | "Average" | "Elite";

export type GamePlanExecution = {
	rebounding: GamePlanExecutionLabel;
	defense: GamePlanExecutionLabel;
	defensePerimeter: GamePlanExecutionLabel;
	blocking: GamePlanExecutionLabel;
	pace: GamePlanExecutionLabel;
};

const labelForComposite = (composite: number): GamePlanExecutionLabel => {
	const eqValue = eq(composite);
	if (eqValue >= 0.75) {
		return "Elite";
	}
	if (eqValue <= 0.35) {
		return "Poor";
	}
	return "Average";
};

const averageComposite = (
	players: { ratings: any }[],
	key: "rebounding" | "defense" | "defensePerimeter" | "blocking" | "pace",
) => {
	if (players.length === 0) {
		return 0.5;
	}
	const weightInfo = (COMPOSITE_WEIGHTS as any)[key];
	let sum = 0;
	for (const p of players) {
		sum += player.compositeRating(
			p.ratings,
			weightInfo.ratings,
			weightInfo.weights,
			false,
		);
	}
	return sum / players.length;
};

// players should already be filtered to the top 8 healthy players by rosterOrder - the same
// convention computeSchemeFit/computeDepthTax use for "who actually plays."
export const computeGamePlanExecution = (
	players: { ratings: any }[],
): GamePlanExecution => ({
	rebounding: labelForComposite(averageComposite(players, "rebounding")),
	defense: labelForComposite(averageComposite(players, "defense")),
	defensePerimeter: labelForComposite(
		averageComposite(players, "defensePerimeter"),
	),
	blocking: labelForComposite(averageComposite(players, "blocking")),
	pace: labelForComposite(averageComposite(players, "pace")),
});
