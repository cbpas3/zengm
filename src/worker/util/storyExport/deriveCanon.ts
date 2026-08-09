// Canon derivation (AI Story Export, §3b/§5 in AI_STORY_EXPORT_PLAN.md).
//
// The full-league aggregation pass that turns the projected entity data into the small "canon"
// tables (<2 MB) that seed the foundational articles: greatest players, greatest team-seasons,
// biggest busts/steals, dynasties. Pure - no DB access - so it's unit-testable without a league;
// the worker wrapper loads the raw arrays and calls this. Same module posture as schemeFit.ts.
//
// Win shares is still the backbone metric, but it is *derived* (`ows + dws`, see statFields.ts), not
// read off a `ws` column that has never existed in storage. v1 read the column, got undefined,
// coalesced to 0, and shipped a "greatest players" table whose evidence fields were all zero and a
// busts/steals pair whose sort key had no variance at all - so the lists were really just the
// lowest player ids matching a round filter. Two guards against that recurring:
//   - `valueMetric` records which metric actually carried the score, and VORP/EWA are used as
//     fallbacks when a league's early seasons predate win shares.
//   - validate.ts fails the export when any ranking's sort key has zero variance.

import { deriveRivalries } from "./deriveRivalries.ts";
import { num, round, sumNullable } from "./statFields.ts";
import type {
	CanonTables,
	DraftValueEntry,
	DynastyEntry,
	PlayerRankingEntry,
	ProjectedPlayoffSeries,
	RawHeadToHead,
	RawPlayer,
	RawPlayerStatsRow,
	RawPlayoffSeries,
	RawTeam,
	TeamSeasonRankingEntry,
} from "./types.ts";
import { deriveWs } from "./statFields.ts";
import type { SeasonPointTotals } from "./projectEntities.ts";

// All tunable in one place (same posture as GAME_PLAN_TUNING). First cut - to be recalibrated once
// we can run it against a real league bundle end to end.
export const CANON_TUNING = {
	// Greatness = careerValue + PEAK_WEIGHT*peakValue + accolades. Peak is double-counted on purpose
	// so a short brilliant career can outrank a long compiler.
	PEAK_WEIGHT: 1.5,
	// Number of best single seasons (by the value metric) that count as "peak".
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
	// Expected career value is fit per draft slot, smoothed over a window of neighbouring picks so a
	// thin league doesn't produce a jagged curve. Below this many samples in the window we fall back
	// to the round average.
	DRAFT_SLOT_WINDOW: 3,
	DRAFT_MIN_SLOT_SAMPLES: 5,
	// VORP and EWA live on different scales than win shares; these put a fallback career value in
	// roughly WS units so a mixed-era league doesn't rank by which metric happened to exist.
	VORP_TO_WS: 1.0,
	EWA_TO_WS: 1.0,
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

export type ValueMetric = "ws" | "vorp" | "ewa" | "none";

// Per-season value in win-share units, preferring real win shares and falling back to VORP then EWA
// for seasons that predate them. Returns null when a season has none of the three, so a career made
// entirely of such seasons is honestly "unknown" rather than "zero".
const seasonValue = (
	s: RawPlayerStatsRow,
): { value: number; metric: Exclude<ValueMetric, "none"> } | null => {
	const ws = deriveWs(s);
	if (ws !== null) {
		return { value: ws, metric: "ws" };
	}
	const vorp = num(s.vorp);
	if (vorp !== null) {
		return { value: vorp * CANON_TUNING.VORP_TO_WS, metric: "vorp" };
	}
	const ewa = num(s.ewa);
	if (ewa !== null) {
		return { value: ewa * CANON_TUNING.EWA_TO_WS, metric: "ewa" };
	}
	return null;
};

type CareerValue = {
	career: number | null;
	peak: number | null;
	metric: ValueMetric;
	// Real win shares only, for the evidence field - null if the league never computed them.
	careerWS: number | null;
	peakWS: number | null;
};

export const careerValue = (p: RawPlayer): CareerValue => {
	const rows = regularSeasonStats(p);
	const values: number[] = [];
	const metrics = new Set<Exclude<ValueMetric, "none">>();
	for (const s of rows) {
		const v = seasonValue(s);
		if (v !== null) {
			values.push(v.value);
			metrics.add(v.metric);
		}
	}

	const wsValues = rows.map(deriveWs).filter((v): v is number => v !== null);

	const peakOf = (arr: number[]) =>
		arr.length === 0
			? null
			: [...arr]
					.sort((a, b) => b - a)
					.slice(0, CANON_TUNING.PEAK_SEASONS)
					.reduce((acc, v) => acc + v, 0);

	// Report the dominant metric: ws if it contributed at all, else whichever fallback did.
	const metric: ValueMetric = metrics.has("ws")
		? "ws"
		: metrics.has("vorp")
			? "vorp"
			: metrics.has("ewa")
				? "ewa"
				: "none";

	return {
		career: values.length === 0 ? null : values.reduce((a, b) => a + b, 0),
		peak: peakOf(values),
		metric,
		careerWS:
			wsValues.length === 0 ? null : wsValues.reduce((a, b) => a + b, 0),
		peakWS: peakOf(wsValues),
	};
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
		return null;
	}
	return { first: Math.min(...seasons), last: Math.max(...seasons) };
};

