import { idb } from "../db/index.ts";
import { g } from "./index.ts";
import getGlobalSettings from "./getGlobalSettings.ts";
import isUntradable from "../core/trade/isUntradable.ts";
import type { TradeTeams } from "../../common/types.ts";
import { trade } from "../core/index.ts";
import {
	buildSeasonGroundTruth,
	formatGroundTruthText,
} from "./seasonGroundTruth.ts";

// --- AI-to-AI trade veto ---

type EvalResult = {
	accepted: boolean;
	reason: string;
};

const evaluateTrade = async (
	teams: [
		{ tid: number; pids: number[]; dpids: number[] },
		{ tid: number; pids: number[]; dpids: number[] },
	],
): Promise<EvalResult | null> => {
	const settings = await getGlobalSettings();
	const apiKey = settings.geminiApiKey;
	if (!apiKey) return null;

	const season = g.get("season");

	const sides = await Promise.all(
		teams.map(async (t) => {
			const teamObj = await idb.cache.teams.get(t.tid);
			const teamName = teamObj
				? `${teamObj.region} ${teamObj.name}`
				: `Team ${t.tid}`;

			const players = (
				await Promise.all(t.pids.map((pid) => idb.cache.players.get(pid)))
			).filter((p) => p !== undefined);

			const picks = (
				await Promise.all(t.dpids.map((dpid) => idb.cache.draftPicks.get(dpid)))
			).filter((dp) => dp !== undefined);

			return {
				teamName,
				giving: players.map((p) => ({
					name: `${p.firstName} ${p.lastName}`,
					age: season - p.born.year,
					pos: p.ratings.at(-1)?.pos ?? "?",
					ovr: p.ratings.at(-1)?.ovr ?? 0,
				})),
				picks: picks.map((dp) => `${dp.season} Round ${dp.round} pick`),
			};
		}),
	);

	const maxOvr = Math.max(
		...sides.flatMap((s) => s.giving.map((p) => p.ovr)),
		0,
	);
	if (maxOvr < 70) return { accepted: true, reason: "" };

	const formatAssets = (side: (typeof sides)[number]) => {
		const playersStr = side.giving
			.map((p) => `${p.name} (${p.pos}, age ${p.age}, OVR ${p.ovr})`)
			.join(", ");
		const picksStr = side.picks.join(", ");
		return [playersStr, picksStr].filter(Boolean).join(", ") || "nothing";
	};

	const prompt = `You are evaluating a trade in a basketball simulation set in the ${season}-${season + 1} NBA season.

${sides[0].teamName} receives: ${formatAssets(sides[1])}
${sides[1].teamName} receives: ${formatAssets(sides[0])}

You have deep knowledge of real NBA history. Factor in each player's actual reputation, attitude, injury history, and how front offices viewed them at this point in time. Consider whether real GMs would actually make this deal.

Reply with ACCEPT or REJECT, then a colon, then one sentence under 20 words explaining why.`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10000);
	try {
		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
					generationConfig: {
						temperature: 0.2,
						// gemini-3.5-flash thinks by default (medium); thinking tokens
						// draw from maxOutputTokens, so a tiny cap yields empty text.
						maxOutputTokens: 2048,
						thinkingConfig: { thinkingLevel: "low" },
					},
				}),
				signal: controller.signal,
			},
		);

		if (!response.ok) return null;

		const data = await response.json();
		const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
		const accepted = text.trimStart().toUpperCase().startsWith("ACCEPT");
		const colonIdx = text.indexOf(":");
		const reason =
			colonIdx >= 0 ? text.slice(colonIdx + 1).trim() : text.trim();

		return { accepted, reason };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
};

// --- Trading block offer generation ---

type GeminiOfferRaw = {
	tid: number;
	players: string[];
	reasoning: string;
};

export type TradingBlockOffer = {
	teams: TradeTeams;
	reasoning: string;
};

