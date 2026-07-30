// Page inventory for the mobile-first accessibility audit.
//
// One canonical URL per view module, grouped by the archetypes in
// MOBILE_FIRST_ACCESSIBILITY_PLAN.md §10. Route patterns come from
// src/ui/util/routeInfos.ts; the params here are substituted with values that exist in the
// league that tools/a11y/bootstrapLeague.ts creates.
//
// Extra variants of the same view are only listed when the layout differs materially (e.g.
// player_stats with statType=advanced has a much wider table than the default).

export type Archetype =
	| "datatable"
	| "dashboard"
	| "roster"
	| "player"
	| "bracket"
	| "form"
	| "transaction"
	| "live"
	| "boxscore"
	| "chart"
	| "tool";

export type RouteSpec = {
	// Stable id used for screenshot filenames and report keys
	id: string;
	// Path relative to the origin. `{lid}`, `{pid}`, `{season}`, `{abbrev}`, `{gid}`, `{eid}` are
	// substituted from the bootstrapped league's fixture data.
	path: string;
	archetype: Archetype;
	// Skip reason, if this route can't be audited automatically
	skip?: string;
};

export const ROUTES: RouteSpec[] = [
	// ---------------------------------------------------------------- non-league
	{ id: "dashboard", path: "/", archetype: "dashboard" },
	{ id: "newLeague", path: "/new_league", archetype: "form" },
	{ id: "achievements", path: "/achievements", archetype: "tool" },
	{ id: "globalSettings", path: "/settings", archetype: "form" },
	{ id: "defaultNewLeagueSettings", path: "/settings/default", archetype: "form" },
	{ id: "keyboardShortcuts", path: "/settings/keyboard", archetype: "tool" },
	{ id: "loginOrRegister", path: "/account/login_or_register", archetype: "form" },
	{ id: "lostPassword", path: "/account/lost_password", archetype: "form" },
	{ id: "account", path: "/account", archetype: "tool" },
	{ id: "dropbox", path: "/dropbox", archetype: "tool" },
	{ id: "exhibition", path: "/exhibition", archetype: "live" },

	// ---------------------------------------------------------------- dashboards
	{ id: "leagueDashboard", path: "/l/{lid}", archetype: "dashboard" },
	{ id: "inbox", path: "/l/{lid}/inbox", archetype: "dashboard" },
	{ id: "news", path: "/l/{lid}/news", archetype: "dashboard" },
	{ id: "dailySchedule", path: "/l/{lid}/daily_schedule", archetype: "dashboard" },
	{ id: "seasonPreview", path: "/l/{lid}/season_preview", archetype: "dashboard" },
	{ id: "frivolities", path: "/l/{lid}/frivolities", archetype: "dashboard" },
	{ id: "gmHistory", path: "/l/{lid}/gm_history", archetype: "dashboard" },

	// ---------------------------------------------------------------- roster family
	{ id: "roster", path: "/l/{lid}/roster", archetype: "roster" },
	{ id: "depth", path: "/l/{lid}/depth", archetype: "roster" },
	{ id: "schedule", path: "/l/{lid}/schedule", archetype: "roster" },
	{ id: "teamHistory", path: "/l/{lid}/team_history", archetype: "roster" },
	{ id: "teamFinances", path: "/l/{lid}/team_finances", archetype: "roster" },
	{ id: "protectPlayers", path: "/l/{lid}/protect_players", archetype: "roster" },
	{ id: "expansionDraft", path: "/l/{lid}/expansion_draft", archetype: "roster" },
	{ id: "fantasyDraft", path: "/l/{lid}/fantasy_draft", archetype: "roster" },

	// ---------------------------------------------------------------- player detail
	{ id: "player", path: "/l/{lid}/player/{pid}", archetype: "player" },
	{
		id: "playerGameLog",
		path: "/l/{lid}/player_game_log/{pid}/{season}",
		archetype: "player",
	},
	{ id: "customizePlayer", path: "/l/{lid}/customize_player/{pid}", archetype: "form" },
	{ id: "comparePlayers", path: "/l/{lid}/compare_players", archetype: "player" },
	{ id: "relatives", path: "/l/{lid}/frivolities/relatives", archetype: "datatable" },

	// ---------------------------------------------------------------- pure DataTable
	{ id: "playerStats", path: "/l/{lid}/player_stats", archetype: "datatable" },
	{
		id: "playerStatsAdvanced",
		path: "/l/{lid}/player_stats/all/{season}/advanced",
		archetype: "datatable",
	},
	{ id: "playerRatings", path: "/l/{lid}/player_ratings", archetype: "datatable" },
	{ id: "playerBios", path: "/l/{lid}/player_bios", archetype: "datatable" },
	{ id: "freeAgents", path: "/l/{lid}/free_agents", archetype: "datatable" },
	{ id: "upcomingFreeAgents", path: "/l/{lid}/upcoming_free_agents", archetype: "datatable" },
	{ id: "leaders", path: "/l/{lid}/leaders", archetype: "datatable" },
	{ id: "leadersYears", path: "/l/{lid}/leaders_years", archetype: "datatable" },
	{ id: "leadersProgressive", path: "/l/{lid}/leaders_progressive", archetype: "datatable" },
	{ id: "hallOfFame", path: "/l/{lid}/hall_of_fame", archetype: "datatable" },
	{ id: "draftHistory", path: "/l/{lid}/draft_history", archetype: "datatable" },
	{ id: "draftTeamHistory", path: "/l/{lid}/draft_team_history", archetype: "datatable" },
	{ id: "draftScouting", path: "/l/{lid}/draft_scouting", archetype: "datatable" },
	{ id: "draftPicks", path: "/l/{lid}/draft_picks", archetype: "datatable" },
	{ id: "transactions", path: "/l/{lid}/transactions", archetype: "datatable" },
	{ id: "injuries", path: "/l/{lid}/injuries", archetype: "datatable" },
	{ id: "watchList", path: "/l/{lid}/watch_list", archetype: "datatable" },
	{ id: "notes", path: "/l/{lid}/notes", archetype: "datatable" },
	{ id: "teamStats", path: "/l/{lid}/team_stats", archetype: "datatable" },
	{ id: "leagueStats", path: "/l/{lid}/league_stats", archetype: "datatable" },
	{ id: "leagueFinances", path: "/l/{lid}/league_finances", archetype: "datatable" },
	{ id: "powerRankings", path: "/l/{lid}/power_rankings", archetype: "datatable" },
	{ id: "teamRecords", path: "/l/{lid}/team_records", archetype: "datatable" },
	{ id: "awardsRecords", path: "/l/{lid}/awards_records", archetype: "datatable" },
	{ id: "awardRaces", path: "/l/{lid}/award_races", archetype: "datatable" },
	{ id: "playerFeats", path: "/l/{lid}/player_feats", archetype: "datatable" },
	{ id: "eventLog", path: "/l/{lid}/event_log", archetype: "datatable" },
	{ id: "historyAll", path: "/l/{lid}/history_all", archetype: "datatable" },
	{ id: "history", path: "/l/{lid}/history", archetype: "datatable" },
	{ id: "colleges", path: "/l/{lid}/frivolities/colleges", archetype: "datatable" },
	{ id: "countries", path: "/l/{lid}/frivolities/countries", archetype: "datatable" },
	{
		id: "frivolitiesDraftClasses",
		path: "/l/{lid}/frivolities/draft_classes",
		archetype: "datatable",
	},
	{
		id: "frivolitiesDraftPosition",
		path: "/l/{lid}/frivolities/draft_position",
		archetype: "datatable",
	},
	{
		id: "frivolitiesJerseyNumbers",
		path: "/l/{lid}/frivolities/jersey_numbers",
		archetype: "datatable",
	},
	{
		id: "frivolitiesTeamSeasons",
		path: "/l/{lid}/frivolities/teams/best_nonchamps",
		archetype: "datatable",
	},
	{
		id: "frivolitiesTrades",
		path: "/l/{lid}/frivolities/trades/biggest",
		archetype: "datatable",
	},
	{ id: "most", path: "/l/{lid}/frivolities/most/games_no_playoffs", archetype: "datatable" },
	{ id: "tragicDeaths", path: "/l/{lid}/frivolities/tragic_deaths", archetype: "datatable" },
	{
		id: "advancedPlayerSearch",
		path: "/l/{lid}/advanced_player_search",
		archetype: "datatable",
	},
	{ id: "scheduledEvents", path: "/l/{lid}/scheduled_events", archetype: "datatable" },
	{ id: "headToHead", path: "/l/{lid}/head2head", archetype: "datatable" },
	{ id: "headToHeadAll", path: "/l/{lid}/head2head_all", archetype: "datatable" },
	{ id: "allStarHistory", path: "/l/{lid}/all_star/history", archetype: "datatable" },
	{ id: "exportPlayers", path: "/l/{lid}/export_players", archetype: "datatable" },

	// ---------------------------------------------------------------- brackets / structured
	{ id: "standings", path: "/l/{lid}/standings", archetype: "bracket" },
	{ id: "playoffs", path: "/l/{lid}/playoffs", archetype: "bracket" },
	{ id: "draftLottery", path: "/l/{lid}/draft_lottery", archetype: "bracket" },
	{ id: "allStar", path: "/l/{lid}/all_star", archetype: "bracket" },
	{ id: "allStarTeams", path: "/l/{lid}/all_star/teams", archetype: "bracket" },
	{ id: "allStarDunk", path: "/l/{lid}/all_star/dunk", archetype: "bracket" },
	{ id: "allStarThree", path: "/l/{lid}/all_star/three", archetype: "bracket" },
	{
		id: "rosterContinuity",
		path: "/l/{lid}/frivolities/roster_continuity",
		archetype: "bracket",
	},

	// ---------------------------------------------------------------- long forms
	{ id: "settings", path: "/l/{lid}/settings", archetype: "form" },
	{ id: "godMode", path: "/l/{lid}/god_mode", archetype: "form" },
	{ id: "manageTeams", path: "/l/{lid}/manage_teams", archetype: "form" },
	{ id: "manageConfs", path: "/l/{lid}/manage_confs", archetype: "form" },
	{ id: "scheduleEditor", path: "/l/{lid}/schedule_editor", archetype: "form" },
	{ id: "editAwards", path: "/l/{lid}/edit_awards", archetype: "form" },
	{ id: "multiTeamMode", path: "/l/{lid}/multi_team_mode", archetype: "form" },
	{ id: "newTeam", path: "/l/{lid}/new_team", archetype: "form" },
	{ id: "autoExpand", path: "/l/{lid}/auto_expand", archetype: "form" },
	{ id: "autoRelocate", path: "/l/{lid}/auto_relocate", archetype: "form" },

	// ---------------------------------------------------------------- transactional
	{ id: "trade", path: "/l/{lid}/trade", archetype: "transaction" },
	{ id: "tradingBlock", path: "/l/{lid}/trading_block", archetype: "transaction" },
	{ id: "tradeProposals", path: "/l/{lid}/trade_proposals", archetype: "transaction" },
	{ id: "savedTrades", path: "/l/{lid}/saved_trades", archetype: "transaction" },
	{ id: "negotiationList", path: "/l/{lid}/negotiation", archetype: "transaction" },
	{ id: "draft", path: "/l/{lid}/draft", archetype: "transaction" },

	// ---------------------------------------------------------------- live / box score
	{ id: "liveGame", path: "/l/{lid}/live_game", archetype: "live" },
	{ id: "gameLog", path: "/l/{lid}/game_log", archetype: "boxscore" },

	// ---------------------------------------------------------------- charts
	{ id: "playerGraphs", path: "/l/{lid}/player_graphs", archetype: "chart" },
	{ id: "teamGraphs", path: "/l/{lid}/team_graphs", archetype: "chart" },
	{ id: "playerRatingDists", path: "/l/{lid}/player_rating_dists", archetype: "chart" },
	{ id: "playerStatDists", path: "/l/{lid}/player_stat_dists", archetype: "chart" },
	{ id: "teamStatDists", path: "/l/{lid}/team_stat_dists", archetype: "chart" },

	// ---------------------------------------------------------------- tools
	{ id: "exportLeague", path: "/l/{lid}/export_league", archetype: "tool" },
	{ id: "exportStats", path: "/l/{lid}/export_stats", archetype: "tool" },
	{ id: "exportStory", path: "/l/{lid}/export_story", archetype: "tool" },
	{ id: "importPlayers", path: "/l/{lid}/import_players", archetype: "tool" },
	{ id: "importPlayersReal", path: "/l/{lid}/import_players_real", archetype: "tool" },
	{ id: "deleteOldData", path: "/l/{lid}/delete_old_data", archetype: "tool" },
	{ id: "dangerZone", path: "/l/{lid}/danger_zone", archetype: "tool" },
];

// Routes that need a param the bootstrap may not have produced (a specific gid, eid, or an
// in-progress negotiation). Audited only when the fixture supplies the value.
export const CONDITIONAL_ROUTES: RouteSpec[] = [
	{ id: "gameLogBoxScore", path: "/l/{lid}/game_log/{abbrev}/{season}/{gid}", archetype: "boxscore" },
	{ id: "tradeSummary", path: "/l/{lid}/trade_summary/{eid}", archetype: "transaction" },
	{ id: "message", path: "/l/{lid}/message", archetype: "tool" },
];

export type Fixture = {
	lid: number;
	pid?: number;
	season?: number;
	abbrev?: string;
	gid?: number;
	eid?: number;
};

export const resolvePath = (path: string, fixture: Fixture): string | undefined => {
	let out = path;
	for (const [key, value] of Object.entries(fixture)) {
		out = out.replaceAll(`{${key}}`, String(value));
	}
	// Anything left unresolved means the fixture didn't supply it
	if (out.includes("{")) {
		return undefined;
	}
	return out;
};
