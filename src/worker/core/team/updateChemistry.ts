// Basketball-only team chemistry (Harder RPD Challenge, Phase 4): a stored, slowly-drifting
// value per team that rewards continuity and recent winning, and punishes stacking high-usage
// stars or churning the roster - so a superteam assembled overnight underperforms until it
// gels, and blowing up a roster every year has a cost. Gated behind the teamChemistry game
// attribute; a neutral/no-op (chemistry stays undefined, treated as 50) when off.
//
// Two update points, mirroring the plan:
//  - updateTeamChemistry: called once per team per game (writeTeamStats.ts) - drifts the stored
//    value toward a daily target built from recent results, star density, and in-season trade
//    churn (numPlayersTradedAway is already tracked per season, see processTrade.ts).
//  - seedSeasonChemistry: called once per team at season rollover (newPhasePreseason.ts) -
//    soft-carries last season's ending value, discounted by offseason roster turnover.
import { helpers } from "../../util/index.ts";
import type { TeamSeason } from "../../../common/types.ts";

// ~a month of games (driftRate ~0.03/game) to fully converge on a new target.
export const CHEMISTRY_DRIFT_RATE = 0.03;

// starDensity: many high-usage/high-value players fighting for touches lowers the target -
// the "can't just stack stars" lever. Player.value is on the same 0-100 scale as ovr/pot (see
// player/value.ts). The first two "stars" are free (every good team has stars); ball-sharing
// friction kicks in beyond that.
const STAR_VALUE_THRESHOLD = 75;
const STARS_BEFORE_FRICTION = 2;
const FRICTION_PER_EXTRA_STAR = 4;
const MAX_STAR_FRICTION = 20;

// recentResults: a winning streak nudges the target up, a losing streak down.
const STREAK_ADJUSTMENT_PER_GAME = 1;
const MAX_STREAK_ADJUSTMENT = 15;

// In-season roster churn (trades away this season) chips away at the target too.
const CHURN_PENALTY_PER_TRADED_PLAYER = 3;
const MAX_CHURN_PENALTY = 20;

export type ChemistryPlayer = {
	value: number;
	injury: { gamesRemaining: number };
};

export const computeChemistryTarget = (
	teamSeason: Pick<TeamSeason, "streak" | "numPlayersTradedAway">,
	players: ChemistryPlayer[],
) => {
	const streakAdjustment = helpers.bound(
		teamSeason.streak * STREAK_ADJUSTMENT_PER_GAME,
		-MAX_STREAK_ADJUSTMENT,
		MAX_STREAK_ADJUSTMENT,
	);

	const numStars = players.filter(
		(p) => p.injury.gamesRemaining === 0 && p.value >= STAR_VALUE_THRESHOLD,
	).length;
	const starFriction = Math.min(
		Math.max(numStars - STARS_BEFORE_FRICTION, 0) * FRICTION_PER_EXTRA_STAR,
		MAX_STAR_FRICTION,
	);

	const churnPenalty = Math.min(
		teamSeason.numPlayersTradedAway * CHURN_PENALTY_PER_TRADED_PLAYER,
		MAX_CHURN_PENALTY,
	);

	return helpers.bound(
		50 + streakAdjustment - starFriction - churnPenalty,
		0,
		100,
	);
};

export const updateTeamChemistry = (
	teamSeason: TeamSeason,
	players: ChemistryPlayer[],
) => {
	const target = computeChemistryTarget(teamSeason, players);
	const current = teamSeason.chemistry ?? 50;
	teamSeason.chemistry = helpers.bound(
		current + (target - current) * CHEMISTRY_DRIFT_RATE,
		0,
		100,
	);
};

// Even with full continuity, a new season means some natural regression toward neutral; full
// roster turnover (continuityFraction 0) resets to neutral outright.
const OFFSEASON_RETENTION = 0.8;

export const seedSeasonChemistry = (
	prevChemistry: number | undefined,
	continuityFraction: number,
) => {
	if (prevChemistry === undefined) {
		return 50;
	}

	const retainedFraction =
		helpers.bound(continuityFraction, 0, 1) * OFFSEASON_RETENTION;
	return helpers.bound(50 + (prevChemistry - 50) * retainedFraction, 0, 100);
};
