// Shared types for the AI Story Export (AI_STORY_EXPORT_PLAN.md).
//
// Input types are structural and deliberately minimal - they name only the fields the pure
// derivation/projection code reads, matching the real export schema (see the plan's §1b). The real
// player/team objects carry far more; extra fields are ignored. Output types are the projected,
// cross-linked tables that go in the bundle.
//
// Nullability convention (added after the v1 bug report): every projected field is `T | null`, never
// `T | undefined`. JSON.stringify *drops* undefined keys, which produced records with a
// non-uniform schema - 114 players simply had no `pos` key, and any consumer assuming a stable shape
// crashed. `null` is a value; absence is not.

// ---------------------------------------------------------------------------
// Raw inputs (subset of the league export schema)
// ---------------------------------------------------------------------------

// A stored player-season row (worker/core/player/stats.basketball.ts). Almost everything is optional
// because historical real-player seasons carry only whatever the source data recorded, and because
// several fields a reader expects (ws, trb) are assembled at read time rather than stored - see
// statFields.ts.
export type RawPlayerStatsRow = {
	season: number;
	tid: number;
	playoffs: boolean;
	gp: number;
	gs?: number;
	min: number;
	pts: number;
	ast: number;
	// Rebounds: modern rows have orb/drb, the oldest real rows have a bare trb.
	orb?: number;
	drb?: number;
	trb?: number;
	stl?: number;
	blk?: number;
	tov?: number;
	pf?: number;
	// Shooting, incl. the shot-location splits that make a season line describe a *style*.
	fg?: number;
	fga?: number;
	fgAtRim?: number;
	fgaAtRim?: number;
	fgLowPost?: number;
	fgaLowPost?: number;
	fgMidRange?: number;
	fgaMidRange?: number;
	tp?: number;
	tpa?: number;
	ft?: number;
	fta?: number;
	// Advanced (written back by worker/util/advStats.basketball.ts; absent for early real seasons).
	per?: number;
	ewa?: number;
	ows?: number;
	dws?: number;
	ws?: number;
	obpm?: number;
	dbpm?: number;
	vorp?: number;
	ortg?: number;
	drtg?: number;
	usgp?: number;
	// Single-game highs for that season.
	ptsMax?: number;
	trbMax?: number;
	astMax?: number;
	stlMax?: number;
	blkMax?: number;
	tpMax?: number;
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
	skills?: string[];
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

export type RawPlayerInjury = {
	season: number;
	games: number;
	type: string;
	ovrDrop?: number;
	potDrop?: number;
};

export type RawPlayer = {
	pid: number;
	firstName: string;
	lastName: string;
	tid: number;
	born: { year: number; loc?: string };
	college?: string;
	pos?: string;
	hgt?: number; // inches
	weight?: number | null; // pounds
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
	injuries?: RawPlayerInjury[];
	devFocus?: string;
};

export type RawTeamSeason = {
	tid: number;
	season: number;
	won: number;
	lost: number;
	tied: number;
	otl: number;
	playoffRoundsWon: number; // -1 means missed the playoffs (see SENTINELS)
	ovrStart?: number;
	ovrEnd?: number;
	avgAge?: number;
	abbrev?: string;
	region?: string;
	name?: string;
	cid?: number;
	did?: number;
};

export type RawTeamStatsRow = {
	tid: number;
	season: number;
	playoffs: boolean;
	gp: number;
	min?: number;
	pts: number;
	oppPts: number;
	fg?: number;
	fga?: number;
	tp?: number;
	tpa?: number;
	ft?: number;
	fta?: number;
	orb?: number;
	drb?: number;
	ast?: number;
	tov?: number;
	stl?: number;
	blk?: number;
	pf?: number;
	oppFg?: number;
	oppFga?: number;
	oppOrb?: number;
	oppDrb?: number;
	oppFta?: number;
	oppTov?: number;
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

// headToHeads store: per-season, keyed by "tidA.tidB" (tidA < tidB), records from tidA's
// perspective (won = tidA's wins over tidB). Points fields are tidA's / tidB's totals.
export type RawHeadToHeadPair = {
	won: number;
	lost: number;
	tied: number;
	otl: number;
	otw: number;
	pts: number;
	oppPts: number;
};

export type RawHeadToHead = {
	season: number;
	regularSeason: Record<string, RawHeadToHeadPair>;
	playoffs?: Record<
		string,
		{
			won: number;
			lost: number;
			pts: number;
			oppPts: number;
			result?: string;
			round?: number;
		}
	>;
};

// playoffSeries store: per-season, series[round][matchup] with home/away sides and the gids of the
// games actually played in that matchup.
export type RawPlayoffMatchupSide = {
	tid: number;
	seed: number;
	won: number;
	cid?: number;
	winp?: number;
};

export type RawPlayoffSeries = {
	season: number;
	series: {
		home: RawPlayoffMatchupSide;
		away?: RawPlayoffMatchupSide;
		gids?: number[];
	}[][];
};

// awards store: one row per season. ZenGM has no award *voting*, so there are no vote shares and no
// runners-up beyond the All-League / All-Defensive / All-Rookie teams (which are the closest thing).
export type RawAwardPlayer = {
	pid: number;
	name: string;
	tid: number;
};

export type RawAwardTeam = {
	tid: number;
	abbrev?: string;
	region?: string;
	name?: string;
	won?: number;
	lost?: number;
};

export type RawAwardsRow = {
	season: number;
	bestRecord?: RawAwardTeam;
	bestRecordConfs?: (RawAwardTeam | undefined | null)[];
	mvp?: RawAwardPlayer;
	dpoy?: RawAwardPlayer;
	roy?: RawAwardPlayer;
	smoy?: RawAwardPlayer;
	mip?: RawAwardPlayer;
	finalsMvp?: RawAwardPlayer;
	allLeague?: { title: string; players: RawAwardPlayer[] }[];
	allDefensive?: { title: string; players: RawAwardPlayer[] }[];
	allRookie?: RawAwardPlayer[];
};

// events store, filtered to the transaction types a player's `transactions[].eid` points at.
export type RawTradeAsset =
	| {
			pid: number;
			name: string;
			contract?: { amount: number; exp: number };
	  }
	| {
			dpid: number;
			season: number | string;
			round: number;
			originalTid: number;
	  };

export type RawEvent = {
	eid: number;
	type: string;
	season: number;
	phase?: number;
	tids?: number[];
	pids?: number[];
	// Trades only. teams[i].assets are the assets *received by* tids[i] (see processTrade.ts).
	teams?: [{ assets: RawTradeAsset[] }, { assets: RawTradeAsset[] }];
	// Free agent / re-signing only.
	contract?: { amount: number; exp: number };
};

export type RawConf = { cid: number; name: string };
export type RawDiv = { did: number; cid: number; name: string };

// ---------------------------------------------------------------------------
// Derived canon outputs (the foundational-article fuel; the plan's §3b)
// ---------------------------------------------------------------------------

export type PlayerRankingEntry = {
	pid: number;
	name: string;
	rank: number;
	greatness: number;
	// Evidence for the writer - so a "greatest players" prompt has material, not just a number.
	careerWS: number | null;
	peakWS: number | null;
	careerVORP: number | null;
	careerPts: number | null;
	rings: number;
	seasonsPlayed: number;
	teams: number[]; // tids the player suited up for
	topAwards: string[]; // notable accolades, most-weighted first
	primeSpan: { first: number; last: number } | null;
	// Which metric actually drove the score, so a writer knows whether to argue from WS.
	valueMetric: "ws" | "vorp" | "ewa" | "none";
};

export type TeamSeasonRankingEntry = {
	tid: number;
	season: number;
	rank: number;
	greatness: number;
	won: number;
	lost: number;
	winPct: number;
	// null when neither team stats nor game scores exist for that season. `pointDiffImputed` says
	// whether the *ranking* substituted a win%-implied value so pre-data eras aren't penalized.
	pointDiffPerGame: number | null;
	pointDiffImputed: boolean;
	wonTitle: boolean;
	playoffRoundsWon: number;
};

export type DraftValueEntry = {
	pid: number;
	name: string;
	draftYear: number;
	round: number;
	pick: number;
	undrafted: boolean;
	careerWS: number | null;
	expectedWS: number | null;
	delta: number | null; // careerWS - expectedWS; negative = underperformed slot
	// How the expectation was set: an exact draft slot, a smoothed neighborhood of slots, or the
	// round average when the league is too short to fit a curve.
	expectedFrom: "slot" | "round";
};

export type DynastyEntry = {
	tid: number;
	titleSeasons: number[];
	span: { first: number; last: number };
	titles: number;
};

export type PlayoffMeeting = {
	season: number;
	round: number;
	winnerTid: number;
	loserTid: number;
	winnerWins: number;
	loserWins: number;
	seriesId: string | null;
	gids: number[];
};

export type RivalryEntry = {
	tids: [number, number]; // always sorted ascending
	regularSeason: { aWon: number; bWon: number; tied: number } | null;
	playoffMeetings: PlayoffMeeting[];
	playoffSeriesCount: number;
	intensity: number;
};

export type CanonTables = {
	players: PlayerRankingEntry[];
	teamSeasons: TeamSeasonRankingEntry[];
	busts: DraftValueEntry[];
	steals: DraftValueEntry[];
	dynasties: DynastyEntry[];
	rivalries: RivalryEntry[];
};

// ---------------------------------------------------------------------------
// Playoff series (first-class records; the v1 bundle only had `finals: true` rows in the index)
// ---------------------------------------------------------------------------

export type ProjectedPlayoffSeries = {
	seriesId: string; // "<season>-R<round>-<lowTid>v<highTid>"
	season: number;
	round: number; // 1-based
	numRoundsThisSeason: number;
	finals: boolean;
	tids: [number, number];
	seeds: [number | null, number | null];
	wins: [number, number];
	winnerTid: number | null;
	loserTid: number | null;
	seriesScore: string; // "4-2"
	gids: number[];
};

// ---------------------------------------------------------------------------
// Leaderboards (all-time top-N, so "fourth-most points in league history" is a lookup, not a scan)
// ---------------------------------------------------------------------------

export type LeaderboardEntry = {
	rank: number;
	pid: number;
	name: string;
	value: number;
	season: number | null; // set for single-season boards, null for career boards
	tid: number | null;
};

export type Leaderboards = {
	career: Record<string, LeaderboardEntry[]>;
	season: Record<string, LeaderboardEntry[]>;
};

// ---------------------------------------------------------------------------
// Game index (the plan's §4a) - the queryable spine over the box-score bulk
// ---------------------------------------------------------------------------

export type GameIndexRow = {
	gid: number;
	season: number;
	playoffs: boolean;
	finals: boolean;
	// Playoff context, stamped from the playoffSeries store. null for regular-season games.
	round: number | null;
	seriesId: string | null;
	seriesGameNumber: number | null;
	tids: [number, number];
	scores: [number, number]; // aligned with tids
	winnerTid: number;
	loserTid: number;
	margin: number;
	overtimes: number;
	pids: number[]; // everyone who played (min > 0)
	topScorerPid: number | null;
	notability: number;
	notable: boolean;
	// Whether this game's full box score is actually in the bundle. `notable` is the *scoring*
	// threshold; the exported shard is capped, so the two are different questions (v1 gave them one
	// name and 72% of games were flagged while 3,000 shipped).
	boxScoreIncluded: boolean;
	notablePids: number[]; // players whose own game was standout
};

// ---------------------------------------------------------------------------
// Projected entity tables (the compact KB; the plan's §3a)
// ---------------------------------------------------------------------------

export type ProjectedStatLine = {
	season: number;
	tid: number;
	playoffs: boolean;
	gp: number;
	gs: number | null;
	min: number | null;
	// Counting stats.
	pts: number | null;
	orb: number | null;
	drb: number | null;
	trb: number | null;
	ast: number | null;
	stl: number | null;
	blk: number | null;
	tov: number | null;
	pf: number | null;
	// Shooting.
	fg: number | null;
	fga: number | null;
	tp: number | null;
	tpa: number | null;
	ft: number | null;
	fta: number | null;
	// Shot locations - the stylistic fingerprint.
	fgAtRim: number | null;
	fgaAtRim: number | null;
	fgLowPost: number | null;
	fgaLowPost: number | null;
	fgMidRange: number | null;
	fgaMidRange: number | null;
	// Share of FGA by location, rounded to 3dp. null when fga is unknown or zero.
	shotDist: {
		atRim: number | null;
		lowPost: number | null;
		midRange: number | null;
		threes: number | null;
	} | null;
	// Advanced.
	per: number | null;
	ws: number | null;
	ows: number | null;
	dws: number | null;
	vorp: number | null;
	bpm: number | null;
	ortg: number | null;
	drtg: number | null;
	usgp: number | null;
	ewa: number | null;
};

export type ProjectedRatingsLine = {
	season: number;
	ovr: number;
	pot: number;
	pos: string | null;
	// ZenGM's own skill labels: 3 (shooter), A (athlete), B (ball handler), Di (interior defender),
	// Dp (perimeter defender), Po (post scorer), Ps (passer), R (rebounder).
	skills: string[];
};

export type ProjectedTransaction = {
	type: string;
	season: number;
	phase: number;
	tid: number;
	fromTid: number | null;
	pickNum: number | null;
	// Joined from the events store, so a trade has a readable other side.
	counterpartyTid: number | null;
	assetsAcquired: TransactionAsset[] | null;
	assetsSurrendered: TransactionAsset[] | null;
	contract: { amount: number; exp: number } | null;
};

export type TransactionAsset =
	| { kind: "player"; pid: number; name: string }
	| {
			kind: "pick";
			dpid: number;
			season: number | string;
			round: number;
			originalTid: number;
	  };

export type ProjectedHighlightGame = {
	gid: number;
	season: number;
	playoffs: boolean;
	tid: number;
	oppTid: number;
	gameScore: number;
	pts: number;
	trb: number | null;
	ast: number | null;
};

export type ProjectedPlayer = {
	pid: number;
	name: string;
	pos: string | null;
	bornYear: number;
	birthLoc: string | null;
	college: string | null;
	heightInches: number | null;
	weightLbs: number | null;
	draft: {
		round: number;
		pick: number;
		year: number;
		originalTid: number | null;
		ovr: number | null;
		pot: number | null;
		undrafted: boolean;
	};
	hof: boolean;
	retiredYear: number | null;
	diedYear: number | null;
	real: boolean;
	devFocus: string | null;
	// Cross-references
	relatives: { type: string; pid: number; name: string }[];
	teamsPlayedFor: number[];
	rings: number;
	// Career narrative material
	awards: { season: number; type: string }[];
	injuries: { season: number; games: number; type: string }[];
	transactions: ProjectedTransaction[];
	ratings: ProjectedRatingsLine[];
	stats: ProjectedStatLine[];
	careerTotals: {
		seasons: number;
		gp: number;
		min: number | null;
		pts: number | null;
		orb: number | null;
		drb: number | null;
		trb: number | null;
		ast: number | null;
		stl: number | null;
		blk: number | null;
		tov: number | null;
		fg: number | null;
		fga: number | null;
		tp: number | null;
		tpa: number | null;
		ft: number | null;
		fta: number | null;
		ws: number | null;
		vorp: number | null;
	};
	careerHighs: {
		pts: number | null;
		trb: number | null;
		ast: number | null;
		stl: number | null;
		blk: number | null;
		tp: number | null;
	};
	// Pre-joined signature games, so a career profile doesn't require scanning the game index.
	highlightGames: ProjectedHighlightGame[];
};

export type ProjectedTeamSeason = {
	season: number;
	abbrev: string | null;
	region: string | null;
	name: string | null;
	won: number;
	lost: number;
	tied: number;
	otl: number;
	winPct: number;
	// -1 in the raw data means "missed the playoffs"; `madePlayoffs` says it in words.
	playoffRoundsWon: number;
	madePlayoffs: boolean;
	wonTitle: boolean;
	playoffSeed: number | null;
	confRank: number | null;
	divRank: number | null;
	// How the team actually played, not just whether it won.
	gp: number | null;
	ptsPerGame: number | null;
	oppPtsPerGame: number | null;
	pointDiffPerGame: number | null;
	pace: number | null;
	ortg: number | null;
	drtg: number | null;
	ovrStart: number | null;
	ovrEnd: number | null;
	avgAge: number | null;
};

export type ProjectedTeam = {
	tid: number;
	abbrev: string;
	region: string;
	name: string;
	cid: number | null;
	did: number | null;
	confName: string | null;
	divName: string | null;
	disabled: boolean;
	// Cross-references / rollups
	divisionRivalTids: number[];
	titleSeasons: number[];
	titles: number;
	// Seasons since the last title, as of the league's current season. null for defunct franchises
	// (a team that folded in 1949 does not have a live drought).
	titleDrought: number | null;
	neverWonTitle: boolean;
	allTime: { won: number; lost: number; winPct: number; seasons: number };
	// Franchise identity changes, surfaced from the per-season region/name rows.
	relocations: { season: number; from: string; to: string }[];
	seasons: ProjectedTeamSeason[];
};

export type ProjectedAwardsSeason = {
	season: number;
	mvp: RawAwardPlayer | null;
	dpoy: RawAwardPlayer | null;
	roy: RawAwardPlayer | null;
	smoy: RawAwardPlayer | null;
	mip: RawAwardPlayer | null;
	finalsMvp: RawAwardPlayer | null;
	allLeague: { title: string; players: RawAwardPlayer[] }[];
	allDefensive: { title: string; players: RawAwardPlayer[] }[];
	allRookie: RawAwardPlayer[];
	bestRecordTid: number | null;
};

// ---------------------------------------------------------------------------
// Data coverage + validation (the bug report's Part 3, items 2 and 3)
// ---------------------------------------------------------------------------

export type MetricCoverage = {
	// Earliest season for which this metric is populated at all.
	earliestSeason: number | null;
	latestSeason: number | null;
	// Share of eligible rows that carry a value, 0-1.
	coverage: number;
	rowsWithValue: number;
	rowsTotal: number;
	note: string | null;
};

export type DataCoverage = {
	metrics: Record<string, MetricCoverage>;
	// Fields that are null for every record - a writer should not build an argument on these.
	knownNullFields: string[];
	// Things ZenGM simply does not model, so no amount of exporting will produce them.
	unavailable: { field: string; reason: string }[];
	sentinels: { field: string; value: string; meaning: string }[];
};

export type ValidationIssue = {
	severity: "error" | "warning";
	check: string;
	message: string;
};

export type KnowledgeBaseMeta = {
	format: "zengm-story-export";
	version: number;
	leagueName: string | null;
	generatedAtSeason: number | null; // the save's current season
	counts: {
		players: number;
		teams: number; // active franchises
		teamsIncludingDisabled: number;
		games: number;
		gamesWithBoxScores: number;
		seasons: number;
		playoffSeries: number;
	};
	files: string[]; // exactly what is in this bundle, so the docs can't promise what isn't here
	dataCoverage: DataCoverage;
	validation: {
		passed: boolean;
		issues: ValidationIssue[];
	};
};

export type KnowledgeBase = {
	meta: KnowledgeBaseMeta;
	players: ProjectedPlayer[];
	teams: ProjectedTeam[];
	conferences: RawConf[];
	divisions: RawDiv[];
	canon: CanonTables;
	playoffSeries: ProjectedPlayoffSeries[];
	awards: ProjectedAwardsSeason[];
	leaderboards: Leaderboards;
	gameIndex: GameIndexRow[];
	notableGids: number[];
};
