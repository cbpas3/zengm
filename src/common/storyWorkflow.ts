// Story-export workflow + prompt library (AI Story Export, Phase 1, §5/§6 in
// AI_STORY_EXPORT_PLAN.md). Shipped as data so the export bundle can embed it (README +
// canon-workflow.md) and the UI can show the prompts. This is the "bring your own model / swarm"
// half: the fork produces facts + canon seeds; these prompts drive the writing off-device.
//
// Kept in common/ so both the worker (serializing the bundle) and the UI (previewing prompts) can
// import it without duplication.

// The non-negotiable framing every prompt inherits. Mirrors Feature 2's "ROSTER DATA IS GROUND
// TRUTH" constraint - it matters just as much for a strong model, which will otherwise pattern-match
// simulated players onto real NBA history.
export const GROUND_TRUTH_PREAMBLE = `You are writing about a *fictional* basketball simulation league. Every player, team, and result below is invented by the simulation. The data in this bundle is the complete and authoritative record — treat it as ground truth. Do not import real-world NBA players, teams, records, or events, and do not invent facts that aren't supported by the data. When you cite a number or a result, it must be traceable to the bundle.`;

export type StoryTier = "foundational" | "dependent";

export type StoryPromptTemplate = {
	id: string;
	tier: StoryTier;
	title: string;
	// Which bundle tables the piece primarily reads (for the workflow doc's guidance).
	inputs: string[];
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
		inputs: ["rankings.players", "players", "teams"],
		prompt: `Using rankings.players (already scored by career win shares, peak, and accolades) plus the players table for detail, write a ranked "Greatest Players in League History" feature covering the top 15-25. For each: their peak, what they won (rings, MVPs), the teams they defined, and the case for their placement. Argue from the evidence fields (careerWS, peakWS, rings, topAwards, primeSpan). Where two players are close, make the comparison explicit. End by emitting a canonical-claims list: for each player, a one-line "regarded as the Nth-greatest player ever" claim keyed by pid.`,
	},
	{
		id: "greatest-teams",
		tier: "foundational",
		title: "The Greatest Team-Seasons Ever",
		inputs: ["rankings.teamSeasons", "teams", "players"],
		prompt: `Using rankings.teamSeasons (scored by win%, point differential, and playoff success), write "The Greatest Teams in League History." Profile the top 10-15 team-seasons: their record and margin, who led them, how their playoff run went, and whether they won it all (wonTitle). Cross-reference the teams table for franchise context and players for the stars. Emit canonical claims: "the {season} {team} rank among the greatest teams ever," keyed by tid+season.`,
	},
	{
		id: "busts-and-steals",
		tier: "foundational",
		title: "Biggest Busts & Steals",
		inputs: ["rankings.busts", "rankings.steals", "players"],
		prompt: `Using rankings.busts (first-round picks who most underperformed their draft slot) and rankings.steals (late/second-round picks who most overperformed), write a two-part draft-history piece. For each name, contrast the expectation (round/pick, expectedWS) with what actually happened (careerWS, delta), and tell the short version of why. Emit canonical claims tagging each player as a notable bust or steal, keyed by pid.`,
	},
	{
		id: "great-rivalries",
		tier: "foundational",
		title: "The Great Rivalries",
		inputs: ["rivalries", "teams", "playoffSeries"],
		prompt: `Using the rivalries table (ranked by intensity: repeat playoff meetings, deep rounds, close series, near-even all-time records), write "The Defining Rivalries" of the league. For each top rivalry: the all-time regular-season record, every playoff meeting (season, round, who won and how close), and how the balance of power shifted. Name the players who embodied it (join via the teams' rosters those seasons). Emit canonical claims describing each rivalry, keyed by the tid pair.`,
	},
	{
		id: "dynasties",
		tier: "foundational",
		title: "The Dynasties",
		inputs: ["dynasties", "teams", "players"],
		prompt: `Using the dynasties table (clusters of titles within a short window), write a chronicle of the league's dynasties. For each: the title seasons, the span, the core players who anchored it (from the teams' rosters those seasons and the players table), and what ended it. Rank them. Emit canonical claims naming each dynasty and its era, keyed by tid.`,
	},
	{
		id: "franchise-histories",
		tier: "foundational",
		title: "Franchise Histories",
		inputs: ["teams", "players", "rivalries"],
		prompt: `Using the teams table (per-season records, titleSeasons, titleDrought, all-time record) write a one-page history for each franchise: their founding-to-present arc, championships and droughts, defining players and eras, and their fiercest rivals (from the rivalries table). Emit canonical claims: each franchise's identity in one line, keyed by tid.`,
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
		inputs: ["teams", "players", "playoffSeries", "gameIndex", "canon claims"],
		prompt: `Write an 800-1000 word retrospective on one team's season, told as a story with an arc: preseason identity → turning point → how it ended. Use the team's season row, its roster's stat lines, the playoff series it played, and (via the game index + pull_games) its signature games. Weave in the established canon: where this season sits in the franchise's history, any rivalry stakes, whether a player was mid-breakthrough. Don't summarize game-by-game — find the throughline.`,
	},
	{
		id: "player-career",
		tier: "dependent",
		title: "Player Career Profile",
		inputs: ["players", "rankings.players", "gameIndex", "canon claims"],
		prompt: `Write a career-retrospective feature on one player. Establish their peak, their defining season, how their game evolved (use the ratings trajectory and career stat lines), the teams and moves that shaped them (transactions), and their signature games (game index, filtered to their notable games via pull_games). Place them against the canon: their all-time rank, rivalries, relatives. Close with their legacy.`,
	},
	{
		id: "game-recap",
		tier: "dependent",
		title: "Game Recap (beat writer)",
		inputs: ["one game box score", "teams", "canon claims"],
		prompt: `You are the beat writer for the winning team's city. Using a single game's box score (pulled by gid via pull_games) plus the surrounding context — both teams' records that season, any rivalry, playoff stakes, whether a performance was a career night — write a 4-6 paragraph recap with a headline. Lead with the decisive moment. Every claim traceable to the data.`,
	},
	{
		id: "league-year-in-review",
		tier: "dependent",
		title: "League Year in Review",
		inputs: ["seasons/awards", "teams", "rankings", "canon claims"],
		prompt: `Write a "State of the League" review of one season: the title race and champion, the MVP case, the biggest surprise and disappointment, and the storylines that will be remembered. Rank the season's top 5 teams with one-line justifications rooted in the standings. Note where any team-season or performance landed on the all-time lists.`,
	},
];