export const callGemini = async (
	apiKey: string,
	prompt: string,
	options?: {
		temperature?: number;
		thinkingLevel?: "minimal" | "low" | "medium" | "high";
		maxOutputTokens?: number;
		timeoutMs?: number;
	},
): Promise<string | null> => {
	console.log("[Gemini] callGemini: starting fetch");
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		options?.timeoutMs ?? 20000,
	);
	try {
		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
					generationConfig: {
						temperature: options?.temperature ?? 0.4,
						// gemini-3.5-flash thinks by default (medium); thinking tokens
						// draw from maxOutputTokens. Budget generously for thinking +
						// the ~1.2k-token JSON, and keep thinking low for latency.
						maxOutputTokens: options?.maxOutputTokens ?? 8192,
						thinkingConfig: {
							thinkingLevel: options?.thinkingLevel ?? "low",
						},
					},
				}),
				signal: controller.signal,
			},
		);

		console.log("[Gemini] callGemini: response status", response.status);
		if (!response.ok) {
			const errText = await response.text().catch(() => "(unreadable)");
			console.log("[Gemini] callGemini: error body", errText);
			return null;
		}
		const data = await response.json();
		const cand = data?.candidates?.[0];
		const text = cand?.content?.parts?.[0]?.text ?? null;
		console.log(
			"[Gemini] callGemini: got text",
			text ? text.slice(0, 100) : null,
			"finishReason",
			cand?.finishReason,
		);
		return text;
	} catch (err) {
		console.log("[Gemini] callGemini: caught error", String(err));
		return null;
	} finally {
		clearTimeout(timer);
	}
};

