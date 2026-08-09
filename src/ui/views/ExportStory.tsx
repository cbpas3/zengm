import { type SubmitEvent, useCallback, useState } from "react";
import useTitleBar from "../hooks/useTitleBar.tsx";
import { toWorker } from "../util/toWorker.ts";
import { ActionButton } from "../components/ActionButton.tsx";
import { downloadFile } from "../util/downloadFile.ts";

const ExportStory = () => {
	const [status, setStatus] = useState<string | undefined>();
	const [includeFullGames, setIncludeFullGames] = useState(false);

	const handleSubmit = useCallback(
		async (event: SubmitEvent) => {
			event.preventDefault();
			setStatus("Exporting...");

			try {
				const { virtualFs, filename } = await toWorker(
					"main",
					"generateStoryExport",
					{ includeFullGames },
				);
				// Encode to bytes ourselves rather than handing downloadFile a string: its string path
				// prepends a UTF-8 BOM (deliberately, so CSV exports open correctly in Excel), and a
				// BOM makes this file fail `json.load()` on the consumer's very first tool call.
				downloadFile(
					filename,
					[new TextEncoder().encode(JSON.stringify(virtualFs))],
					"application/json",
				);
				setStatus(undefined);
			} catch (error) {
				setStatus(`Error: ${(error as Error).message}`);
			}
		},
		[includeFullGames],
	);

	useTitleBar({ title: "AI Story Export" });

	return (
		<>
			<p>
				Export your league as a rich, interconnected knowledge base designed to
				be handed to a strong external AI model (or a swarm of agents) that
				writes the stories for you — greatest-players lists, franchise
				histories, rivalries, season retrospectives, game recaps, and more.
				Unlike the on-device recap/season-story features, this puts a frontier
				model behind the writing.
			</p>
			<p>
				The download is a single JSON file: normalized, ID-linked tables
				(players, teams, rankings, dynasties, rivalries, a game index) plus a{" "}
				<code>README.md</code>, a <code>canon-workflow.md</code> prompt library,
				and a <code>pull_games.py</code> helper — all embedded. Open the
				workflow doc first; write the foundational pieces (greatest
				players/teams/busts/ rivalries) before the dependent ones so the whole
				corpus stays consistent.
			</p>

			<form onSubmit={handleSubmit}>
				<div className="form-check mb-3">
					<input
						className="form-check-input"
						type="checkbox"
						id="story-full-games"
						checked={includeFullGames}
						onChange={() => {
							setIncludeFullGames((v) => !v);
							setStatus(undefined);
						}}
					/>
					<label className="form-check-label" htmlFor="story-full-games">
						Include full game detail (every game's box scores). Much larger file
						— off by default. Standout ("notable") games are always included;
						the game index + <code>pull_games.py</code> can fetch any others on
						demand.
					</label>
				</div>

				<ActionButton type="submit" processing={status === "Exporting..."}>
					Export Story Data
				</ActionButton>
			</form>

			{status && status !== "Exporting..." ? (
				<p
					className={`mt-3${status.startsWith("Error:") ? " text-danger" : ""}`}
				>
					{status}
				</p>
			) : null}
		</>
	);
};

export default ExportStory;
