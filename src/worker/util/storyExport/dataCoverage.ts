// Data coverage profiling (AI Story Export; the bug report's Part 3 item 2).
//
// A writer should be able to tell what is trustworthy without profiling 40,000 rows first. Several
// metrics in this bundle are genuinely absent for whole eras - a league whose early history was
// imported rather than simulated has no VORP before the sim started computing it - and the honest
// answer is "unknown", not 0. This module measures, per metric, the first and last season with a
// value and what share of eligible rows carry one, and lists both the fields that are null
// everywhere and the things ZenGM does not model at all.
//
// Pure, DB-free.

import type {
	DataCoverage,
	MetricCoverage,
	ProjectedPlayer,
	ProjectedStatLine,
	ProjectedTeam,
} from "./types.ts";

// Documented meanings for the magic numbers that survive into the bundle because they *are* the
// data. v1 shipped these bare, and any expected-value-by-pick math divided by them.
export const SENTINELS: DataCoverage["sentinels"] = [
	{
		field: "teams[].seasons[].playoffRoundsWon",
		value: "-1",
		meaning:
			"Missed the playoffs. 0 means made them and lost in the first round. `madePlayoffs` says the same thing as a boolean.",
	},
	{
		field: "players[].draft",
		value: "round 0, pick 0, originalTid null",
		meaning:
			"Undrafted. Flagged explicitly as `draft.undrafted`; these players are excluded from the per-slot expected-value curve behind rankings.busts/steals.",
	},
	{
		field: "players[].stats[].tid",
		value: "-1 / -2 / -3",
		meaning:
			"Not a real franchise: free agent (-1), undrafted/unsigned (-2), retired (-3). Such rows are excluded from teamsPlayedFor.",
	},
];

// Things no amount of exporting will produce, because the simulation never computes them. Stated
// explicitly so a prompt doesn't ask for them and a writer doesn't assume they were dropped.
export const UNAVAILABLE: DataCoverage["unavailable"] = [
	{
		field: "award vote shares / runners-up",
		reason:
			"ZenGM awards have no voting - a winner is selected deterministically. The closest thing to a runner-up field is the All-League / All-Defensive / All-Rookie teams in awards.json, which are exported in full.",
	},
	{
		field: "coaches",
		reason: "ZenGM does not model coaches as entities.",
	},
	{
		field: "arena names",
		reason:
			"Teams have a region, a name and a stadium capacity, but no arena name. Relocations and rebrands are exported as teams[].relocations.",
	},
];

const measure = (
	rows: { season: number; value: number | null }[],
	note: string | null = null,
): MetricCoverage => {
	let earliestSeason: number | null = null;
	let latestSeason: number | null = null;
	let rowsWithValue = 0;

	for (const row of rows) {
		if (row.value === null) {
			continue;
		}
		rowsWithValue += 1;
		if (earliestSeason === null || row.season < earliestSeason) {
			earliestSeason = row.season;
		}
		if (latestSeason === null || row.season > latestSeason) {
			latestSeason = row.season;
		}
	}

	return {
		earliestSeason,
		latestSeason,
		coverage:
			rows.length === 0
				? 0
				: Math.round((rowsWithValue / rows.length) * 1000) / 1000,
		rowsWithValue,
		rowsTotal: rows.length,
		note,
	};
};

const PLAYER_METRICS: {
	key: keyof ProjectedStatLine;
	note?: string;
}[] = [
	{ key: "pts" },
	{
		key: "trb",
		note: "Derived: trb + orb + drb. Modern rows store orb/drb only.",
	},
	{ key: "ast" },
	{ key: "stl" },
	{ key: "blk" },
	{ key: "tov" },
	{ key: "fga" },
	{ key: "tpa" },
	{
		key: "fgaAtRim",
		note: "Shot-location splits are recorded by the sim; imported historical seasons have none.",
	},
	{ key: "per" },
	{ key: "ws", note: "Derived: ows + dws. There is no stored `ws` column." },
	{ key: "vorp" },
	{ key: "ewa" },
	{ key: "usgp" },
];

export const buildDataCoverage = (
	players: ProjectedPlayer[],
	teams: ProjectedTeam[],
): DataCoverage => {
	const metrics: Record<string, MetricCoverage> = {};

	const statRows: ProjectedStatLine[] = [];
	for (const p of players) {
		for (const s of p.stats) {
			statRows.push(s);
		}
	}

	for (const { key, note } of PLAYER_METRICS) {
		metrics[`players.stats.${key}`] = measure(
			statRows.map((s) => ({
				season: s.season,
				value: (s[key] as number | null) ?? null,
			})),
			note ?? null,
		);
	}

	const teamSeasonRows = teams.flatMap((t) => t.seasons);
	const teamMetrics: {
		key:
			| "pointDiffPerGame"
			| "ptsPerGame"
			| "pace"
			| "ortg"
			| "drtg"
			| "avgAge";
		note?: string;
	}[] = [
		{
			key: "pointDiffPerGame",
			note: "From team stat rows where they exist, otherwise summed from the game index. Seasons with neither are null.",
		},
		{ key: "ptsPerGame" },
		{
			key: "pace",
			note: "Needs full team shooting/rebounding splits, so team-stat rows only.",
		},
		{ key: "ortg" },
		{ key: "drtg" },
		{ key: "avgAge" },
	];
	for (const { key, note } of teamMetrics) {
		metrics[`teams.seasons.${key}`] = measure(
			teamSeasonRows.map((s) => ({ season: s.season, value: s[key] })),
			note ?? null,
		);
	}

	metrics["players.ratings.skills"] = measure(
		players.flatMap((p) =>
			p.ratings.map((r) => ({
				season: r.season,
				value: r.skills.length > 0 ? 1 : null,
			})),
		),
		"ZenGM skill labels: 3 (shooter), A (athlete), B (ball handler), Di (interior defender), Dp (perimeter defender), Po (post scorer), Ps (passer), R (rebounder).",
	);

	const knownNullFields = Object.entries(metrics)
		.filter(([, m]) => m.rowsTotal > 0 && m.rowsWithValue === 0)
		.map(([key]) => key);

	return {
		metrics,
		knownNullFields,
		unavailable: UNAVAILABLE,
		sentinels: SENTINELS,
	};
};
