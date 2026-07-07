const ChemistryMeter = ({ chemistry }: { chemistry?: number }) => {
	if (chemistry === undefined) {
		return null;
	}

	const rounded = Math.round(chemistry);

	let label: string;
	let barClassName: string;
	if (chemistry >= 65) {
		label = "Gelling";
		barClassName = "progress-bar bg-success";
	} else if (chemistry <= 35) {
		label = "Discord";
		barClassName = "progress-bar bg-danger";
	} else {
		label = "Neutral";
		barClassName = "progress-bar bg-secondary";
	}

	return (
		<div style={{ maxWidth: 200 }}>
			<div
				className="d-flex justify-content-between"
				title="Rewards roster continuity and recent winning; penalizes stacking high-usage stars or churning the roster"
			>
				<span>Chemistry</span>
				<span>
					{rounded}/100 ({label})
				</span>
			</div>
			<div className="progress" style={{ height: 6 }}>
				<div className={barClassName} style={{ width: `${rounded}%` }} />
			</div>
		</div>
	);
};

export default ChemistryMeter;
