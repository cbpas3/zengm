// Canon derivation (AI Story Export, Phase 1, §3b/§5 in AI_STORY_EXPORT_PLAN.md).
//
// The full-league aggregation pass that turns the projected entity data into the small "canon"
// tables (<2 MB) that seed the foundational articles: greatest players, greatest team-seasons,
// biggest busts/steals, dynasties. Pure - no DB access - so it's unit-testable without a league;
// the worker wrapper loads the raw arrays and calls this. Same module posture as schemeFit.ts.
//
// Win Shares (`ws`) is the backbone metric: it's already computed per player-season in the export,
// aggregates cleanly across a career, and is a defensible single-number value proxy. Accolades and
// rings layer on top so peak/greatness isn't purely a longevity count.

import type {
	CanonTables,
	DraftValueEntry,
	DynastyEntry,
	PlayerRankingEntry,
	RawPlayer,
	RawTeam,
	TeamSeasonRankingEntry,
} from "./types.ts";

// All tunable in one place (same posture as GAME_PLAN_TUNING). First cut - to be recalibrated once
// we can run it against a real league bundle end to end.
export const CANON_TUNING = {
	// Greatness = careerWS + PEAK_WEIGHT*peakWS + accolades. Peak is double-counted on purpose so a
	// short brilliant career can outrank a long compiler.
	PEAK_WEIGHT: 1.5,
	// Number of best single seasons (by WS) that count as "peak".
	PEAK_SEASONS: 3,
	// How many entries each ranking table keeps.
	TOP_PLAYERS: 100,
	TOP_TEAM_SEASONS: 50,
	TOP_DRAFT: 40,
	// A team-season's greatness: win% (0-1) scaled up, plus point-diff/game, plus a title bonus
	// scaled by rounds won.
	TEAM_WINPCT_WEIGHT: 100,
	TEAM_ROUNDS_WEIGHT: 6,
	// Busts/steals: only consider players with a real career length, so a one-game cup-of-coffee
	// doesn't dominate either list.
	MIN_SEASONS_FOR_DRAFT_LISTS: 3,
	// Dynasty: at least this many titles, all within a rolling window of this many seasons.
	DYNASTY_MIN_TITLES: 3,
	DYNASTY_WINDOW: 8,
} as const;

// Accolade weights. Matched by substring against the player's awards[].type strings (BBGM stores
// full titles like "Most Valuable Player", "First Team All-League", "Won Championship"). Ordered
// most-to-least so topAwards can surface the headline honors.
const ACCOLADE_WEIGHTS: { match: string; weight: number; label: string }[] = [
	{ match: "Most Valuable Player", weight: 30, label: "MVP" },
	{ match: "Finals MVP", weight: 18, label: "Finals MVP" },
	{ match: "Defensive Player of the Year", weight: 12, label: "DPOY" },
	{ match: "First Team All-League", weight: 10, label: "All-League 1st" },
	{ match: "Won Championship", weight: 10, label: "Champion" },
	{ match: "Second Team All-League", weight: 6, label: "All-League 2nd" },
	{ match: "Third Team All-League", weight: 4, label: "All-League 3rd" },
	{ match: "First Team All-Defensive", weight: 4, label: "All-Defensive 1st" },
	{ match: "Rookie of the Year", weight: 4, label: "ROY" },
	{ match: "Most Improved Player", weight: 3, label: "MIP" },
	{ match: "Sixth Man of the Year", weight: 3, label: "6MOY" },
	{ match: "All-Star", weight: 2, label: "All-Star" },
];

const regularSeasonStats = (p: RawPlayer) =>
	p.stats.filter((s) => !s.playoffs && s.gp > 0);

const sumWS = (p: RawPlayer) =>
	regularSeasonStats(p).reduce((acc, s) => acc + (s.ws ?? 0), 0);

const peakWS = (p: RawPlayer) => {
	const wsValues = regularSeasonStats(p)
		.map((s) => s.ws ?? 0)
		.sort((a, b) => b - a)
		.slice(0, CANON_TUNING.PEAK_SEASONS);
	return wsValues.reduce((acc, v) => acc + v, 0);
};

const countRings = (p: RawPlayer) =>
	p.awards.filter((a) => a.type.includes("Won Championship")).length;

const accoladeScore = (p: RawPlayer) => {
	let score = 0;
	for (const award of p.awards) {
		for (const w of ACCOLADE_WEIGHTS) {
			if (award.type.includes(w.match)) {
				score += w.weight;
				break;
			}
		}
	}
	return score;
};

