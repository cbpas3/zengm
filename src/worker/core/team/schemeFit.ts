// Basketball-only scheme-fit (Harder RPD Challenge, Phase 3): punishes setting a game plan
// that doesn't match your personnel - cranking threePointRate with no shooters, or postPlay
// with no post scorers. Primary signal is actual ratings (works for every player, dev-focus or
// not); DEV_FOCUS_GAMEPLAN_AFFINITY is an optional bonus layer on top.
//
// Mirrors positionalDepthTax.ts: a shared compute helper called from processTeam (loadTeams.ts),
// applied in GameSim.basketball's doShot alongside the existing game-plan reads.
import type { DevFocusType } from "../../../common/types.ts";
import { DEV_FOCUS_GAMEPLAN_AFFINITY } from "../player/developSeason.ts";

export type SchemeFit = {
	threePointer: number;
	atRim: number;
	lowPost: number;
};

export type SchemeFitPlayer = {
	compositeRating: {
		shootingThreePointer: number;
		shootingAtRim: number;
		shootingLowPost: number;
	};
	devFocus?: DevFocusType;
};

export type SchemeFitGamePlan = {
	threePointRate: number;
	rimAttack: number;
	postPlay: number;
};

// How hard emphasis vs. capability mismatch swings efficiency - k=0.3 means a maxed-out slider
// (100 or 0) against a fully mismatched roster (capability 0 or 1) swings about +/-7.5%.
const K = 0.3;

// Optional dev-focus bonus: small additional swing (on top of K above) when players whose
// archetype affinity matches a slider are on a plan that leans into it. Capped so a stacked
// roster of matching archetypes can't dominate the ratings-based fit above.
const AFFINITY_BONUS_PER_PLAYER = 0.02;
const MAX_AFFINITY_BONUS = 0.06;

const average = (values: number[]) =>
	values.length === 0
		? 0.5
		: values.reduce((sum, value) => sum + value, 0) / values.length;

const fit = (capability: number, sliderValue: number) =>
	1 + K * (capability - 0.5) * (sliderValue / 100 - 0.5);

const affinityBonus = (
	players: SchemeFitPlayer[],
	key: "threePointRate" | "rimAttack" | "postPlay",
	sliderValue: number,
) => {
	// Only a bonus for leaning into the archetype, not a penalty for leaning away from it.
	if (sliderValue <= 50) {
		return 0;
	}

	let matches = 0;
	for (const p of players) {
		if (p.devFocus && DEV_FOCUS_GAMEPLAN_AFFINITY[p.devFocus][key]) {
			matches += 1;
		}
	}

	const emphasis = (sliderValue - 50) / 50;
	return (
		Math.min(matches * AFFINITY_BONUS_PER_PLAYER, MAX_AFFINITY_BONUS) * emphasis
	);
};

// players should already be filtered to healthy players (those who will actually get minutes),
// ordered best-to-worst (e.g. by rosterOrder), since only the top `limit` are counted - the same
// "who actually plays" proxy used by positionalDepthTax.
export const computeSchemeFit = (
	players: SchemeFitPlayer[],
	gamePlan: SchemeFitGamePlan,
	limit = 8,
): SchemeFit => {
	const top = players.slice(0, limit);

	const threeCapability = average(
		top.map((p) => p.compositeRating.shootingThreePointer),
	);
	const rimCapability = average(
		top.map((p) => p.compositeRating.shootingAtRim),
	);
	const postCapability = average(
		top.map((p) => p.compositeRating.shootingLowPost),
	);

	return {
		threePointer:
			fit(threeCapability, gamePlan.threePointRate) +
			affinityBonus(top, "threePointRate", gamePlan.threePointRate),
		atRim:
			fit(rimCapability, gamePlan.rimAttack) +
			affinityBonus(top, "rimAttack", gamePlan.rimAttack),
		lowPost:
			fit(postCapability, gamePlan.postPlay) +
			affinityBonus(top, "postPlay", gamePlan.postPlay),
	};
};