export const generateTradingBlockOffers = async (
	userPids: number[],
	userDpids: number[],
): Promise<TradingBlockOffer[] | null> => {
	const settings = await getGlobalSettings();
	const apiKey = settings.geminiApiKey;
	console.log("[Gemini] generateTradingBlockOffers: apiKey present?", !!apiKey);
	if (!apiKey) return null;

	const season = g.get("season");
	const userTid = g.get("userTid");

	// Gather offered players
	const offeredPlayers = (
		await Promise.all(userPids.map((pid) => idb.cache.players.get(pid)))
	).filter((p) => p !== undefined);

	if (offeredPlayers.length === 0 && userDpids.length === 0) return null;

	const offeredDesc = offeredPlayers
		.map((p) => {
			const r = p.ratings.at(-1)!;
			const contractYears = p.contract.exp - season + 1;
			return `${p.firstName} ${p.lastName} (${r.pos}, age ${season - p.born.year}, OVR ${r.ovr}, ${contractYears} yr contract)`;
		})
		.join(", ");

	// Gather all non-user teams with their tradeable rosters
	const allTeams = (await idb.cache.teams.getAll()).filter(
		(t) => !t.disabled && t.tid !== userTid,
	);

	// Get season records for all teams
	const teamsWithRecords = await idb.getCopies.teamsPlus({
		attrs: ["tid", "region", "name"],
		seasonAttrs: ["won", "lost"],
		season,
		addDummySeason: true,
	});
	const recordByTid: Record<number, string> = {};
	for (const t of teamsWithRecords) {
		recordByTid[t.tid] = `${t.seasonAttrs.won}-${t.seasonAttrs.lost}`;
	}

	// Build condensed team data for prompt
	const teamEntries: string[] = [];
	const playerNameToPid: Map<string, number> = new Map();

	for (const t of allTeams) {
		const players = (
			await idb.cache.players.indexGetAll("playersByTid", t.tid)
		).filter((p) => !isUntradable(p).untradable);

		// Sort by ovr descending, take top 9
		const topPlayers = players
			.slice()
			.sort(
				(a, b) => (b.ratings.at(-1)?.ovr ?? 0) - (a.ratings.at(-1)?.ovr ?? 0),
			)
			.slice(0, 9);

		// Only register non-franchise players as offerable (skip the #1 player)
		for (const p of topPlayers.slice(1)) {
			const key = `${p.firstName} ${p.lastName}`.toLowerCase();
			playerNameToPid.set(`${t.tid}:${key}`, p.pid);
		}

		const playerList = topPlayers
			.map((p, idx) => {
				const r = p.ratings.at(-1)!;
				const yrs = p.contract.exp - season + 1;
				const tag = idx === 0 ? " [FRANCHISE — DO NOT OFFER]" : "";
				return `  - ${p.firstName} ${p.lastName} (${r.pos}, age ${season - p.born.year}, OVR ${r.ovr}, ${yrs}yr)${tag}`;
			})
			.join("\n");

		const record = recordByTid[t.tid] ?? "?-?";
		teamEntries.push(
			`${t.region} ${t.name} [tid:${t.tid}] (${record}):\n${playerList}`,
		);
	}

	const prompt = `You are an expert NBA historian and GM advisor. The basketball simulation is set in the **${season}-${season + 1} NBA season**.

A player is available on the trading block:
${offeredDesc}

**Critical instructions:**
1. ROSTER DATA IS GROUND TRUTH. Every player listed below is currently on that team right now in ${season}. Do not assume any trades, departures, or roster changes that are not reflected in the data. If a player appears on a team's roster, they are there — regardless of what you know about real NBA history after ${season}.
2. NEVER include a [FRANCHISE — DO NOT OFFER] player in an offer. They are context only.
3. NEVER include in an offer a player your reasoning identifies as the key reason the team wants this trade target (e.g. if you say "to pair with X", X must not be in the offer).
4. Only name players from that team's exact roster. Do not invent players.
5. Use your knowledge of each player's real reputation, attitude, locker-room presence, and injury history as of ${season} to judge which teams would realistically pursue the trade target — and at what price.
6. Use your knowledge of each team's real organizational culture, coaching staff, and roster needs as of ${season} to determine who are realistic suitors.
7. Propose 3–5 teams. For each, name 1–3 tradeable (non-franchise) players they would offer.

League rosters:
${teamEntries.join("\n\n")}

Respond ONLY with valid JSON, no markdown fences:
{
  "offers": [
    {
      "tid": <exact tid number from brackets above>,
      "players": ["First Last"],
      "reasoning": "Two sentences: why this team wants the player AND whether the player's reputation makes them a realistic or unlikely suitor."
    }
  ]
}`;

	const raw = await callGemini(apiKey, prompt);
	if (!raw) return null;

	// Strip markdown fences if present
	const cleaned = raw
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();

	let parsed: { offers: GeminiOfferRaw[] };
	try {
		parsed = JSON.parse(cleaned);
	} catch {
		// Try extracting JSON object from within the response
		const match = cleaned.match(/\{[\s\S]*\}/);
		if (!match) return null;
		try {
			parsed = JSON.parse(match[0]);
		} catch {
			return null;
		}
	}

	if (!Array.isArray(parsed?.offers)) return null;

	// Resolve each offer to pids and run makeItWork to balance value
	const results: TradingBlockOffer[] = [];

	for (const offer of parsed.offers) {
		if (typeof offer.tid !== "number") continue;

		const resolvedPids: number[] = [];
		for (const name of offer.players ?? []) {
			const key = `${offer.tid}:${name.toLowerCase()}`;
			const pid = playerNameToPid.get(key);
			if (pid !== undefined) resolvedPids.push(pid);
		}

		if (resolvedPids.length === 0) continue;

		const tradeTeams: TradeTeams = [
			{
				tid: userTid,
				pids: userPids,
				pidsExcluded: [],
				dpids: userDpids,
				dpidsExcluded: [],
			},
			{
				tid: offer.tid,
				pids: resolvedPids,
				pidsExcluded: [],
				dpids: [],
				dpidsExcluded: [],
			},
		];

		// Let makeItWork balance the value (may add picks or minor players)
		const balanced = await trade.makeItWork(tradeTeams, {
			holdUserConstant: true,
			maxAssetsToAdd: 3 + userPids.length,
		});

		if (balanced) {
			results.push({
				teams: balanced,
				reasoning: offer.reasoning ?? "",
			});
		}
	}

	return results.length > 0 ? results : null;
};

// --- Season retrospective (two-pass: outline, then prose) ---

type SeasonStoryOutline = {
	title: string;
	angle: string;
	beats: { when: string; what: string; why_it_mattered: string }[];
};

// The season-story prompts are much larger than this file's other prompts
// (a full ground-truth text block, plus a long-form prose request), so they
// run closer to the fetch timeout than a quick trade veto/offer call does.
// One retry absorbs an occasional slow/cold-start response instead of
// surfacing the fallback banner and making the user click again.
const callGeminiWithRetry = async (
	apiKey: string,
	prompt: string,
	options: Parameters<typeof callGemini>[2],
): Promise<string | null> => {
	const first = await callGemini(apiKey, prompt, options);
	if (first) {
		return first;
	}

	console.log("[Gemini] callGeminiWithRetry: first attempt failed, retrying");
	return callGemini(apiKey, prompt, options);
};

