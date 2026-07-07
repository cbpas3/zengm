import { idb } from "../db/index.ts";
import { g, helpers, getTeamInfoBySeason } from "./index.ts";
import getPlayoffsByConf from "../core/season/getPlayoffsByConf.ts";
import type {
	DevFocusType,
	EventBBGM,
	PlayerAward,
	TradeEventTeams,
} from "../../common/types.ts";

const DEV_FOCUS_LABELS: Record<DevFocusType, string> = {
	sharpshooter: "Sharpshooter",
	slasher: "Slasher",
	postScorer: "Post Scorer",
	playmaker: "Playmaker",
	threeAndD: "3-and-D",
	lockdown: "Lockdown",
	athletic: "Athletic",
	floorGeneral: "Floor General",
};

const SIMPLE_AWARD_KEYS = [
	"mvp",
	"roy",
	"smoy",
	"dpoy",
	"mip",
	"finalsMvp",
] as const;

type SignatureGame = {
	day: number | undefined;
	opponentAbbrev: string;
	homeAway: "home" | "away";
	result: "W" | "L";
	pts: number;
	oppPts: number;
	overtime: boolean;
	tag: string;
};

export type SeasonGroundTruth = {
	season: number;
	tid: number;
	teamName: string;
	abbrev: string;
	record: { won: number; lost: number; tied: number; otl: number };
	seed: number | undefined;
	howSeasonEnded: string;
	playoffSeries: {
		round: number;
		opponentAbbrev: string;
		won: number;
		lost: number;
		seriesWon: boolean;
	}[];
	regularSeasonArc:
		| {
				longestWinStreak: number;
				longestLossStreak: number;
				segments: { label: string; won: number; lost: number }[];
				signatureGames: SignatureGame[];
		  }
		| undefined;
	teamLeaders: {
		name: string;
		pts: number;
		trb: number;
		ast: number;
		gp: number;
		awardsThisSeason: string[];
	}[];
	leagueAwards: { type: string; playerName: string }[];
	trades: string[];
	devNotes: string[];
};

