// Shared types for the AI Story Export (Phase 1, AI_STORY_EXPORT_PLAN.md).
//
// Input types are structural and deliberately minimal - they name only the fields the pure
// derivation/projection code reads, matching the real export schema (see the plan's §1b). The real
// player/team objects carry far more; extra fields are ignored. Output types are the projected,
// cross-linked tables that go in the bundle.

// ---------------------------------------------------------------------------
// Raw inputs (subset of the league export schema)
// ---------------------------------------------------------------------------

export type RawPlayerStatsRow = {
	season: number;
	tid: number;
	playoffs: boolean;
	gp: number;
	min: number;
	pts: number;
	trb: number;
	ast: number;
	ws: number;
	vorp: number;
	per: number;
	ewa: number;
};

export type RawPlayerAward = {
	season: number;
	type: string;
};

export type RawPlayerRatingsRow = {
	season: number;
	ovr: number;
	pot: number;
	pos: string;
};

export type RawPlayerTransaction = {
	type: string;
	season: number;
	phase: number;
	tid: number;
	fromTid?: number;
	eid?: number;
	pickNum?: number;
};

export type RawRelative = {
	type: string;
	pid: number;
	name: string;
};

export type RawPlayer = {
	pid: number;
	firstName: string;
	lastName: string;
	tid: number;
	born: { year: number; loc?: string };
	college?: string;
	pos?: string;
	hgt?: number;
	weight?: number | null;
	draft: {
		round: number;
		pick: number;
		year: number;
		tid?: number;
		originalTid?: number;
		ovr?: number;
		pot?: number;
	};
	hof?: number;
	retiredYear?: number | null;
	diedYear?: number;
	real?: boolean;
	value?: number;
	awards: RawPlayerAward[];
	ratings: RawPlayerRatingsRow[];
	stats: RawPlayerStatsRow[];
	statsTids?: number[];
	transactions?: RawPlayerTransaction[];
	relatives?: RawRelative[];
	devFocus?: string;
};

export type RawTeamSeason = {
	tid: number;
	season: number;
	won: number;
	lost: number;
	tied: number;
	otl: number;
	playoffRoundsWon: number;
	ovrStart?: number;
	ovrEnd?: number;
	abbrev?: string;
	region?: string;
	name?: string;
};

export type RawTeamStatsRow = {
	season: number;
	playoffs: boolean;
	gp: number;
	pts: number;
	oppPts: number;
};

export type RawTeam = {
	tid: number;
	abbrev: string;
	region: string;
	name: string;
	cid?: number;
	did?: number;
	disabled?: boolean;
	seasons: RawTeamSeason[];
	stats: RawTeamStatsRow[];
};

// ---------------------------------------------------------------------------
// Derived canon outputs (the foundational-article fuel; the plan's §3b)
// ---------------------------------------------------------------------------

export type PlayerRankingEntry = {
	pid: number;
	name: string;
	rank: number;
	greatness: number;
	// Evidence for the writer - so a "greatest players" prompt has material, not just a number.
	careerWS: number;
	peakWS: number;
	rings: number;
	seasonsPlayed: number;
	teams: number[]; // tids the player suited up for
	topAwards: string[]; // notable accolades, most-weighted first
	primeSpan: { first: number; last: number } | undefined;
};

export type TeamSeasonRankingEntry = {
	tid: number;
	season: number;
	rank: number;
	greatness: number;
	won: number;
	lost: number;
	winPct: number;
	pointDiffPerGame: number;
	wonTitle: boolean;
	playoffRoundsWon: number;
};

export type DraftValueEntry = {
	pid: number;
	name: string;
	draftYear: number;
	round: number;
	pick: number;
	careerWS: number;
	expectedWS: number;
	delta: number; // careerWS - expectedWS; negative = underperformed slot
};

export type DynastyEntry = {
	tid: number;
	titleSeasons: number[];
	span: { first: number; last: number };
	titles: number;
};

export type CanonTables = {
	players: PlayerRankingEntry[];
	teamSeasons: TeamSeasonRankingEntry[];
	busts: DraftValueEntry[];
	steals: DraftValueEntry[];
	dynasties: DynastyEntry[];
};