export const generateSeasonStoryArticle = async (
	tid: number,
	season: number,
): Promise<string | null> => {
	const settings = await getGlobalSettings();
	const apiKey = settings.geminiApiKey;
	if (!apiKey) {
		return null;
	}

	const groundTruth = await buildSeasonGroundTruth(tid, season);
	if (!groundTruth) {
		return null;
	}

	const factsText = formatGroundTruthText(groundTruth);
	const { isComplete } = groundTruth.seasonProgress;

	// Pass 1: outline
	const outlineArcGuidance = isComplete
		? "identify the season's narrative through-line and 4-6 chronological beats that tell its story: the setup, the turning point, the climax, and how it ended."
		: "identify the season's narrative through-line SO FAR and 3-5 chronological beats: the setup, the turning point (if one has emerged), and where things stand right now. The season has NOT concluded -- do not invent an ending, a turning point that hasn't happened, or a final result.";

	const outlinePrompt = `You are a veteran NBA beat writer planning a season retrospective for the ${groundTruth.teamName} covering the ${season} NBA season, for the team's hometown newspaper.

GROUND TRUTH — the only facts you may use. Do not invent or assume anything beyond this:
${factsText}

Based ONLY on the facts above, ${outlineArcGuidance}

Respond ONLY with valid JSON, no markdown fences:
{
  "title": "a short, punchy headline for this retrospective",
  "angle": "one sentence describing the through-line of the season",
  "beats": [
    { "when": "roughly when in the season this happened", "what": "what happened, using exact facts from above", "why_it_mattered": "why this was a turning point or important beat" }
  ]
}`;

	const rawOutline = await callGeminiWithRetry(apiKey, outlinePrompt, {
		temperature: 0.5,
		timeoutMs: 30000,
	});
	if (!rawOutline) {
		return null;
	}

	const cleanedOutline = rawOutline
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();

	let outline: SeasonStoryOutline;
	try {
		outline = JSON.parse(cleanedOutline);
	} catch {
		const match = cleanedOutline.match(/{[\S\s]*}/);
		if (!match) {
			return null;
		}
		try {
			outline = JSON.parse(match[0]);
		} catch {
			return null;
		}
	}
	if (!outline || !Array.isArray(outline.beats) || outline.beats.length === 0) {
		return null;
	}

	// Pass 2: prose, following the approved outline
	const beatsText = outline.beats
		.map((b, i) => `${i + 1}. ${b.when}: ${b.what} — ${b.why_it_mattered}`)
		.join("\n");

	const proseStructureGuidance = isComplete
		? "Structure: setup → turning point → climax → resolution, following the beats above in order."
		: "Structure: setup → turning point (if any) → where things stand right now, following the beats above in order. This season is still in progress -- do NOT claim it has ended, been decided, or reached a resolution. Close with 2-3 sentences on what to watch for the rest of the season (trending strengths/weaknesses, a hot or cold streak, a player developing), grounded only in the facts given.";
	const proseDevGuidance = isComplete
		? ""
		: "\n6. If player development notes are listed above (breakthrough seasons, mentorship, development focus), weave at least one in -- it's exactly the kind of forward-looking color that fits an in-progress storyline.";

	const prosePrompt = `You are a veteran NBA beat writer writing a season retrospective for the ${groundTruth.teamName}, covering the ${season} NBA season, for the team's hometown newspaper.

GROUND TRUTH — the only facts you may use. Do not invent or assume any score, stat, trade, or event not listed here:
${factsText}

APPROVED OUTLINE — follow this narrative arc, but write in flowing prose, not bullet points:
Title: ${outline.title}
Angle: ${outline.angle}
Beats:
${beatsText}

Instructions:
1. Write ONLY from the facts given above. Never invent a score, stat, quote, trade, or player not listed.
2. 600-900 words, veteran beat-writer voice.
3. ${proseStructureGuidance}
4. Weave in the exact stats/records/scores given, without rounding or altering any numbers.
5. Write in prose paragraphs separated by blank lines. No headers, no bullet points, no markdown formatting.${proseDevGuidance}

Write the retrospective now.`;

	const rawArticle = await callGeminiWithRetry(apiKey, prosePrompt, {
		temperature: 0.7,
		thinkingLevel: "medium",
		maxOutputTokens: 8192,
		timeoutMs: 30000,
	});
	if (!rawArticle) {
		return null;
	}

	return rawArticle
		.replace(/^```(?:\w+)?\s*/, "")
		.replace(/\s*```$/, "")
		.trim();
};

export default evaluateTrade;
