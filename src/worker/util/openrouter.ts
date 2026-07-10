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

// OpenRouter free tier (as of mid-2026): 50 requests/day, 20 requests/minute,
// shared across every model and every feature in this file. A $10 lifetime
// credit top-up raises the daily cap to 1,000 — mentioned in the Global
// Settings help text, not handled in code.
//
// Primary model is Tencent Hy3 (free) — OpenRouter's #1 free model by usage,
// ranks well across general-knowledge and creative-writing categories, and
// is built for "grounded, anti-hallucination" answers, which matters for
// prompts whose #1 instruction is "roster data is ground truth." It defaults
// to a no-think mode, so (unlike the old Gemini integration) reasoning is
// opt-in per call rather than something we have to fight by default.
//
// The two fallbacks are only used if the primary model's provider is down or
// rate-limited (per-model contention on a popular free model, not our
// account's daily cap) — OpenRouter tries them in order within the same
// request, so it doesn't cost extra against the 50/day budget.
const OPENROUTER_MODELS = [
	"tencent/hy3:free",
	"openai/gpt-oss-120b:free",
	"google/gemma-4-31b-it:free",
];

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

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
	const apiKey = settings.openRouterApiKey;
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

	// sides has exactly 2 elements (one per side of `teams`), but Array.map loses tuple-ness
	const side0 = sides[0]!;
	const side1 = sides[1]!;

	const prompt = `You are evaluating a trade in a basketball simulation set in the ${season}-${season + 1} NBA season.

${side0.teamName} receives: ${formatAssets(side1)}
${side1.teamName} receives: ${formatAssets(side0)}

You have deep knowledge of real NBA history. Factor in each player's actual reputation, attitude, injury history, and how front offices viewed them at this point in time. Consider whether real GMs would actually make this deal.

Reply with ACCEPT or REJECT, then a colon, then one sentence under 20 words explaining why.`;

	const text = await callOpenRouter(apiKey, prompt, {
		temperature: 0.2,
		thinkingLevel: "low",
		maxOutputTokens: 2048,
		timeoutMs: 10000,
	});
	if (!text) return null;

	const accepted = text.trimStart().toUpperCase().startsWith("ACCEPT");
	const colonIdx = text.indexOf(":");
	const reason = colonIdx >= 0 ? text.slice(colonIdx + 1).trim() : text.trim();

	return { accepted, reason };
};

// --- Trading block offer generation ---

type OpenRouterOfferRaw = {
	tid: number;
	players: string[];
	reasoning: string;
};

export type TradingBlockOffer = {
	teams: TradeTeams;
	reasoning: string;
};

export const callOpenRouter = async (
	apiKey: string,
	prompt: string,
	options?: {
		temperature?: number;
		thinkingLevel?: "minimal" | "low" | "medium" | "high";
		maxOutputTokens?: number;
		timeoutMs?: number;
		onError?: (info: { status?: number; body?: string }) => void;
	},
): Promise<string | null> => {
	console.log("[OpenRouter] callOpenRouter: starting fetch");
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		options?.timeoutMs ?? 20000,
	);
	try {
		const response = await fetch(OPENROUTER_CHAT_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
				"HTTP-Referer": "https://zengm.com",
				"X-Title": "ZenGM",
			},
			body: JSON.stringify({
				models: OPENROUTER_MODELS,
				messages: [{ role: "user", content: prompt }],
				temperature: options?.temperature ?? 0.4,
				max_tokens: options?.maxOutputTokens ?? 8192,
				reasoning: {
					// Reasoning tokens are billed/capped as part of max_tokens (same
					// gotcha as the old Gemini thinking models), so keep effort low by
					// default and let callers opt into "medium" for longer prose.
					effort: options?.thinkingLevel ?? "low",
				},
			}),
			signal: controller.signal,
		});

		console.log(
			"[OpenRouter] callOpenRouter: response status",
			response.status,
		);
		if (!response.ok) {
			const errText = await response.text().catch(() => "(unreadable)");
			console.log("[OpenRouter] callOpenRouter: error body", errText);
			options?.onError?.({ status: response.status, body: errText });
			return null;
		}
		const data = await response.json();
		const choice = data?.choices?.[0];
		const text = choice?.message?.content ?? null;
		console.log(
			"[OpenRouter] callOpenRouter: got text",
			text ? text.slice(0, 100) : null,
			"finish_reason",
			choice?.finish_reason,
			"model",
			data?.model,
		);
		return text;
	} catch (err) {
		console.log("[OpenRouter] callOpenRouter: caught error", String(err));
		options?.onError?.({ body: String(err) });
		return null;
	} finally {
		clearTimeout(timer);
	}
};

