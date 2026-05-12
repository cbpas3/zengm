import developSeasonBaseball from "./developSeason.baseball.ts";
import developSeasonBasketball from "./developSeason.basketball.ts";
import developSeasonFootball from "./developSeason.football.ts";
import developSeasonHockey from "./developSeason.hockey.ts";
import type {
	DevFocusType,
	MinimalPlayerRatings,
} from "../../../common/types.ts";
import { g, helpers } from "../../util/index.ts";
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
};

const DEV_FOCUS_RATINGS: Record<DevFocusType, string[]> = {
	scoring: ["ins", "dnk", "ft", "fg", "tp"],
	defense: ["diq", "stre", "spd", "jmp"],
	athleticism: ["stre", "spd", "jmp", "endu"],
	playmaking: ["oiq", "drb", "pss", "reb"],
};

const developSeason = async (
	ratings: MinimalPlayerRatings,
	age: number,
	srID: string | undefined,
	coachingLevel: number,
	forPot: boolean,
	devOptions?: DevOptions,
) => {
	// Step 1: Sport-specific development (no bonus params — bonuses applied after RPD below)
	bySport({
		baseball: developSeasonBaseball(ratings as any, age, coachingLevel),
		basketball: developSeasonBasketball(ratings as any, age, coachingLevel),
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
		for (const key of RATINGS) {
			if (key === "hgt") continue;
			const focusBonus =
				devOptions?.devFocus &&
				DEV_FOCUS_RATINGS[devOptions.devFocus].includes(key as string)
					? 4
					: 0;
			const mentorBonus = devOptions?.mentorBoostKeys?.includes(key as string)
				? 2
				: 0;
			if (focusBonus || mentorBonus) {
				(ratings as any)[key] = limitRating(
					(ratings as any)[key] + focusBonus + mentorBonus,
				);
			}
		}
	}
};

export default developSeason;
