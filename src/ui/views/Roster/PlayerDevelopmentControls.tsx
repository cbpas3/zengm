import { toWorker } from "../../util/toWorker.ts";
import type { View } from "../../../common/types.ts";
import type { DevFocusType } from "../../../common/types.ts";

type Player = View<"roster">["players"][number];

const DEV_FOCUS_OPTIONS: { value: DevFocusType; label: string }[] = [
	{ value: "scoring", label: "Scoring" },
	{ value: "defense", label: "Defense" },
	{ value: "athleticism", label: "Athleticism" },
	{ value: "playmaking", label: "Playmaking" },
];

const PlayerDevelopmentControls = ({
	p,
	players,
}: {
	p: Player;
	players: Player[];
}) => {
	const availableMentors = players
		.filter((m) => m.pid !== p.pid && m.stats.age >= 28)
		.sort((a, b) => b.ratings.ovr - a.ratings.ovr);

	const currentMentor =
		p.mentorPid !== undefined
			? players.find((m) => m.pid === p.mentorPid)
			: undefined;

	const mentorOnTeam =
		currentMentor !== undefined && currentMentor.tid === p.tid;

	return (
		<div className="d-flex flex-column gap-1" style={{ minWidth: 130 }}>
			<label
				className="d-flex align-items-center gap-1 mb-0"
				style={{ fontSize: "0.8rem", cursor: "pointer" }}
			>
				<input
					type="checkbox"
					checked={!!p.devOverride}
					onChange={async (e) => {
						await toWorker("main", "updatePlayerDevelopment", {
							pid: p.pid,
							devOverride: e.target.checked,
						});
					}}
				/>
				Free Dev
			</label>

			<select
				className="form-select form-select-sm"
				value={p.devFocus ?? ""}
				onChange={async (e) => {
					await toWorker("main", "updatePlayerDevelopment", {
						pid: p.pid,
						devFocus: (e.target.value as DevFocusType) || null,
					});
				}}
				title="Development focus"
			>
				<option value="">Focus: None</option>
				{DEV_FOCUS_OPTIONS.map(({ value, label }) => (
					<option key={value} value={value}>
						{label}
					</option>
				))}
			</select>

			{p.stats.age <= 23 ? (
				<select
					className="form-select form-select-sm"
					value={p.mentorPid ?? ""}
					onChange={async (e) => {
						const val = e.target.value;
						await toWorker("main", "updatePlayerDevelopment", {
							pid: p.pid,
							mentorPid: val ? Number(val) : null,
						});
					}}
					title="Mentor"
				>
					<option value="">Mentor: None</option>
					{currentMentor && !mentorOnTeam ? (
						<option
							value={currentMentor.pid}
							disabled
							style={{ color: "#999" }}
						>
							{currentMentor.firstName} {currentMentor.lastName} (away)
						</option>
					) : null}
					{availableMentors.map((m) => (
						<option key={m.pid} value={m.pid}>
							{m.firstName} {m.lastName} ({m.ratings.ovr})
						</option>
					))}
				</select>
			) : null}
		</div>
	);
};

export default PlayerDevelopmentControls;
