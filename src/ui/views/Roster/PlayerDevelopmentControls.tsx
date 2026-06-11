import { toWorker } from "../../util/toWorker.ts";
import type { View } from "../../../common/types.ts";
import type { DevFocusType } from "../../../common/types.ts";

type Player = View<"roster">["players"][number];

const DEV_FOCUS_OPTIONS: { value: DevFocusType; label: string }[] = [
	{ value: "sharpshooter", label: "Sharpshooter" },
	{ value: "slasher", label: "Slasher" },
	{ value: "postScorer", label: "Post Scorer" },
	{ value: "playmaker", label: "Playmaker" },
	{ value: "threeAndD", label: "3-and-D" },
	{ value: "lockdown", label: "Lockdown" },
	{ value: "athletic", label: "Athletic" },
	{ value: "floorGeneral", label: "Floor General" },
];

const WORK_ETHIC_STYLE: Record<
	string,
	{ bg: string; text: string; label: string }
> = {
	elite: { bg: "#198754", text: "#fff", label: "Elite Work Ethic" },
	high: { bg: "#0d6efd", text: "#fff", label: "High Work Ethic" },
	average: { bg: "#6c757d", text: "#fff", label: "Avg Work Ethic" },
	low: { bg: "#dc3545", text: "#fff", label: "Low Work Ethic" },
};

const DEV_PROFILE_STYLE: Record<
	string,
	{ bg: string; text: string; label: string }
> = {
	earlyBloom: { bg: "#fd7e14", text: "#fff", label: "Early Bloom" },
	lateBloom: { bg: "#6610f2", text: "#fff", label: "Late Bloom" },
	consistent: { bg: "#20c997", text: "#fff", label: "Consistent" },
	physical: { bg: "#0dcaf0", text: "#000", label: "Physical" },
	standard: { bg: "#adb5bd", text: "#000", label: "Standard" },
};

const PlayerDevelopmentControls = ({
	p,
	players,
}: {
	p: Player;
	players: Player[];
}) => {
	const availableMentors = players
		.filter((m) => m.pid !== p.pid && m.age >= 28)
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
					const val = e.target.value;
					await toWorker("main", "updatePlayerDevelopment", {
						pid: p.pid,
						devFocus: val === "" ? null : (val as DevFocusType),
					});
				}}
				title="Development focus"
			>
				<option value="">Archetype: None</option>
				{DEV_FOCUS_OPTIONS.map(({ value, label }) => (
					<option key={value} value={value}>
						{label}
					</option>
				))}
			</select>

			{p.age <= 23 ? (
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

			{(() => {
				const ethic = (p as any).workEthic ?? "average";
				const s = WORK_ETHIC_STYLE[ethic];
				return (
					<span
						style={{
							fontSize: "0.7rem",
							padding: "1px 6px",
							borderRadius: 4,
							background: s.bg,
							color: s.text,
							alignSelf: "flex-start",
						}}
					>
						{s.label}
					</span>
				);
			})()}
			{(() => {
				const profile = (p as any).devProfile ?? "standard";
				const s = DEV_PROFILE_STYLE[profile];
				return (
					<span
						style={{
							fontSize: "0.7rem",
							padding: "1px 6px",
							borderRadius: 4,
							background: s.bg,
							color: s.text,
							alignSelf: "flex-start",
						}}
					>
						{s.label}
					</span>
				);
			})()}
		</div>
	);
};

export default PlayerDevelopmentControls;