// The mechanism that keeps a swarm self-consistent (§5). Tier 1 emits these; Tier 2 consumes them.
export const CANON_INDEX_NOTE = `Canon index: as Tier-1 (foundational) pieces are written, collect their canonical claims into a canon-index file — a list of { subject: <pid | tid | tid-pair | tid+season>, claim: "<one line>", source: "<article id>" }. When writing any Tier-2 (dependent) piece, load the canon-index entries relevant to that piece's subject and treat them as established facts to stay consistent with. This is what prevents a franchise history and a season retrospective from contradicting each other across hundreds of articles.`;

// pull_games.py — shipped verbatim in the bundle. The index-driven, constant-memory box-score
// filter (§4a): resolve gids from gameIndex.json by pid/season/notable, then stream just those out
// of the (opt-in) per-season NDJSON shards. Stdlib only, so it runs anywhere Python 3 does.
export const PULL_GAMES_PY = `#!/usr/bin/env python3
"""Pull specific box scores out of a ZenGM Story Export bundle without scanning the whole thing.

Reads gameIndex.json to resolve which gids you want, then streams just those game objects out of
the per-season NDJSON shards in games/ (constant memory). Examples:

    python pull_games.py --pid 1234                # every game that player appeared in
    python pull_games.py --pid 1234 --notable      # only his standout games
    python pull_games.py --season 2016 --playoffs  # a season's playoff games
    python pull_games.py --tid 5 --season 2016     # one team's season

Output is NDJSON (one game per line) on stdout. Requires only the Python 3 standard library. The
games/ shards ship only if the bundle was exported with "include full game detail"; without them
this still tells you which gids match (use --ids-only)."""
import argparse, json, os, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", default=".", help="path to the bundle dir")
    ap.add_argument("--pid", type=int, help="player id the game must include")
    ap.add_argument("--tid", type=int, help="team id in the game")
    ap.add_argument("--season", type=int)
    ap.add_argument("--playoffs", action="store_true")
    ap.add_argument("--notable", action="store_true", help="only notable games")
    ap.add_argument("--notable-for-pid", action="store_true",
                    help="with --pid, only games where that player was a standout")
    ap.add_argument("--ids-only", action="store_true", help="print matching gids, don't fetch box scores")
    args = ap.parse_args()

    index_path = os.path.join(args.bundle, "gameIndex.json")
    with open(index_path) as f:
        index = json.load(f)

    wanted = {}
    for row in index:
        if args.season is not None and row["season"] != args.season: continue
        if args.playoffs and not row["playoffs"]: continue
        if args.tid is not None and args.tid not in row["tids"]: continue
        if args.pid is not None and args.pid not in row["pids"]: continue
        if args.notable and not row["notable"]: continue
        if args.notable_for_pid and args.pid is not None and args.pid not in row["notablePids"]: continue
        wanted.setdefault(row["season"], set()).add(row["gid"])

    all_gids = sorted(g for gids in wanted.values() for g in gids)
    if args.ids_only or not os.path.isdir(os.path.join(args.bundle, "games")):
        if not args.ids_only:
            print("(no games/ shards in this bundle — re-export with full game detail; matching gids below)", file=sys.stderr)
        print(json.dumps(all_gids))
        return

    for season, gids in sorted(wanted.items()):
        shard = os.path.join(args.bundle, "games", "season-%d.ndjson" % season)
        if not os.path.exists(shard): continue
        with open(shard) as f:
            for line in f:                       # streamed: one game per line, constant memory
                gid = line[:64].split(':', 1)[0]  # fast pre-check on the leading "gid":N is optional
                obj = json.loads(line)
                if obj.get("gid") in gids:
                    sys.stdout.write(line if line.endswith("\\n") else line + "\\n")

if __name__ == "__main__":
    main()
`;
