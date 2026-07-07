// Basketball-only positional-depth tax: punishes rosters that don't cover the position
// spectrum. Shared by the sim-facing computation (loadTeams.ts -> GameSim.basketball),
// the Roster UI readout (worker/views/roster.ts), and the AI position-awareness fixes in
// freeAgents/getBest.ts and team/checkRosterSizes.ts.
//
// Deliberately narrower than rosterAutoSort's findStarters "F/C" grouping (which also
// counts SF/GF) so a wing-heavy small-ball team still gets dinged on the glass even when
// auto-sort is otherwise satisfied.
export const POSITION_GROUPS = {
	bigs: ["C", "FC", "PF"],
	wings: ["SF", "GF", "F"],
	guards: ["PG", "G", "SG"],
} as const;

export type PositionGroup = keyof typeof POSITION_GROUPS;

export const getPositionGroup = (pos: string): PositionGroup | undefined => {
	for (const group of Object.keys(POSITION_GROUPS) as PositionGroup[]) {
		if ((POSITION_GROUPS[group] as readonly string[]).includes(pos)) {
			return group;
		}
	}

	return undefined;
};

export type PositionGroupCounts = Record<PositionGroup, number>;

// positions should already be ordered best-to-worst (e.g. by rosterOrder), most healthy
// first, since only the top `limit` are counted - a proxy for "who actually plays."
export const countTopPositionGroups = (
	positions: string[],
	limit = 8,
): PositionGroupCounts => {
	const counts: PositionGroupCounts = { bigs: 0, wings: 0, guards: 0 };

	let counted = 0;
	for (const pos of positions) {
		if (counted >= limit) {
			break;
		}

		const group = getPositionGroup(pos);
		if (group) {
			counts[group] += 1;
		}

		counted += 1;
	}

	return counts;
};

export type DepthTax = {
	rebounding: number;
	interiorD: number;
	ballHandling: number;
	oppRim: number;
	overall: number;
};

export const computeDepthTax = (counts: PositionGroupCounts): DepthTax => {
	const depthTax: DepthTax = {
		rebounding: 1,
		interiorD: 1,
		ballHandling: 1,
		oppRim: 1,
		overall: 1,
	};

	const total = counts.bigs + counts.wings + counts.guards;
	if (total === 0) {
		return depthTax;
	}

	// No healthy big man in the rotation - rebounding and interior D take the biggest
	// hit, and whoever you're facing shoots better at the rim against you.
	if (counts.bigs === 0) {
		depthTax.rebounding = 0.85;
		depthTax.interiorD = 0.85;
		depthTax.oppRim = 1.1;
	}

	// No true point/lead guard - ball security suffers.
	if (counts.guards === 0) {
		depthTax.ballHandling = 0.9;
	}

	// Extreme imbalance (6+ of the top 8 in one bucket) - small global penalty.
	if (Math.max(counts.bigs, counts.wings, counts.guards) >= 6) {
		depthTax.overall = 0.97;
	}

	return depthTax;
};
