// Entity projection (AI Story Export, §3a in AI_STORY_EXPORT_PLAN.md).
//
// Turns the raw export records into the compact, cross-linked entity tables: trim the noise
// (cosmetic face fields, financials, fuzz - see the plan's §4 TRIM bucket) and surface the
// interconnections that are already latent in the data (transactions = career movement, relatives,
// statsTids = teams played for) as clean fields. Pure, DB-free.
//
// The point of "trim" is not to drop career data - the per-season stats/ratings/awards are the whole
// value - but to drop the ~40 face fields, the financial block, and the internal bookkeeping that no
// writer needs.
//
// Two rules learned from the v1 bug report:
//   1. Derived stats are derived here, via statFields.ts. Storage rows have no `ws` and no `trb`.
//   2. Absent values are `null`, never `undefined` (JSON.stringify drops undefined keys, which made
//      the schema non-uniform) and never `0` (which reads as "replacement level" instead of
//      "unknown").

import {
	deriveBpm,
	deriveTrb,
	deriveWs,
	maxNullable,
	num,
	possessions,
	ratio,
	round,
	sumNullable,
} from "./statFields.ts";
import type {
	ProjectedPlayer,
	ProjectedRatingsLine,
	ProjectedStatLine,
	ProjectedTeam,
	ProjectedTeamSeason,
	ProjectedTransaction,
	RawConf,
	RawDiv,
	RawEvent,
	RawPlayer,
	RawPlayerStatsRow,
	RawTeam,
	RawTeamSeason,
	RawTeamStatsRow,
	TransactionAsset,
} from "./types.ts";

const shotDistribution = (s: RawPlayerStatsRow) => {
	const fga = num(s.fga);
	if (fga === null || fga === 0) {
		return null;
	}
	const share = (v: number | null) => round(ratio(v, fga), 3);
	return {
		atRim: share(num(s.fgaAtRim)),
		lowPost: share(num(s.fgaLowPost)),
		midRange: share(num(s.fgaMidRange)),
		threes: share(num(s.tpa)),
	};
};

const projectStatLine = (s: RawPlayerStatsRow): ProjectedStatLine => ({
	season: s.season,
	tid: s.tid,
	playoffs: s.playoffs,
	gp: s.gp,
	gs: num(s.gs),
	min: round(num(s.min)),
	pts: num(s.pts),
	orb: num(s.orb),
	drb: num(s.drb),
	trb: deriveTrb(s),
	ast: num(s.ast),
	stl: num(s.stl),
	blk: num(s.blk),
	tov: num(s.tov),
	pf: num(s.pf),
	fg: num(s.fg),
	fga: num(s.fga),
	tp: num(s.tp),
	tpa: num(s.tpa),
	ft: num(s.ft),
	fta: num(s.fta),
	fgAtRim: num(s.fgAtRim),
	fgaAtRim: num(s.fgaAtRim),
	fgLowPost: num(s.fgLowPost),
	fgaLowPost: num(s.fgaLowPost),
	fgMidRange: num(s.fgMidRange),
	fgaMidRange: num(s.fgaMidRange),
	shotDist: shotDistribution(s),
	per: round(num(s.per)),
	ws: round(deriveWs(s)),
	ows: round(num(s.ows)),
	dws: round(num(s.dws)),
	vorp: round(num(s.vorp)),
	bpm: round(deriveBpm(s)),
	ortg: round(num(s.ortg)),
	drtg: round(num(s.drtg)),
	usgp: round(num(s.usgp)),
	ewa: round(num(s.ewa)),
});

const projectRatingsLine = (
	r: RawPlayer["ratings"][number],
): ProjectedRatingsLine => ({
	season: r.season,
	ovr: r.ovr,
	pot: r.pot,
	pos: r.pos ?? null,
	skills: r.skills ?? [],
});

// `p.pos` is only set on players imported from a custom league file; for everyone else the position
// lives on each ratings row. v1 read only `p.pos` and emitted no key at all for the ~2% of players
// who lacked it. Prefer the explicit field, then the last season the player was actually rated.
const resolvePos = (p: RawPlayer): string | null => {
	if (p.pos) {
		return p.pos;
	}
	for (let i = p.ratings.length - 1; i >= 0; i--) {
		const pos = p.ratings[i]?.pos;
		if (pos) {
			return pos;
		}
	}
	return null;
};

