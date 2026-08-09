// Story-export workflow + prompt library (AI Story Export, §5/§6 in AI_STORY_EXPORT_PLAN.md).
// Shipped as data so the export bundle can embed it (README + canon-workflow.md) and the UI can
// show the prompts. This is the "bring your own model / swarm" half: the fork produces facts +
// canon seeds; these prompts drive the writing off-device.
//
// Kept in common/ so both the worker (serializing the bundle) and the UI (previewing prompts) can
// import it without duplication.
//
// Each prompt declares the files it reads *and* the specific evidence fields it tells the writer to
// argue from. Both are machine-checked against the assembled bundle before export (validate.ts) -
// v1's greatest-players prompt instructed the model to argue from `careerWS`, which was zero for
// every player in the file, and nothing caught it.

// The non-negotiable framing every prompt inherits. Mirrors Feature 2's "ROSTER DATA IS GROUND
// TRUTH" constraint - it matters just as much for a strong model, which will otherwise pattern-match
// simulated players onto real NBA history.
export const GROUND_TRUTH_PREAMBLE = `You are writing about a *fictional* basketball simulation league. Every player, team, and result below is invented by the simulation. The data in this bundle is the complete and authoritative record — treat it as ground truth. Do not import real-world NBA players, teams, records, or events, and do not invent facts that aren't supported by the data. When you cite a number or a result, it must be traceable to the bundle. A field that is \`null\` is *not computable* for that season, not zero — never describe a null metric as a low one.`;

export type StoryTier = "foundational" | "dependent";

export type StoryPromptTemplate = {
	id: string;
	tier: StoryTier;
	title: string;
	// Bundle files the piece reads. Must exist in the bundle or the prompt is dropped from the
	// generated workflow doc.
	inputs: string[];
	// Dotted paths into the knowledge base whose presence the prompt depends on.
	evidence: string[];
	prompt: string;
};