const topAwards = (p: RawPlayer): string[] => {
	const counts = new Map<string, number>();
	for (const award of p.awards) {
		for (const w of ACCOLADE_WEIGHTS) {
			if (award.type.includes(w.match)) {
				counts.set(w.label, (counts.get(w.label) ?? 0) + 1);
				break;
			}
		}
	}
	// ACCOLADE_WEIGHTS is already in importance order; preserve it.
	const order = ACCOLADE_WEIGHTS.map((w) => w.label);
	return [...counts.entries()]
		.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
		.map(([label, n]) => (n > 1 ? `${n}x ${label}` : label));
};

const seasonsPlayed = (p: RawPlayer) =>
	new Set(regularSeasonStats(p).map((s) => s.season)).size;

const teamsFor = (p: RawPlayer) =>
	p.statsTids && p.statsTids.length > 0
		? [...new Set(p.statsTids)]
		: [...new Set(p.stats.map((s) => s.tid))].filter((t) => t >= 0);

const primeSpan = (p: RawPlayer) => {
	const seasons = regularSeasonStats(p).map((s) => s.season);
	if (seasons.length === 0) {
		return undefined;
	}
	return { first: Math.min(...seasons), last: Math.max(...seasons) };
};

export const rankPlayers = (players: RawPlayer[]): PlayerRankingEntry[] => {
	const scored = players
		.map((p) => {
			const careerWS = sumWS(p);
			const pk = peakWS(p);
			const greatness =
				careerWS + CANON_TUNING.PEAK_WEIGHT * pk + accoladeScore(p);
			return { p, careerWS, pk, greatness };
		})
		.filter((x) => x.greatness > 0)
		.sort((a, b) => b.greatness - a.greatness)
		.slice(0, CANON_TUNING.TOP_PLAYERS);

	return scored.map(({ p, careerWS, pk, greatness }, i) => ({
		pid: p.pid,
		name: `${p.firstName} ${p.lastName}`,
		rank: i + 1,
		greatness: Math.round(greatness * 10) / 10,
		careerWS: Math.round(careerWS * 10) / 10,
		peakWS: Math.round(pk * 10) / 10,
		rings: countRings(p),
		seasonsPlayed: seasonsPlayed(p),
		teams: teamsFor(p),
		topAwards: topAwards(p),
		primeSpan: primeSpan(p),
	}));
};

const regularTeamStat = (t: RawTeam, season: number) =>
	t.stats.find((s) => s.season === season && !s.playoffs);

export const rankTeamSeasons = (teams: RawTeam[]): TeamSeasonRankingEntry[] => {
	const rows: Omit<TeamSeasonRankingEntry, "rank">[] = [];

	for (const t of teams) {
		if (t.disabled) {
			continue;
		}
		for (const ts of t.seasons) {
			const games = ts.won + ts.lost + ts.tied + ts.otl;
			if (games <= 0) {
				continue;
			}
			const winPct = (ts.won + 0.5 * ts.tied) / games;
			const stat = regularTeamStat(t, ts.season);
			const pointDiffPerGame =
				stat && stat.gp > 0 ? (stat.pts - stat.oppPts) / stat.gp : 0;
			const greatness =
				winPct * CANON_TUNING.TEAM_WINPCT_WEIGHT +
				pointDiffPerGame +
				ts.playoffRoundsWon * CANON_TUNING.TEAM_ROUNDS_WEIGHT;

			rows.push({
				tid: t.tid,
				season: ts.season,
				greatness: Math.round(greatness * 10) / 10,
				won: ts.won,
				lost: ts.lost,
				winPct: Math.round(winPct * 1000) / 1000,
				pointDiffPerGame: Math.round(pointDiffPerGame * 10) / 10,
				wonTitle: false, // filled below once we know each season's champion
				playoffRoundsWon: ts.playoffRoundsWon,
			});
		}
	}

	// Champion of a season = the team with the max playoffRoundsWon that season (there is exactly
	// one, and it must be > 0). Mark it so the ranking can flag title teams.
	const maxRoundsBySeason = new Map<number, number>();
	for (const r of rows) {
		const cur = maxRoundsBySeason.get(r.season) ?? 0;
		if (r.playoffRoundsWon > cur) {
			maxRoundsBySeason.set(r.season, r.playoffRoundsWon);
		}
	}
	for (const r of rows) {
		const max = maxRoundsBySeason.get(r.season) ?? 0;
		r.wonTitle = max > 0 && r.playoffRoundsWon === max;
	}

	return rows
		.sort((a, b) => b.greatness - a.greatness)
		.slice(0, CANON_TUNING.TOP_TEAM_SEASONS)
		.map((r, i) => ({ ...r, rank: i + 1 }));
};

