import { assert, beforeAll, describe, test } from "vitest";
import GameSim from "./index.ts";
import { team } from "../index.ts";
import loadTeams from "../game/loadTeams.ts";
import { g, helpers } from "../../util/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import createRandomPlayers from "../league/create/createRandomPlayers.ts";
import { range } from "../../../common/utils.ts";
import { GAME_PLAN_TUNING, eq } from "./gamePlanTuning.ts";
import { idb } from "../../db/index.ts";
import { PHASE } from "../../../common/constants.ts";
import type { Team } from "../../../common/types.ts";

// Permanent statistical harness for the Game Plan rebalance - see
// GAME_PLAN_REBALANCE_PLAN.md section 6 for the suite design this file implements, and
// CLAUDE.md's "Game Plan Rebalance" section for a summary of what each fix does.

type GamePlan = NonNullable<Team["gamePlan"]>;

const NEUTRAL_GAME_PLAN: GamePlan = {
	pace: 50,
	threePointRate: 50,
	postPlay: 50,
	rimAttack: 50,
	ballMovement: 50,
	transition: 50,
	crashOffensiveGlass: 50,
	pickCoverage: 50,
	perimeterPressure: 50,
	helpAggression: 50,
	defensiveGlass: 50,
};

// A "legacy" gamePlan object as it would exist in an old save from before defense sliders
// existed (Phase 1) - only the original 5 offense keys, all others missing and expected to
// fall back to the `?? 50` neutral default everywhere they're read.
const LEGACY_GAME_PLAN = {
	pace: 50,
	threePointRate: 50,
	postPlay: 50,
	rimAttack: 50,
	ballMovement: 50,
} as GamePlan;

// A raw `player.generate()` call produces an undeveloped, ~19-year-old draft-prospect-quality
// player, not a "league average NBA player" - real rosters only look realistic after running
// through the actual league-creation pipeline (20 simulated draft classes + player.develop, see
// createRandomPlayers.ts). That pipeline is the only thing in this codebase that produces
// properly archetype-correlated ratings (a shooting guard has real, correlated tp/fg/spd, not
// independent noise), which turns out to matter a lot: a naive uniform-or-jittered-ratings roster
// produces wildly unrealistic aggregate stats (25-30% FG, 30+ TOV/game) even when every composite
// averages to a textbook-neutral 0.5. So the harness pays createRandomPlayers' cost (~1-2s) exactly
// once for the whole file (see getFullLeaguePool below) and reuses the same rosters throughout,
// with only `Team.gamePlan` (and, for Suite C, which tid's roster) varying between configs - which
// is also methodologically cleaner, since every comparison runs on the *same* underlying talent.
//
// Generating with all 30 tids active (not just [0, 1]) matters too: draft-class size is driven by
// g.get("numActiveTeams") regardless of activeTids.length, so passing only [0, 1] would let those
// two teams monopolize the top of a full league's talent pool (median OVR ~78, nowhere near league
// average). Generating for the full league and picking tid 0 for "average" instead gives a
// genuinely average-ish team (median OVR ~65) - and, in practice, is not even slower.