export const rankPlayers = (players: RawPlayer[]): PlayerRankingEntry[] => {
	const scored = players
		.map((p) => {
			const value = careerValue(p);
			const greatness =
				(value.career ?? 0) +
				CANON_TUNING.PEAK_WEIGHT * (value.peak ?? 0) +
				accoladeScore(p);
			return { p, value, greatness };
		})
		.filter((x) => x.greatness > 0)
		.sort((a, b) => b.greatness - a.greatness)
		.slice(0, CANON_TUNING.TOP_PLAYERS);

	return scored.map(({ p, value, greatness }, i) => ({
		pid: p.pid,
		name: `${p.firstName} ${p.lastName}`,
		rank: i + 1,
		greatness: Math.round(greatness * 10) / 10,
		careerWS: round(value.careerWS),
		peakWS: round(value.peakWS),
		careerVORP: round(
			sumNullable(regularSeasonStats(p).map((s) => num(s.vorp))),
		),
		careerPts: sumNullable(regularSeasonStats(p).map((s) => num(s.pts))),
		rings: countRings(p),
		seasonsPlayed: seasonsPlayed(p),
		teams: teamsFor(p),
		topAwards: topAwards(p),
		primeSpan: primeSpan(p),
		valueMetric: value.metric,
	}));
};

// ---------------------------------------------------------------------------
// Team seasons
// ---------------------------------------------------------------------------

const regularTeamStat = (t: RawTeam, season: number) =>
	t.stats.find((s) => s.season === season && !s.playoffs);

export type RankTeamSeasonsOptions = {
	// tid -> season -> points scored/allowed, summed from the game index. The backfill for leagues
	// whose early seasons were imported rather than simulated and so have no team stat rows.
	pointsFromGames?: Map<number, Map<number, SeasonPointTotals>>;
};

export const rankTeamSeasons = (
	teams: RawTeam[],
	options: RankTeamSeasonsOptions = {},
): TeamSeasonRankingEntry[] => {
	type Row = Omit<TeamSeasonRankingEntry, "rank">;
	const rows: Row[] = [];

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
			const fromGames = options.pointsFromGames?.get(t.tid)?.get(ts.season);
			let pointDiffPerGame: number | null = null;
			if (
				stat &&
				stat.gp > 0 &&
				num(stat.pts) !== null &&
				num(stat.oppPts) !== null
			) {
				pointDiffPerGame = (stat.pts - stat.oppPts) / stat.gp;
			} else if (fromGames && fromGames.gp > 0) {
				pointDiffPerGame = (fromGames.pts - fromGames.oppPts) / fromGames.gp;
			}

			rows.push({
				tid: t.tid,
				season: ts.season,
				greatness: 0, // scored below, once the point-diff imputation model is fit
				won: ts.won,
				lost: ts.lost,
				winPct: Math.round(winPct * 1000) / 1000,
				pointDiffPerGame:
					pointDiffPerGame === null
						? null
						: Math.round(pointDiffPerGame * 10) / 10,
				pointDiffImputed: false,
				wonTitle: false, // filled below once we know each season's champion
				playoffRoundsWon: ts.playoffRoundsWon,
			});
		}
	}

	// Point differential is one of three scoring components, so a season with no differential data
	// used to score as if the team had been exactly average - a flat, invisible penalty on every
	// pre-data era (the 72-10 team in the bug report). Instead, fit the league's own relationship
	// between win% and differential over the rows that *do* have it, and impute the rest. A team is
	// then ranked on what its record implies rather than punished for a gap in the source data.
	const known = rows.filter((r) => r.pointDiffPerGame !== null);
	let slope = 0;
	if (known.length >= 5) {
		let sxy = 0;
		let sxx = 0;
		for (const r of known) {
			const x = r.winPct - 0.5;
			sxy += x * r.pointDiffPerGame!;
			sxx += x * x;
		}
		slope = sxx > 0 ? sxy / sxx : 0;
	}
	for (const r of rows) {
		if (r.pointDiffPerGame === null) {
			r.pointDiffImputed = true;
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

		const diffForScore = r.pointDiffPerGame ?? slope * (r.winPct - 0.5);
		r.greatness =
			Math.round(
				(r.winPct * CANON_TUNING.TEAM_WINPCT_WEIGHT +
					diffForScore +
					r.playoffRoundsWon * CANON_TUNING.TEAM_ROUNDS_WEIGHT) *
					10,
			) / 10;
	}

	return rows
		.sort((a, b) => b.greatness - a.greatness)
		.slice(0, CANON_TUNING.TOP_TEAM_SEASONS)
		.map((r, i) => ({ ...r, rank: i + 1 }));
};

// ---------------------------------------------------------------------------
// Draft value (busts & steals)
// ---------------------------------------------------------------------------

type DraftSample = {
	pid: number;
	name: string;
	draftYear: number;
	round: number;
	pick: number;
	undrafted: boolean;
	careerWS: number | null;
};

