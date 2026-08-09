// Stat-field normalization for the story export.
//
// This module exists because of a class of bug the first cut of the exporter shipped: it read
// *display* stat names off *storage* records. Several of the numbers a writer most wants
// (win shares, total rebounds) are not columns in the database at all - they're assembled at read
// time by src/common/processPlayerStats.basketball.ts. Reading `row.ws` off a raw stats row yields
// `undefined`, and `undefined ?? 0` yields a number that passes every truthiness check while being
// silently, uniformly wrong.
//
// So: one place that knows how each derived field is actually built, and one convention for
// "not computable" - `null`, never `0`, never a dropped key. Pure, DB-free.

// Fields that are genuinely absent (older real-player seasons predate the box-score detail needed
// to compute them) must survive as null so a consumer can tell "replacement level" from "unknown".
export const num = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

export const round = (value: number | null, places = 1): number | null => {
	if (value === null) {
		return null;
	}
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
};

// Sum that preserves "unknown": if no input had a value, the total is null rather than 0.
export const sumNullable = (values: (number | null)[]): number | null => {
	let total = 0;
	let any = false;
	for (const v of values) {
		if (v !== null) {
			total += v;
			any = true;
		}
	}
	return any ? total : null;
};

export const maxNullable = (values: (number | null)[]): number | null => {
	let best: number | null = null;
	for (const v of values) {
		if (v !== null && (best === null || v > best)) {
			best = v;
		}
	}
	return best;
};

export const ratio = (
	numerator: number | null,
	denominator: number | null,
): number | null => {
	if (numerator === null || denominator === null || denominator === 0) {
		return null;
	}
	return numerator / denominator;
};

// A stats row as it is *stored* (worker/core/player/stats.basketball.ts): raw counting stats plus
// the advanced stats advStats.basketball.ts writes back. Everything is optional because historical
// real-player seasons carry only whatever the source data had.
export type StoredStatFields = {
	orb?: number;
	drb?: number;
	trb?: number;
	ows?: number;
	dws?: number;
	ws?: number;
	obpm?: number;
	dbpm?: number;
	bpm?: number;
};

// Win shares. Never stored; `ws = dws + ows` (processPlayerStats.basketball.ts). A row that has
// neither component is unknown, not zero. `ws` itself is accepted as a fallback so a hand-built or
// externally-sourced row still works.
export const deriveWs = (s: StoredStatFields): number | null => {
	const ows = num(s.ows);
	const dws = num(s.dws);
	if (ows === null && dws === null) {
		return num(s.ws);
	}
	return (ows ?? 0) + (dws ?? 0);
};

// Total rebounds. Modern rows store orb/drb separately and have no trb; the oldest real-player rows
// store a bare trb (and sometimes only drb). Mirrors processPlayerStats.basketball.ts's "trb" case.
export const deriveTrb = (s: StoredStatFields): number | null => {
	const trb = num(s.trb);
	const orb = num(s.orb);
	const drb = num(s.drb);
	if (trb === null && orb === null && drb === null) {
		return null;
	}
	return (trb ?? 0) + (orb ?? 0) + (drb ?? 0);
};

// Box plus/minus: `bpm = dbpm + obpm`, same shape as win shares.
export const deriveBpm = (s: StoredStatFields): number | null => {
	const obpm = num(s.obpm);
	const dbpm = num(s.dbpm);
	if (obpm === null && dbpm === null) {
		return num(s.bpm);
	}
	return (obpm ?? 0) + (dbpm ?? 0);
};

// Possessions estimate, mirroring worker/core/team/processStats.basketball.ts's `poss` (itself from
// basketball-reference's glossary). Duplicated rather than imported so this module stays pure and
// free of the worker's helpers; keep the two in sync if the sim's formula ever changes.
export type TeamStatFieldsForPoss = {
	fg?: number;
	fga?: number;
	fta?: number;
	orb?: number;
	drb?: number;
	tov?: number;
	oppFg?: number;
	oppFga?: number;
	oppFta?: number;
	oppOrb?: number;
	oppDrb?: number;
	oppTov?: number;
};

const safeRatio = (a: number, b: number) => (b === 0 ? 0 : a / b);

export const possessions = (ts: TeamStatFieldsForPoss): number | null => {
	const fga = num(ts.fga);
	const oppFga = num(ts.oppFga);
	// Without both sides' shot volume the estimate is meaningless, so call it unknown.
	if (fga === null || oppFga === null) {
		return null;
	}
	const fg = num(ts.fg) ?? 0;
	const fta = num(ts.fta) ?? 0;
	const orb = num(ts.orb) ?? 0;
	const drb = num(ts.drb) ?? 0;
	const tov = num(ts.tov) ?? 0;
	const oppFg = num(ts.oppFg) ?? 0;
	const oppFta = num(ts.oppFta) ?? 0;
	const oppOrb = num(ts.oppOrb) ?? 0;
	const oppDrb = num(ts.oppDrb) ?? 0;
	const oppTov = num(ts.oppTov) ?? 0;

	return (
		0.5 *
		(fga +
			0.4 * fta -
			1.07 * safeRatio(orb, orb + oppDrb) * (fga - fg) +
			tov +
			(oppFga +
				0.4 * oppFta -
				1.07 * safeRatio(oppOrb, oppOrb + drb) * (oppFga - oppFg) +
				oppTov))
	);
};
