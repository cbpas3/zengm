import { helpers } from "../../util/index.ts";

// Central tuning knobs for the Game Plan system (offense/defense sliders in
// TeamGameSim.gamePlan). Single source of truth so retuning is a one-file edit -
// see CLAUDE.md "Game Plan Rebalance" and GAME_PLAN_REBALANCE_PLAN.md for the
// design rationale behind each constant.
export const GAME_PLAN_TUNING = {
	// F-A - execution quality helper. EQ_PIVOT is the team composite-rating value that maps to a
	// neutral eq of 0.5. A player with every rating at exactly 50 (out of 100) has composite = 0.5
	// by construction (player.compositeRating is a weighted average over a 0-100 scale, see
	// src/worker/core/player/compositeRating.ts), but that is not what a realistically-generated
	// "league average" team's on-court composite actually looks like: real rosters go through 20
	// simulated draft classes + player.develop (createRandomPlayers.ts), which correlates ratings
	// by archetype and skews starters-getting-most-minutes teams well above a flat 50. Measured via
	// T-B0 in gamePlan.test.ts against a realistically-generated 30-team league (~0.62 average
	// composite for rebounding/defense/defensePerimeter/dribbling/passing/blocking) - a flat-50
	// synthetic roster is not representative and was rejected as the calibration source (see T-B0's
	// comment for why).
	EQ_PIVOT: 0.62,
	EQ_SLOPE: 1.7,
	EQ_MIN: 0.25,
	EQ_MAX: 1.0,

	// F-I - safety rails
	CLAMP_SCHEME_MIN: 0.88,
	CLAMP_SCHEME_MAX: 1.12,

	// F-B - rebound contest (doReb)
	REBOUND_DEFENSIVE_GLASS_DELTA: 0.05,
	REBOUND_CRASH_DELTA: 0.05,
	REBOUND_PRESSURE_PENALTY: 0.02,
	REBOUND_DELTA_CLAMP: 0.06,

	// F-C - turnover pressure (probTov + getShotInfo blow-by term)
	PRESSURE_TOV_SLOPE: 0.08,
	PRESSURE_FOUL_SLOPE: 0.15,
	PRESSURE_BLOWBY_RIM_FREQ_SLOPE: 0.08,

	// F-D - transition / fast breaks (getPossessionOutcome, doShot)
	FAST_BREAK_BASE_PROB: 0.22,
	FAST_BREAK_INTENT_SLOPE: 0.35,
	FAST_BREAK_CRASH_BONUS_SLOPE: 0.2,
	FAST_BREAK_RIM_BIAS: 1.4,
	FAST_BREAK_TOV_BASE: 0.04,
	FAST_BREAK_TOV_BALLHANDLING_SLOPE: 0.05,
	FAST_BREAK_SHOOTER_ENERGY_PENALTY: 0.003,

	// F-E - pickCoverage / helpAggression (getShotInfo)
	PICK_COVERAGE_ABOVE_INTERIOR_SLOPE: 0.08,
	PICK_COVERAGE_ABOVE_USAGE_SLOPE: 0.4,
	PICK_COVERAGE_ABOVE_THREE_FREQ_SLOPE: 0.08,
	PICK_COVERAGE_BELOW_ATRIM_SLOPE: 0.06,
	PICK_COVERAGE_BELOW_REBOUND_BONUS: 0.01,
	PICK_COVERAGE_BELOW_MIDRANGE_SLOPE: 0.06,

	HELP_AGGRESSION_ABOVE_RIM_SLOPE: 0.1,
	HELP_AGGRESSION_ABOVE_THREE_FREQ_SLOPE: 0.1,
	HELP_AGGRESSION_ABOVE_THREE_EFF_SLOPE: 0.06,
	HELP_AGGRESSION_BELOW_THREE_EFF_SLOPE: 0.05,
	HELP_AGGRESSION_BELOW_RIM_FREQ_SLOPE: 0.08,

	// F-G - shot-mix sliders (getShotInfo)
	THREE_POINT_RATE_MIN_MULT: 0.6,
	THREE_POINT_RATE_MAX_MULT: 1.4,
	RIM_ATTACK_MIN_MULT: 0.6,
	RIM_ATTACK_MAX_MULT: 1.5,
	POST_PLAY_MIN_MULT: 0.6,
	POST_PLAY_MAX_MULT: 1.5,
	SCHEME_FIT_K: 0.5,

	// F-F - usage-efficiency curve (getShotInfo/doShot, the Cade fix). USAGE_THRESHOLD is
	// calibrated against the post-**1.9 usage composite distribution (see processTeam in
	// loadTeams.ts) of a realistically-generated league: league-wide top players cluster
	// ~0.55-0.59, median is ~0.34 (measured via a 30-team seeded league, gamePlan.test.ts's
	// harness). Set at the top of that real range so a true #1 option pays ~nothing while a
	// median-usage player forced into ISO pays a real penalty.
	USAGE_ISO_PENALTY_SLOPE: 0.28,
	USAGE_THRESHOLD: 0.55,
	// The plan specifies fatigue as a x(1 + 0.3*isoIntent) multiplier on the shooter's normal
	// per-possession energy drain, but that drain is only computed later (updatePlayingTime, from
	// total possession clock time) - not available yet at shot time. Approximated the same way as
	// F-D's fast-break energy cost: a flat extra subtraction at shot time, sized as a fraction of a
	// nominal possession's drain (see FAST_BREAK_SHOOTER_ENERGY_PENALTY's comment for the same
	// pattern) rather than a true multiplier.
	USAGE_ISO_SHOOTER_ENERGY_PENALTY: 0.002,
} as const;

// intent: how hard a slider leans away from neutral (50), signed. -1 (dial at 0)
// to +1 (dial at 100).
export const intent = (slider: number) => (slider - 50) / 50;

// eq: execution quality for a team composite rating (already 0-1-ish scale, see
// updateTeamCompositeRatings). ~0.5 (league average) -> eq ~0.5. Elite -> ~1.0.
// Awful -> ~0.25. Benefit terms of every possession-economy dial multiply by eq;
// cost terms never do (design principle: aggression is free to call, expensive
// to execute badly).
export const eq = (composite: number) =>
	helpers.bound(
		0.5 + GAME_PLAN_TUNING.EQ_SLOPE * (composite - GAME_PLAN_TUNING.EQ_PIVOT),
		GAME_PLAN_TUNING.EQ_MIN,
		GAME_PLAN_TUNING.EQ_MAX,
	);

// clampScheme: shared bound for any single gamePlan-derived probability
// multiplier, so no individual effect can swing a shot probability more than
// +/-12%.
export const clampScheme = (x: number) =>
	helpers.bound(
		x,
		GAME_PLAN_TUNING.CLAMP_SCHEME_MIN,
		GAME_PLAN_TUNING.CLAMP_SCHEME_MAX,
	);