// Tier 1 — foundational canon. No dependencies; run these first. Each is seeded by a derived
// ranking/relationship table, so the model argues from computed evidence rather than vibes. Tier 1
// should emit, alongside prose, a list of canonical claims (see CANON_INDEX_NOTE) that Tier 2 reads.
export const FOUNDATIONAL_PROMPTS: StoryPromptTemplate[] = [
	{
		id: "greatest-players",
		tier: "foundational",
		title: "The Greatest Players of All Time",
		inputs: [
			"rankings.json",
			"players.json",
			"teams.json",
			"leaderboards.json",
		],
		evidence: [
			"canon.players.careerWS",
			"canon.players.peakWS",
			"canon.players.valueMetric",
			"canon.players.topAwards",
			"leaderboards.career",
		],
		prompt: `Using rankings.players (scored by career value, peak, and accolades) plus the players table for detail, write a ranked "Greatest Players in League History" feature covering the top 15-25. For each: their peak, what they won (rings, MVPs), the teams they defined, and the case for their placement. Argue from the evidence fields (careerWS, peakWS, rings, topAwards, primeSpan), and check each player's \`valueMetric\` first — if it is not "ws", win shares were not computable for that era and you must reason from careerVORP/points and accolades instead of quoting a win-share total. Anchor claims in leaderboards.json where you can ("third-most points in league history"). Where two players are close, make the comparison explicit. End by emitting a canonical-claims list: for each player, a one-line "regarded as the Nth-greatest player ever" claim keyed by pid.`,
	},
	{
		id: "greatest-teams",
		tier: "foundational",
		title: "The Greatest Team-Seasons Ever",
		inputs: ["rankings.json", "teams.json", "players.json"],
		evidence: [
			"canon.teamSeasons.pointDiffPerGame",
			"canon.teamSeasons.pointDiffImputed",
			"canon.teamSeasons.wonTitle",
		],
		prompt: `Using rankings.teamSeasons (scored by win%, point differential, and playoff success), write "The Greatest Teams in League History." Profile the top 10-15 team-seasons: their record and margin, who led them, how their playoff run went, and whether they won it all (wonTitle). Where \`pointDiffImputed\` is true, the league had no differential data for that season and the ranking estimated one from the record — say so rather than quoting the number as measured. Cross-reference the teams table for franchise context (pace, offensive/defensive rating, seed) and players for the stars. Emit canonical claims: "the {season} {team} rank among the greatest teams ever," keyed by tid+season.`,
	},
	{
		id: "busts-and-steals",
		tier: "foundational",
		title: "Biggest Busts & Steals",
		inputs: ["rankings.json", "players.json"],
		evidence: [
			"canon.busts.expectedWS",
			"canon.busts.delta",
			"canon.busts.expectedFrom",
		],
		prompt: `Using rankings.busts (first-round picks who most underperformed their draft slot) and rankings.steals (late/second-round/undrafted players who most overperformed), write a two-part draft-history piece. For each name, contrast the expectation (round/pick, expectedWS — fitted from this league's own history at that slot) with what actually happened (careerWS, delta), and tell the short version of why: their ratings trajectory, injuries, and where they moved. Emit canonical claims tagging each player as a notable bust or steal, keyed by pid.`,
	},
	{
		id: "great-rivalries",
		tier: "foundational",
		title: "The Great Rivalries",
		inputs: ["rivalries.json", "teams.json", "playoffSeries.json"],
		evidence: ["canon.rivalries.playoffMeetings", "playoffSeries.seriesScore"],
		prompt: `Using the rivalries table (ranked by intensity: repeat playoff meetings, deep rounds, close series, near-even all-time records), write "The Defining Rivalries" of the league. For each top rivalry: the all-time regular-season record, every playoff meeting (season, round, who won and how close — join to playoffSeries.json via seriesId for seeds and the exact series score), and how the balance of power shifted. Name the players who embodied it (join via the teams' rosters those seasons). Emit canonical claims describing each rivalry, keyed by the tid pair.`,
	},
	{
		id: "dynasties",
		tier: "foundational",
		title: "The Dynasties",
		inputs: [
			"dynasties.json",
			"teams.json",
			"players.json",
			"playoffSeries.json",
		],
		evidence: ["teams.seasons.playoffSeed", "teams.seasons.ortg"],
		prompt: `Using the dynasties table (clusters of titles within a short window), write a chronicle of the league's dynasties. For each: the title seasons, the span, the core players who anchored it (from the teams' rosters those seasons and the players table), how they were built (transactions and draft position), what they were stylistically (pace, offensive/defensive rating), and what ended it. Rank them. Emit canonical claims naming each dynasty and its era, keyed by tid.`,
	},
	{
		id: "franchise-histories",
		tier: "foundational",
		title: "Franchise Histories",
		inputs: ["teams.json", "players.json", "rivalries.json"],
		evidence: ["teams.seasons.confRank", "teams.relocations"],
		prompt: `Using the teams table (per-season records and context, titleSeasons, titleDrought, all-time record, relocations) write a one-page history for each franchise: their founding-to-present arc, championships and droughts, relocations and rebrands, defining players and eras, and their fiercest rivals (from the rivalries table). Note that defunct franchises are present with \`disabled: true\` and a null titleDrought. Emit canonical claims: each franchise's identity in one line, keyed by tid.`,
	},
];

