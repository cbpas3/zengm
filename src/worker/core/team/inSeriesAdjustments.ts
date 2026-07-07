// Basketball-only in-series AI adjustments (Harder RPD Challenge, Phase 5): during a playoff
// series, the AI opponent's coach reads the user's shot profile from the earlier games of *this*
// series and nudges its own defensive game-plan sliders (Phase 1) to counter it - so a
// superior-but-predictable team can get out-schemed instead of running the same plan for seven
// games. Pure heuristic; no LLM. Gated behind the inSeriesAdjustments game attribute.
//
// DB access (finding the series entry, pulling prior box scores, aggregating the shot profile)
// happens in loadTeams.ts, mirroring isGame6EliminationGameOrGame7 there; this file is the pure
// compute step, mirroring positionalDepthTax.ts / schemeFit.ts.
import { helpers } from "../../util/index.ts";
import type { Team } from "../../../common/types.ts";

export type GamePlan = NonNullable<Team["gamePlan"]>;

export type OpponentSeriesShotProfile = {
	threePointRate: number; // tpa / fga, averaged over the series games played so far
	threePointAccuracy: number; // tp / tpa
	rimRate: number; // fgaAtRim / fga
	orbPerGame: number;
	starUsageShare: number; // leading scorer's pts / team pts, averaged
};

export type SeriesContext = {
	gamesPlayed: number; // games already completed in this series, before the one being loaded
	numGamesSeries: number; // total possible games in this round (e.g. 7)
	trailing: boolean; // is the AI team behind in the series
};

// Roughly league-average baselines the profile is compared against - what matters is the
// deviation from these, not the raw values.
const NEUTRAL_THREE_POINT_RATE = 0.38;
const NEUTRAL_THREE_POINT_ACCURACY = 0.36;
const NEUTRAL_RIM_RATE = 0.35;
const NEUTRAL_ORB_PER_GAME = 10;
const NEUTRAL_STAR_USAGE_SHARE = 0.28;

// How hard each fully-realized threat signal can push a defensive slider, before series-progress/
// trailing escalation and the final adjustment cap below.
const THREE_POINT_THREAT_SCALE = 80;
const PAINT_THREAT_SCALE = 50;
const STAR_THREAT_SCALE = 160;

// Keep the AI coherent - each slider moves at most this far from its stored value.
const MAX_ADJUSTMENT = 25;

// Bigger swings later in a series (games 5-7), and more urgency if the AI is trailing.
export const computeSeriesEscalation = (context: SeriesContext) => {
	const progress = helpers.bound(
		context.gamesPlayed / Math.max(context.numGamesSeries - 1, 1),
		0,
		1,
	);
	return (0.5 + progress * 0.5) * (context.trailing ? 1.3 : 1);
};

export const computeInSeriesAdjustments = (
	baseGamePlan: GamePlan,
	profile: OpponentSeriesShotProfile,
	context: SeriesContext,
): GamePlan => {
	const escalation = computeSeriesEscalation(context);

	const threePointThreat =
		profile.threePointRate -
		NEUTRAL_THREE_POINT_RATE +
		(profile.threePointAccuracy - NEUTRAL_THREE_POINT_ACCURACY) * 2;
	const paintThreat =
		profile.rimRate -
		NEUTRAL_RIM_RATE +
		(profile.orbPerGame - NEUTRAL_ORB_PER_GAME) * 0.04;
	const starThreat = profile.starUsageShare - NEUTRAL_STAR_USAGE_SHARE;

	const adjust = (base: number, rawDelta: number) =>
		helpers.bound(
			base +
				helpers.bound(rawDelta * escalation, -MAX_ADJUSTMENT, MAX_ADJUSTMENT),
			0,
			100,
		);

	return {
		...baseGamePlan,
		// Stay closer to shooters (down) and pressure the ball (up) against a hot, high-volume
		// three-point shooting series opponent.
		helpAggression: adjust(
			baseGamePlan.helpAggression,
			-threePointThreat * THREE_POINT_THREAT_SCALE,
		),
		perimeterPressure: adjust(
			baseGamePlan.perimeterPressure,
			threePointThreat * THREE_POINT_THREAT_SCALE,
		),
		// Switch/blitz more and crash the defensive glass harder against a series opponent living
		// in the paint and/or feeding one high-usage star.
		pickCoverage: adjust(
			baseGamePlan.pickCoverage,
			paintThreat * PAINT_THREAT_SCALE + starThreat * STAR_THREAT_SCALE,
		),
		defensiveGlass: adjust(
			baseGamePlan.defensiveGlass,
			paintThreat * PAINT_THREAT_SCALE,
		),
	};
};