const tradeAsset = (
	asset: NonNullable<RawEvent["teams"]>[number]["assets"][number],
): TransactionAsset =>
	"pid" in asset
		? { kind: "player", pid: asset.pid, name: asset.name }
		: {
				kind: "pick",
				dpid: asset.dpid,
				season: asset.season,
				round: asset.round,
				originalTid: asset.originalTid,
			};

// A trade transaction on a player only records "he moved from X to Y". The other side of the deal
// lives in the events store, keyed by the transaction's eid. Without it, a sentence like "what Utah
// got back for Karl Malone" is unwritable - which is exactly the gap the bug report called out.
const projectTransaction = (
	t: NonNullable<RawPlayer["transactions"]>[number],
	eventsByEid: Map<number, RawEvent>,
): ProjectedTransaction => {
	const base: ProjectedTransaction = {
		type: t.type,
		season: t.season,
		phase: t.phase,
		tid: t.tid,
		fromTid: t.fromTid ?? null,
		pickNum: num(t.pickNum),
		counterpartyTid: null,
		assetsAcquired: null,
		assetsSurrendered: null,
		contract: null,
	};

	const event = t.eid === undefined ? undefined : eventsByEid.get(t.eid);
	if (!event) {
		return base;
	}

	if (event.contract) {
		base.contract = {
			amount: event.contract.amount,
			exp: event.contract.exp,
		};
	}

	if (event.type === "trade" && event.teams && event.tids?.length === 2) {
		// teams[i].assets are the assets *received by* tids[i] (worker/core/trade/processTrade.ts).
		// `t.tid` is the team this player landed on, so that side is the acquiring one.
		const acquiringIndex = event.tids[0] === t.tid ? 0 : 1;
		const otherIndex = acquiringIndex === 0 ? 1 : 0;
		base.counterpartyTid = event.tids[otherIndex] ?? null;
		base.assetsAcquired = event.teams[acquiringIndex].assets.map(tradeAsset);
		base.assetsSurrendered = event.teams[otherIndex].assets.map(tradeAsset);
	}

	return base;
};

export type ProjectPlayerContext = {
	eventsByEid?: Map<number, RawEvent>;
	// Signature games, precomputed while streaming the box scores (see buildFromDb.ts).
	highlightGamesByPid?: Map<number, ProjectedPlayer["highlightGames"]>;
};

export const projectPlayer = (
	p: RawPlayer,
	context: ProjectPlayerContext = {},
): ProjectedPlayer => {
	const { eventsByEid = new Map(), highlightGamesByPid = new Map() } = context;
	const regular = p.stats.filter((s) => !s.playoffs && s.gp > 0);

	const teamsPlayedFor =
		p.statsTids && p.statsTids.length > 0
			? [...new Set(p.statsTids)]
			: [...new Set(p.stats.map((s) => s.tid))].filter((t) => t >= 0);

	const total = (pick: (s: RawPlayerStatsRow) => number | null) =>
		sumNullable(regular.map(pick));
	const high = (pick: (s: RawPlayerStatsRow) => number | null) =>
		maxNullable(p.stats.map(pick));

	const undrafted = p.draft.round === 0 && p.draft.pick === 0;

	return {
		pid: p.pid,
		name: `${p.firstName} ${p.lastName}`,
		pos: resolvePos(p),
		bornYear: p.born.year,
		birthLoc: p.born.loc ?? null,
		college: p.college ?? null,
		heightInches: num(p.hgt),
		weightLbs: num(p.weight),
		draft: {
			round: p.draft.round,
			pick: p.draft.pick,
			year: p.draft.year,
			// -1 originalTid is the undrafted sentinel; don't hand a writer a fake team id.
			originalTid:
				p.draft.originalTid !== undefined && p.draft.originalTid >= 0
					? p.draft.originalTid
					: null,
			ovr: num(p.draft.ovr),
			pot: num(p.draft.pot),
			undrafted,
		},
		hof: p.hof === 1,
		retiredYear: p.retiredYear ?? null,
		diedYear: p.diedYear ?? null,
		real: !!p.real,
		devFocus: p.devFocus ?? null,
		relatives: (p.relatives ?? []).map((r) => ({
			type: r.type,
			pid: r.pid,
			name: r.name,
		})),
		teamsPlayedFor,
		rings: p.awards.filter((a) => a.type.includes("Won Championship")).length,
		awards: p.awards.map((a) => ({ season: a.season, type: a.type })),
		injuries: (p.injuries ?? []).map((i) => ({
			season: i.season,
			games: i.games,
			type: i.type,
		})),
		transactions: (p.transactions ?? []).map((t) =>
			projectTransaction(t, eventsByEid),
		),
		ratings: p.ratings.map(projectRatingsLine),
		stats: p.stats.filter((s) => s.gp > 0).map(projectStatLine),
		careerTotals: {
			seasons: new Set(regular.map((s) => s.season)).size,
			gp: regular.reduce((acc, s) => acc + s.gp, 0),
			min: round(total((s) => num(s.min))),
			pts: total((s) => num(s.pts)),
			orb: total((s) => num(s.orb)),
			drb: total((s) => num(s.drb)),
			trb: total(deriveTrb),
			ast: total((s) => num(s.ast)),
			stl: total((s) => num(s.stl)),
			blk: total((s) => num(s.blk)),
			tov: total((s) => num(s.tov)),
			fg: total((s) => num(s.fg)),
			fga: total((s) => num(s.fga)),
			tp: total((s) => num(s.tp)),
			tpa: total((s) => num(s.tpa)),
			ft: total((s) => num(s.ft)),
			fta: total((s) => num(s.fta)),
			ws: round(total(deriveWs)),
			vorp: round(total((s) => num(s.vorp))),
		},
		careerHighs: {
			pts: high((s) => num(s.ptsMax)),
			trb: high((s) => num(s.trbMax)),
			ast: high((s) => num(s.astMax)),
			stl: high((s) => num(s.stlMax)),
			blk: high((s) => num(s.blkMax)),
			tp: high((s) => num(s.tpMax)),
		},
		highlightGames: highlightGamesByPid.get(p.pid) ?? [],
	};
};

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

