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
	if (!apiKey) {
		return null;
	}

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
	if (maxOvr < 70) {
		return { accepted: true, reason: "" };
	}

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
		maxOutputTokens: 2048,
		timeoutMs: 10000,
	});
	if (!text) {
		return null;
	}

	const accepted = text.trimStart().toUpperCase().startsWith("ACCEPT");
	const colonIdx = text.indexOf(":");
	const reason = colonIdx >= 0 ? text.slice(colonIdx + 1).trim() : text.trim();

	return { accepted, reason };
};

// --- Trading block offer generation (multi-step) ---
//
// This used to be a single mega-prompt: one call asked a free model to pick
// 3-5 suitor teams across all ~29 rosters AND write the "why" reasoning AND
// select which specific players to offer, all in one generation. In
// practice this produced consistent self-contradictions -- the model would
// write reasoning like "they'd want this to pair with their star X" and
// then include X in the actual offer, because nothing forced it to track
// that constraint across a long, repetitive multi-team JSON blob. Free-tier
// models are not reliable at self-consistency over that much simultaneous
// output.
//
// Fixed by decomposing into narrower back-and-forth exchanges, each asking
// for the simplest possible field, with the "don't offer the player your
// own reasoning was just about" constraint enforced in CODE (removing that
// player from the option list before the next call even sees it) instead
// of by instruction -- a dumb model can't violate a constraint about an
// option it was never shown:
//
//   1. Shortlist -- across all teams at once, pick suitors + a one-line
//      reason + (optionally) name the ONE player on that roster who is the
//      actual subject of the reasoning and must not be offered.
//   2. (code, no LLM call) Resolve that protected player to a pid and drop
//      them from the team's tradable list.
//   3. Per shortlisted team, one call scoped to ONLY that team's
//      already-filtered roster: "pick 1-3 of these to offer." No
//      reasoning, no other teams, nothing left to be inconsistent with.
//
// The final "reasoning" text shown in the UI is step 1's needSummary,
// written before the model knew which players would end up in the offer --
// it can't contradict a pick it never saw.
//
// Cost: up to 1 + MAX_SHORTLIST_TEAMS calls per click against the shared
// 50/day free-tier quota (see the module-level comment above), vs. 1 call
// before. MAX_SHORTLIST_TEAMS is 3 (not the old 3-5) specifically to bound
// that -- each call is also much smaller/simpler than the old mega-prompt,
// so the added round trips are partly offset by shorter per-call timeouts.
const MAX_SHORTLIST_TEAMS = 3;

type TradableRosterPlayer = {
	pid: number;
	name: string;
	pos: string;
	age: number;
	ovr: number;
	yrs: number;
};

type TeamRosterInfo = {
	tid: number;
	teamName: string;
	record: string;
	franchisePlayer: TradableRosterPlayer;
	tradablePlayers: TradableRosterPlayer[];
};

type ShortlistEntryRaw = {
	tid: number;
	needSummary: string;
	protectPlayer: string;
};

type ShortlistRaw = {
	teams: ShortlistEntryRaw[];
};

type OfferSelectionRaw = {
	players: string[];
};

export type TradingBlockOffer = {
	teams: TradeTeams;
	reasoning: string;
};

const extractJsonObject = <T>(raw: string): T | null => {
	const cleaned = raw
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
	try {
		return JSON.parse(cleaned) as T;
	} catch {
		const match = cleaned.match(/{[\S\s]*}/);
		if (!match) {
			return null;
		}
		try {
			return JSON.parse(match[0]) as T;
		} catch {
			return null;
		}
	}
};