// Tier 2 — dependent pieces. Each is handed scoped Tier-0 facts PLUS the relevant Tier-1 canon
// claims, so it stays consistent with the established canon (a title recap "knows" it's an
// underdog's first ring against a chronicled dynasty).
export const DEPENDENT_PROMPTS: StoryPromptTemplate[] = [
	{
		id: "season-retrospective",
		tier: "dependent",
		title: "Team Season Retrospective",
		inputs: [
			"teams.json",
			"players.json",
			"playoffSeries.json",
			"gameIndex.json",
		],
		evidence: ["players.injuries", "teams.seasons.pointDiffPerGame"],
		prompt: `Write an 800-1000 word retrospective on one team's season, told as a story with an arc: preseason identity → turning point → how it ended. Use the team's season row (record, point differential, pace, offensive/defensive rating, seed, conference finish), its roster's stat lines, the playoff series it played (playoffSeries.json, by tid+season), and its signature games (gameIndex.json, filtered to that team and season). Check the roster's \`injuries\` for that season before explaining any collapse or absence — an unexplained gap in a star's games played is usually there. Weave in the established canon: where this season sits in the franchise's history, any rivalry stakes, whether a player was mid-breakthrough. Don't summarize game-by-game — find the throughline.`,
	},
	{
		id: "player-career",
		tier: "dependent",
		title: "Player Career Profile",
		inputs: [
			"players.json",
			"rankings.json",
			"gameIndex.json",
			"leaderboards.json",
		],
		evidence: [
			"players.ratings.skills",
			"players.stats.shotDist",
			"players.transactions",
			"players.highlightGames",
		],
		prompt: `Write a career-retrospective feature on one player. Establish their peak, their defining season, and — this is the part that separates a recap from writing — *how they played*: use the per-season \`skills\` labels on their ratings rows (3 = shooter, A = athlete, B = ball handler, Di = interior defender, Dp = perimeter defender, Po = post scorer, Ps = passer, R = rebounder) and the \`shotDist\` shares on their stat lines to describe their game concretely, and shooting splits to judge whether volume was efficient. Cover the teams and moves that shaped them (transactions — each trade carries both sides), injuries, their pre-joined \`highlightGames\`, and where they sit on the all-time leaderboards. Place them against the canon: their all-time rank, rivalries, relatives. Close with their legacy.`,
	},
	{
		id: "game-recap",
		tier: "dependent",
		title: "Game Recap (beat writer)",
		inputs: ["gameIndex.json", "teams.json", "players.json"],
		evidence: ["gameIndex.boxScoreIncluded", "gameIndex.seriesId"],
		prompt: `You are the beat writer for the winning team's city. Pick a game whose index row has \`boxScoreIncluded: true\` (otherwise its box score is not in this bundle), pull it with pull_games.py, and write a 4-6 paragraph recap with a headline. Use the surrounding context — both teams' records that season, any rivalry, and, if \`seriesId\` is set, the playoff round and where this game sat in the series (\`seriesGameNumber\`, and the series score from playoffSeries.json). The box score's \`clutchPlaysDetail\` gives you the decisive moments as structured records; lead with one. Every claim traceable to the data.`,
	},
	{
		id: "league-year-in-review",
		tier: "dependent",
		title: "League Year in Review",
		inputs: [
			"awards.json",
			"teams.json",
			"rankings.json",
			"playoffSeries.json",
		],
		evidence: ["awards.mvp", "awards.allLeague"],
		prompt: `Write a "State of the League" review of one season: the title race and champion (playoffSeries.json for the bracket), the MVP case (awards.json — note that ZenGM awards have no vote totals, so argue the case from the stat lines rather than inventing a margin), the biggest surprise and disappointment, and the storylines that will be remembered. Rank the season's top 5 teams with one-line justifications rooted in the standings and point differential. Note where any team-season or performance landed on the all-time lists.`,
	},
];

// The mechanism that keeps a swarm self-consistent (§5). Tier 1 emits these; Tier 2 consumes them.
export const CANON_INDEX_NOTE = `Canon index: as Tier-1 (foundational) pieces are written, collect their canonical claims into a canon-index file — a list of { subject: <pid | tid | tid-pair | tid+season>, claim: "<one line>", source: "<article id>" }. When writing any Tier-2 (dependent) piece, load the canon-index entries relevant to that piece's subject and treat them as established facts to stay consistent with. This is what prevents a franchise history and a season retrospective from contradicting each other across hundreds of articles.`;

// What the shipped docs actually instruct a reader to open and argue from, scoped to the prompts
// that survive into this particular bundle. validate.ts checks every entry against the assembled
// knowledge base, so the workflow can never again reference a table or a field that isn't there.
export const documentedReadsFor = (
	bundleFiles: string[],
): { files: string[]; claims: { path: string; describe: string }[] } => {
	const available = new Set(bundleFiles);
	const applicable = [...FOUNDATIONAL_PROMPTS, ...DEPENDENT_PROMPTS].filter(
		(p) => p.inputs.every((f) => available.has(f)),
	);

	const files = [...new Set(applicable.flatMap((p) => p.inputs))].sort();
	const claims = new Map<string, string>();
	for (const p of applicable) {
		for (const path of p.evidence) {
			claims.set(path, `used by the "${p.title}" prompt`);
		}
	}

	return {
		files,
		claims: [...claims.entries()].map(([path, describe]) => ({
			path,
			describe,
		})),
	};
};