const teamStatFor = (t: RawTeam, season: number, playoffs: boolean) =>
	t.stats.find((s) => s.season === season && !!s.playoffs === playoffs);

// Point differential, from team stats when they exist and otherwise backfilled from the games
// themselves. v1 read only team stats, which in a league whose early history was imported rather
// than simulated meant every pre-import season silently scored a flat 0 - penalizing the greatest
// teams in league history by a whole ranking component.
export type SeasonPointTotals = {
	gp: number;
	pts: number;
	oppPts: number;
};

export type TeamSeasonExtras = {
	// tid -> season -> totals derived from the game index (see buildFromDb.ts).
	pointsFromGames?: Map<number, Map<number, SeasonPointTotals>>;
	// tid -> season -> playoff seed (from the playoffSeries store).
	seedsByTidSeason?: Map<number, Map<number, number>>;
	confs?: RawConf[];
	divs?: RawDiv[];
	// numPeriods * quarterLength, i.e. helpers.effectiveGameLength(). Needed for pace; passed in
	// rather than hardcoded because a league can change either setting.
	gameLengthMinutes?: number;
};

const projectTeamSeason = (
	t: RawTeam,
	ts: RawTeamSeason,
	extras: TeamSeasonExtras,
	championRoundsBySeason: Map<number, number>,
	rankLookup: {
		conf: Map<string, number>;
		div: Map<string, number>;
	},
): ProjectedTeamSeason => {
	const games = ts.won + ts.lost + ts.tied + ts.otl;
	const winPct = games > 0 ? (ts.won + 0.5 * ts.tied) / games : 0;

	const stat = teamStatFor(t, ts.season, false);
	const fromGames = extras.pointsFromGames?.get(t.tid)?.get(ts.season);

	let gp: number | null = null;
	let pts: number | null = null;
	let oppPts: number | null = null;
	if (
		stat &&
		stat.gp > 0 &&
		num(stat.pts) !== null &&
		num(stat.oppPts) !== null
	) {
		gp = stat.gp;
		pts = stat.pts;
		oppPts = stat.oppPts;
	} else if (fromGames && fromGames.gp > 0) {
		gp = fromGames.gp;
		pts = fromGames.pts;
		oppPts = fromGames.oppPts;
	}

	const perGame = (v: number | null) => round(ratio(v, gp), 1);
	const poss = stat ? possessions(stat as RawTeamStatsRow) : null;
	const min = stat ? num(stat.min) : null;

	const championRounds = championRoundsBySeason.get(ts.season) ?? 0;

	return {
		season: ts.season,
		abbrev: ts.abbrev ?? null,
		region: ts.region ?? null,
		name: ts.name ?? null,
		won: ts.won,
		lost: ts.lost,
		tied: ts.tied,
		otl: ts.otl,
		winPct: Math.round(winPct * 1000) / 1000,
		playoffRoundsWon: ts.playoffRoundsWon,
		madePlayoffs: ts.playoffRoundsWon >= 0,
		wonTitle: championRounds > 0 && ts.playoffRoundsWon === championRounds,
		playoffSeed: extras.seedsByTidSeason?.get(t.tid)?.get(ts.season) ?? null,
		confRank: rankLookup.conf.get(`${ts.season}.${t.tid}`) ?? null,
		divRank: rankLookup.div.get(`${ts.season}.${t.tid}`) ?? null,
		gp,
		ptsPerGame: perGame(pts),
		oppPtsPerGame: perGame(oppPts),
		pointDiffPerGame:
			pts !== null && oppPts !== null ? perGame(pts - oppPts) : null,
		pace:
			poss !== null && min !== null && min > 0
				? round(((extras.gameLengthMinutes ?? 48) * poss) / (min / 5), 1)
				: null,
		ortg:
			poss !== null && stat
				? round(ratio(num(stat.pts), poss * 0.01), 1)
				: null,
		drtg:
			poss !== null && stat
				? round(ratio(num(stat.oppPts), poss * 0.01), 1)
				: null,
		ovrStart: num(ts.ovrStart),
		ovrEnd: num(ts.ovrEnd),
		avgAge: round(num(ts.avgAge), 1),
	};
};

