import developSeasonBaseball from "./developSeason.baseball.ts";
import developSeasonBasketball from "./developSeason.basketball.ts";
import developSeasonFootball from "./developSeason.football.ts";
import developSeasonHockey from "./developSeason.hockey.ts";
import type {
	DevFocusType,
	DevProfileType,
	MinimalPlayerRatings,
} from "../../../common/types.ts";
import { g, helpers, random } from "../../util/index.ts";
import { RATINGS } from "../../../common/constants.ts";
import loadDataBasketball from "../realRosters/loadData.basketball.ts";
import type { Ratings } from "../realRosters/loadData.basketball.ts";
import limitRating from "./limitRating.ts";
import { bySport, isSport } from "../../../common/sportFunctions.ts";

// Cache for performance
let groupedRatings: Record<string, Ratings> | undefined;

type DevOptions = {
	devOverride?: boolean;
	devFocus?: DevFocusType;
	mentorBoostKeys?: string[];
	mentorRatings?: Partial<Record<string, number>>;
	workEthic?: "elite" | "high" | "average" | "low";
	devProfile?: DevProfileType;
	minutesMultiplier?: number;
	focusFloor?: Partial<Record<string, number>>;
};

const WORK_ETHIC_MULTIPLIER: Record<string, number> = {
	elite: 1.5,
	high: 1.2,
	average: 1.0,
	low: 0.7,
};

export const DEV_FOCUS_RATINGS: Record<DevFocusType, string[]> = {
	sharpshooter: ["tp", "fg", "ft"],
	slasher: ["dnk", "spd", "jmp"],
	postScorer: ["ins", "stre", "reb"],
	playmaker: ["pss", "drb", "oiq"],
	threeAndD: ["tp", "diq", "spd"],
	lockdown: ["diq", "stre", "spd", "jmp"],
	athletic: ["spd", "jmp", "endu", "stre"],
	floorGeneral: ["oiq", "pss", "drb"],
};

// Scheme-fit bonus (Phase 3): archetypes that line up with a game-plan slider get a small extra
// bump on top of the ratings-based fit in schemeFit.ts. Not every archetype has an obvious
// offense-slider counterpart (e.g. lockdown/floorGeneral are defense/playmaking focused), so
// those map to {}.
export const DEV_FOCUS_GAMEPLAN_AFFINITY: Record<
	DevFocusType,
	Partial<Record<"threePointRate" | "rimAttack" | "postPlay", number>>
> = {
	sharpshooter: { threePointRate: 1 },
	slasher: { rimAttack: 1 },
	postScorer: { postPlay: 1 },
	playmaker: {},
	threeAndD: { threePointRate: 1 },
	lockdown: {},
	athletic: { rimAttack: 1 },
	floorGeneral: {},
};

const getMentorBonus = (
	mentorRatings: Partial<Record<string, number>> | undefined,
	key: string,
	menteeCurrentRating: number,
): number => {
	if (!mentorRatings) return 2;
	const mentorVal = mentorRatings[key];
	if (mentorVal === undefined) return 1;
	const gap = mentorVal - menteeCurrentRating;
	if (gap > 30) return 3;
	if (gap > 15) return 2;
	if (gap > 0) return 1;
	return 0;
};

const getBreakthroughProb = (
	age: number,
	devProfile?: DevProfileType,
): number => {
	if (devProfile === "lateBloom" && age <= 30) return 0.05;
	if (age <= 22) return 0.2;
	if (age <= 24) return 0.15;
	if (age <= 27) return 0.08;
	return 0;
};

