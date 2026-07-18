// Knowledge-base assembly (AI Story Export, Phase 1, §3/§7 in AI_STORY_EXPORT_PLAN.md).
//
// Pure orchestrator: takes the already-loaded raw arrays (+ the streamed game index) and runs the
// projection/derivation modules to produce the full compact table set. Kept pure and DB-free so it's
// unit-testable; the worker view owns the idb reads and the (memory-sensitive) game-index streaming,
// then calls this. The game index is passed in precomputed rather than built here, so this never has
// to hold all ~900k games in memory at once.

import { deriveCanon } from "./deriveCanon.ts";
import { attachTitles, projectPlayer, projectTeams } from "./projectEntities.ts";
import type {
	GameIndexRow,
	KnowledgeBase,
	RawHeadToHead,
	RawPlayer,
	RawPlayoffSeries,
	RawTeam,
} from "./types.ts";

export type AssembleInput = {
	players: RawPlayer[];
	teams: RawTeam[];
	playoffSeries?: RawPlayoffSeries[];
	headToHeads?: RawHeadToHead[];
	gameIndex?: GameIndexRow[];
	notableGids?: number[];
	leagueName?: string;
	generatedAtSeason?: number;
};

export const assembleKnowledgeBase = (input: AssembleInput): KnowledgeBase => {
	const {
		players,
		teams,
		playoffSeries = [],
		headToHeads = [],
		gameIndex = [],
		notableGids = [],
		leagueName,
		generatedAtSeason,
	} = input;

	const projectedTeams = projectTeams(teams);
	attachTitles(teams, projectedTeams);

	const projectedPlayers = players.map(projectPlayer);
	const canon = deriveCanon(players, teams, playoffSeries, headToHeads);

	// Count distinct seasons across team histories (a reasonable "how long is this league" number).
	const seasonSet = new Set<number>();
	for (const t of teams) {
		for (const s of t.seasons) {
			seasonSet.add(s.season);
		}
	}

	return {
		meta: {
			format: "zengm-story-export",
			version: 1,
			leagueName,
			generatedAtSeason,
			counts: {
				players: projectedPlayers.length,
				teams: projectedTeams.filter((t) => !t.disabled).length,
				games: gameIndex.length,
				seasons: seasonSet.size,
			},
		},
		players: projectedPlayers,
		teams: projectedTeams,
		canon,
		gameIndex,
		notableGids,
	};
};