export const buildSeasonGroundTruth = async (
	tid: number,
	season: number,
): Promise<SeasonGroundTruth | null> => {
	const teamSeason = (
		await idb.getCopies.teamSeasons({ tid, season }, "noCopyCache")
	)[0];
	if (!teamSeason) {
		return null;
	}

	const numPlayoffRounds = g.get("numGamesPlayoffSeries", season).length;
	const playoffsByConf = await getPlayoffsByConf(season);
	const howSeasonEnded = helpers.roundsWonText({
		playoffRoundsWon: teamSeason.playoffRoundsWon,
		numPlayoffRounds,
		playoffsByConf,
		showMissedPlayoffs: true,
	});

	// Playoff series results + seed, from the playoffSeries store
	let seed: number | undefined;
	const playoffSeries: SeasonGroundTruth["playoffSeries"] = [];
	const playoffSeriesRecord = await idb.getCopy.playoffSeries(
		{ season },
		"noCopyCache",
	);
	if (playoffSeriesRecord) {
		for (let round = 0; round < playoffSeriesRecord.series.length; round++) {
			for (const matchup of playoffSeriesRecord.series[round]!) {
				const isHome = matchup.home.tid === tid;
				const isAway = matchup.away?.tid === tid;
				if (!isHome && !isAway) {
					continue;
				}

				const self = isHome ? matchup.home : matchup.away!;
				const opp = isHome ? matchup.away : matchup.home;
				if (seed === undefined) {
					seed = self.seed;
				}

				if (opp) {
					const oppTeamInfo = await getTeamInfoBySeason(opp.tid, season);
					playoffSeries.push({
						round: round + 1,
						opponentAbbrev: opp.abbrev ?? oppTeamInfo?.abbrev ?? "???",
						won: self.won,
						lost: opp.won,
						seriesWon: self.won > opp.won,
					});
				}
			}
		}
	}

	// Regular-season game log, queried opportunistically -- box scores may have
	// been pruned per the league's saveOldBoxScores.pastSeasons setting, in
	// which case we just omit this section rather than erroring.
	let regularSeasonArc: SeasonGroundTruth["regularSeasonArc"];
	const seasonGames = await idb.getCopies.games({ season }, "noCopyCache");
	const regGames = seasonGames
		.filter(
			(gm) =>
				!gm.playoffs && (gm.teams[0].tid === tid || gm.teams[1].tid === tid),
		)
		.sort((a, b) => a.gid - b.gid);

	if (regGames.length > 0) {
		let curStreakResult: "W" | "L" | undefined;
		let curStreakLen = 0;
		let longestWinStreak = 0;
		let longestLossStreak = 0;

		const allTeamsRecords = await idb.getCopies.teamsPlus(
			{
				attrs: ["tid"],
				seasonAttrs: ["won", "lost", "tied", "otl"],
				season,
				addDummySeason: true,
			},
			"noCopyCache",
		);
		const winpByTid: Record<number, number> = {};
		for (const t of allTeamsRecords) {
			winpByTid[t.tid] = helpers.calcWinp(t.seasonAttrs);
		}

		const candidates = regGames.map((gm) => {
			const result: "W" | "L" = gm.won.tid === tid ? "W" : "L";
			const ownPts = result === "W" ? gm.won.pts : gm.lost.pts;
			const oppPts = result === "W" ? gm.lost.pts : gm.won.pts;
			const oppTid = gm.won.tid === tid ? gm.lost.tid : gm.won.tid;

			if (curStreakResult === result) {
				curStreakLen += 1;
			} else {
				curStreakResult = result;
				curStreakLen = 1;
			}
			if (result === "W") {
				longestWinStreak = Math.max(longestWinStreak, curStreakLen);
			} else {
				longestLossStreak = Math.max(longestLossStreak, curStreakLen);
			}

			return {
				gm,
				result,
				ownPts,
				oppPts,
				oppTid,
				overtime: gm.overtimes > 0,
			};
		});

		const scored = candidates.map((c) => {
			const oppWinp = winpByTid[c.oppTid] ?? 0.5;
			const margin = c.ownPts - c.oppPts;
			let score = Math.abs(margin) * 0.05;
			let tag: string | undefined;

			if (c.result === "W" && oppWinp >= 0.6) {
				score += 3 + oppWinp * 2;
				tag = "Statement win over a contender";
			} else if (c.result === "L" && oppWinp <= 0.4) {
				score += 2 + (0.4 - oppWinp) * 5;
				tag = "Bad loss to a lottery-caliber team";
			}
			if (c.overtime) {
				score += 1;
				tag ??= "Overtime thriller";
			}
			tag ??= c.result === "W" ? "Notable win" : "Notable loss";

			return { ...c, score, tag };
		});

		scored.sort((a, b) => b.score - a.score);
		const topGames = scored.slice(0, 8).sort((a, b) => a.gm.gid - b.gm.gid);

		const signatureGames: SignatureGame[] = [];
		for (const c of topGames) {
			const oppTeamInfo = await getTeamInfoBySeason(c.oppTid, season);
			signatureGames.push({
				day: c.gm.day,
				opponentAbbrev: oppTeamInfo?.abbrev ?? "???",
				homeAway: c.gm.teams[0].tid === tid ? "home" : "away",
				result: c.result,
				pts: c.ownPts,
				oppPts: c.oppPts,
				overtime: c.overtime,
				tag: c.tag,
			});
		}

		// No literal calendar-month data is tracked by the sim, so the arc is
		// divided into quarters of the season by chronological game order.
		const segments: { label: string; won: number; lost: number }[] = [];
		const chunkSize = Math.ceil(regGames.length / 4);
		for (let i = 0; i < 4; i++) {
			const chunk = regGames.slice(i * chunkSize, (i + 1) * chunkSize);
			if (chunk.length === 0) {
				continue;
			}
			const won = chunk.filter((gm) => gm.won.tid === tid).length;
			segments.push({
				label: `Games ${i * chunkSize + 1}-${i * chunkSize + chunk.length}`,
				won,
				lost: chunk.length - won,
			});
		}

		regularSeasonArc = {
			longestWinStreak,
			longestLossStreak,
			segments,
			signatureGames,
		};
	}

	// Team statistical leaders + this season's awards
	const rosterPlayers = await idb.getCopies.players(
		{ activeSeason: season, statsTid: tid },
		"noCopyCache",
	);
	const playersWithStats = await idb.getCopies.playersPlus(rosterPlayers, {
		attrs: ["pid", "firstName", "lastName", "awards"],
		stats: ["pts", "trb", "ast", "gp"],
		season,
		tid,
		statType: "perGame",
	});

	const round1 = (x: number) => Math.round(x * 10) / 10;

	const teamLeaders = playersWithStats
		.filter((p) => p.stats.gp > 0)
		.sort((a, b) => b.stats.pts - a.stats.pts)
		.slice(0, 4)
		.map((p) => ({
			name: `${p.firstName} ${p.lastName}`,
			pts: round1(p.stats.pts),
			trb: round1(p.stats.trb),
			ast: round1(p.stats.ast),
			gp: p.stats.gp,
			awardsThisSeason: (p.awards as PlayerAward[])
				.filter((a) => a.season === season)
				.map((a) => a.type),
		}));

	// League-wide awards (MVP, All-League, etc.) won by this team's players
	const leagueAwards: SeasonGroundTruth["leagueAwards"] = [];
	const awardsRecord = await idb.getCopy.awards({ season }, "noCopyCache");
	if (awardsRecord) {
		for (const key of SIMPLE_AWARD_KEYS) {
			const award = awardsRecord[key];
			if (award && award.tid === tid) {
				leagueAwards.push({ type: key, playerName: award.name });
			}
		}
		for (const team of awardsRecord.allLeague ?? []) {
			for (const p of team.players) {
				if (p.tid === tid) {
					leagueAwards.push({
						type: `All-League ${team.title}`,
						playerName: p.name,
					});
				}
			}
		}
		for (const team of awardsRecord.allDefensive ?? []) {
			for (const p of team.players) {
				if (p.tid === tid) {
					leagueAwards.push({
						type: `All-Defensive ${team.title}`,
						playerName: p.name,
					});
				}
			}
		}
		for (const p of awardsRecord.allRookie ?? []) {
			if (p.tid === tid) {
				leagueAwards.push({ type: "All-Rookie Team", playerName: p.name });
			}
		}
	}

	// In-season trades involving this team
	const trades: string[] = [];
	const tradeEvents = (
		await idb.getCopies.events({ season }, "noCopyCache")
	).filter(
		(e): e is Extract<EventBBGM, { type: "trade" }> =>
			e.type === "trade" && e.tids.includes(tid) && !!e.teams,
	);
	for (const event of tradeEvents) {
		const myIdx = event.tids.indexOf(tid);
		const otherIdx = myIdx === 0 ? 1 : 0;
		const otherTid = event.tids[otherIdx]!;

		const assetToText = (asset: TradeEventTeams[number]["assets"][number]) => {
			if ("pid" in asset) {
				return asset.name;
			}
			const seasonDesc =
				typeof asset.season === "number" ? asset.season : event.season;
			return `a ${seasonDesc} round ${helpers.ordinal(asset.round)} pick`;
		};

		const received = event.teams![myIdx]!.assets.map(assetToText);
		const gaveAway = event.teams![otherIdx]!.assets.map(assetToText);
		const otherTeamInfo = await getTeamInfoBySeason(otherTid, event.season);
		const otherTeamName = otherTeamInfo
			? `${otherTeamInfo.region} ${otherTeamInfo.name}`
			: `Team ${otherTid}`;

		trades.push(
			`Acquired ${received.length > 0 ? received.join(", ") : "nothing"} from the ${otherTeamName} in exchange for ${gaveAway.length > 0 ? gaveAway.join(", ") : "nothing"}.`,
		);
	}

	// Dev-system texture. devFocus/mentorPid are live fields on the player
	// object (not historical per-season), so they only reliably describe this
	// season when it's the current one -- otherwise fall back to inferring
	// "breakthrough-caliber" leaps from the season-over-season ratings delta,
	// which is real per-season data.
	const devNotes: string[] = [];
	for (const p of rosterPlayers) {
		const ratingsThisSeason = p.ratings.find((r) => r.season === season);
		const ratingsPrevSeason = p.ratings.find((r) => r.season === season - 1);
		if (ratingsThisSeason && ratingsPrevSeason) {
			const age = season - p.born.year;
			const delta = ratingsThisSeason.ovr - ratingsPrevSeason.ovr;
			if (age <= 24 && delta >= 8) {
				devNotes.push(
					`${p.firstName} ${p.lastName} (age ${age}) leaped from ${ratingsPrevSeason.ovr} to ${ratingsThisSeason.ovr} overall this season.`,
				);
			}
		}
	}
	if (season === g.get("season")) {
		for (const p of rosterPlayers) {
			if (p.tid !== tid) {
				continue;
			}
			if (p.devFocus) {
				devNotes.push(
					`${p.firstName} ${p.lastName} is currently under a ${DEV_FOCUS_LABELS[p.devFocus]} development focus.`,
				);
			}
			if (p.mentorPid !== undefined) {
				const mentor = await idb.cache.players.get(p.mentorPid);
				if (mentor) {
					devNotes.push(
						`${p.firstName} ${p.lastName} is being mentored by ${mentor.firstName} ${mentor.lastName}.`,
					);
				}
			}
		}
	}

	return {
		season,
		tid,
		teamName: `${teamSeason.region} ${teamSeason.name}`,
		abbrev: teamSeason.abbrev,
		record: {
			won: teamSeason.won,
			lost: teamSeason.lost,
			tied: teamSeason.tied,
			otl: teamSeason.otl,
		},
		seed,
		howSeasonEnded,
		playoffSeries,
		regularSeasonArc,
		teamLeaders,
		leagueAwards,
		trades,
		devNotes: devNotes.slice(0, 4),
	};
};