// pull_games.py — shipped verbatim in the bundle. The index-driven box-score filter (§4a): resolve
// gids from gameIndex.json, then pull just those games.
//
// It defaults to the *single-file* bundle, because that is how this export is actually delivered -
// one JSON object keyed by path, with no directory and no NDJSON shards on disk. v1's script
// assumed a directory layout that only exists if you unpack the bundle yourself, so its very first
// file open failed on the file it ships next to. Both layouts work now.
export const PULL_GAMES_PY = `#!/usr/bin/env python3
"""Pull specific box scores out of a ZenGM Story Export bundle.

Reads gameIndex.json to resolve which gids you want, then pulls just those game objects out of the
bundle. Works against either delivery shape:

  * the single JSON file this export downloads as (default), or
  * a directory, if you have unpacked the bundle's keys into files.

Examples:

    python pull_games.py --bundle export.json --pid 1234              # every game he appeared in
    python pull_games.py --bundle export.json --pid 1234 --notable    # only his standout games
    python pull_games.py --bundle export.json --season 2016 --playoffs
    python pull_games.py --bundle export.json --tid 5 --season 2016
    python pull_games.py --bundle export.json --series 2016-R4-3v11   # a whole playoff series
    python pull_games.py --bundle export.json --pid 1234 --ids-only   # just the gids

Output is NDJSON (one game per line) on stdout. Requires only the Python 3 standard library.

Not every game's box score ships: the notable-games shard is capped, and the full per-season bulk is
opt-in at export time. Rows whose 'boxScoreIncluded' is false can be identified and described from
the index, but their box scores are not in the bundle - re-export with full game detail to get them.
"""
import argparse, json, os, sys


def load_bundle(path):
    """Returns (index, get_games) where get_games yields box-score dicts for a set of gids."""
    if os.path.isdir(path):
        with open(os.path.join(path, "gameIndex.json"), encoding="utf-8") as f:
            index = json.load(f)

        def get_games(wanted_by_season, all_gids):
            notable = os.path.join(path, "notableGames.json")
            if os.path.exists(notable):
                with open(notable, encoding="utf-8") as f:
                    for game in json.load(f):
                        if game.get("gid") in all_gids:
                            yield game
            for season, gids in sorted(wanted_by_season.items()):
                shard = os.path.join(path, "games", "season-%d.ndjson" % season)
                if not os.path.exists(shard):
                    continue
                with open(shard, encoding="utf-8") as f:
                    for line in f:  # streamed: one game per line, constant memory
                        obj = json.loads(line)
                        if obj.get("gid") in gids:
                            yield obj

        return index, get_games

    # Single-file bundle: one JSON object keyed by path.
    with open(path, encoding="utf-8-sig") as f:
        bundle = json.load(f)
    index = bundle.get("gameIndex.json", [])

    def get_games(wanted_by_season, all_gids):
        for game in bundle.get("notableGames.json", []) or []:
            if game.get("gid") in all_gids:
                yield game
        for key, value in bundle.items():
            if not key.startswith("games/") or not isinstance(value, str):
                continue
            for line in value.splitlines():
                if not line.strip():
                    continue
                obj = json.loads(line)
                if obj.get("gid") in all_gids:
                    yield obj

    return index, get_games


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", default="."
                    , help="path to the exported .json bundle, or an unpacked bundle directory")
    ap.add_argument("--pid", type=int, help="player id the game must include")
    ap.add_argument("--tid", type=int, help="team id in the game")
    ap.add_argument("--season", type=int)
    ap.add_argument("--playoffs", action="store_true")
    ap.add_argument("--series", help="seriesId, e.g. 2016-R4-3v11")
    ap.add_argument("--notable", action="store_true", help="only notable games")
    ap.add_argument("--available", action="store_true",
                    help="only games whose box score is actually in this bundle")
    ap.add_argument("--notable-for-pid", action="store_true",
                    help="with --pid, only games where that player was a standout")
    ap.add_argument("--ids-only", action="store_true",
                    help="print matching gids, don't fetch box scores")
    args = ap.parse_args()

    index, get_games = load_bundle(args.bundle)

    wanted = {}
    for row in index:
        if args.season is not None and row["season"] != args.season: continue
        if args.playoffs and not row.get("playoffs"): continue
        if args.series is not None and row.get("seriesId") != args.series: continue
        if args.tid is not None and args.tid not in row["tids"]: continue
        if args.pid is not None and args.pid not in row["pids"]: continue
        if args.notable and not row["notable"]: continue
        if args.available and not row.get("boxScoreIncluded"): continue
        if args.notable_for_pid and args.pid is not None and args.pid not in row["notablePids"]:
            continue
        wanted.setdefault(row["season"], set()).add(row["gid"])

    all_gids = set(g for gids in wanted.values() for g in gids)
    if args.ids_only:
        print(json.dumps(sorted(all_gids)))
        return

    found = set()
    for game in get_games(wanted, all_gids):
        if game.get("gid") in found:
            continue
        found.add(game.get("gid"))
        sys.stdout.write(json.dumps(game) + "\\n")

    missing = len(all_gids) - len(found)
    if missing:
        print("%d of %d matching games have no box score in this bundle "
              "(see 'boxScoreIncluded' in gameIndex.json; re-export with full game detail)."
              % (missing, len(all_gids)), file=sys.stderr)


if __name__ == "__main__":
    main()
`;
