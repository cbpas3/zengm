import { useState } from "react";
import { toWorker } from "../../util/toWorker.ts";
import { ActionButton } from "../../components/ActionButton.tsx";

const SeasonStory = ({ tid, season }: { tid: number; season: number }) => {
	const [state, setState] = useState<{
		requested: boolean;
		generating: boolean;
		article: string | null;
		usedFallback: boolean;
	}>({
		requested: false,
		generating: false,
		article: null,
		usedFallback: false,
	});

	const handleClick = async () => {
		setState((prevState) => ({ ...prevState, generating: true }));

		const result = await toWorker("main", "generateSeasonStory", {
			tid,
			season,
		});

		setState({
			requested: true,
			generating: false,
			article: result.article,
			usedFallback: result.usedFallback,
		});
	};

	const paragraphs = state.article
		? state.article
				.split(/\n\s*\n/)
				.filter((paragraph) => paragraph.trim() !== "")
		: [];

	return (
		<div className="mt-1 mb-2">
			<ActionButton
				processing={state.generating}
				onClick={handleClick}
				variant="secondary"
				processingText="Writing"
			>
				{state.article ? "Regenerate season story" : "Generate season story"}
			</ActionButton>

			{state.requested && state.usedFallback ? (
				<div className="alert alert-warning mt-2 d-inline-block ms-2">
					AI season story unavailable — set a Gemini API key on the{" "}
					<a href="/settings">Global Settings</a> page, or try again.
				</div>
			) : null}

			{paragraphs.length > 0 ? (
				<div className="mt-3" style={{ maxWidth: 800 }}>
					{paragraphs.map((paragraph, i) => (
						<p key={i}>{paragraph.replace(/\s*\n\s*/g, " ")}</p>
					))}
				</div>
			) : null}
		</div>
	);
};

export default SeasonStory;