export const formatGroundTruthText = (gt: SeasonGroundTruth): string => {
	const recordText = `${gt.record.won}-${gt.record.lost}${gt.record.tied ? `-${gt.record.tied}T` : ""}${gt.record.otl ? `-${gt.record.otl}OTL` : ""}`;

	const playoffSeriesText =
		gt.playoffSeries.length > 0
			? gt.playoffSeries
					.map(
						(s) =>
							`- Round ${s.round} vs ${s.opponentAbbrev}: ${s.won}-${s.lost} (${s.seriesWon ? "won series" : "lost series"})`,
					)
					.join("\n")
			: "- Did not make the playoffs";

	const arcText = gt.regularSeasonArc
		? [
				`- Longest win streak: ${gt.regularSeasonArc.longestWinStreak} games`,
				`- Longest losing streak: ${gt.regularSeasonArc.longestLossStreak} games`,
				"- Record by quarter of the season (chronological, not calendar months):",
				...gt.regularSeasonArc.segments.map(
					(s) => `  - ${s.label}: ${s.won}-${s.lost}`,
				),
				"- Signature games (chronological):",
				...gt.regularSeasonArc.signatureGames.map(
					(sg) =>
						`  - (${sg.homeAway}) ${sg.result} ${sg.pts}-${sg.oppPts} vs ${sg.opponentAbbrev}${sg.overtime ? " (OT)" : ""} -- ${sg.tag}`,
				),
			].join("\n")
		: "- Game-by-game data is not available for this season (box scores have been pruned for old seasons); rely only on the season-level facts here.";

	const leadersText =
		gt.teamLeaders.length > 0
			? gt.teamLeaders
					.map(
						(p) =>
							`- ${p.name}: ${p.pts} pts, ${p.trb} reb, ${p.ast} ast per game (${p.gp} games)${p.awardsThisSeason.length > 0 ? ` [${p.awardsThisSeason.join(", ")}]` : ""}`,
					)
					.join("\n")
			: "- No player stats available";

	const leagueAwardsText =
		gt.leagueAwards.length > 0
			? gt.leagueAwards.map((a) => `- ${a.playerName}: ${a.type}`).join("\n")
			: "- None";

	const tradesText =
		gt.trades.length > 0
			? gt.trades.map((t) => `- ${t}`).join("\n")
			: "- No trades involving this team during the season";

	const devText =
		gt.devNotes.length > 0
			? gt.devNotes.map((n) => `- ${n}`).join("\n")
			: "- Nothing notable";

	return `Team: ${gt.teamName} (${gt.abbrev})
Season: ${gt.season}
Final record: ${recordText}
Seed: ${gt.seed !== undefined ? `#${gt.seed}` : "did not make playoffs"}
How the season ended: ${gt.howSeasonEnded}

Playoff series results:
${playoffSeriesText}

Regular-season arc:
${arcText}

Team statistical leaders:
${leadersText}

League awards won by this team's players:
${leagueAwardsText}

In-season trades:
${tradesText}

Player development notes:
${devText}`;
};
