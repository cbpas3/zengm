// Game notability (AI Story Export, Phase 1, §4a in AI_STORY_EXPORT_PLAN.md).
//
// The box-score bulk is ~89% of a league export (see the plan's §1a). Nobody loads it whole, so
// every game gets a compact index row (built in gameIndex.ts) carrying a *notability* score, and a
// subset of games is flagged "notable" for the pre-filtered shard that ships in the default bundle.
// This module is the pure scoring core: no DB access, structural input types only, same convention
// as schemeFit.ts / genAiGamePlan.ts.
//
// "Notable for a player" vs "notable game" are different questions and both matter (the plan's Yao
// example: all-his-games vs only-his-notable-ones). So we compute a per-player game score first,
// then derive both the game-level notability and the set of players who personally stood out.

// The minimal per-player box line we need. Matches the real export schema
// (games[].teams[].players[]); extra fields on the real object are ignored via structural typing.
export type BoxPlayerLine = {
	pid: number;
	min: number;
	pts: number;
	fg: number;
	fga: number;
	ft: number;
	fta: number;
	orb: number;
	drb: number;
	ast: number;
	stl: number;
	blk: number;
	tov: number;
	pf: number;
};

export type BoxTeamLine = {
	tid: number;
	pts: number;
	players: BoxPlayerLine[];
};

export type BoxGame = {
	gid: number;
	season: number;
	playoffs: boolean;
	finals?: boolean;
	overtimes: number;
	teams: [BoxTeamLine, BoxTeamLine];
};

// All tunable in one place, honest about being a first cut to be recalibrated against a real
// league (same posture as GAME_PLAN_TUNING). The game-score cutoffs are on Hollinger's game-score
// scale (roughly points-equivalent): ~10 is an average starter's night, 25+ is a standout, 40+ is
// historic. Margins are point differentials.
export const STORY_NOTABILITY = {
	// A player's own game is "notable" at/above this game score -> he's added to notablePids.
	PLAYER_GAME_SCORE: 25,
	// A single dominant individual game makes the whole game notable at/above this.
	ELITE_GAME_SCORE: 32,
	// Nailbiters and blowouts are both story-worthy.
	CLOSE_MARGIN: 4,
	BLOWOUT_MARGIN: 25,
	// A game's notability must reach this to be flagged for the notable-games shard (playoff /
	// finals / feat games are always flagged regardless, see computeGameNotability).
	NOTABLE_CUTOFF: 22,
} as const;

// Hollinger game score: a single-number summary of a player's box-score line. Not stored by the
// sim, so we compute it here from the raw counting stats every box line already has.
export const gameScore = (p: BoxPlayerLine): number =>
	p.pts +
	0.4 * p.fg -
	0.7 * p.fga -
	0.4 * (p.fta - p.ft) +
	0.7 * p.orb +
	0.3 * p.drb +
	p.stl +
	0.7 * p.ast +
	0.7 * p.blk -
	0.4 * p.pf -
	p.tov;

export type GameNotability = {
	// Continuous score, stored on the index row so the filter script / an agent can threshold
	// however it likes rather than being stuck with our boolean.
	notability: number;
	// Our default boolean: is this game in the pre-filtered notable-games shard?
	notable: boolean;
	// Highest-scoring player in the game (by points), for the index row's at-a-glance headline.
	topScorerPid: number | undefined;
	// Players whose *own* game was notable (game score >= PLAYER_GAME_SCORE). Enables
	// "notable games for pid X" = index rows whose notablePids includes X.
	notablePids: number[];
};

// hasFeat: whether this gid produced a playerFeat (passed in by the caller, since feats live in a
// separate store). A feat always makes the game notable.
export const computeGameNotability = (
	game: BoxGame,
	{ hasFeat = false }: { hasFeat?: boolean } = {},
): GameNotability => {
	const allLines = [...game.teams[0].players, ...game.teams[1].players];

	let topScorerPid: number | undefined;
	let topPts = -Infinity;
	let maxGameScore = -Infinity;
	const notablePids: number[] = [];

	for (const line of allLines) {
		if (line.min <= 0) {
			continue;
		}
		if (line.pts > topPts) {
			topPts = line.pts;
			topScorerPid = line.pid;
		}
		const gs = gameScore(line);
		if (gs > maxGameScore) {
			maxGameScore = gs;
		}
		if (gs >= STORY_NOTABILITY.PLAYER_GAME_SCORE) {
			notablePids.push(line.pid);
		}
	}

	const margin = Math.abs(game.teams[0].pts - game.teams[1].pts);

	// Build up a continuous notability score from independent signals.
	let notability = 0;
	// Individual brilliance is the dominant term.
	if (maxGameScore > 0) {
		notability += maxGameScore;
	}
	// Close games and blowouts are both interesting; the mushy middle isn't.
	if (margin <= STORY_NOTABILITY.CLOSE_MARGIN) {
		notability += 6;
	} else if (margin >= STORY_NOTABILITY.BLOWOUT_MARGIN) {
		notability += 4;
	}
	if (game.overtimes > 0) {
		notability += 4 + game.overtimes;
	}
	if (game.playoffs) {
		notability += 8;
	}
	if (game.finals) {
		notability += 12;
	}
	if (hasFeat) {
		notability += 10;
	}

	// A game is flagged notable if it clears the cutoff, contained a truly elite individual game, or
	// is a playoff/finals/feat game (those are always story-relevant regardless of the box score).
	const notable =
		notability >= STORY_NOTABILITY.NOTABLE_CUTOFF ||
		maxGameScore >= STORY_NOTABILITY.ELITE_GAME_SCORE ||
		game.playoffs ||
		!!game.finals ||
		hasFeat;

	return {
		notability: Math.round(notability * 10) / 10,
		notable,
		topScorerPid,
		notablePids,
	};
};
