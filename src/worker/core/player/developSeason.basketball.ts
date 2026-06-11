import limitRating from "./limitRating.ts";
import { helpers, random } from "../../util/index.ts";
import type {
	PlayerRatings,
	RatingKey,
} from "../../../common/types.basketball.ts";
import type { DevProfileType } from "../../../common/types.ts";
import { coachingEffect } from "../../../common/budgetLevels.ts";

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
		changeLimits: () => [-Infinity, 12],
	},
	spd: {
		ageModifier: (age: number) => {
			// Speed holds through prime (28-31), declines after
			if (age <= 31) {
				return 0;
			}

			if (age <= 35) {
				return -2;
			}

			if (age <= 38) {
				return -3.5;
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
			// Jumping holds through prime (28-31), declines after
			if (age <= 31) {
				return 0;
			}

			if (age <= 35) {
				return -2.5;
			}

			if (age <= 38) {
				return -4;
			}

			if (age <= 40) {
				return -6;
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

			// Endurance holds through prime (24-31), declines after
			if (age <= 31) {
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

const calcBaseChange = (
	age: number,
	coachingLevel: number,
	devProfile?: DevProfileType,
): number => {
	let val: number;

	if (age <= 21) {
		val = 4;
	} else if (age <= 23) {
		val = 3;
	} else if (age <= 25) {
		val = 2.5;
	} else if (age <= 27) {
		val = 1.5;
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

	// Apply devProfile modifier to val before noise
	if (devProfile === "earlyBloom") {
		if (age <= 25) {
			val *= 1.3;
		} else if (age >= 31) {
			val *= 0.8;
		}
	} else if (devProfile === "lateBloom") {
		if (age <= 23) {
			val *= 0.8;
		} else if (age <= 30) {
			val *= 1.15;
		}
	}

	// Noise bounds are set so young players can never have a full decline year from noise alone.
	// The negative bound never exceeds the base value, ensuring the floor is 0 or positive.
	if (devProfile === "consistent" && val > 0) {
		// No variance when improving — guaranteed steady growth
	} else if (age <= 21) {
		// base 4 — worst case: 4 - 3 = 1 (always positive)
		val += helpers.bound(random.realGauss(0, 5), -3, 20);
	} else if (age <= 23) {
		// base 3 — worst case: 3 - 2.5 = 0.5
		val += helpers.bound(random.realGauss(0, 4), -2.5, 15);
	} else if (age <= 25) {
		// base 2.5 — worst case: 2.5 - 2 = 0.5
		val += helpers.bound(random.realGauss(0, 3), -2, 10);
	} else if (age <= 27) {
		// base 1.5 — worst case: 1.5 - 1.5 = 0 (plateau, not decline)
		val += helpers.bound(random.realGauss(0, 3), -1.5, 6);
	} else if (age <= 31) {
		// Prime — tight noise, occasional slight dip acceptable
		val += helpers.bound(random.realGauss(0, 2), -1, 3);
	} else {
		// Decline phase — moderate variance
		val += helpers.bound(random.realGauss(0, 3), -2, 2);
	}

	val *= 1 + (val > 0 ? 1 : -1) * coachingEffect(coachingLevel);

	return val;
};

const PHYSICAL_KEYS = new Set(["spd", "jmp", "stre", "endu"]);

const developSeason = (
	ratings: PlayerRatings,
	age: number,
	coachingLevel: number,
	devProfile?: DevProfileType,
	minutesMultiplier: number = 1.0,
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

	const baseChange = calcBaseChange(age, coachingLevel, devProfile);

	for (const key of helpers.keys(ratingsFormulas)) {
		// physical: athletic keys age 2 years slower for ageModifier lookup
		const ageForModifier =
			devProfile === "physical" && PHYSICAL_KEYS.has(key) ? age - 2 : age;
		const ageModifier = ratingsFormulas[key].ageModifier(ageForModifier);
		const changeLimits = ratingsFormulas[key].changeLimits(age);

		ratings[key] = limitRating(
			ratings[key] +
				helpers.bound(
					(baseChange * minutesMultiplier + ageModifier) *
						random.uniform(0.4, 1.4),
					changeLimits[0],
					changeLimits[1],
				),
		);
	}
};

export default developSeason;