export const generateTradingBlockOffers = async (
	userPids: number[],
	userDpids: number[],
): Promise<{ offers: TradingBlockOffer[] | null; rateLimited: boolean }> => {
	const settings = await getGlobalSettings();
	const apiKey = settings.openRouterApiKey;
	console.log(
		"[OpenRouter] generateTradingBlockOffers: apiKey present?",
		!!apiKey,
	);
	if (!apiKey) return { offers: null, rateLimited: false };

	const season = g.get("season");
	const userTid = g.get("userTid");

	// Gather offered players
	const offeredPlayers = (
		await Promise.all(userPids.map((pid) => idb.cache.players.get(pid)))
	).filter((p) => p !== undefined);

	if (offeredPlayers.length === 0 && userDpids.length === 0) {
		return { offers: null, rateLimited: false };
	}

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

	let rateLimited = false;
	const raw = await callOpenRouter(apiKey, prompt, {
		onError: (info) => {
			if (info.status === 429) rateLimited = true;
		},
	});
	if (!raw) return { offers: null, rateLimited };

	// Strip markdown fences if present
	const cleaned = raw
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();

	let parsed: { offers: OpenRouterOfferRaw[] };
	try {
		parsed = JSON.parse(cleaned);
	} catch {
		// Try extracting JSON object from within the response
		const match = cleaned.match(/\{[\s\S]*\}/);
		if (!match) return { offers: null, rateLimited };
		try {
			parsed = JSON.parse(match[0]);
		} catch {
			return { offers: null, rateLimited };
		}
	}

	if (!Array.isArray(parsed?.offers)) return { offers: null, rateLimited };

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

	return { offers: results.length > 0 ? results : null, rateLimited };
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
// surfacing the fallback banner and making the user click again. Also tracks
// whether the free-tier rate limit (HTTP 429) was the cause, so the caller
// can show something more useful than a generic "unavailable" message.
//
// The retry is skipped when the first attempt was rate-limited: OpenRouter's
// free tier is a shared 50-requests/day budget across every feature in this
// file, and a 429 fired seconds ago is going to fire again immediately —
// retrying would just spend a second unit of that scarce daily quota on a
// guaranteed-duplicate failure.
const callOpenRouterWithRetry = async (
	apiKey: string,
	prompt: string,
	options: Parameters<typeof callOpenRouter>[2],
): Promise<{ text: string | null; rateLimited: boolean }> => {
	let rateLimited = false;
	const onError = (info: { status?: number }) => {
		if (info.status === 429) {
			rateLimited = true;
		}
	};

	const first = await callOpenRouter(apiKey, prompt, { ...options, onError });
	if (first) {
		return { text: first, rateLimited: false };
	}
	if (rateLimited) {
		return { text: null, rateLimited: true };
	}

	console.log(
		"[OpenRouter] callOpenRouterWithRetry: first attempt failed, retrying",
	);
	const second = await callOpenRouter(apiKey, prompt, { ...options, onError });
	return { text: second, rateLimited };
};

export type SeasonStoryResult = {
	article: string | null;
	errorReason?: "rate_limited" | "other";
};

export const generateSeasonStoryArticle = async (
	tid: number,
	season: number,
): Promise<SeasonStoryResult> => {
	const settings = await getGlobalSettings();
	const apiKey = settings.openRouterApiKey;
	if (!apiKey) {
		return { article: null, errorReason: "other" };
	}

	const groundTruth = await buildSeasonGroundTruth(tid, season);
	if (!groundTruth) {
		return { article: null, errorReason: "other" };
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

	const outlineResult = await callOpenRouterWithRetry(apiKey, outlinePrompt, {
		temperature: 0.5,
		timeoutMs: 30000,
	});
	if (!outlineResult.text) {
		return {
			article: null,
			errorReason: outlineResult.rateLimited ? "rate_limited" : "other",
		};
	}

	const cleanedOutline = outlineResult.text
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();

	let outline: SeasonStoryOutline;
	try {
		outline = JSON.parse(cleanedOutline);
	} catch {
		const match = cleanedOutline.match(/{[\S\s]*}/);
		if (!match) {
			return { article: null, errorReason: "other" };
		}
		try {
			outline = JSON.parse(match[0]);
		} catch {
			return { article: null, errorReason: "other" };
		}
	}
	if (!outline || !Array.isArray(outline.beats) || outline.beats.length === 0) {
		return { article: null, errorReason: "other" };
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

	const proseResult = await callOpenRouterWithRetry(apiKey, prosePrompt, {
		temperature: 0.7,
		thinkingLevel: "medium",
		maxOutputTokens: 8192,
		timeoutMs: 30000,
	});
	if (!proseResult.text) {
		return {
			article: null,
			errorReason: proseResult.rateLimited ? "rate_limited" : "other",
		};
	}

	return {
		article: proseResult.text
			.replace(/^```(?:\w+)?\s*/, "")
			.replace(/\s*```$/, "")
			.trim(),
	};
};

export default evaluateTrade;
