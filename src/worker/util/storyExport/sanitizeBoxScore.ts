// Box-score hygiene for the exported shards (AI Story Export).
//
// The stored Game object is written for the in-app box-score UI, not for a consumer outside the
// app, and it shows: minutes are unrounded floats (`35.164555269229595`) and clutchPlays are HTML
// strings containing league-relative anchor hrefs (`<a href="/l/3/player/4177">Buddy Hield</a>
// made a three-pointer at the buzzer`). Neither is usable as-is by an external writer, and the
// links are dead outside this browser profile.
//
// So each exported game gets: rounded minutes, and clutchPlays as both plain text and a structured
// `{pids, tids, text}` record recovered from the anchors. Pure, DB-free.

const ANCHOR = /<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
const ANY_TAG = /<[^>]+>/g;

const decodeEntities = (s: string) =>
	s
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&nbsp;", " ");

export type StructuredClutchPlay = {
	text: string;
	// Entities the play links to, recovered from the anchor hrefs (/l/<lid>/player/<pid>, and
	// /l/<lid>/roster/<abbrev>/<season> for teams - the abbrev is kept as-is since the bundle's
	// teams table is keyed by tid and abbrevs change over time).
	pids: number[];
	teamAbbrevs: string[];
};

export const parseClutchPlay = (html: string): StructuredClutchPlay => {
	const pids: number[] = [];
	const teamAbbrevs: string[] = [];

	for (const match of html.matchAll(ANCHOR)) {
		const href = match[1] ?? "";
		const player = /\/player\/(\d+)/.exec(href);
		if (player) {
			pids.push(Number(player[1]));
			continue;
		}
		const roster = /\/roster\/([^/]+)/.exec(href);
		if (roster) {
			teamAbbrevs.push(decodeURIComponent(roster[1]!));
		}
	}

	const text = decodeEntities(html.replaceAll(ANY_TAG, ""))
		.replaceAll(/\s+/g, " ")
		.trim();

	return { text, pids, teamAbbrevs };
};

const roundMinutes = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value)
		? Math.round(value * 10) / 10
		: value;

type LooseGame = Record<string, any>;

// Returns a shallow-ish copy: the arrays that get rewritten are rebuilt, everything else is passed
// through by reference. The caller serializes immediately, so nothing is mutated in the DB.
export const sanitizeBoxScore = (game: unknown): unknown => {
	if (typeof game !== "object" || game === null) {
		return game;
	}
	const g = game as LooseGame;
	const out: LooseGame = { ...g };

	if (Array.isArray(g.clutchPlays)) {
		const parsed = g.clutchPlays.map((play: unknown) =>
			typeof play === "string"
				? parseClutchPlay(play)
				: { text: String(play), pids: [], teamAbbrevs: [] },
		);
		out.clutchPlays = parsed.map((p: StructuredClutchPlay) => p.text);
		out.clutchPlaysDetail = parsed;
	}

	if (Array.isArray(g.teams)) {
		out.teams = g.teams.map((team: unknown) => {
			if (typeof team !== "object" || team === null) {
				return team;
			}
			const t = team as LooseGame;
			const outTeam: LooseGame = { ...t, min: roundMinutes(t.min) };
			if (Array.isArray(t.players)) {
				outTeam.players = t.players.map((p: unknown) => {
					if (typeof p !== "object" || p === null) {
						return p;
					}
					const line = p as LooseGame;
					return { ...line, min: roundMinutes(line.min) };
				});
			}
			return outTeam;
		});
	}

	return out;
};