// Conference/division finish. Computed over every team that played that season, so it's a real
// standing rather than something the writer has to reconstruct from 30 rows.
const buildRankLookups = (teams: RawTeam[]) => {
	const conf = new Map<string, number>();
	const div = new Map<string, number>();

	type Row = { tid: number; winPct: number; key: number | undefined };
	const bySeasonConf = new Map<string, Row[]>();
	const bySeasonDiv = new Map<string, Row[]>();

	for (const t of teams) {
		for (const ts of t.seasons) {
			const games = ts.won + ts.lost + ts.tied + ts.otl;
			if (games <= 0) {
				continue;
			}
			const winPct = (ts.won + 0.5 * ts.tied) / games;
			const cid = ts.cid ?? t.cid;
			const did = ts.did ?? t.did;
			if (cid !== undefined) {
				const key = `${ts.season}.${cid}`;
				const arr = bySeasonConf.get(key) ?? [];
				arr.push({ tid: t.tid, winPct, key: cid });
				bySeasonConf.set(key, arr);
			}
			if (did !== undefined) {
				const key = `${ts.season}.${did}`;
				const arr = bySeasonDiv.get(key) ?? [];
				arr.push({ tid: t.tid, winPct, key: did });
				bySeasonDiv.set(key, arr);
			}
		}
	}

	const fill = (groups: Map<string, Row[]>, out: Map<string, number>) => {
		for (const [groupKey, rows] of groups) {
			const season = groupKey.split(".")[0]!;
			rows.sort((a, b) => b.winPct - a.winPct);
			for (const [i, row] of rows.entries()) {
				out.set(`${season}.${row.tid}`, i + 1);
			}
		}
	};
	fill(bySeasonConf, conf);
	fill(bySeasonDiv, div);

	return { conf, div };
};

