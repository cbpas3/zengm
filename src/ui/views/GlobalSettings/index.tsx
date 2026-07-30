import { useState, type ChangeEvent, type SubmitEvent } from "react";
import useTitleBar from "../../hooks/useTitleBar.tsx";
import { helpers } from "../../util/helpers.ts";
import { logEvent } from "../../util/logEvent.ts";
import { toWorker } from "../../util/toWorker.ts";
import RealData from "./RealData.tsx";
import Storage from "./Storage.tsx";
import type { View } from "../../../common/types.ts";
import {
	DEFAULT_PHASE_CHANGE_REDIRECTS,
	PHASE,
	PHASE_TEXT,
} from "../../../common/constants.ts";
import { MoreLinks } from "../../components/MoreLinks.tsx";
import { useBlocker } from "../../hooks/useBlocker.ts";
import { HelpPopover } from "../../components/HelpPopover.tsx";
import { safeLocalStorage } from "../../util/safeLocalStorage.ts";
import { isSport } from "../../../common/sportFunctions.ts";

const GlobalSettings = (props: View<"globalSettings">) => {
	const [state, setState] = useState(() => {
		const themeLocalStorage = safeLocalStorage.getItem("theme");
		let theme: "dark" | "light" | "default";
		if (themeLocalStorage === "dark") {
			theme = "dark";
		} else if (themeLocalStorage === "light") {
			theme = "light";
		} else {
			theme = "default";
		}

		let units: "metric" | "us" | "default";
		if (props.units === "metric") {
			units = "metric";
		} else if (props.units === "us") {
			units = "us";
		} else {
			units = "default";
		}

		const fullNames = props.fullNames ? "always" : ("abbrev-small" as const);

		// A device preference stored in localStorage, like theme - not a league/account option
		const fontScale = window.getFontScale();

		return {
			fontScale,
			fullNames,
			openRouterApiKey: props.openRouterApiKey ?? "",
			phaseChangeRedirects: props.phaseChangeRedirects,
			realPlayerPhotos: props.realPlayerPhotos,
			realTeamInfo: props.realTeamInfo,
			theme,
			units,
		};
	});

	const { setDirty } = useBlocker();

	const handleChange =
		(name: string) =>
		(event: ChangeEvent<HTMLSelectElement | HTMLTextAreaElement>) => {
			const value = event.target.value;
			setState((state2) => ({
				...state2,
				[name]: value,
			}));
			setDirty(true);
		};

	const handleFormSubmit = async (event: SubmitEvent) => {
		event.preventDefault();

		if (state.theme === "default") {
			safeLocalStorage.removeItem("theme");
		} else {
			safeLocalStorage.setItem("theme", state.theme);
		}
		if (window.themeCSSLink) {
			window.themeCSSLink.href = window.getThemeFilename(window.getTheme());
		}

		if (state.fontScale === "default") {
			safeLocalStorage.removeItem("fontScale");
		} else {
			safeLocalStorage.setItem("fontScale", state.fontScale);
		}
		// Apply immediately - a text-size change the user can't see until they reload is useless
		window.applyFontScale(state.fontScale);

		const units = state.units === "default" ? undefined : state.units;
		try {
			await toWorker("main", "updateOptions", {
				fullNames: state.fullNames === "always",
				openRouterApiKey: state.openRouterApiKey || undefined,
				phaseChangeRedirects: state.phaseChangeRedirects,
				realPlayerPhotos: state.realPlayerPhotos,
				realTeamInfo: state.realTeamInfo,
				units,
			});
			logEvent({
				type: "success",
				text: "Settings successfully updated.",
				saveToDb: false,
			});
			setDirty(false);
		} catch (error) {
			logEvent({
				type: "error",
				text: error.message,
				saveToDb: false,
				persistent: true,
			});
		}
	};

	useTitleBar({ title: "Global Settings" });

	const phaseChangeRedirects = DEFAULT_PHASE_CHANGE_REDIRECTS.map((phase) => {
		let label;
		if (phase === PHASE.REGULAR_SEASON) {
			label = "Season preview, before regular season";
		} else if (phase === PHASE.DRAFT_LOTTERY) {
			label = "Season summary, after playoffs";
		} else {
			label = helpers.upperCaseFirstLetter(PHASE_TEXT[phase]);
		}

		return {
			phase,
			label,
			checked: state.phaseChangeRedirects.includes(phase),
		};
	});

	return (
		<>
			<MoreLinks type="globalSettings" page="/settings" />

			<form onSubmit={handleFormSubmit}>
				<div className="row">
					<div className="col-sm-3 col-6 mb-3">
						<label className="form-label" htmlFor="options-font-scale">
							Text Size
						</label>
						<select
							id="options-font-scale"
							className="form-select"
							onChange={handleChange("fontScale")}
							value={state.fontScale}
						>
							{/* Plain-language labels with the actual sizes, since "112.5%" means
							    nothing to the person who needs this setting */}
							<option value="compact">Standard (16px)</option>
							<option value="default">Large (18px) — recommended</option>
							<option value="large">Larger (21px)</option>
							<option value="xlarge">Largest (24px)</option>
						</select>
					</div>
					<div className="col-sm-3 col-6 mb-3">
						<label className="form-label" htmlFor="options-color-scheme">
							Color Scheme
						</label>
						<select
							id="options-color-scheme"
							className="form-select"
							onChange={handleChange("theme")}
							value={state.theme}
						>
							<option value="default">Auto</option>
							<option value="light">Light</option>
							<option value="dark">Dark</option>
						</select>
					</div>
					<div className="col-sm-3 col-6 mb-3">
						<label className="form-label" htmlFor="options-units">
							Units
						</label>
						<select
							id="options-units"
							className="form-select"
							onChange={handleChange("units")}
							value={state.units}
						>
							<option value="default">Auto</option>
							<option value="us">US</option>
							<option value="metric">Metric</option>
						</select>
					</div>
					<div className="col-sm-3 col-6 mb-3">
						<label className="form-label" htmlFor="options-fullNames">
							Player Name Display
						</label>
						<select
							id="options-fullNames"
							className="form-select"
							onChange={handleChange("fullNames")}
							value={state.fullNames}
						>
							<option value="abbrev-small">
								Abbreviate first names and skills on small screens
							</option>
							<option value="always">Always show full names and skills</option>
						</select>
					</div>
					<div className="col-sm-3 col-6 mb-3">
						<label className="form-label">
							Auto UI Redirect{" "}
							<HelpPopover title="Auto UI Redirect">
								<p>
									At different points in the game, the UI automatically
									redirects to a page. For example, when the regular season
									ends, it automatically redirects to the playoff bracket. If
									you find that behavior annoying, you can disable it here.
								</p>
							</HelpPopover>
						</label>
						{phaseChangeRedirects.map(({ checked, label, phase }) => (
							<div key={phase} className="form-check">
								<input
									className="form-check-input"
									type="checkbox"
									id={`options-phaseChangeRedirects-${phase}`}
									checked={checked}
									onChange={() => {
										let phaseChangeRedirects;
										if (checked) {
											phaseChangeRedirects = state.phaseChangeRedirects.filter(
												(phase2) => phase2 !== phase,
											);
										} else {
											phaseChangeRedirects = [
												...state.phaseChangeRedirects,
												phase,
											];
										}

										setState({
											...state,
											phaseChangeRedirects,
										});
									}}
								/>
								<label
									className="form-check-label"
									htmlFor={`options-phaseChangeRedirects-${phase}`}
								>
									{label}
								</label>
							</div>
						))}
						<div className="mt-1">
							<button
								className="btn btn-link p-0"
								type="button"
								onClick={() => {
									setState({
										...state,
										phaseChangeRedirects: DEFAULT_PHASE_CHANGE_REDIRECTS,
									});
								}}
							>
								All
							</button>{" "}
							|{" "}
							<button
								className="btn btn-link p-0"
								type="button"
								onClick={() => {
									setState({
										...state,
										phaseChangeRedirects: [],
									});
								}}
							>
								None
							</button>
						</div>
					</div>
					<div className="col-sm-3 col-6 mb-3">
						<label className="form-label">Persistent Storage</label>
						<Storage />
					</div>
				</div>

				{isSport("basketball") ? (
					<>
						<h2>AI Trade Realism</h2>
						<div className="row mb-3">
							<div className="col-sm-6">
								<label
									className="form-label"
									htmlFor="options-openrouter-api-key"
								>
									OpenRouter API Key{" "}
									<HelpPopover title="AI Trade Realism">
										<p>
											When set, trade proposals are evaluated by an AI model
											(via OpenRouter) before being accepted. Trades that
											wouldn't happen in real life (wrong player reputation, bad
											team fit, etc.) are rejected with a reason. Only affects
											notable trades (players rated 70+ OVR).
										</p>
										<p>
											Get a free key at{" "}
											<a
												href="https://openrouter.ai/settings/keys"
												rel="noopener noreferrer"
												target="_blank"
											>
												OpenRouter
											</a>
											. The free tier is limited to 50 requests/day and
											20/minute — shared across trade evaluation, trade offers,
											game recaps, and season stories. Adding $10 in credits
											raises the daily cap to 1,000.
										</p>
									</HelpPopover>
								</label>
								<input
									type="password"
									id="options-openrouter-api-key"
									className="form-control"
									placeholder="sk-or-v1-..."
									value={state.openRouterApiKey}
									onChange={handleChange("openRouterApiKey") as any}
								/>
							</div>
						</div>

						<h2>Team and Player Data for "Real Players" Leagues</h2>
						<RealData
							handleChange={handleChange}
							realPlayerPhotos={state.realPlayerPhotos}
							realTeamInfo={state.realTeamInfo}
						/>
					</>
				) : null}

				<button className="btn btn-primary mt-3">Save global settings</button>
			</form>
		</>
	);
};

export default GlobalSettings;
