import { useState } from "react";
import CollapseArrow from "../../components/CollapseArrow.tsx";
import { AnimatePresence, m } from "framer-motion";
import { toWorker } from "../../util/toWorker.ts";

type GamePlan = {
	pace: number;
	threePointRate: number;
	postPlay: number;
	rimAttack: number;
	ballMovement: number;
};

const DEFAULT_GAME_PLAN: GamePlan = {
	pace: 50,
	threePointRate: 50,
	postPlay: 50,
	rimAttack: 50,
	ballMovement: 50,
};

const SLIDER_CONFIG: {
	key: keyof GamePlan;
	label: string;
	minLabel: string;
	maxLabel: string;
}[] = [
	{
		key: "pace",
		label: "Pace",
		minLabel: "Grind it out",
		maxLabel: "Run-and-gun",
	},
	{
		key: "threePointRate",
		label: "3PT Emphasis",
		minLabel: "No 3s",
		maxLabel: "Live by the 3",
	},
	{
		key: "rimAttack",
		label: "Attack the Rim",
		minLabel: "Settle for jumpers",
		maxLabel: "Always drive",
	},
	{
		key: "postPlay",
		label: "Post Play",
		minLabel: "No post-ups",
		maxLabel: "Post-centric",
	},
	{
		key: "ballMovement",
		label: "Ball Movement",
		minLabel: "ISO / star ball",
		maxLabel: "Distribute evenly",
	},
];

const GamePlanSlider = ({
	config,
	value,
	onChange,
}: {
	config: (typeof SLIDER_CONFIG)[number];
	value: number;
	onChange: (key: keyof GamePlan, value: number) => void;
}) => {
	const id = `game-plan-${config.key}`;

	return (
		<div className="mb-3">
			<label className="form-label mb-0 fw-semibold" htmlFor={id}>
				{config.label}
			</label>
			<input
				type="range"
				className="form-range"
				id={id}
				value={value}
				min="0"
				max="100"
				step="5"
				onChange={async (event) => {
					const parsed = Number.parseInt(event.target.value);
					if (!Number.isNaN(parsed)) {
						onChange(config.key, parsed);
					}
				}}
			/>
			<div
				className="d-flex justify-content-between text-body-secondary"
				style={{ fontSize: "0.75rem", marginTop: -4 }}
			>
				<span>{config.minLabel}</span>
				<span className="fw-bold">{value}</span>
				<span>{config.maxLabel}</span>
			</div>
		</div>
	);
};

const GamePlanEditor = ({
	t,
}: {
	t: {
		tid: number;
		gamePlan?: GamePlan;
	};
}) => {
	const [expanded, setExpanded] = useState(!window.mobile);
	const [gamePlan, setGamePlan] = useState<GamePlan>(
		t.gamePlan ?? DEFAULT_GAME_PLAN,
	);

	const handleChange = async (key: keyof GamePlan, value: number) => {
		const updated = { ...gamePlan, [key]: value };
		setGamePlan(updated);
		await toWorker("main", "updateGamePlan", { tid: t.tid, gamePlan: updated });
	};

	return (
		<div className="game-plan-editor">
			<div className="d-flex align-items-center">
				{window.mobile ? (
					<button
						className="btn btn-link p-0 fw-bold"
						type="button"
						onClick={() => setExpanded((prev) => !prev)}
					>
						<CollapseArrow open={expanded} /> Game Plan
					</button>
				) : (
					<b>Game Plan</b>
				)}
			</div>
			<AnimatePresence initial={false}>
				{expanded ? (
					<m.div
						className="mt-2"
						initial="collapsed"
						animate="open"
						exit="collapsed"
						variants={{
							open: { opacity: 1, height: "auto" },
							collapsed: { opacity: 0, height: 0 },
						}}
						transition={{ duration: 0.3, type: "tween" }}
					>
						{SLIDER_CONFIG.map((config) => (
							<GamePlanSlider
								key={config.key}
								config={config}
								value={gamePlan[config.key]}
								onChange={handleChange}
							/>
						))}
					</m.div>
				) : null}
			</AnimatePresence>
		</div>
	);
};

export default GamePlanEditor;