// Division-rival tids are computed from each team's *latest* season's did, so we need all teams
// together - hence projectTeams (plural) rather than a per-team function like projectPlayer.
export const projectTeams = (
	teams: RawTeam[],
	extras: TeamSeasonExtras = {},
): ProjectedTeam[] => {
	// Division-rival grouping by current did.
	const tidsByDid = new Map<number, number[]>();
	for (const t of teams) {
		if (t.did === undefined || t.disabled) {
			continue;
		}
		const arr = tidsByDid.get(t.did) ?? [];
		arr.push(t.tid);
		tidsByDid.set(t.did, arr);
	}

	const confNames = new Map((extras.confs ?? []).map((c) => [c.cid, c.name]));
	const divNames = new Map((extras.divs ?? []).map((d) => [d.did, d.name]));

	const championRoundsBySeason = new Map<number, number>();
	for (const t of teams) {
		for (const s of t.seasons) {
			const cur = championRoundsBySeason.get(s.season) ?? 0;
			if (s.playoffRoundsWon > cur) {
				championRoundsBySeason.set(s.season, s.playoffRoundsWon);
			}
		}
	}

	const rankLookup = buildRankLookups(teams);

	return teams.map((t) => {
		const seasons = [...t.seasons].sort((a, b) => a.season - b.season);

		// Title fields are stamped by attachTitles (champion = league-max playoffRoundsWon that
		// season, a whole-league fact); left as clean defaults here.
		let allWon = 0;
		let allLost = 0;
		for (const s of seasons) {
			allWon += s.won;
			allLost += s.lost;
		}

		const divisionRivalTids =
			t.did !== undefined
				? (tidsByDid.get(t.did) ?? []).filter((tid) => tid !== t.tid)
				: [];

		const allGames = allWon + allLost;

		// Relocations/rebrands, read off the per-season identity rows (which already carry them).
		const relocations: ProjectedTeam["relocations"] = [];
		let prevLabel: string | undefined;
		for (const s of seasons) {
			if (s.region === undefined && s.name === undefined) {
				continue;
			}
			const label = `${s.region ?? t.region} ${s.name ?? t.name}`;
			if (prevLabel !== undefined && label !== prevLabel) {
				relocations.push({ season: s.season, from: prevLabel, to: label });
			}
			prevLabel = label;
		}

		return {
			tid: t.tid,
			abbrev: t.abbrev,
			region: t.region,
			name: t.name,
			cid: t.cid ?? null,
			did: t.did ?? null,
			confName: t.cid !== undefined ? (confNames.get(t.cid) ?? null) : null,
			divName: t.did !== undefined ? (divNames.get(t.did) ?? null) : null,
			disabled: !!t.disabled,
			divisionRivalTids,
			titleSeasons: [],
			titles: 0,
			titleDrought: null,
			neverWonTitle: true,
			allTime: {
				won: allWon,
				lost: allLost,
				winPct:
					allGames > 0 ? Math.round((allWon / allGames) * 1000) / 1000 : 0,
				seasons: seasons.length,
			},
			relocations,
			seasons: seasons.map((s) =>
				projectTeamSeason(t, s, extras, championRoundsBySeason, rankLookup),
			),
		};
	});
};

// Champion set is a whole-league fact (max playoffRoundsWon per season). Compute it once and stamp
// each projected team's title fields, so titleSeasons/titles/titleDrought are correct and consistent
// with deriveCanon's dynasty detection (which uses the same rule).
export const attachTitles = (
	teams: RawTeam[],
	projected: ProjectedTeam[],
	currentSeason?: number,
): void => {
	const maxRoundsBySeason = new Map<number, number>();
	for (const t of teams) {
		for (const s of t.seasons) {
			const cur = maxRoundsBySeason.get(s.season) ?? 0;
			if (s.playoffRoundsWon > cur) {
				maxRoundsBySeason.set(s.season, s.playoffRoundsWon);
			}
		}
	}

	const projByTid = new Map(projected.map((p) => [p.tid, p]));
	for (const t of teams) {
		const proj = projByTid.get(t.tid);
		if (!proj) {
			continue;
		}
		const titleSeasons: number[] = [];
		for (const s of t.seasons) {
			const max = maxRoundsBySeason.get(s.season) ?? 0;
			if (max > 0 && s.playoffRoundsWon === max) {
				titleSeasons.push(s.season);
			}
		}
		titleSeasons.sort((a, b) => a - b);
		proj.titleSeasons = titleSeasons;
		proj.titles = titleSeasons.length;
		proj.neverWonTitle = titleSeasons.length === 0;

		const latestSeason = proj.seasons[proj.seasons.length - 1]?.season;
		if (latestSeason === undefined || proj.disabled) {
			// A franchise that folded in 1949 does not have a live title drought. v1 measured it from
			// the team's own final season and reported "2" for a team that has not existed since.
			proj.titleDrought = null;
		} else {
			// Measure against the league's current season when we know it, so an active team's drought
			// is the number a reader expects.
			const asOf = currentSeason ?? latestSeason;
			const from =
				titleSeasons.length === 0
					? (proj.seasons[0]?.season ?? latestSeason)
					: titleSeasons[titleSeasons.length - 1]!;
			proj.titleDrought = Math.max(0, asOf - from);
		}
	}
};
