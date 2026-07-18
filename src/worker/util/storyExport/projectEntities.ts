// Entity projection (AI Story Export, Phase 1, §3a in AI_STORY_EXPORT_PLAN.md).
//
// Turns the raw export records into the compact, cross-linked entity tables: trim the noise
// (cosmetic face fields, financials, fuzz, per-game max pointer arrays - see the plan's §4 TRIM
// bucket) and surface the interconnections that are already latent in the data (transactions =
// career movement, relatives, statsTids = teams played for) as clean fields. Pure, DB-free.
//
// The point of "trim" here is not to drop career data - the per-season stats/ratings/awards are the
// whole value - but to drop the ~40 face fields, the financial block, and the internal bookkeeping
// that no writer needs, so the compact layer stays small (the plan measured ~15-25 MB before this).

import type {
	ProjectedPlayer,
	ProjectedStatLine,
	ProjectedTeam,
	RawPlayer,
	RawTeam,
} from "./types.ts";

const projectStatLine = (
	s: RawPlayer["stats"][number],
): ProjectedStatLine => ({
	season: s.season,
	tid: s.tid,
	playoffs: s.playoffs,
	gp: s.gp,
	min: Math.round(s.min),
	pts: s.pts,
	trb: s.trb,
	ast: s.ast,
	per: Math.round((s.per ?? 0) * 10) / 10,
	ws: Math.round((s.ws ?? 0) * 10) / 10,
	vorp: Math.round((s.vorp ?? 0) * 10) / 10,
});

export const projectPlayer = (p: RawPlayer): ProjectedPlayer => {
	const regular = p.stats.filter((s) => !s.playoffs && s.gp > 0);

	const teamsPlayedFor =
		p.statsTids && p.statsTids.length > 0
			? [...new Set(p.statsTids)]
			: [...new Set(p.stats.map((s) => s.tid))].filter((t) => t >= 0);

	const careerTotals = regular.reduce(
		(acc, s) => {
			acc.gp += s.gp;
			acc.pts += s.pts;
			acc.trb += s.trb;
			acc.ast += s.ast;
			acc.ws += s.ws ?? 0;
			return acc;
		},
		{ gp: 0, pts: 0, trb: 0, ast: 0, ws: 0 },
	);

	return {
		pid: p.pid,
		name: `${p.firstName} ${p.lastName}`,
		pos: p.pos,
		bornYear: p.born.year,
		birthLoc: p.born.loc,
		college: p.college,
		draft: {
			round: p.draft.round,
			pick: p.draft.pick,
			year: p.draft.year,
			originalTid: p.draft.originalTid,
			ovr: p.draft.ovr,
			pot: p.draft.pot,
		},
		hof: p.hof === 1,
		retiredYear: p.retiredYear ?? undefined,
		diedYear: p.diedYear,
		real: !!p.real,
		devFocus: p.devFocus,
		relatives: (p.relatives ?? []).map((r) => ({
			type: r.type,
			pid: r.pid,
			name: r.name,
		})),
		teamsPlayedFor,
		rings: p.awards.filter((a) => a.type.includes("Won Championship")).length,
		awards: p.awards.map((a) => ({ season: a.season, type: a.type })),
		transactions: (p.transactions ?? []).map((t) => ({
			type: t.type,
			season: t.season,
			phase: t.phase,
			tid: t.tid,
			fromTid: t.fromTid,
		})),
		ratings: p.ratings.map((r) => ({
			season: r.season,
			ovr: r.ovr,
			pot: r.pot,
			pos: r.pos,
		})),
		stats: p.stats.filter((s) => s.gp > 0).map(projectStatLine),
		careerTotals: {
			seasons: new Set(regular.map((s) => s.season)).size,
			gp: careerTotals.gp,
			pts: careerTotals.pts,
			trb: careerTotals.trb,
			ast: careerTotals.ast,
			ws: Math.round(careerTotals.ws * 10) / 10,
		},
	};
};

// Division-rival tids are computed from each team's *latest* season's did, so we need all teams
// together - hence projectTeams (plural) rather than a per-team function like projectPlayer.
export const projectTeams = (teams: RawTeam[]): ProjectedTeam[] => {
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

		return {
			tid: t.tid,
			abbrev: t.abbrev,
			region: t.region,
			name: t.name,
			cid: t.cid,
			did: t.did,
			disabled: !!t.disabled,
			divisionRivalTids,
			titleSeasons: [],
			titles: 0,
			titleDrought: undefined,
			neverWonTitle: true,
			allTime: {
				won: allWon,
				lost: allLost,
				winPct: allGames > 0 ? Math.round((allWon / allGames) * 1000) / 1000 : 0,
				seasons: seasons.length,
			},
			seasons: seasons.map((s) => ({
				season: s.season,
				abbrev: s.abbrev,
				region: s.region,
				name: s.name,
				won: s.won,
				lost: s.lost,
				tied: s.tied,
				otl: s.otl,
				playoffRoundsWon: s.playoffRoundsWon,
				ovrStart: s.ovrStart,
				ovrEnd: s.ovrEnd,
			})),
		};
	});
};

// Champion set is a whole-league fact (max playoffRoundsWon per season). Compute it once and stamp
// each projected team's title fields, so titleSeasons/titles/titleDrought are correct and consistent
// with deriveCanon's dynasty detection (which uses the same rule).
export const attachTitles = (
	teams: RawTeam[],
	projected: ProjectedTeam[],
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
		if (latestSeason === undefined) {
			proj.titleDrought = undefined;
		} else if (titleSeasons.length === 0) {
			const firstSeason = proj.seasons[0]?.season ?? latestSeason;
			proj.titleDrought = latestSeason - firstSeason;
		} else {
			proj.titleDrought = latestSeason - titleSeasons[titleSeasons.length - 1]!;
		}
	}
};
