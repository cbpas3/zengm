// Knowledge-base assembly (AI Story Export, §3/§7 in AI_STORY_EXPORT_PLAN.md).
//
// Pure orchestrator: takes the already-loaded raw arrays (+ the streamed game index) and runs the
// projection/derivation modules to produce the full compact table set. Kept pure and DB-free so it's
// unit-testable; the worker loader owns the idb reads and the (memory-sensitive) game-index
// streaming, then calls this. The game index is passed in precomputed rather than built here, so
// this never has to hold every game in memory at once.

import { buildDataCoverage } from "./dataCoverage.ts";
import { deriveCanon } from "./deriveCanon.ts";
import { deriveLeaderboards } from "./deriveLeaderboards.ts";
import {
	buildSeedLookup,
	projectPlayoffSeries,
} from "./derivePlayoffSeries.ts";
import {
	attachTitles,
	projectPlayer,
	projectTeams,
	type SeasonPointTotals,
} from "./projectEntities.ts";
import type {
	GameIndexRow,
	KnowledgeBase,
	ProjectedAwardsSeason,
	ProjectedPlayer,
	RawAwardsRow,
	RawConf,
	RawDiv,
	RawEvent,
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
	awards?: RawAwardsRow[];
	events?: RawEvent[];
	confs?: RawConf[];
	divs?: RawDiv[];
	gameIndex?: GameIndexRow[];
	notableGids?: number[];
	pointsFromGames?: Map<number, Map<number, SeasonPointTotals>>;
	highlightGamesByPid?: Map<number, ProjectedPlayer["highlightGames"]>;
	gameLengthMinutes?: number;
	leagueName?: string;
	generatedAtSeason?: number;
};

const projectAwards = (rows: RawAwardsRow[]): ProjectedAwardsSeason[] =>
	[...rows]
		.sort((a, b) => a.season - b.season)
		.map((a) => ({
			season: a.season,
			mvp: a.mvp ?? null,
			dpoy: a.dpoy ?? null,
			roy: a.roy ?? null,
			smoy: a.smoy ?? null,
			mip: a.mip ?? null,
			finalsMvp: a.finalsMvp ?? null,
			allLeague: a.allLeague ?? [],
			allDefensive: a.allDefensive ?? [],
			allRookie: a.allRookie ?? [],
			bestRecordTid: a.bestRecord?.tid ?? null,
		}));

export const assembleKnowledgeBase = (input: AssembleInput): KnowledgeBase => {
	const {
		players,
		teams,
		playoffSeries = [],
		headToHeads = [],
		awards = [],
		events = [],
		confs = [],
		divs = [],
		gameIndex = [],
		notableGids = [],
		pointsFromGames,
		highlightGamesByPid,
		gameLengthMinutes,
		leagueName,
		generatedAtSeason,
	} = input;

	const projectedPlayoffSeries = projectPlayoffSeries(playoffSeries);

	const projectedTeams = projectTeams(teams, {
		pointsFromGames,
		seedsByTidSeason: buildSeedLookup(playoffSeries),
		confs,
		divs,
		gameLengthMinutes,
	});
	attachTitles(teams, projectedTeams, generatedAtSeason);

	const eventsByEid = new Map(events.map((e) => [e.eid, e]));
	const projectedPlayers = players.map((p) =>
		projectPlayer(p, { eventsByEid, highlightGamesByPid }),
	);

	const canon = deriveCanon(players, teams, playoffSeries, headToHeads, {
		pointsFromGames,
		projectedPlayoffSeries,
	});

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
			version: 2,
			leagueName: leagueName ?? null,
			generatedAtSeason: generatedAtSeason ?? null,
			counts: {
				players: projectedPlayers.length,
				teams: projectedTeams.filter((t) => !t.disabled).length,
				// v1 reported only the active count while teams.json carried the defunct franchises
				// too, so the two never agreed.
				teamsIncludingDisabled: projectedTeams.length,
				games: gameIndex.length,
				gamesWithBoxScores: gameIndex.filter((r) => r.boxScoreIncluded).length,
				seasons: seasonSet.size,
				playoffSeries: projectedPlayoffSeries.length,
			},
			// Stamped by the serializer, which is the only thing that knows what was actually written.
			files: [],
			dataCoverage: buildDataCoverage(projectedPlayers, projectedTeams),
			validation: { passed: true, issues: [] },
		},
		players: projectedPlayers,
		teams: projectedTeams,
		conferences: confs,
		divisions: divs,
		canon,
		playoffSeries: projectedPlayoffSeries,
		awards: projectAwards(awards),
		leaderboards: deriveLeaderboards(players),
		gameIndex,
		notableGids,
	};
};
