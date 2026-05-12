import limitRating from "./limitRating.ts";
import { helpers, random } from "../../util/index.ts";
import type {
	PlayerRatings,
	RatingKey,
} from "../../../common/types.basketball.ts";
import { coachingEffect } from "../../../common/budgetLevels.ts";
import type { DevFocusType } from "../../../common/types.ts";

type RatingFormula = {
	ageModifier: (age: number) => number;
	changeLimits: (age: number) => [number, number];
};

const shootingFormula: RatingFormula = {
	ageModifier: (age: number) => {
		// Skills age gracefully — offset the base decline that starts at 32+
		if (age <= 31) {
			return 0;
		}

		if (age <= 34) {
			return 0.5;
		}

		return 1.5;
	},
	changeLimits: () => [-3, 13],
};
const iqFormula: RatingFormula = {
	ageModifier: (age: number) => {
		if (age <= 21) {
			return 4;
		}

		if (age <= 23) {
			return 3;
		}

		// IQ/skill holds through prime, then offset the base decline
		if (age <= 31) {
			return 0;
		}

		if (age <= 34) {
			return 0.5;
		}

		return 1.5;
	},
	changeLimits: (age) => {
		if (age >= 24) {
			return [-3, 9];
		}

		// For 19: [-3, 32]
		// For 23: [-3, 12]
		return [-3, 7 + 5 * (24 - age)];
	},
};
const ratingsFormulas: Record<Exclude<RatingKey, "hgt">, RatingFormula> = {
	stre: {
		ageModifier: () => 0,
		changeLimits: () => [-Infinity, Infinity],
	},
	spd: {
		ageModifier: (age: number) => {
			// Speed holds through prime, then declines
			if (age <= 29) {
				return 0;
			}

			if (age <= 33) {
				return -1.5;
			}

			if (age <= 37) {
				return -3;
			}

			if (age <= 40) {
				return -5;
			}

			return -8;
		},
		changeLimits: () => [-12, 2],
	},
	jmp: {
		ageModifier: (age: number) => {
			// Jumping holds through prime, then declines
			if (age <= 29) {
				return 0;
			}

			if (age <= 33) {
				return -2;
			}

			if (age <= 37) {
				return -3.5;
			}

			if (age <= 40) {
				return -5;
			}

			return -10;
		},
		changeLimits: () => [-12, 2],
	},
	endu: {
		ageModifier: (age: number) => {
			if (age <= 23) {
				return random.uniform(0, 9);
			}

			if (age <= 30) {
				return 0;
			}

			if (age <= 35) {
				return -2;
			}

			if (age <= 40) {
				return -4;
			}

			return -8;
		},
		changeLimits: () => [-11, 19],
	},
	dnk: {
		ageModifier: (age: number) => {
			// Dunking tracks athleticism more than shooting — no offset bonus
			if (age <= 29) {
				return 0;
			}

			return -0.5;
		},
		changeLimits: () => [-3, 13],
	},
	ins: shootingFormula,
	ft: shootingFormula,
	fg: shootingFormula,
	tp: shootingFormula,
	oiq: iqFormula,
	diq: iqFormula,
	drb: {
		ageModifier: shootingFormula.ageModifier,
		changeLimits: () => [-2, 5],
	},
	pss: {
		ageModifier: shootingFormula.ageModifier,
		changeLimits: () => [-2, 5],
	},
	reb: {
		ageModifier: shootingFormula.ageModifier,
		changeLimits: () => [-2, 5],
	},
};

const calcBaseChange = (age: number, coachingLevel: number): number => {
	let val: number;

	if (age <= 21) {
		val = 2;
	} else if (age <= 25) {
		val = 1.5;
	} else if (age <= 27) {
		val = 1;
	} else if (age <= 31) {
		// Prime plateau — base is neutral, individual rating formulas determine direction
		val = 0;
	} else if (age <= 34) {
		val = -1.5;
	} else if (age <= 37) {
		val = -3;
	} else if (age <= 40) {
		val = -4.5;
	} else {
		val = -6;
	}

	// Noise — tighter during prime so variance doesn't randomly derail a player's best years
	if (age <= 23) {
		val += helpers.bound(random.realGauss(0, 5), -4, 20);
	} else if (age <= 27) {
		val += helpers.bound(random.realGauss(0, 4), -3, 8);
	} else if (age <= 31) {
		val += helpers.bound(random.realGauss(0, 2), -1, 3);
	} else {
		val += helpers.bound(random.realGauss(0, 3), -2, 2);
	}

	val *= 1 + (val > 0 ? 1 : -1) * coachingEffect(coachingLevel);

	return val;
};

const DEV_FOCUS_RATINGS: Record<DevFocusType, string[]> = {
	scoring: ["ins", "dnk", "ft", "fg", "tp"],
	defense: ["diq", "stre", "spd", "jmp"],
	athleticism: ["stre", "spd", "jmp", "endu"],
	playmaking: ["oiq", "drb", "pss", "reb"],
};

const developSeason = (
	ratings: PlayerRatings,
	age: number,
	coachingLevel: number,
	devFocus?: DevFocusType,
	mentorBoostKeys?: string[],
) => {
	// In young players, height can sometimes increase
	if (age <= 21) {
		const heightRand = Math.random();

		if (heightRand > 0.99 && age <= 20 && ratings.hgt <= 99) {
			ratings.hgt += 1;
		}

		if (heightRand > 0.999 && ratings.hgt <= 99) {
			ratings.hgt += 1;
		}
	}

	const baseChange = calcBaseChange(age, coachingLevel);

	for (const key of helpers.keys(ratingsFormulas)) {
		const ageModifier = ratingsFormulas[key].ageModifier(age);
		const changeLimits = ratingsFormulas[key].changeLimits(age);

		let change = baseChange + ageModifier;
		if (devFocus && DEV_FOCUS_RATINGS[devFocus].includes(key)) change *= 1.4;
		if (mentorBoostKeys?.includes(key)) change *= 1.2;

		ratings[key] = limitRating(
			ratings[key] +
				helpers.bound(
					change * random.uniform(0.4, 1.4),
					changeLimits[0],
					changeLimits[1],
				),
		);
	}
};

export default developSeason;
