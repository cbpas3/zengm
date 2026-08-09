// All-time leaderboards (AI Story Export).
//
// Every "greatest ever" argument wants to say "fourth-most points in league history," and without
// this table a consumer has to recompute it from 5,000 player records every time it wants to make
// that claim - which in practice means it either doesn't, or it guesses. Career and single-season
// top-N for the counting stats and the advanced metrics. Pure, DB-free.

import { deriveTrb, deriveWs, num, round, sumNullable } from "./statFields.ts";
import type {
	LeaderboardEntry,
	Leaderboards,
	RawPlayer,
	RawPlayerStatsRow,
} from "./types.ts";

export const LEADERBOARD_TUNING = {
	TOP_N: 25,
	// Rate stats need a workload floor or a 3-game career tops the list.
	MIN_CAREER_GP_FOR_RATE: 400,
	MIN_SEASON_GP_FOR_RATE: 41,
} as const;

type Metric = {
	key: string;
	// Higher is better for everything here (drtg would need inverting; left out deliberately).
	value: (s: RawPlayerStatsRow) => number | null;
	// Rate stats are averaged/weighted rather than summed, so they get a games-played floor.
	rate?: boolean;
	decimals?: number;
};

const METRICS: Metric[] = [
	{ key: "pts", value: (s) => num(s.pts) },
	{ key: "trb", value: deriveTrb },
	{ key: "ast", value: (s) => num(s.ast) },
	{ key: "stl", value: (s) => num(s.stl) },
	{ key: "blk", value: (s) => num(s.blk) },
	{ key: "tp", value: (s) => num(s.tp) },
	{ key: "min", value: (s) => num(s.min) },
	{ key: "ws", value: deriveWs, decimals: 1 },
	{ key: "vorp", value: (s) => num(s.vorp), decimals: 1 },
	{ key: "ewa", value: (s) => num(s.ewa), decimals: 1 },
	{ key: "per", value: (s) => num(s.per), rate: true, decimals: 1 },
];

const rank = (
	rows: {
		pid: number;
		name: string;
		value: number;
		season: number | null;
		tid: number | null;
	}[],
	decimals: number,
): LeaderboardEntry[] =>
	rows
		.sort((a, b) => b.value - a.value)
		.slice(0, LEADERBOARD_TUNING.TOP_N)
		.map((r, i) => ({
			rank: i + 1,
			pid: r.pid,
			name: r.name,
			value: round(r.value, decimals)!,
			season: r.season,
			tid: r.tid,
		}));

export const deriveLeaderboards = (players: RawPlayer[]): Leaderboards => {
	const career: Record<string, LeaderboardEntry[]> = {};
	const season: Record<string, LeaderboardEntry[]> = {};

	// Regular season only. Playoff leaderboards are a different (and much shorter) argument; the
	// per-player stat lines carry the playoff rows for anyone who wants them.
	const regularByPlayer = players.map((p) => ({
		p,
		name: `${p.firstName} ${p.lastName}`,
		rows: p.stats.filter((s) => !s.playoffs && s.gp > 0),
	}));

	for (const metric of METRICS) {
		const decimals = metric.decimals ?? 0;

		const careerRows = [];
		const seasonRows = [];

		for (const { p, name, rows } of regularByPlayer) {
			const gp = rows.reduce((acc, s) => acc + s.gp, 0);

			if (metric.rate) {
				// Minutes-weighted career average, so a rate stat isn't dominated by short seasons.
				let weighted = 0;
				let weight = 0;
				for (const s of rows) {
					const v = metric.value(s);
					const min = num(s.min);
					if (v !== null && min !== null && min > 0) {
						weighted += v * min;
						weight += min;
					}
				}
				if (weight > 0 && gp >= LEADERBOARD_TUNING.MIN_CAREER_GP_FOR_RATE) {
					careerRows.push({
						pid: p.pid,
						name,
						value: weighted / weight,
						season: null,
						tid: null,
					});
				}
			} else {
				const total = sumNullable(rows.map(metric.value));
				if (total !== null) {
					careerRows.push({
						pid: p.pid,
						name,
						value: total,
						season: null,
						tid: null,
					});
				}
			}

			// A player traded mid-season has one stored row per team. Aggregate by season so a 2,000
			// point year isn't split into two unremarkable half-years.
			const bySeason = new Map<number, RawPlayerStatsRow[]>();
			for (const s of rows) {
				const arr = bySeason.get(s.season) ?? [];
				arr.push(s);
				bySeason.set(s.season, arr);
			}

			for (const [seasonYear, seasonStatRows] of bySeason) {
				const seasonGp = seasonStatRows.reduce((acc, s) => acc + s.gp, 0);
				// Attribute the season to whichever team the player played the most games for.
				const primaryTid = [...seasonStatRows].sort((a, b) => b.gp - a.gp)[0]!
					.tid;

				let value: number | null;
				if (metric.rate) {
					if (seasonGp < LEADERBOARD_TUNING.MIN_SEASON_GP_FOR_RATE) {
						continue;
					}
					let weighted = 0;
					let weight = 0;
					for (const s of seasonStatRows) {
						const v = metric.value(s);
						const min = num(s.min);
						if (v !== null && min !== null && min > 0) {
							weighted += v * min;
							weight += min;
						}
					}
					value = weight > 0 ? weighted / weight : null;
				} else {
					value = sumNullable(seasonStatRows.map(metric.value));
				}

				if (value !== null) {
					seasonRows.push({
						pid: p.pid,
						name,
						value,
						season: seasonYear,
						tid: primaryTid,
					});
				}
			}
		}

		career[metric.key] = rank(careerRows, decimals);
		season[metric.key] = rank(seasonRows, decimals);
	}

	return { career, season };
};