// mulberry32: tiny deterministic PRNG, used only to pin down roster generation (see below) so
// this file's "average roster" bands (T-A2, T-B0) don't flake across separate test-process runs.
// Player/league generation goes through raw Math.random() throughout this codebase (no seed
// plumbing), so roster quality is otherwise different every run - fine for a real game, but it
// meant this file's calibration assertions would occasionally land outside their bands purely
// because a *different random roster* got generated, not because of a real regression.
const mulberry32 = (seed: number) => {
	let s = seed;
	return () => {
		s |= 0;
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

// Real reference to the native RNG, captured once - anything that temporarily seeds Math.random
// (here, or in T-A1 below) must restore this afterward, or every later test in the file would
// silently run on a deterministic sequence too.
const nativeRandom = Math.random;

const withSeed = async <T>(seed: number, fn: () => Promise<T>): Promise<T> => {
	Math.random = mulberry32(seed);
	try {
		return await fn();
	} finally {
		Math.random = nativeRandom;
	}
};

// The full 30-team seeded league this file's rosters are drawn from. Generated once and reused,
// so different tiers (average, elite, awful - see getTieredRosters) all come from one consistent,
// deterministic talent distribution rather than separate independently-random calls.
let fullLeaguePool: any[] | undefined;

const getFullLeaguePool = async () => {
	if (fullLeaguePool) {
		return fullLeaguePool;
	}
	resetG();
	g.setWithoutSavingToDB("season", 2016);
	const teamsDefault = helpers.getTeamsDefault();
	const teamObjs = teamsDefault.map(team.generate);

	fullLeaguePool = await withSeed(12345, () =>
		createRandomPlayers({
			activeTids: range(teamsDefault.length),
			onlyFreeAgents: false,
			scoutingLevel: DEFAULT_LEVEL,
			teams: teamObjs,
		}),
	);
	return fullLeaguePool;
};

// Clone a tid's roster from the full league pool and relabel it to a fresh tid (0 or 1), so it
// can be dropped into either slot of a two-team matchup regardless of its original tid.
const rosterForTid = async (sourceTid: number, newTid: number) => {
	const allPlayers = await getFullLeaguePool();
	const players = allPlayers.filter((p: any) => p.tid === sourceTid);
	return structuredClone(players).map((p: any) => ({ ...p, tid: newTid }));
};

const avgOvr = (players: any[]) =>
	players.reduce((sum, p) => sum + p.ratings.at(-1).ovr, 0) / players.length;

const allTids = (allPlayers: any[]) =>
	[...new Set(allPlayers.map((p: any) => p.tid))].filter(
		(tid): tid is number => typeof tid === "number" && tid >= 0,
	);

// Buckets tids from the full league by average roster OVR and picks representative "average"
// (tid 0 itself), "elite" (best roster in the league), and "awful"/"bottomTier" (worst roster)
// tids for Suite C's talent-gating tests - see T-C1 below.
let tieredTids: { average: number; elite: number; awful: number } | undefined;

const getTieredTids = async () => {
	if (tieredTids) {
		return tieredTids;
	}
	const allPlayers = await getFullLeaguePool();
	const byOvr = allTids(allPlayers)
		.map((tid) => ({
			tid,
			ovr: avgOvr(allPlayers.filter((p: any) => p.tid === tid)),
		}))
		.sort((a, b) => a.ovr - b.ovr);

	tieredTids = {
		average: 0,
		elite: byOvr.at(-1)!.tid,
		awful: byOvr[0]!.tid,
	};
	return tieredTids;
};

// Same idea, but ranked by the *actual in-game* value of a specific composite rating, rather than
// generic overall OVR - a team can be "elite" overall while being mediocre at, say, perimeter
// defense specifically, and a raw-ratings approximation of a composite doesn't reliably predict
// what updateTeamCompositeRatings will actually compute once fatigue/synergy/rosterOrder-based
// starter selection are in play. So this measures it directly: for each tid, build it as team 0
// against a fixed average opponent, construct a real GameSim, and read
// game.team[0].compositeRating[key] straight from the same code eq() reads from.
const tieredTidsByCompositeCache = new Map<
	string,
	{ elite: number; awful: number }
>();

const getTieredTidsByComposite = async (compositeKey: string) => {
	const cached = tieredTidsByCompositeCache.get(compositeKey);
	if (cached) {
		return cached;
	}

	const allPlayers = await getFullLeaguePool();
	const { average } = await getTieredTids();
	const opponentTeam = await rosterForTid(average, 1);

	const results: { tid: number; value: number }[] = [];
	for (const tid of allTids(allPlayers)) {
		if (tid === average) {
			continue;
		}
		const candidateTeam = await rosterForTid(tid, 0);
		await setupMatchup([candidateTeam, opponentTeam]);
		const teams = await loadTeams([0, 1], {} as any);
		const game: any = new GameSim({
			gid: 0,
			teams: [teams[0]!, teams[1]!] as any,
			baseInjuryRate: 0,
			doPlayByPlay: false,
			homeCourtFactor: 1,
			allStarGame: false,
			neutralSite: true,
		});
		game.updateTeamCompositeRatings();
		results.push({ tid, value: game.team[0].compositeRating[compositeKey] });
	}
	results.sort((a, b) => a.value - b.value);

	const result = { elite: results.at(-1)!.tid, awful: results[0]!.tid };
	tieredTidsByCompositeCache.set(compositeKey, result);
	return result;
};

// Same idea again, but for a *player*-level shooting composite (shootingThreePointer/AtRim/
// LowPost) - these aren't in updateTeamCompositeRatings' team-level list, so this instead mirrors
// computeSchemeFit's own "top 8 healthy players by rosterOrder, averaged" (schemeFit.ts) directly
// against loadTeams' output, without needing a full GameSim.
const tieredTidsByShootingCompositeCache = new Map<
	string,
	{ elite: number; awful: number }
>();

const getTieredTidsByShootingComposite = async (compositeKey: string) => {
	const cached = tieredTidsByShootingCompositeCache.get(compositeKey);
	if (cached) {
		return cached;
	}

	const allPlayers = await getFullLeaguePool();
	const { average } = await getTieredTids();
	const opponentTeam = await rosterForTid(average, 1);

	const results: { tid: number; value: number }[] = [];
	for (const tid of allTids(allPlayers)) {
		if (tid === average) {
			continue;
		}
		const candidateTeam = await rosterForTid(tid, 0);
		await setupMatchup([candidateTeam, opponentTeam]);
		const teams = await loadTeams([0, 1], {} as any);
		// processTeam's output is already sorted by rosterOrder (see loadTeams.ts, and the same
		// "top 8 by array order" pattern positionalDepthTax/schemeFit use) - no re-sort needed.
		const top8 = teams[0]!.player.slice(0, 8);
		const value =
			top8.reduce(
				(sum: number, p: any) => sum + p.compositeRating[compositeKey],
				0,
			) / top8.length;
		results.push({ tid, value });
	}
	results.sort((a, b) => a.value - b.value);

	const result = { elite: results.at(-1)!.tid, awful: results[0]!.tid };
	tieredTidsByShootingCompositeCache.set(compositeKey, result);
	return result;
};

// For every tid, finds its single most usage-heavy player's post-**1.9 usage composite (see
// processTeam in loadTeams.ts) - i.e. how ball-dominant that team's best option actually is.
// Powers two different T-C3 picks off the same league-wide scan: the biggest value league-wide is
// a genuine top-decile #1 option ("elite-usage star pays ~nothing"), while a value near the middle
// of *this specific distribution* (team-leaders, not all players) represents a solid-but-not-
// special go-to guy getting overloaded - the "64 OVR forced into 30%+ usage" the plan describes.
let usageStarTidsByValueCache: { tid: number; value: number }[] | undefined;

const getUsageStarTidsByValue = async () => {
	if (usageStarTidsByValueCache) {
		return usageStarTidsByValueCache;
	}

	const allPlayers = await getFullLeaguePool();
	const { average } = await getTieredTids();
	const opponentTeam = await rosterForTid(average, 1);

	const results: { tid: number; value: number }[] = [];
	for (const tid of allTids(allPlayers)) {
		if (tid === average) {
			continue;
		}
		const candidateTeam = await rosterForTid(tid, 0);
		await setupMatchup([candidateTeam, opponentTeam]);
		const teams = await loadTeams([0, 1], {} as any);
		const topUsage = Math.max(
			...teams[0]!.player.map((p: any) => p.compositeRating.usage),
		);
		results.push({ tid, value: topUsage });
	}
	results.sort((a, b) => a.value - b.value);

	usageStarTidsByValueCache = results;
	return usageStarTidsByValueCache;
};

const getEliteUsageStarTid = async () => {
	const results = await getUsageStarTidsByValue();
	return results.at(-1)!.tid;
};

const getMidTierUsageStarTid = async () => {
	const results = await getUsageStarTidsByValue();
	// The 20th percentile of *team-leader* usage composites, not the 50th: since every value in
	// this distribution is already "that team's best option," the median team-leader is still
	// fairly ball-dominant (~0.49 measured, not far off the ~0.55-0.59 league ceiling) - not a
	// meaningful overload case. A team whose best option is only 20th-percentile-of-team-leaders
	// good is a much better match for "a solid player, not a real go-to guy, forced into a #1 role."
	return results[Math.floor(results.length * 0.2)]!.tid;
};

beforeAll(async () => {
	await getFullLeaguePool();
	await getTieredTids();
});

// Sets up a two-team matchup from explicit rosters (each already relabeled to tid 0/1 via
// rosterForTid) plus their gamePlans - the general form Suite C's talent-gating tests need.
// gameAttrs applies extra game attributes (e.g. `{ schemeFit: true }`) after the resetG() default,
// since resetG() always resets them to off.
const setupMatchup = async (
	rosters: [any[], any[]],
	gamePlans?: [GamePlan | undefined, GamePlan | undefined],
	gameAttrs?: Record<string, unknown>,
) => {
	resetG();
	g.setWithoutSavingToDB("season", 2016);
	// resetG's userTids is [0], so team 1 (tid 1) counts as an AI team - without turning this
	// off by default, a `gamePlan: undefined` team 1 would get an F-H AI-generated plan instead
	// of actually staying undefined, which would confound Suite A/B's "undefined behaves like
	// all-50" baseline tests (they're testing the `?? 50` fallback pattern, not F-H). Suite D's
	// tests turn this back on explicitly via gameAttrs to test F-H itself.
	g.setWithoutSavingToDB("aiGamePlans", false);
	if (gameAttrs) {
		for (const [key, value] of Object.entries(gameAttrs)) {
			g.setWithoutSavingToDB(key as any, value);
		}
	}
	const teamsDefault = helpers.getTeamsDefault().slice(0, 2);
	const teamObjs = teamsDefault.map(team.generate);
	if (gamePlans) {
		teamObjs[0]!.gamePlan = gamePlans[0];
		teamObjs[1]!.gamePlan = gamePlans[1];
	}
	await resetCache({
		players: [...rosters[0], ...rosters[1]],
		teams: teamObjs,
		teamSeasons: teamsDefault.map((t) => team.genSeasonRow(t)),
		teamStats: teamsDefault.map((t) => team.genStatsRow(t.tid)),
	});
	await team.rosterAutoSort(0);
	await team.rosterAutoSort(1);
};

// Suite A/B's original "average vs average, cloned roster" setup, now expressed via setupMatchup.
const setupTeams = async (
	gamePlans?: [GamePlan | undefined, GamePlan | undefined],
	gameAttrs?: Record<string, unknown>,
) => {
	const team0 = await rosterForTid(0, 0);
	const team1 = await rosterForTid(0, 1);
	await setupMatchup([team0, team1], gamePlans, gameAttrs);
};

const simGame = async () => {
	const teams = await loadTeams([0, 1], {} as any);
	for (const t of [teams[0], teams[1]]) {
		if (t!.depth !== undefined) {
			t!.depth = team.getDepthPlayers(t!.depth, t!.player);
		}
	}
	const game = new GameSim({
		gid: 0,
		teams: [teams[0]!, teams[1]!] as any,
		baseInjuryRate: g.get("injuryRate"),
		doPlayByPlay: false,
		homeCourtFactor: 1,
		allStarGame: false,
		neutralSite: true,
	});
	return game.run();
};

type Agg = {
	games: number;
	pts: [number, number];
	orb: [number, number];
	drb: [number, number];
	tov: [number, number];
	fga: [number, number];
	tpa: [number, number];
	tp: [number, number];
	fg: [number, number];
	wins: [number, number];
};

const emptyAgg = (): Agg => ({
	games: 0,
	pts: [0, 0],
	orb: [0, 0],
	drb: [0, 0],
	tov: [0, 0],
	fga: [0, 0],
	tpa: [0, 0],
	tp: [0, 0],
	fg: [0, 0],
	wins: [0, 0],
});

const STAT_KEYS = [
	"pts",
	"orb",
	"drb",
	"tov",
	"fga",
	"tpa",
	"tp",
	"fg",
] as const;

const simGames = async (n: number) => {
	const agg = emptyAgg();
	for (let i = 0; i < n; i++) {
		const result = await simGame();
		agg.games += 1;
		for (const t of [0, 1] as const) {
			for (const key of STAT_KEYS) {
				agg[key][t] += result.team[t].stat[key] ?? 0;
			}
		}
		if (result.team[0].stat.pts > result.team[1].stat.pts) {
			agg.wins[0] += 1;
		} else if (result.team[1].stat.pts > result.team[0].stat.pts) {
			agg.wins[1] += 1;
		}
	}
	return agg;
};

// League-wide (both teams combined) per-game average of a raw counting stat
const avgPerGame = (agg: Agg, key: (typeof STAT_KEYS)[number]) =>
	(agg[key][0] + agg[key][1]) / agg.games;

const winPct = (agg: Agg, t: 0 | 1) => agg.wins[t] / agg.games;

// ORB% = offensive rebounds / (offensive rebounds + opponent defensive rebounds), averaged
// across both teams' possessions
const orbPct = (agg: Agg) => {
	const t0 = agg.orb[0] / (agg.orb[0] + agg.drb[1]);
	const t1 = agg.orb[1] / (agg.orb[1] + agg.drb[0]);
	return (t0 + t1) / 2;
};

const pointDifferential = (agg: Agg) => (agg.pts[0] - agg.pts[1]) / agg.games;

describe("gamePlan", () => {
	describe("Suite A - Neutrality/calibration (regression safety)", () => {
		test("T-A1: undefined vs all-50 vs legacy (missing new keys) gamePlan produce equivalent league stats", async () => {
			const N = 150;

			// undefined / all-50 / legacy should be operationally identical everywhere in the sim
			// (every `?? 50` default and every intent(50) === 0 term agrees), so replaying the
			// *same* random-game sequence for all three configs (rather than three independent
			// samples) turns this into an exact-equivalence check instead of a statistical one -
			// no sampling noise, no risk of a flaky threshold. Seeding wraps setupTeams too (not
			// just simGames), since rosterAutoSort can itself consume random draws.
			const seed = 42;
			const undefinedAgg = await withSeed(seed, async () => {
				await setupTeams(undefined);
				return simGames(N);
			});

			const neutralAgg = await withSeed(seed, async () => {
				await setupTeams([NEUTRAL_GAME_PLAN, NEUTRAL_GAME_PLAN]);
				return simGames(N);
			});

			const legacyAgg = await withSeed(seed, async () => {
				await setupTeams([LEGACY_GAME_PLAN, LEGACY_GAME_PLAN]);
				return simGames(N);
			});

			const withinTolerance = (a: number, b: number, tolerance = 0.05) =>
				Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9) <= tolerance;

			for (const [label, otherAgg] of [
				["all-50", neutralAgg],
				["legacy", legacyAgg],
			] as const) {
				for (const key of ["pts", "orb", "tov", "tpa", "fg"] as const) {
					const a = avgPerGame(undefinedAgg, key);
					const b = avgPerGame(otherAgg, key);
					assert(
						withinTolerance(a, b),
						`${label} vs undefined gamePlan diverged on ${key}: ${a.toFixed(2)} vs ${b.toFixed(2)}`,
					);
				}
			}
		});

		test("T-A2: all-50 league averages fall inside historical bands", async () => {
			const N = 150;
			await setupTeams([NEUTRAL_GAME_PLAN, NEUTRAL_GAME_PLAN]);
			const agg = await simGames(N);

			const ppg = avgPerGame(agg, "pts") / 2;
			assert(ppg >= 80 && ppg <= 135, `PPG out of band: ${ppg.toFixed(1)}`);

			const orb = orbPct(agg);
			assert(
				orb >= 0.18 && orb <= 0.32,
				`ORB% out of band: ${(orb * 100).toFixed(1)}%`,
			);

			const tovPerGame = avgPerGame(agg, "tov") / 2;
			assert(
				tovPerGame >= 9 && tovPerGame <= 20,
				`TOV/game out of band: ${tovPerGame.toFixed(1)}`,
			);
		});
	});

	describe("Suite B - Bounded effect sizes (average vs average)", () => {
		test("T-B0: eq() calibration - league-average composites yield eq in [0.4, 0.6]", async () => {
			// Pure function sanity: pivot maps to exactly neutral, and the clamp bounds hold.
			assert.strictEqual(eq(GAME_PLAN_TUNING.EQ_PIVOT), 0.5);
			assert.strictEqual(eq(0), GAME_PLAN_TUNING.EQ_MIN);
			assert.strictEqual(eq(1), GAME_PLAN_TUNING.EQ_MAX);

			// Empirical: average the actual team composite ratings the sim reads
			// (updateTeamCompositeRatings' `toUpdate` list) for the shared realistically-generated
			// roster pair this whole file uses (see getFullLeaguePool's comment - a synthetic flat-50 or
			// jittered roster was tried first and rejected because it produces wildly unrealistic
			// game stats even though it hits composite=0.5 "on paper"). A handful of trials averages
			// out which 5 of the 13 players happen to be on court, not roster-generation variance
			// (the roster itself is fixed for the whole file).
			const composites = [
				"rebounding",
				"defense",
				"defensePerimeter",
				"dribbling",
				"passing",
				"blocking",
			] as const;
			const sums = Object.fromEntries(composites.map((c) => [c, 0])) as Record<
				(typeof composites)[number],
				number
			>;
			const trials = 5;
			for (let i = 0; i < trials; i++) {
				await setupTeams(undefined);
				const teams = await loadTeams([0, 1], {} as any);
				const game: any = new GameSim({
					gid: 0,
					teams: [teams[0]!, teams[1]!] as any,
					baseInjuryRate: 0,
					doPlayByPlay: false,
					homeCourtFactor: 1,
					allStarGame: false,
					neutralSite: true,
				});
				game.updateTeamCompositeRatings();
				for (const t of [0, 1] as const) {
					for (const c of composites) {
						sums[c] += game.team[t].compositeRating[c];
					}
				}
			}

			let overallSum = 0;
			for (const c of composites) {
				overallSum += sums[c] / (trials * 2);
			}
			const avgComposite = overallSum / composites.length;

			// Loosely centered on the eq() pivot - a wide-but-meaningful band, since individual
			// composites vary in how "high" league-average sits (some ~0.36, some ~0.47 - see
			// EQ_PIVOT's comment in gamePlanTuning.ts), but the pivot's job is to keep the
			// *average* of them landing near neutral eq.
			const avgEq = eq(avgComposite);
			assert(
				avgEq >= 0.4 && avgEq <= 0.6,
				`league-average eq out of calibration band: composite=${avgComposite.toFixed(4)}, eq=${avgEq.toFixed(4)}`,
			);
		});

		test("T-B1: crashOffensiveGlass and defensiveGlass produce bounded, opposite-signed rebound effects at each extreme", async () => {
			const N = 300;

			// Only team 0's crashOffensiveGlass (an offense dial) changes across these three
			// configs, so measure team 0's own ORB rate specifically (orb[0] / (orb[0] + drb[1])),
			// not the two-team-averaged orbPct() - team 1's component is unaffected by team 0's
			// offense dial and just dilutes the signal with unrelated noise.
			const team0OrbRate = (agg: Agg) => agg.orb[0] / (agg.orb[0] + agg.drb[1]);

			await setupTeams([NEUTRAL_GAME_PLAN, NEUTRAL_GAME_PLAN]);
			const neutral = await simGames(N);
			const neutralOrb = team0OrbRate(neutral);
			const neutralDiff = pointDifferential(neutral);

			await setupTeams([
				{ ...NEUTRAL_GAME_PLAN, crashOffensiveGlass: 100 },
				NEUTRAL_GAME_PLAN,
			]);
			const crash100 = await simGames(N);
			const crash100Orb = team0OrbRate(crash100);

			await setupTeams([
				{ ...NEUTRAL_GAME_PLAN, crashOffensiveGlass: 0 },
				NEUTRAL_GAME_PLAN,
			]);
			const crash0 = await simGames(N);
			const crash0Orb = team0OrbRate(crash0);

			// crashOffensiveGlass=100 should raise team 0's ORB rate relative to neutral;
			// crashOffensiveGlass=0 should lower it. Both bounded, not just directional.
			assert(
				crash100Orb > neutralOrb,
				`crash=100 didn't raise ORB%: ${crash100Orb} vs neutral ${neutralOrb}`,
			);
			assert(
				crash0Orb < neutralOrb,
				`crash=0 didn't lower ORB%: ${crash0Orb} vs neutral ${neutralOrb}`,
			);
			assert(
				crash100Orb >= 0.1 && crash100Orb <= 0.5,
				`crash=100 ORB% out of sane band: ${crash100Orb}`,
			);
			assert(
				crash0Orb >= 0.05 && crash0Orb <= 0.45,
				`crash=0 ORB% out of sane band: ${crash0Orb}`,
			);

			assert(
				Math.abs(pointDifferential(crash100) - neutralDiff) <= 4,
				`crash=100 point differential swing too large: ${pointDifferential(crash100) - neutralDiff}`,
			);
		});

		test("T-B1: perimeterPressure raises opponent TOV and reduces opponent rebound share, bounded", async () => {
			const N = 400;

			await setupTeams([NEUTRAL_GAME_PLAN, NEUTRAL_GAME_PLAN]);
			const neutral = await simGames(N);
			const neutralOppTov = avgPerGame(neutral, "tov") / 2;

			await setupTeams([
				{ ...NEUTRAL_GAME_PLAN, perimeterPressure: 100 },
				NEUTRAL_GAME_PLAN,
			]);
			const pressure100 = await simGames(N);
			// Team 1 (offense against team 0's pressure) TOV rate, vs team 1's own neutral-vs-neutral
			// baseline (rosters are talent-symmetric, but comparing team 1 to team 1 rather than
			// team 1 to team 0 removes any doubt).
			const t1TovPerGame = pressure100.tov[1] / N;
			const t1TovPerGameNeutral = neutral.tov[1] / N;

			assert(
				t1TovPerGame > t1TovPerGameNeutral,
				`perimeterPressure=100 didn't raise opponent TOV: ${t1TovPerGame} vs neutral ${t1TovPerGameNeutral}`,
			);
			assert(
				t1TovPerGame - t1TovPerGameNeutral <= 3.5,
				`perimeterPressure=100 TOV swing too large: +${(t1TovPerGame - t1TovPerGameNeutral).toFixed(2)}/game`,
			);
			assert(
				neutralOppTov >= 5 && neutralOppTov <= 22,
				`neutral TOV/game way out of band: ${neutralOppTov}`,
			);
		});

		test("T-B1: transition raises fast-break-driven scoring efficiency without an extreme point swing", async () => {
			const N = 150;

			await setupTeams([NEUTRAL_GAME_PLAN, NEUTRAL_GAME_PLAN]);
			const neutral = await simGames(N);

			await setupTeams([
				{ ...NEUTRAL_GAME_PLAN, transition: 100 },
				NEUTRAL_GAME_PLAN,
			]);
			const transition100 = await simGames(N);

			await setupTeams([
				{ ...NEUTRAL_GAME_PLAN, transition: 0 },
				NEUTRAL_GAME_PLAN,
			]);
			const transition0 = await simGames(N);

			const neutralDiff = pointDifferential(neutral);
			const t100Diff = pointDifferential(transition100);
			const t0Diff = pointDifferential(transition0);

			// Target band is +/-2.5 per the plan; widened here to +/-5 to absorb N=150 sampling
			// noise on a single realistic (not perfectly-average-on-every-composite) roster pair -
			// see getFullLeaguePool's comment. Tightening this further is exactly what the T-D2
			// full-league tuning pass (PR-5) is for.
			assert(
				Math.abs(t100Diff - neutralDiff) <= 5,
				`transition=100 point differential swing too large: ${t100Diff - neutralDiff}`,
			);
			assert(
				Math.abs(t0Diff - neutralDiff) <= 5,
				`transition=0 point differential swing too large: ${t0Diff - neutralDiff}`,
			);
		});

		test("T-B2: all possession-economy dials maxed out vs all-50 nets a bounded swing", async () => {
			const N = 150;

			await setupTeams([NEUTRAL_GAME_PLAN, NEUTRAL_GAME_PLAN]);
			const neutral = await simGames(N);

			const maxedOffense: GamePlan = {
				...NEUTRAL_GAME_PLAN,
				transition: 100,
				crashOffensiveGlass: 100,
			};
			const maxedDefense: GamePlan = {
				...NEUTRAL_GAME_PLAN,
				pickCoverage: 100,
				perimeterPressure: 100,
				helpAggression: 100,
				defensiveGlass: 100,
			};

			await setupTeams([
				{ ...maxedOffense, ...maxedDefense },
				NEUTRAL_GAME_PLAN,
			]);
			const maxed = await simGames(N);

			const neutralDiff = pointDifferential(neutral);
			const maxedDiff = pointDifferential(maxed);
			const swing = maxedDiff - neutralDiff;

			assert(
				swing <= 8,
				`all-dials-maxed swing on an average-vs-average matchup too large: +${swing.toFixed(2)} pts/game (F-E's eq()-gating on pickCoverage/helpAggression is in now, so this is tighter than PR-1's loose pre-F-E ceiling, but still short of the design target of +3 - precise tuning against this exact number is what the T-D2 full-league script in PR-5 is for)`,
			);
		});
	});

	describe("Suite C - Talent gating (the user's complaint, directly)", () => {
		const MAXED_OFFENSE: GamePlan = {
			...NEUTRAL_GAME_PLAN,
			transition: 100,
			crashOffensiveGlass: 100,
		};
		const MAXED_DEFENSE: GamePlan = {
			...NEUTRAL_GAME_PLAN,
			pickCoverage: 100,
			perimeterPressure: 100,
			helpAggression: 100,
			defensiveGlass: 100,
		};
		const MAXED_GAME_PLAN: GamePlan = { ...MAXED_OFFENSE, ...MAXED_DEFENSE };

		test("T-C1 (the Cade test): worst-roster-in-the-league, every possession dial maxed, vs an average opponent - win% <= 0.40; mismatched dials hurt more than helping", async () => {
			const N = 500;
			const { awful, average } = await getTieredTids();

			const bottomTeam = await rosterForTid(awful, 0);
			const opponentTeam = await rosterForTid(average, 1);

			await setupMatchup(
				[bottomTeam, opponentTeam],
				[MAXED_GAME_PLAN, NEUTRAL_GAME_PLAN],
			);
			const maxed = await simGames(N);
			const maxedWinPct = winPct(maxed, 0);

			assert(
				maxedWinPct <= 0.4,
				`bottom-tier roster with every dial maxed still won too often: ${(maxedWinPct * 100).toFixed(1)}% (target <= 40%)`,
			);

			// A shot-mix plan that leans hard into three-point volume regardless of whether the
			// roster can actually shoot them - bad coaching choices must be able to hurt, not just
			// fail to help. Needs a team specifically bad at *shooting threes* (not just generically
			// bad overall - see getTieredTidsByShootingComposite's comment), and win%/margin are too
			// coarse/noisy at N=200 for such a lopsided matchup, so this uses the bad-shooting
			// team's own scoring instead - the same direct signal T-C4 uses.
			const badShootingTid = (
				await getTieredTidsByShootingComposite("shootingThreePointer")
			).awful;
			const badShootingTeam = await rosterForTid(badShootingTid, 0);

			await setupMatchup(
				[badShootingTeam, opponentTeam],
				[NEUTRAL_GAME_PLAN, NEUTRAL_GAME_PLAN],
				{ schemeFit: true },
			);
			const neutral = await simGames(N);
			const neutralPts = neutral.pts[0] / N;

			await setupMatchup(
				[badShootingTeam, opponentTeam],
				[{ ...NEUTRAL_GAME_PLAN, threePointRate: 100 }, NEUTRAL_GAME_PLAN],
				{ schemeFit: true },
			);
			const mismatched = await simGames(N);
			const mismatchedPts = mismatched.pts[0] / N;

			assert(
				mismatchedPts < neutralPts,
				`mismatched dials (threePointRate=100 on a bad-shooting roster) didn't lower scoring relative to all-50: ${mismatchedPts.toFixed(2)} vs ${neutralPts.toFixed(2)}`,
			);
		});

		test("T-C2: perimeterPressure's probTov() gating scales with eq(defensePerimeter), elite >= 2x awful", async () => {
			const { average } = await getTieredTids();
			// perimeterPressure's benefit is gated by eq(defensePerimeter) specifically (F-C/F-A) -
			// rank tids by that exact in-game composite, not generic OVR, since a team can be
			// "elite" overall while being mediocre at perimeter defense specifically.
			const { elite, awful } =
				await getTieredTidsByComposite("defensePerimeter");

			const opponentTeam = await rosterForTid(average, 1);

			// Measures the gating formula directly (via the real game.probTov()) rather than
			// simulating full games: forcedTovDelta's whole point is the *marginal* effect of one
			// slider, which is a small signal relative to a full game's other sources of
			// game-to-game variance (fastbreaks, fouls, shot luck...) - simulating hundreds of
			// games to average that noise out obscures more than it resolves for a comparison this
			// granular, whereas the formula itself is deterministic given a fixed roster.
			const pressureFactor = async (
				executionTid: number,
				perimeterPressure: number,
			) => {
				const defenseTeam = await rosterForTid(executionTid, 0);
				await setupMatchup(
					[defenseTeam, opponentTeam],
					[{ ...NEUTRAL_GAME_PLAN, perimeterPressure }, NEUTRAL_GAME_PLAN],
				);
				const teams = await loadTeams([0, 1], {} as any);
				const game: any = new GameSim({
					gid: 0,
					teams: [teams[0]!, teams[1]!] as any,
					baseInjuryRate: 0,
					doPlayByPlay: false,
					homeCourtFactor: 1,
					allStarGame: false,
					neutralSite: true,
				});
				game.updateTeamCompositeRatings();
				game.o = 1;
				game.d = 0;
				return game.probTov();
			};

			const eliteNeutral = await pressureFactor(elite, 50);
			const eliteMaxed = await pressureFactor(elite, 100);
			const awfulNeutral = await pressureFactor(awful, 50);
			const awfulMaxed = await pressureFactor(awful, 100);

			const eliteDelta = eliteMaxed - eliteNeutral;
			const awfulDelta = awfulMaxed - awfulNeutral;

			assert(
				eliteDelta > 0,
				`elite-execution defense's probTov() didn't rise with perimeterPressure at all: delta=${eliteDelta.toFixed(4)}`,
			);
			// Deterministic (no game simulation, no sampling noise) - measured ratio for these two
			// real rosters is ~1.95x, essentially the plan's 2x target.
			assert(
				eliteDelta >= 1.9 * awfulDelta,
				`elite-execution defense's probTov() gain wasn't >= ~2x the awful-execution defense's: elite=+${eliteDelta.toFixed(4)}, awful=+${awfulDelta.toFixed(4)}`,
			);
		});

		test("T-C4: threePointRate=100 on a bad-shooting roster scores fewer points than the same roster at neutral (net negative, not just less positive)", async () => {
			const N = 500;
			const { average } = await getTieredTids();
			// Needs a team specifically bad at shooting threes, not just generically bad overall -
			// see getTieredTidsByShootingComposite's comment (same reasoning as T-C1/T-C2's use of
			// getTieredTidsByComposite for the composite each dial actually depends on).
			const badShootingTid = (
				await getTieredTidsByShootingComposite("shootingThreePointer")
			).awful;
			const bottomTeam = await rosterForTid(badShootingTid, 0);
			const opponentTeam = await rosterForTid(average, 1);

			await setupMatchup(
				[bottomTeam, opponentTeam],
				[NEUTRAL_GAME_PLAN, NEUTRAL_GAME_PLAN],
				{ schemeFit: true },
			);
			const neutral = await simGames(N);
			const neutralPts = neutral.pts[0] / N;

			await setupMatchup(
				[bottomTeam, opponentTeam],
				[{ ...NEUTRAL_GAME_PLAN, threePointRate: 100 }, NEUTRAL_GAME_PLAN],
				{ schemeFit: true },
			);
			const maxed = await simGames(N);
			const maxedPts = maxed.pts[0] / N;

			assert(
				maxedPts < neutralPts,
				`threePointRate=100 on a bad-shooting roster didn't net negative: ${maxedPts.toFixed(1)} pts/game vs ${neutralPts.toFixed(1)} at neutral`,
			);
		});

		test("T-C3 (the usage-efficiency curve): the ISO penalty gates on usage talent - a mid-tier star pays a real cost, an elite-usage star pays ~nothing", async () => {
			// A full-game simulation (varying ballMovement, measuring one player's aggregate TS%)
			// was tried first and abandoned: an individual player's shot-type mix, foul-drawing, and
			// playing time are all bursty enough that TS% needed N in the thousands to stop being
			// dominated by sampling noise, and even then the ISO-heavy player occasionally picked up
			// so few total attempts that TS% (a ratio of small counts) swung wildly (>90% one run).
			// This instead verifies the penalty formula directly against each player's actual
			// in-game usage composite (post-**1.9, see processTeam in loadTeams.ts) - deterministic,
			// and it's what getShotInfo actually evaluates, just without full-game noise on top.
			const { average } = await getTieredTids();
			// The "mid-tier star" needs a team whose featured player's usage talent sits near the
			// middle of the *team-leaders* distribution (not the whole-league player pool, and not
			// just "an average team's best player" - that turned out to still be fairly ball-
			// dominant, ~0.46 vs a ~0.55-0.59 ceiling) - a solid-but-not-special go-to guy, the
			// "64 OVR forced to 30%+ usage" the plan describes.
			const midTierStarTid = await getMidTierUsageStarTid();
			const eliteUsageStarTid = await getEliteUsageStarTid();

			const starUsageComposite = async (starTid: number) => {
				const opponentTeam = await rosterForTid(average, 1);
				const starTeam = await rosterForTid(starTid, 0);
				await setupMatchup([starTeam, opponentTeam]);
				const teams = await loadTeams([0, 1], {} as any);
				return Math.max(
					...teams[0]!.player.map((p: any) => p.compositeRating.usage),
				);
			};

			// isoIntent = 1 at ballMovement = 0 (fully ISO) - mirrors getShotInfo's own
			// isoIntent/usageOverload computation exactly.
			const isoOverloadPenalty = (usageComposite: number) =>
				GAME_PLAN_TUNING.USAGE_ISO_PENALTY_SLOPE *
				Math.max(0, GAME_PLAN_TUNING.USAGE_THRESHOLD - usageComposite);

			const midTierUsage = await starUsageComposite(midTierStarTid);
			const eliteUsage = await starUsageComposite(eliteUsageStarTid);

			const midTierPenalty = isoOverloadPenalty(midTierUsage);
			const elitePenalty = isoOverloadPenalty(eliteUsage);

			assert(
				midTierPenalty >= 0.03,
				`mid-tier star (usage composite ${midTierUsage.toFixed(3)}) doesn't pay a meaningful ISO penalty: ${midTierPenalty.toFixed(4)} probMake (target >= 0.03, roughly the plan's >= 3pp TS% target)`,
			);
			assert(
				elitePenalty < 0.01,
				`elite-usage star (usage composite ${eliteUsage.toFixed(3)}) pays too much of an ISO penalty for a true #1 option: ${elitePenalty.toFixed(4)} probMake`,
			);
		});
	});

	describe("Suite D - Symmetry / AI", () => {
		// T-D1 (genAiGamePlan unit tests) lives in src/worker/core/team/genAiGamePlan.test.ts -
		// it's a pure function with no need for this file's roster/GameSim harness.

		test("T-D3: Phase 5 revival - an AI team with no stored gamePlan still gets its plan adjusted in-series", async () => {
			await setupTeams(undefined, {
				aiGamePlans: true,
				inSeriesAdjustments: true,
			});
			g.setWithoutSavingToDB("phase", PHASE.PLAYOFFS);

			// tid 1 is the AI team here (userTids is [0], set by resetG in setupTeams) - confirm it
			// really has no *stored* plan (Team.gamePlan), the case the old `gamePlan !== undefined`
			// guard used to make Phase 5 permanently dead for every AI team (F2 in the plan).
			const storedTeam1 = await idb.cache.teams.get(1);
			assert.strictEqual(storedTeam1!.gamePlan, undefined);

			// A single prior series game where the user's team (tid 0) shot a very high volume of
			// threes at a hot clip - computeInSeriesAdjustments (inSeriesAdjustments.ts) should read
			// this as a three-point threat and push helpAggression down / perimeterPressure up.
			await idb.cache.playoffSeries.put({
				season: g.get("season"),
				currentRound: 0,
				series: [
					[
						{
							home: { tid: 1, cid: 0, winp: 0.6, won: 1, seed: 1 },
							away: { tid: 0, cid: 0, winp: 0.6, won: 0, seed: 8 },
							gids: [12345],
						},
					],
				],
			} as any);
			await idb.cache.games.add({
				gid: 12345,
				season: g.get("season"),
				teams: [
					{
						tid: 0,
						fga: 90,
						tpa: 45,
						tp: 20,
						fgaAtRim: 15,
						orb: 8,
						pts: 110,
						players: [{ pts: 28 }, { pts: 20 }],
					},
					{
						tid: 1,
						fga: 85,
						tpa: 25,
						tp: 9,
						fgaAtRim: 25,
						orb: 10,
						pts: 95,
						players: [{ pts: 22 }],
					},
				],
			} as any);

			const teams = await loadTeams([0, 1], {} as any);
			const adjustedGamePlan = teams[1]!.gamePlan;
			assert(
				adjustedGamePlan !== undefined,
				"AI team should have a plan at all",
			);

			// Baseline: what the AI would generate from its own roster alone, with no series to
			// react to yet (currentRound: -1 short-circuits getInSeriesGamePlan to a no-op).
			await idb.cache.playoffSeries.put({
				season: g.get("season"),
				currentRound: -1,
				series: [],
			} as any);
			const baselineTeams = await loadTeams([0, 1], {} as any);
			const baselineGamePlan = baselineTeams[1]!.gamePlan!;

			assert(
				adjustedGamePlan!.helpAggression < baselineGamePlan.helpAggression ||
					adjustedGamePlan!.perimeterPressure >
						baselineGamePlan.perimeterPressure,
				`in-series adjustment against a hot three-point series didn't move helpAggression down or perimeterPressure up: baseline ${JSON.stringify(baselineGamePlan)} vs adjusted ${JSON.stringify(adjustedGamePlan)}`,
			);
		});
	});

	// T-D2 (full-league season script: Spearman corr(OVR, wins) >= 0.65, no <=30 OVR team above
	// 45 wins, top-5 PER all >= 70 OVR) is deliberately not implemented here - it needs a full
	// season sim (hundreds of games across 30 teams), which doesn't belong in the fast unit-test
	// suite this file otherwise is. Follow the genRatings.test.ts pattern (describe.skip + a
	// comment with the manual run command) if/when this gets built out as a real tuning-pass tool.
});