const developSeason = async (
	ratings: MinimalPlayerRatings,
	age: number,
	srID: string | undefined,
	coachingLevel: number,
	forPot: boolean,
	devOptions?: DevOptions,
) => {
	// Snapshot focus ratings before step 1 so we can enforce a no-regression floor in step 3
	const focusKeys =
		!forPot && devOptions?.devFocus
			? DEV_FOCUS_RATINGS[devOptions.devFocus]
			: [];
	const ratingSnapshot: Record<string, number> = {};
	for (const key of focusKeys) {
		ratingSnapshot[key] = (ratings as any)[key];
	}

	// Step 1: Sport-specific development (no bonus params — bonuses applied after RPD below)
	bySport({
		baseball: developSeasonBaseball(ratings as any, age, coachingLevel),
		basketball: developSeasonBasketball(
			ratings as any,
			age,
			coachingLevel,
			devOptions?.devProfile,
			devOptions?.minutesMultiplier ?? 1.0,
		),
		football: developSeasonFootball(ratings as any, age, coachingLevel),
		hockey: developSeasonHockey(ratings as any, age, coachingLevel),
	});

	// Step 2: RPD blend — basketball only, skipped when devOverride is set
	if (
		isSport("basketball") &&
		Object.hasOwn(g, "realPlayerDeterminism") &&
		!devOptions?.devOverride
	) {
		if (forPot && !g.get("rpdPot")) {
			// Pot calculation in RPD league: skip both RPD and bonuses
			return;
		}

		if (srID !== undefined) {
			const realPlayerDeterminism =
				helpers.bound(g.get("realPlayerDeterminism"), 0, 1) ** 2;
			if (realPlayerDeterminism > 0) {
				const basketball = await loadDataBasketball();
				const bio = basketball.bios[srID];
				if (bio) {
					if (!groupedRatings) {
						groupedRatings = {};
						for (const row of basketball.ratings) {
							groupedRatings[`${row.slug}_${row.season}`] = row;
						}
					}

					// Find real ratings with same age - can't just use season to look it up, because legends and random debut
					const targetSeason = bio.bornYear + age;
					const realRatings = groupedRatings[`${srID}_${targetSeason}`];

					if (realRatings) {
						for (const key of RATINGS) {
							// Focus and mentor keys are exempt — they follow coaching/sim path
							const isFocusKey =
								devOptions?.devFocus &&
								DEV_FOCUS_RATINGS[devOptions.devFocus].includes(key as string);
							const isMentorKey = devOptions?.mentorBoostKeys?.includes(
								key as string,
							);
							if (isFocusKey || isMentorKey) continue;

							(ratings as any)[key] = limitRating(
								realPlayerDeterminism * (realRatings as any)[key] +
									(1 - realPlayerDeterminism) * (ratings as any)[key],
							);
						}
					}
				}
			}
		}
	}

	// Step 3: Focus/mentor bonuses — applied after RPD so they cannot be overwritten.
	// Skipped for pot calculations to avoid inflating projections.
	if (
		!forPot &&
		isSport("basketball") &&
		(devOptions?.devFocus || devOptions?.mentorBoostKeys?.length)
	) {
		// Breakthrough: tiered probability by age, scaled by work ethic
		const ethicMult = WORK_ETHIC_MULTIPLIER[devOptions?.workEthic ?? "average"];
		const isBreakthrough =
			devOptions?.devFocus !== undefined &&
			Math.random() <
				getBreakthroughProb(age, devOptions?.devProfile) * ethicMult;

		for (const key of RATINGS) {
			if (key === "hgt") continue;

			const isFocusKey =
				devOptions?.devFocus &&
				DEV_FOCUS_RATINGS[devOptions.devFocus].includes(key as string);
			const isMentorKey = devOptions?.mentorBoostKeys?.includes(key as string);

			if (!isFocusKey && !isMentorKey) continue;

			const rawFocusBonus = isFocusKey
				? isBreakthrough
					? random.randInt(12, 22)
					: 4
				: 0;
			const headroomFactor = isFocusKey
				? Math.max(0.25, (100 - (ratings as any)[key]) / 50)
				: 1;
			const focusBonus = Math.round(rawFocusBonus * headroomFactor * ethicMult);
			const mentorBonus = isMentorKey
				? getMentorBonus(
						devOptions?.mentorRatings,
						key as string,
						(ratings as any)[key],
					)
				: 0;

			const newVal = (ratings as any)[key] + focusBonus + mentorBonus;

			const persistedFloor = isFocusKey
				? devOptions?.focusFloor?.[key as string]
				: undefined;
			const floor = persistedFloor !== undefined ? persistedFloor : -Infinity;

			const finalVal = limitRating(Math.max(newVal, floor));
			(ratings as any)[key] = finalVal;

			// Decay or advance the persistent floor
			if (
				isFocusKey &&
				persistedFloor !== undefined &&
				devOptions?.focusFloor
			) {
				if (newVal >= persistedFloor) {
					devOptions.focusFloor[key as string] = finalVal;
				} else {
					const originalSnapshot =
						ratingSnapshot[key as string] ?? persistedFloor;
					devOptions.focusFloor[key as string] = Math.max(
						persistedFloor - 1,
						originalSnapshot - 3,
					);
				}
			}
		}
	}
};

export default developSeason;