// Expected career WS by draft round, computed from the league's own distribution (self-calibrating,
// so it adapts to league length/quality rather than assuming a fixed curve). Undrafted (round 0)
// gets its own bucket.
const expectedWSByRound = (
	players: { round: number; careerWS: number }[],
): Map<number, number> => {
	const byRound = new Map<number, number[]>();
	for (const p of players) {
		const arr = byRound.get(p.round) ?? [];
		arr.push(p.careerWS);
		byRound.set(p.round, arr);
	}
	const expected = new Map<number, number>();
	for (const [round, arr] of byRound) {
		expected.set(round, arr.reduce((a, b) => a + b, 0) / arr.length);
	}
	return expected;
};

export const rankDraftValue = (
	players: RawPlayer[],
): { busts: DraftValueEntry[]; steals: DraftValueEntry[] } => {
	const eligible = players
		.filter((p) => seasonsPlayed(p) >= CANON_TUNING.MIN_SEASONS_FOR_DRAFT_LISTS)
		.map((p) => ({
			pid: p.pid,
			name: `${p.firstName} ${p.lastName}`,
			draftYear: p.draft.year,
			round: p.draft.round,
			pick: p.draft.pick,
			careerWS: Math.round(sumWS(p) * 10) / 10,
		}));

	const expected = expectedWSByRound(eligible);

	const withDelta: DraftValueEntry[] = eligible.map((p) => {
		const exp = expected.get(p.round) ?? 0;
		return {
			...p,
			expectedWS: Math.round(exp * 10) / 10,
			delta: Math.round((p.careerWS - exp) * 10) / 10,
		};
	});

	// Busts: first-round picks who fell furthest short of their round's norm.
	const busts = withDelta
		.filter((p) => p.round === 1)
		.sort((a, b) => a.delta - b.delta)
		.slice(0, CANON_TUNING.TOP_DRAFT);

	// Steals: second-round-or-later (incl. undrafted) picks who most exceeded their round's norm.
	const steals = withDelta
		.filter((p) => p.round >= 2 || p.round === 0)
		.sort((a, b) => b.delta - a.delta)
		.slice(0, CANON_TUNING.TOP_DRAFT);

	return { busts, steals };
};

export const findDynasties = (teams: RawTeam[]): DynastyEntry[] => {
	// Champion per season from the team-season data.
	const maxRoundsBySeason = new Map<number, number>();
	for (const t of teams) {
		for (const ts of t.seasons) {
			const cur = maxRoundsBySeason.get(ts.season) ?? 0;
			if (ts.playoffRoundsWon > cur) {
				maxRoundsBySeason.set(ts.season, ts.playoffRoundsWon);
			}
		}
	}
	const titleSeasonsByTid = new Map<number, number[]>();
	for (const t of teams) {
		for (const ts of t.seasons) {
			const max = maxRoundsBySeason.get(ts.season) ?? 0;
			if (max > 0 && ts.playoffRoundsWon === max) {
				const arr = titleSeasonsByTid.get(t.tid) ?? [];
				arr.push(ts.season);
				titleSeasonsByTid.set(t.tid, arr);
			}
		}
	}

	const dynasties: DynastyEntry[] = [];
	for (const [tid, seasonsUnsorted] of titleSeasonsByTid) {
		const seasons = [...seasonsUnsorted].sort((a, b) => a - b);
		// Slide a window; a dynasty is DYNASTY_MIN_TITLES titles inside DYNASTY_WINDOW seasons.
		for (let i = 0; i < seasons.length; i++) {
			const windowTitles = seasons.filter(
				(s) => s >= seasons[i]! && s < seasons[i]! + CANON_TUNING.DYNASTY_WINDOW,
			);
			if (windowTitles.length >= CANON_TUNING.DYNASTY_MIN_TITLES) {
				dynasties.push({
					tid,
					titleSeasons: windowTitles,
					span: {
						first: windowTitles[0]!,
						last: windowTitles[windowTitles.length - 1]!,
					},
					titles: windowTitles.length,
				});
				break; // one dynasty entry per team's first qualifying window
			}
		}
	}

	return dynasties.sort((a, b) => b.titles - a.titles);
};

export const deriveCanon = (
	players: RawPlayer[],
	teams: RawTeam[],
): CanonTables => {
	const { busts, steals } = rankDraftValue(players);
	return {
		players: rankPlayers(players),
		teamSeasons: rankTeamSeasons(teams),
		busts,
		steals,
		dynasties: findDynasties(teams),
	};
};
