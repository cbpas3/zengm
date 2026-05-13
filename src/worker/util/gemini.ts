import { idb } from "../db/index.ts";
import { g } from "./index.ts";
import getGlobalSettings from "./getGlobalSettings.ts";
import isUntradable from "../core/trade/isUntradable.ts";
import type { TradeTeams } from "../../common/types.ts";
import { trade } from "../core/index.ts";

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

	try {
		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
					generationConfig: { temperature: 0.2, maxOutputTokens: 80 },
				}),
				signal: AbortSignal.timeout(8000),
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

const callGemini = async (
	apiKey: string,
	prompt: string,
): Promise<string | null> => {
	try {
		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
					generationConfig: { temperature: 0.4, maxOutputTokens: 1200 },
				}),
				signal: AbortSignal.timeout(15000),
			},
		);

		if (!response.ok) return null;
		const data = await response.json();
		return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
	} catch {
		return null;
	}
};

export const generateTradingBlockOffers = async (
	userPids: number[],
	userDpids: number[],
): Promise<TradingBlockOffer[] | null> => {
	const settings = await getGlobalSettings();
	const apiKey = settings.geminiApiKey;
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

		for (const p of topPlayers) {
			const key = `${p.firstName} ${p.lastName}`.toLowerCase();
			playerNameToPid.set(`${t.tid}:${key}`, p.pid);
		}

		const playerList = topPlayers
			.map((p) => {
				const r = p.ratings.at(-1)!;
				const yrs = p.contract.exp - season + 1;
				return `  - ${p.firstName} ${p.lastName} (${r.pos}, age ${season - p.born.year}, OVR ${r.ovr}, ${yrs}yr)`;
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
1. Draw on your deep knowledge of real NBA history at this exact point in time (${season}).
2. Consider each player's real reputation, attitude, locker-room presence, injury history, and how front offices genuinely viewed them in ${season}. If a player had well-known character issues, only desperate or risk-tolerant organizations would pursue them — and at a discount.
3. Consider each team's real historical situation in ${season}: their championship window, organizational culture (some teams were character-first, others win-at-all-costs), coaching staff preferences, and roster needs.
4. Only list players from their exact roster below. Do not invent players.
5. Propose 3–5 teams that would realistically pursue this player. For each, name 1–3 players they would offer.

League rosters (tradeable players only):
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

export default evaluateTrade;
