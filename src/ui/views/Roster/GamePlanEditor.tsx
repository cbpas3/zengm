import { useState } from "react";
import CollapseArrow from "../../components/CollapseArrow.tsx";
import { AnimatePresence, m } from "framer-motion";
import { toWorker } from "../../util/toWorker.ts";

type GamePlan = {
	// Offense
	pace: number;
	threePointRate: number;
	postPlay: number;
	rimAttack: number;
	ballMovement: number;
	transition: number;
	crashOffensiveGlass: number;

	// Defense
	pickCoverage: number;
	perimeterPressure: number;
	helpAggression: number;
	defensiveGlass: number;
};

const DEFAULT_GAME_PLAN: GamePlan = {
	pace: 50,
	threePointRate: 50,
	postPlay: 50,
	rimAttack: 50,
	ballMovement: 50,
	transition: 50,
	crashOffensiveGlass: 50,
	pickCoverage: 50,
	perimeterPressure: 50,
	helpAggression: 50,
	defensiveGlass: 50,
};

// Matches src/worker/core/team/gamePlanExecution.ts
type GamePlanExecutionLabel = "Poor" | "Average" | "Elite";
type GamePlanExecution = {
	rebounding: GamePlanExecutionLabel;
	defense: GamePlanExecutionLabel;
	defensePerimeter: GamePlanExecutionLabel;
	blocking: GamePlanExecutionLabel;
	pace: GamePlanExecutionLabel;
};

type SliderConfig = {
	key: keyof GamePlan;
	label: string;
	minLabel: string;
	maxLabel: string;
	// Which execution-quality composite this dial's benefit is actually gated by (F-A/F-E in
	// GAME_PLAN_REBALANCE_PLAN.md) - shown as a small chip so a dial silently executing at the
	// eq() floor doesn't just feel broken (F-J).
	executionKey?: keyof GamePlanExecution;
};

const OFFENSE_SLIDER_CONFIG: SliderConfig[] = [
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
	{
		key: "transition",
		label: "Transition",
		minLabel: "Walk it up",
		maxLabel: "Push every miss/make",
		executionKey: "pace",
	},
	{
		key: "crashOffensiveGlass",
		label: "Crash Offensive Glass",
		minLabel: "Get back on D",
		maxLabel: "Send bodies to the boards",
		executionKey: "rebounding",
	},
];

const DEFENSE_SLIDER_CONFIG: SliderConfig[] = [
	{
		key: "pickCoverage",
		label: "Pick Coverage",
		minLabel: "Drop coverage",
		maxLabel: "Switch everything",
		executionKey: "defensePerimeter",
	},
	{
		key: "perimeterPressure",
		label: "Perimeter Pressure",
		minLabel: "Sag off",
		maxLabel: "Pressure the ball",
		executionKey: "defensePerimeter",
	},
	{
		key: "helpAggression",
		label: "Help Aggression",
		minLabel: "Stay home on shooters",
		maxLabel: "Collapse on drives",
		executionKey: "defense",
	},
	{
		key: "defensiveGlass",
		label: "Defensive Glass",
		minLabel: "Leak out for offense",
		maxLabel: "Crash defensive boards",
		executionKey: "rebounding",
	},
];

const EXECUTION_BADGE_CLASS: Record<GamePlanExecutionLabel, string> = {
	Elite: "badge rounded-pill text-bg-success",
	Average: "badge rounded-pill text-bg-secondary",
	Poor: "badge rounded-pill text-bg-danger",
};

const GamePlanSlider = ({
	config,
	value,
	execution,
	onChange,
}: {
	config: SliderConfig;
	value: number;
	execution?: GamePlanExecution;
	onChange: (key: keyof GamePlan, value: number) => void;
}) => {
	const id = `game-plan-${config.key}`;
	const executionLabel = config.executionKey
		? execution?.[config.executionKey]
		: undefined;

	return (
		<div className="mb-3">
			<label className="form-label mb-0 fw-semibold" htmlFor={id}>
				{config.label}
			</label>
			{executionLabel ? (
				<span
					className={`${EXECUTION_BADGE_CLASS[executionLabel]} ms-2`}
					style={{ fontSize: "var(--zen-fs-xs)" }}
					title="How well your current roster can actually execute this dial"
				>
					{executionLabel} execution
				</span>
			) : null}
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
				style={{ fontSize: "var(--zen-fs-sm)" }}
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
		gamePlanExecution?: GamePlanExecution;
	};
}) => {
	const [expanded, setExpanded] = useState(!window.mobile);
	const [gamePlan, setGamePlan] = useState<GamePlan>({
		...DEFAULT_GAME_PLAN,
		...t.gamePlan,
	});

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
						<div
							className="text-body-secondary text-uppercase fw-bold mb-1"
							style={{ fontSize: "var(--zen-fs-sm)" }}
						>
							Offense
						</div>
						{OFFENSE_SLIDER_CONFIG.map((config) => (
							<GamePlanSlider
								key={config.key}
								config={config}
								value={gamePlan[config.key]}
								execution={t.gamePlanExecution}
								onChange={handleChange}
							/>
						))}
						<div
							className="text-body-secondary text-uppercase fw-bold mb-1"
							style={{ fontSize: "var(--zen-fs-sm)" }}
						>
							Defense
						</div>
						{DEFENSE_SLIDER_CONFIG.map((config) => (
							<GamePlanSlider
								key={config.key}
								config={config}
								value={gamePlan[config.key]}
								execution={t.gamePlanExecution}
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
