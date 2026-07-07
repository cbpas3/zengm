type RosterBalanceCounts = {
	bigs: number;
	wings: number;
	guards: number;
};

const RosterBalance = ({
	rosterBalance,
}: {
	rosterBalance?: RosterBalanceCounts;
}) => {
	if (!rosterBalance) {
		return null;
	}

	const warnings: string[] = [];

	if (rosterBalance.bigs === 0) {
		warnings.push(
			"No true big man (C/PF/FC) in your rotation — rebounding and interior defense are reduced, and opponents finish better at the rim against you.",
		);
	}

	if (rosterBalance.guards === 0) {
		warnings.push(
			"No true guard (PG/G/SG) in your rotation — ball security is reduced.",
		);
	}

	if (
		Math.max(rosterBalance.bigs, rosterBalance.wings, rosterBalance.guards) >= 6
	) {
		warnings.push(
			"Your rotation is heavily concentrated at one position group — overall ratings take a small hit.",
		);
	}

	if (warnings.length === 0) {
		return null;
	}

	return (
		<div className="alert alert-warning p-2 mb-0" style={{ maxWidth: 400 }}>
			<b>Roster Balance</b>
			<ul className="mb-0 ps-3">
				{warnings.map((warning) => (
					<li key={warning}>{warning}</li>
				))}
			</ul>
		</div>
	);
};

export default RosterBalance;