// Expected career value by draft *slot*, computed from the league's own history (self-calibrating,
// so it adapts to league length/quality rather than assuming a fixed curve) and smoothed over
// neighbouring picks so a thin sample doesn't produce a jagged curve. Falls back to the round
// average where a slot has too few samples. v1 used the round average only, which meant the #1
// overall pick and the #30 pick were held to the same standard - the single biggest reason the bust
// list read as arbitrary even once the metric worked.
const buildExpectedValue = (samples: DraftSample[]) => {
	const bySlot = new Map<string, number[]>();
	const byRound = new Map<number, number[]>();
	for (const s of samples) {
		if (s.careerWS === null) {
			continue;
		}
		const roundArr = byRound.get(s.round) ?? [];
		roundArr.push(s.careerWS);
		byRound.set(s.round, roundArr);

		if (!s.undrafted) {
			const key = `${s.round}.${s.pick}`;
			const slotArr = bySlot.get(key) ?? [];
			slotArr.push(s.careerWS);
			bySlot.set(key, slotArr);
		}
	}

	const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
	const roundMeans = new Map<number, number>();
	for (const [r, arr] of byRound) {
		roundMeans.set(r, mean(arr));
	}

	return (
		s: DraftSample,
	): { expected: number | null; from: "slot" | "round" } => {
		if (!s.undrafted) {
			const window: number[] = [];
			for (
				let pick = s.pick - CANON_TUNING.DRAFT_SLOT_WINDOW;
				pick <= s.pick + CANON_TUNING.DRAFT_SLOT_WINDOW;
				pick++
			) {
				const arr = bySlot.get(`${s.round}.${pick}`);
				if (arr) {
					window.push(...arr);
				}
			}
			if (window.length >= CANON_TUNING.DRAFT_MIN_SLOT_SAMPLES) {
				return { expected: mean(window), from: "slot" };
			}
		}
		const roundMean = roundMeans.get(s.round);
		return {
			expected: roundMean === undefined ? null : roundMean,
			from: "round",
		};
	};
};

export const rankDraftValue = (
	players: RawPlayer[],
): { busts: DraftValueEntry[]; steals: DraftValueEntry[] } => {
	const eligible: DraftSample[] = players
		.filter((p) => seasonsPlayed(p) >= CANON_TUNING.MIN_SEASONS_FOR_DRAFT_LISTS)
		.map((p) => {
			const value = careerValue(p);
			return {
				pid: p.pid,
				name: `${p.firstName} ${p.lastName}`,
				draftYear: p.draft.year,
				round: p.draft.round,
				pick: p.draft.pick,
				// round 0 / pick 0 / originalTid -1 is ZenGM's undrafted sentinel. Keeping these in the
				// per-slot expectation would divide by a slot that does not exist.
				undrafted: p.draft.round === 0 && p.draft.pick === 0,
				careerWS: round(value.career),
			};
		});

	const expectedFor = buildExpectedValue(eligible);

	const withDelta: DraftValueEntry[] = eligible.map((s) => {
		const { expected, from } = expectedFor(s);
		return {
			pid: s.pid,
			name: s.name,
			draftYear: s.draftYear,
			round: s.round,
			pick: s.pick,
			undrafted: s.undrafted,
			careerWS: s.careerWS,
			expectedWS: round(expected),
			delta:
				s.careerWS === null || expected === null
					? null
					: round(s.careerWS - expected),
			expectedFrom: from,
		};
	});

	// Only players whose delta is actually computable can be ranked; the rest would sort as ties.
	const rankable = withDelta.filter((p) => p.delta !== null);

	// Busts: first-round picks who fell furthest short of their slot's norm.
	const busts = rankable
		.filter((p) => p.round === 1)
		.sort((a, b) => a.delta! - b.delta!)
		.slice(0, CANON_TUNING.TOP_DRAFT);

	// Steals: second-round-or-later (incl. undrafted) picks who most exceeded their slot's norm.
	const steals = rankable
		.filter((p) => p.round >= 2 || p.undrafted)
		.sort((a, b) => b.delta! - a.delta!)
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
				(s) =>
					s >= seasons[i]! && s < seasons[i]! + CANON_TUNING.DYNASTY_WINDOW,
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

export type DeriveCanonOptions = RankTeamSeasonsOptions & {
	// Projected series, so a rivalry's playoff meetings can carry the gids of the actual games.
	projectedPlayoffSeries?: ProjectedPlayoffSeries[];
};

export const deriveCanon = (
	players: RawPlayer[],
	teams: RawTeam[],
	playoffSeries: RawPlayoffSeries[] = [],
	headToHeads: RawHeadToHead[] = [],
	options: DeriveCanonOptions = {},
): CanonTables => {
	const { busts, steals } = rankDraftValue(players);
	return {
		players: rankPlayers(players),
		teamSeasons: rankTeamSeasons(teams, options),
		busts,
		steals,
		dynasties: findDynasties(teams),
		rivalries: deriveRivalries(playoffSeries, headToHeads, {
			projectedPlayoffSeries: options.projectedPlayoffSeries,
		}),
	};
};