export const callOpenRouter = async (
	apiKey: string,
	prompt: string,
	options?: {
		temperature?: number;
		thinkingLevel?: "none" | "minimal" | "low" | "medium" | "high";
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
					// Measured against the real trading-block prompt (~29 teams'
					// rosters): forcing even "low" effort reasoning on by default
					// made Hy3 blow through a 30s timeout, because "low" still spends
					// ~20% of max_tokens on chain-of-thought before the actual answer.
					// Unlike gemini-3.5-flash (medium reasoning by default, the old
					// gotcha this pattern was copied from), Hy3's own default is
					// no-think — fastest — so default to "none" explicitly and only
					// opt into real reasoning (season story's prose pass) where the
					// task actually benefits from it.
					effort: options?.thinkingLevel ?? "none",
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
	} catch (error) {
		console.log("[OpenRouter] callOpenRouter: caught error", String(error));
		options?.onError?.({ body: String(error) });
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
	if (!apiKey) {
		return { offers: null, rateLimited: false };
	}

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

	// Build per-team roster info once, reused by both steps below. The
	// franchise player is tracked separately from tradablePlayers so it's
	// structurally never offerable -- not because a prompt says not to.
	const teamRosterInfos: TeamRosterInfo[] = [];

	for (const t of allTeams) {
		const players = (
			await idb.cache.players.indexGetAll("playersByTid", t.tid)
		).filter((p) => !isUntradable(p).untradable);

		const sorted = players
			.slice()
			.sort(
				(a, b) => (b.ratings.at(-1)?.ovr ?? 0) - (a.ratings.at(-1)?.ovr ?? 0),
			)
			.slice(0, 9);

		if (sorted.length === 0) {
			continue;
		}

		const toEntry = (p: (typeof sorted)[number]): TradableRosterPlayer => {
			const r = p.ratings.at(-1)!;
			return {
				pid: p.pid,
				name: `${p.firstName} ${p.lastName}`,
				pos: r.pos,
				age: season - p.born.year,
				ovr: r.ovr,
				yrs: p.contract.exp - season + 1,
			};
		};

		teamRosterInfos.push({
			tid: t.tid,
			teamName: `${t.region} ${t.name}`,
			record: recordByTid[t.tid] ?? "?-?",
			franchisePlayer: toEntry(sorted[0]!),
			tradablePlayers: sorted.slice(1).map(toEntry),
		});
	}

	if (teamRosterInfos.length === 0) {
		return { offers: null, rateLimited: false };
	}

	let rateLimited = false;

	// --- Step 1: shortlist teams + one-line need + protected player ---
	// A condensed view (franchise player + top 3 tradable) is enough context
	// to name a "protect" player without paying for every team's full roster
	// in this pass -- that full roster only matters in step 3, scoped to one
	// team at a time.
	const shortlistEntries = teamRosterInfos.map((t) => {
		const shown = [t.franchisePlayer, ...t.tradablePlayers.slice(0, 3)];
		const list = shown
			.map((p, idx) => {
				const tag = idx === 0 ? " [FRANCHISE]" : "";
				return `  - ${p.name} (${p.pos}, age ${p.age}, OVR ${p.ovr})${tag}`;
			})
			.join("\n");
		return `${t.teamName} [tid:${t.tid}] (${t.record}):\n${list}`;
	});

	const shortlistPrompt = `You are an NBA front-office analyst. The basketball simulation is set in the **${season}-${season + 1} NBA season**.

A player is available on the trading block:
${offeredDesc}

Below is every other team, their record, and a few of their key players (their best/"franchise" player is marked -- teams never trade their franchise player).

${shortlistEntries.join("\n\n")}

Task: pick ${MAX_SHORTLIST_TEAMS} teams that would realistically want to trade for this player. You are NOT choosing a trade package yet -- that happens in a later step. Do not name any player except in the optional "protectPlayer" field below.

For each team, respond with:
- "tid": the exact tid number from brackets above
- "needSummary": one sentence -- why this specific team wants this player right now, and whether their real-world reputation makes them a realistic or unlikely suitor
- "protectPlayer": if your needSummary names a specific player on this team's roster (e.g. "to pair with X" or "X needs more help"), put that player's exact name here so they are protected from being traded away later. Otherwise use an empty string "".

ROSTER DATA IS GROUND TRUTH -- use only the teams and players listed above, exactly as listed. Use your knowledge of real NBA player reputations, team culture, and organizational needs as of ${season} to judge fit and realism.

Respond ONLY with valid JSON, no markdown fences:
{
  "teams": [
    { "tid": <number>, "needSummary": "...", "protectPlayer": "..." }
  ]
}`;

	const shortlistRaw = await callOpenRouter(apiKey, shortlistPrompt, {
		timeoutMs: 20000,
		onError: (info) => {
			if (info.status === 429) {
				rateLimited = true;
			}
		},
	});
	if (!shortlistRaw) {
		return { offers: null, rateLimited };
	}

	const shortlistParsed = extractJsonObject<ShortlistRaw>(shortlistRaw);
	if (!shortlistParsed || !Array.isArray(shortlistParsed.teams)) {
		return { offers: null, rateLimited };
	}

	// --- Step 2 (code, no LLM call): resolve + drop the protected player ---
	const teamRosterByTid = new Map(teamRosterInfos.map((t) => [t.tid, t]));
	const seenTids = new Set<number>();
	const shortlist: {
		info: TeamRosterInfo;
		needSummary: string;
		tradablePlayers: TradableRosterPlayer[];
	}[] = [];

	for (const entry of shortlistParsed.teams) {
		if (shortlist.length >= MAX_SHORTLIST_TEAMS) {
			break;
		}
		if (typeof entry.tid !== "number" || seenTids.has(entry.tid)) {
			continue;
		}
		const info = teamRosterByTid.get(entry.tid);
		if (!info) {
			continue;
		}
		seenTids.add(entry.tid);

		const protectName =
			typeof entry.protectPlayer === "string"
				? entry.protectPlayer.trim().toLowerCase()
				: "";
		const tradablePlayers = protectName
			? info.tradablePlayers.filter((p) => p.name.toLowerCase() !== protectName)
			: info.tradablePlayers;
		if (tradablePlayers.length === 0) {
			continue;
		}

		const needSummary =
			typeof entry.needSummary === "string" && entry.needSummary.trim()
				? entry.needSummary.trim()
				: `Interested in trading for ${offeredPlayers.map((p) => `${p.firstName} ${p.lastName}`).join(" and ")}.`;

		shortlist.push({ info, needSummary, tradablePlayers });
	}

	if (shortlist.length === 0) {
		return { offers: null, rateLimited };
	}

	// --- Step 3: per-team asset selection, scoped to that team's already- ---
	// --- filtered roster. The protected player is structurally absent    ---
	// --- from both the prompt and the name→pid lookup below, so naming   ---
	// --- them (even by hallucination) can't resolve to a pid.            ---
	const offerSelectionResults = await Promise.all(
		shortlist.map(async (entry) => {
			const rosterList = entry.tradablePlayers
				.map(
					(p) =>
						`  - ${p.name} (${p.pos}, age ${p.age}, OVR ${p.ovr}, ${p.yrs}yr)`,
				)
				.join("\n");

			const prompt = `You are an NBA front-office analyst for the ${entry.info.teamName} (${entry.info.record}) during the ${season} season.

Your team wants to trade for: ${offeredDesc}
Why: ${entry.needSummary}

Here is your team's tradable roster. These are the ONLY players you may offer -- do not name anyone else:
${rosterList}

Task: pick 1 to 3 players from the list above that your team would realistically include in this trade offer. Match value roughly to what a team would give up for the target, not just your best remaining players.

Respond ONLY with valid JSON, no markdown fences, using exact names from the list above:
{ "players": ["First Last"] }`;

			const raw = await callOpenRouter(apiKey, prompt, {
				timeoutMs: 15000,
				onError: (info) => {
					if (info.status === 429) {
						rateLimited = true;
					}
				},
			});
			if (!raw) {
				return null;
			}

			const parsed = extractJsonObject<OfferSelectionRaw>(raw);
			if (!parsed || !Array.isArray(parsed.players)) {
				return null;
			}

			const nameToPid = new Map(
				entry.tradablePlayers.map((p) => [p.name.toLowerCase(), p.pid]),
			);
			const resolvedPids: number[] = [];
			for (const name of parsed.players) {
				if (typeof name !== "string") {
					continue;
				}
				const pid = nameToPid.get(name.toLowerCase());
				if (pid !== undefined && !resolvedPids.includes(pid)) {
					resolvedPids.push(pid);
				}
				if (resolvedPids.length >= 3) {
					break;
				}
			}
			if (resolvedPids.length === 0) {
				return null;
			}

			return { entry, resolvedPids };
		}),
	);

	// Resolve each offer to pids and run makeItWork to balance value
	const results: TradingBlockOffer[] = [];

	for (const selection of offerSelectionResults) {
		if (!selection) {
			continue;
		}
		const { entry, resolvedPids } = selection;

		const tradeTeams: TradeTeams = [
			{
				tid: userTid,
				pids: userPids,
				pidsExcluded: [],
				dpids: userDpids,
				dpidsExcluded: [],
			},
			{
				tid: entry.info.tid,
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
				// Written in step 1, before the model knew which players would
				// end up in the offer -- it cannot contradict a pick it never saw.
				reasoning: entry.needSummary,
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
