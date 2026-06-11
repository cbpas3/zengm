# Player Development Realism Plan

This document identifies the gaps in the current development system, proposes concrete improvements ordered by impact vs. complexity, and includes ready-to-use prompts for Claude Sonnet 4.6 to implement each one.

---

## Diagnosis: What Is Unrealistic Today

### 1. Flat +4 Focus Bonus

Every player with a focus archetype gets exactly `+4` to their focus ratings each season (or `+12–22` on a breakthrough). A 50-rated sharpshooter improves at the same speed as an 87-rated one. In reality, rating improvement follows diminishing returns — it is much harder to go from 85→90 than from 50→55.

**Files:** `developSeason.ts` line 135–138.

---

### 2. Breakthrough Is Pure Coin-Flip RNG

The 15% breakthrough trigger is `age <= 24 && Math.random() < 0.15`. No player-specific factors — Giannis and a second-round bust have identical breakthrough odds. The hard age ≤24 cutoff also means players like Kawhi Leonard, who peaked around 27, cannot have a late breakthrough.

**Files:** `developSeason.ts` line 122.

---

### 3. No Work Ethic / Personality Trait

This is the single biggest realism gap. Kobe Bryant, Kevin Durant, and Kawhi Leonard are famous for legendary work ethics; conversely, Kwame Brown and Marvin Williams barely improved despite high physical ceilings. The current system has no way to distinguish them. Every player with the same archetype and age develops identically (minus noise).

**Missing from:** `types.ts` — no such field on `PlayerWithoutKey`.

---

### 4. No Diminishing Returns

`focusBonus = isBreakthrough ? randInt(12, 22) : 4` — the bonus is completely flat regardless of current rating value. A player going from 93→97 on a focus rating is as easy as 53→57. High-rated skills are already very hard to improve in real sports.

**Files:** `developSeason.ts` line 134–138.

---

### 5. No Playing-Time Multiplier

A player averaging 2 minutes per game develops at the same rate as one averaging 36. In reality, playing time is the primary driver of in-season skill development.

**Missing from:** the entire development pipeline — minutes are not passed to `developSeason`.

---

### 6. Single Age Threshold for Breakthrough

The hard ≤24 cutoff creates an artificial cliff. Development in reality is a gradient:

- Ages 19–22 is the explosive growth window
- Ages 23–24 are still high probability
- Ages 25–27 see rarer but possible surges
- "Late bloomers" can break through at 28–30

**Files:** `developSeason.ts` line 122.

---

### 7. Mentor Bonus is Flat and Tiny

`mentorBonus = isMentorKey ? 2 : 0` — every mentor relationship gives exactly +2. A Hall-of-Fame shooter mentoring a rookie on shooting gives the same boost as a fringe veteran doing the same. The mentor's skill level relative to the mentee should matter.

**Files:** `developSeason.ts` line 139.

---

### 8. Regression Floor is Completely Rigid

The guaranteed floor (`Math.max(newVal, snapshot)`) means focus ratings absolutely cannot drop from their season-start values. While the floor concept is valuable, making it permanent across every season means ratings can only ever accumulate — a player who stops working on their shot will still hold every gain. The floor should decay slightly each season it is not exceeded naturally.

**Files:** `developSeason.ts` line 144–148.

---

### 9. No Position-Aware Natural Development Paths

A point guard and a center using the same "Playmaker" archetype follow identical development paths. Real players' positions shape their natural growth — guards naturally improve ball-handling and shooting through repetition, bigs naturally develop post skills and rebounding. The current system has no position weighting at all.

**Missing from:** `developSeason.basketball.ts` — `calcBaseChange` has no position parameter.

---

### 10. Potential Does Not Account for Custom Development

`monteCarloPot` runs 20 simulated seasons with `forPot=true`, which **skips** focus/mentor bonuses entirely. This means the displayed potential ceiling does not reflect the player's development program. A player with a Sharpshooter focus shows the same potential as one with no focus. This makes the Potential column misleading for coached players.

**Files:** `develop.ts` (monteCarloPot block), `developSeason.ts` line 116.

---

## Proposed Improvements (Priority Order)

---

### Improvement 1: Work Ethic Trait

**Impact:** Very High | **Complexity:** Medium

Add a per-player `workEthic` trait (values: `"elite" | "high" | "average" | "low"`) generated at player creation. Work ethic:

- Multiplies the focus bonus: `elite = ×1.5`, `high = ×1.2`, `average = ×1.0`, `low = ×0.7`
- Multiplies breakthrough probability: `elite = ×1.6`, `high = ×1.25`, `average = ×1.0`, `low = ×0.6`
- Is visible in the player bio/ratings card so users can make roster decisions based on it
- Is generated with realistic distribution: ~15% elite, ~30% high, ~40% average, ~15% low

**Files to change:**

- `src/common/types.ts` — add `workEthic` to `PlayerWithoutKey`
- `src/worker/core/player/generate.ts` (or wherever players are created) — generate the trait
- `src/worker/core/player/developSeason.ts` — apply multipliers to `focusBonus` and breakthrough probability
- `src/worker/core/player/develop.ts` — pass `workEthic` down through `devOptions`
- `src/worker/api/index.ts` — expose `workEthic` in roster view
- `src/ui/views/Player/index.tsx` or Bio component — display the trait

---

### Improvement 2: Diminishing Returns on Focus Bonuses

**Impact:** High | **Complexity:** Low

Scale the focus bonus by how far the rating is from 100. The closer to the ceiling, the smaller the gain. Formula:

```
headroomFactor = (100 - currentRating) / 50   // 1.0 at 50, 0.0 at 100
scaledBonus = focusBonus * Math.max(0.25, headroomFactor)
```

This means:

- Rating 50: full bonus (×1.0)
- Rating 75: half bonus (×0.5)
- Rating 90: 20% bonus (×0.2), floor at ×0.25
- Rating 95+: minimum 25% bonus always (floor ensures it never feels pointless)

**Files to change:**

- `src/worker/core/player/developSeason.ts` — modify the focus bonus calculation in Step 3 (lines 134–148)

---

### Improvement 3: Tiered Breakthrough Probability

**Impact:** High | **Complexity:** Low

Replace the single `age <= 24 && 0.15` with age bands and a work ethic multiplier (see Improvement 1):

| Age                             | Base Probability | Notes                 |
| ------------------------------- | ---------------- | --------------------- |
| ≤22                             | 20%              | Prime growth window   |
| 23–24                           | 15%              | Current behavior      |
| 25–27                           | 8%               | Late surge, realistic |
| 28–30 (late bloomer trait only) | 5%               | Rare but canonical    |
| 31+                             | 0%               | No breakthroughs      |

The `lateBlooomer` trait (see Improvement 5) extends the window. This alone makes development feel more differentiated without requiring a full trait system.

**Files to change:**

- `src/worker/core/player/developSeason.ts` — replace line 122's single condition with a probability lookup function

---

### Improvement 4: Scaled Mentor Bonus

**Impact:** Medium | **Complexity:** Low

Instead of a flat +2 mentor bonus, scale by the gap between mentor's skill and mentee's skill in the boosted key:

```
gap = mentorRating[key] - menteeRating[key]
mentorBonus = gap > 30 ? 3 : gap > 15 ? 2 : gap > 0 ? 1 : 0
```

This means:

- A 90-rated shooter mentoring a 55-rated shooter → +3 (huge gap, lots to learn)
- A 75-rated shooter mentoring a 70-rated shooter → +1 (diminishing benefit)
- Mentee is actually better than mentor in a skill → +0 (nothing to teach)

**Files to change:**

- `src/worker/core/player/develop.ts` — when resolving mentor, pass mentor's ratings down
- `src/worker/core/player/developSeason.ts` — change `DevOptions` type to accept mentor ratings, replace flat +2 with gap-based formula
- `src/common/types.ts` — update `DevOptions` if it becomes a shared type

---

### Improvement 5: Player Development Archetype Trait

**Impact:** High | **Complexity:** Medium

Add a second per-player trait `devProfile` (distinct from the coaching `devFocus`) that describes the player's natural development curve:

| Profile      | Behavior                                                                               |
| ------------ | -------------------------------------------------------------------------------------- |
| `earlyBloom` | +30% base bonus ages 19–22, peak earlier (27), steeper decline after 30                |
| `lateBloom`  | −20% base bonus ages 19–24, breakthrough window extends to 30, decline starts at 33    |
| `consistent` | No breakthroughs, but base bonus is guaranteed (no negative noise years before 28)     |
| `physical`   | `spd`, `jmp`, `stre`, `endu` age curve shifted 2 years later; athleticism holds longer |
| `standard`   | Current behavior (no modification)                                                     |

Distribution at generation: `earlyBloom` 15%, `lateBloom` 10%, `consistent` 20%, `physical` 15%, `standard` 40%.

**Files to change:**

- `src/common/types.ts` — add `devProfile` union type and field on `PlayerWithoutKey`
- `src/worker/core/player/generate.ts` — generate trait at player creation
- `src/worker/core/player/developSeason.ts` — pass `devProfile` through `DevOptions`, apply modifiers to base change and age thresholds
- `src/worker/core/player/developSeason.basketball.ts` — `calcBaseChange` needs a `devProfile` parameter to adjust return value
- `src/ui/views/Player/` — display trait in bio

---

### Improvement 6: Playing-Time Development Multiplier

**Impact:** Medium | **Complexity:** Medium-High

Development scales with playing time. The preseason hook calls `player.develop()` — at that point, the player's previous season stats (minutes per game) are available via `p.stats`.

Proposed multiplier lookup:

| MPG   | Multiplier                 |
| ----- | -------------------------- |
| 30+   | 1.15 (heavy starter bonus) |
| 22–29 | 1.00 (baseline starter)    |
| 12–21 | 0.80 (rotation player)     |
| 5–11  | 0.60 (bench depth)         |
| 0–4   | 0.45 (inactive/DNP)        |

The multiplier applies to `baseChange` in `calcBaseChange`, affecting all rating keys uniformly. It does **not** affect focus bonuses (those represent intentional off-court work) — only the passive in-game development from reps.

**Files to change:**

- `src/worker/core/player/develop.ts` — read last season MPG from `p.stats`, compute multiplier, pass to `developSeason`
- `src/worker/core/player/developSeason.ts` — forward `minutesMultiplier` param to sport-specific function
- `src/worker/core/player/developSeason.basketball.ts` — apply multiplier inside `calcBaseChange` to `val` before noise

---

### Improvement 7: Softened Regression Floor

**Impact:** Medium | **Complexity:** Low

The current floor is `Math.max(newVal, snapshot)` — permanent and absolute. Change it to a _decaying_ floor that drops 1 point per season if the player does not naturally hit or exceed it:

```
// In player data, store: focusFloor: Partial<Record<string, number>>
// Each season:
//   if newVal >= currentFloor[key]: floor stays (player naturally met it)
//   else: floor = max(currentFloor[key] - 1, snapshot - 3)  // floor decays, but not below 3 under original snapshot
//   apply: newVal = max(newVal, currentFloor[key])
```

This means:

- Active development still protects ratings
- Neglecting development (removing focus) causes gradual decay
- Floor cannot drop more than 3 points below the original snapshot (safety net preserved)

**Files to change:**

- `src/common/types.ts` — add `focusFloor: Partial<Record<string, number>>` to `PlayerWithoutKey`
- `src/worker/core/player/develop.ts` — read/write `focusFloor` on the player object, pass to `developSeason`
- `src/worker/core/player/developSeason.ts` — replace snapshot-based floor with persistent `focusFloor`
- `src/worker/api/index.ts` — initialize `focusFloor` when `devFocus` is first set

---

### Improvement 8: Potential Calculation Reflects Focus

**Impact:** Medium | **Complexity:** Medium

`monteCarloPot()` runs with `forPot=true`, which skips focus bonuses. The Potential column therefore ignores the player's development program entirely. Fix this by running a separate "coached potential" estimate that includes bonuses at a discounted rate.

Proposed approach: add a second pot value `potFocused` calculated by running Monte Carlo with `forPot=false` but using a fixed "average work ethic" (no random noise on bonuses) and a 50% focus bonus rate. This gives a realistic ceiling for a coached player without over-inflating projections.

Display it in the UI as the standard potential column when the player has a focus set, with a small "coached" indicator.

**Files to change:**

- `src/worker/core/player/develop.ts` — add `monteCarloPotFocused()` or modify `monteCarloPot` to accept a `includeDevBonuses` flag
- `src/worker/core/player/developSeason.ts` — add a `forCoachPot` mode that uses 50% of normal focus bonuses, skips mentor
- `src/worker/views/roster.ts` — expose `potFocused` to UI
- `src/ui/views/Roster/` — display coached pot when focus is set

---

## Implementation Sequence (Recommended)

The improvements build on each other. Implement in this order to avoid rework:

```
Phase 1 (standalone, no dependencies):
  → Improvement 2: Diminishing Returns        [~1 hour, single file]
  → Improvement 3: Tiered Breakthrough        [~30 min, single file]
  → Improvement 4: Scaled Mentor Bonus        [~1 hour, two files]

Phase 2 (requires Phase 1 breakthrough logic):
  → Improvement 1: Work Ethic Trait           [~3 hours, 4 files]
  → Improvement 7: Softened Floor             [~2 hours, 3 files]

Phase 3 (requires Work Ethic Trait from Phase 2):
  → Improvement 5: Dev Profile Trait          [~4 hours, 4 files]
  → Improvement 6: Playing-Time Multiplier    [~3 hours, 3 files]

Phase 4 (requires all of above):
  → Improvement 8: Coached Potential          [~3 hours, 4 files]
```

---

## Claude Sonnet 4.6 Implementation Prompts

Each prompt below is self-contained. Read the relevant files before sending the prompt.

---

### Prompt 1 — Diminishing Returns on Focus Bonuses

> **Task:** Modify `src/worker/core/player/developSeason.ts` to apply diminishing returns to focus bonuses in Step 3.
>
> **Current behavior (lines 134–138):**
>
> ```typescript
> const focusBonus = isFocusKey
> 	? isBreakthrough
> 		? random.randInt(12, 22)
> 		: 4
> 	: 0;
> ```
>
> **Desired behavior:** The `focusBonus` (both normal and breakthrough) should scale down as the current rating approaches 100. Use this formula:
>
> ```
> headroomFactor = Math.max(0.25, (100 - currentRating) / 50)
> scaledFocusBonus = Math.round(rawFocusBonus * headroomFactor)
> ```
>
> Where `currentRating = (ratings as any)[key]` before the bonus is applied.
>
> Apply `headroomFactor` to both the `+4` normal bonus and the `randInt(12, 22)` breakthrough bonus. The minimum factor is `0.25` (not 0), so there is always some benefit.
>
> Do not change any other logic. Do not change imports. Only modify the bonus calculation in Step 3. The guaranteed floor logic below it should remain unchanged.
>
> **Context:** `src/worker/core/player/developSeason.ts` — the full file is provided above. The change is entirely within the Step 3 block (lines 113–150).

---

### Prompt 2 — Tiered Breakthrough Probability

> **Task:** Modify `src/worker/core/player/developSeason.ts` to replace the hard `age <= 24` breakthrough threshold with a tiered probability function.
>
> **Current behavior (line 122):**
>
> ```typescript
> const isBreakthrough =
> 	devOptions?.devFocus !== undefined && age <= 24 && Math.random() < 0.15;
> ```
>
> **Desired behavior:** Replace the single condition with a helper function that returns a probability based on age, then a single `Math.random() < prob` check:
>
> ```typescript
> const getBreakthroughProb = (age: number): number => {
> 	if (age <= 22) return 0.2;
> 	if (age <= 24) return 0.15;
> 	if (age <= 27) return 0.08;
> 	return 0;
> };
>
> const isBreakthrough =
> 	devOptions?.devFocus !== undefined &&
> 	Math.random() < getBreakthroughProb(age);
> ```
>
> Define `getBreakthroughProb` as a module-level function (not inside `developSeason`) so it is easy to unit-test and extend later. Do not change any other logic in the file.

---

### Prompt 3 — Scaled Mentor Bonus

> **Task:** Scale the mentor bonus in `src/worker/core/player/developSeason.ts` based on the gap between the mentor's rating and the mentee's current rating for each skill.
>
> **Current behavior (line 139):**
>
> ```typescript
> const mentorBonus = isMentorKey ? 2 : 0;
> ```
>
> **Step A — Change the `DevOptions` type** (top of `developSeason.ts`):
>
> ```typescript
> type DevOptions = {
> 	devOverride?: boolean;
> 	devFocus?: DevFocusType;
> 	mentorBoostKeys?: string[];
> 	mentorRatings?: Partial<Record<string, number>>; // ← add this
> };
> ```
>
> **Step B — Replace the flat +2 with gap-based formula:**
>
> ```typescript
> const getMentorBonus = (
> 	mentorRatings: Partial<Record<string, number>> | undefined,
> 	key: string,
> 	menteeCurrentRating: number,
> ): number => {
> 	if (!mentorRatings) return 2; // fallback to flat +2 if mentor ratings unavailable
> 	const mentorVal = mentorRatings[key];
> 	if (mentorVal === undefined) return 1;
> 	const gap = mentorVal - menteeCurrentRating;
> 	if (gap > 30) return 3;
> 	if (gap > 15) return 2;
> 	if (gap > 0) return 1;
> 	return 0;
> };
>
> // Replace line 139:
> const mentorBonus = isMentorKey
> 	? getMentorBonus(
> 			devOptions?.mentorRatings,
> 			key as string,
> 			(ratings as any)[key],
> 		)
> 	: 0;
> ```
>
> **Step C — In `src/worker/core/player/develop.ts`**, when building `devOptions` for the `developSeason` call, add the mentor's current ratings for the `mentorBoostKeys`. Look at how `mentorBoostKeys` is currently constructed (the top-4 sorted skill keys from the mentor's ratings). Pass those same mentor rating values as `mentorRatings: { [key]: mentorRatings[key] }`.
>
> Do not change the UI. Do not change how `mentorBoostKeys` is determined.

---

### Prompt 4 — Work Ethic Trait

> **Task:** Add a `workEthic` trait to players and use it to multiply development bonuses.
>
> **Step A — Add type** in `src/common/types.ts`:
> Find `PlayerWithoutKey` and add:
>
> ```typescript
> workEthic?: "elite" | "high" | "average" | "low";
> ```
>
> **Step B — Generate trait at player creation**. Find the file that calls `player.generate()` or sets initial player fields (likely `src/worker/core/player/generate.ts`). Add a function:
>
> ```typescript
> const generateWorkEthic = (): Player["workEthic"] => {
> 	const r = Math.random();
> 	if (r < 0.15) return "elite";
> 	if (r < 0.45) return "high";
> 	if (r < 0.85) return "average";
> 	return "low";
> };
> ```
>
> Call it and assign the result to `p.workEthic` when a new player is created. Existing players without the field default to `"average"` via `?? "average"`.
>
> **Step C — Pass through `develop.ts`**. In `src/worker/core/player/develop.ts`, pass `p.workEthic` as part of `devOptions`:
>
> ```typescript
> type DevOptions = {
>     ...existing fields...
>     workEthic?: "elite" | "high" | "average" | "low";
> };
> ```
>
> **Step D — Apply multipliers in `developSeason.ts`**. Add a helper:
>
> ```typescript
> const WORK_ETHIC_MULTIPLIER: Record<string, number> = {
> 	elite: 1.5,
> 	high: 1.2,
> 	average: 1.0,
> 	low: 0.7,
> };
> ```
>
> In Step 3, after calculating `rawFocusBonus` (with diminishing returns already applied from Prompt 1), multiply by `WORK_ETHIC_MULTIPLIER[devOptions.workEthic ?? "average"]` and round. Apply the same multiplier to `getBreakthroughProb(age)` when checking `isBreakthrough`.
>
> **Step E — Display in UI**. In `src/worker/views/roster.ts`, expose `workEthic` in the player row data. In the roster table or player modal, add a text label for the trait. A small colored badge (green/blue/gray/red for elite/high/average/low) works well.

---

### Prompt 5 — Player Development Profile Trait

> **Task:** Add a `devProfile` trait (distinct from `devFocus`) that modifies the player's natural aging curve.
>
> **Step A — Add type** in `src/common/types.ts`:
>
> ```typescript
> type DevProfileType =
> 	| "earlyBloom"
> 	| "lateBloom"
> 	| "consistent"
> 	| "physical"
> 	| "standard";
> ```
>
> Add `devProfile?: DevProfileType` to `PlayerWithoutKey`.
>
> **Step B — Generate at player creation** (same file as `workEthic` in Prompt 4):
>
> ```typescript
> const generateDevProfile = (): DevProfileType => {
> 	const r = Math.random();
> 	if (r < 0.15) return "earlyBloom";
> 	if (r < 0.25) return "lateBloom";
> 	if (r < 0.45) return "consistent";
> 	if (r < 0.6) return "physical";
> 	return "standard";
> };
> ```
>
> **Step C — Pass through `develop.ts`** into `DevOptions`.
>
> **Step D — Apply in `developSeason.basketball.ts`**. Modify `calcBaseChange(age, coachingLevel)` to accept an optional third argument `devProfile?: DevProfileType` and apply these rules **to the `val` before noise is added**:
>
> - `earlyBloom`: ages ≤25, multiply `val` by `1.3`; ages ≥31, multiply by `0.8` (steeper decline)
> - `lateBloom`: ages ≤23, multiply `val` by `0.8`; ages 24–30, multiply by `1.15`
> - `consistent`: if `val > 0`, replace the noise call with `0` (no variance, but guaranteed improvement when base is positive). If `val < 0` (decline), keep normal noise.
> - `physical`: for `spd`, `jmp`, `stre`, `endu` ratings **only**, shift the effective `age` by `-2` in the `ageModifier` calculation (athleticism ages 2 years slower). This requires passing `devProfile` into the per-rating `ageModifier` functions for those keys.
> - `standard`: no change.
>
> For `lateBloom`, also update `getBreakthroughProb` in `developSeason.ts` to add an additional case: if `devProfile === "lateBloom"` and `age <= 30`, use `0.05`.
>
> **Step E — Display in UI** alongside `workEthic`.

---

### Prompt 6 — Playing-Time Development Multiplier

> **Task:** Scale passive development (base change) by the player's minutes per game from the previous season.
>
> **Step A — In `src/worker/core/player/develop.ts`**, before calling `developSeason`, read the player's previous season minutes from `p.stats`. The last element of `p.stats` (filtered to `!s.playoffs`) holds the last regular season stats. The MPG value is `lastSeason.min / lastSeason.gp` (handle division-by-zero and missing stats gracefully, defaulting to `1.0`).
>
> Compute:
>
> ```typescript
> const getMinutesMultiplier = (mpg: number): number => {
> 	if (mpg >= 30) return 1.15;
> 	if (mpg >= 22) return 1.0;
> 	if (mpg >= 12) return 0.8;
> 	if (mpg >= 5) return 0.6;
> 	return 0.45;
> };
> ```
>
> Pass `minutesMultiplier` as a new field in `DevOptions`.
>
> **Step B — In `developSeason.ts`**, pass `devOptions?.minutesMultiplier ?? 1.0` to the sport-specific function call. Update the `bySport` call for basketball to pass the multiplier.
>
> **Step C — In `developSeason.basketball.ts`**, modify `developSeason` to accept an optional `minutesMultiplier: number = 1.0` parameter. Inside the `for` loop over `ratingsFormulas`, multiply `baseChange` by `minutesMultiplier` before it is added to the rating:
>
> ```typescript
> ratings[key] = limitRating(
> 	ratings[key] +
> 		helpers.bound(
> 			(baseChange * minutesMultiplier + ageModifier) *
> 				random.uniform(0.4, 1.4),
> 			changeLimits[0],
> 			changeLimits[1],
> 		),
> );
> ```
>
> Do **not** apply the multiplier to focus bonuses in Step 3 of `developSeason.ts` — those represent off-court intentional work and should not scale with playing time.
>
> **Note:** For the `newPlayer=true` path (draft class creation), `minutesMultiplier` should always be `1.0`.

---

### Prompt 7 — Softened Regression Floor

> **Task:** Replace the single-season absolute floor with a persistent per-player floor that decays 1 point per season when not met naturally.
>
> **Step A — Add field to player type** in `src/common/types.ts`:
>
> ```typescript
> focusFloor?: Partial<Record<string, number>>;
> ```
>
> **Step B — Initialize in `src/worker/api/index.ts`** in `updatePlayerDevelopment`. When `devFocus` is first set on a player (transitioning from `undefined` to a value), initialize `p.focusFloor` by copying the player's current focus ratings:
>
> ```typescript
> const focusRatings = DEV_FOCUS_RATINGS[newFocus];
> p.focusFloor = {};
> for (const key of focusRatings) {
> 	p.focusFloor[key] = (p.ratings[p.ratings.length - 1] as any)[key];
> }
> ```
>
> When `devFocus` is cleared, also clear `focusFloor`.
>
> **Step C — Pass through `develop.ts`**. Add `focusFloor` to `devOptions`.
>
> **Step D — Modify floor logic in `developSeason.ts`** (Step 3, lines 144–148). Replace the snapshot-based floor with:
>
> ```typescript
> const persistedFloor = devOptions?.focusFloor?.[key as string];
> const floor =
> 	isFocusKey && persistedFloor !== undefined ? persistedFloor : -Infinity;
>
> const finalVal = limitRating(Math.max(newVal, floor));
> (ratings as any)[key] = finalVal;
>
> // After application, decay the floor by 1 if not naturally met
> if (isFocusKey && persistedFloor !== undefined && devOptions?.focusFloor) {
> 	if (newVal >= persistedFloor) {
> 		// Player met the floor naturally — hold it at current value
> 		devOptions.focusFloor[key as string] = finalVal;
> 	} else {
> 		// Player didn't reach floor — decay by 1 (min: 3 below original snapshot)
> 		const originalSnapshot = ratingSnapshot[key as string] ?? persistedFloor;
> 		devOptions.focusFloor[key as string] = Math.max(
> 			persistedFloor - 1,
> 			originalSnapshot - 3,
> 		);
> 	}
> }
> ```
>
> **Step E — In `develop.ts`**, after `developSeason` returns, write the mutated `devOptions.focusFloor` back to `p.focusFloor`. This makes the decay persistent across seasons.
>
> Remove the `ratingSnapshot` logic for focus keys from `developSeason.ts` since `focusFloor` now handles it. Keep the snapshot only as a reference for the `-3` lower bound.

---

## Key Constants Summary (for reference during implementation)

| Location                      | Constant              | Current Value     | After Improvements                                       |
| ----------------------------- | --------------------- | ----------------- | -------------------------------------------------------- |
| `developSeason.ts`            | Normal focus bonus    | `4`               | `4 × headroomFactor × workEthicMultiplier`               |
| `developSeason.ts`            | Breakthrough bonus    | `randInt(12, 22)` | `randInt(12, 22) × headroomFactor × workEthicMultiplier` |
| `developSeason.ts`            | Breakthrough prob ≤24 | `0.15`            | `0.20 (≤22), 0.15 (23-24), 0.08 (25-27)`                 |
| `developSeason.ts`            | Mentor bonus          | `2`               | `0–3 based on skill gap`                                 |
| `develop.ts`                  | Mentor age threshold  | `>= 28`           | unchanged                                                |
| `develop.ts`                  | Mentee age cutoff     | `<= 23`           | unchanged                                                |
| `developSeason.basketball.ts` | Height growth cutoff  | `<= 21`           | unchanged                                                |

---

## Notes

- **Test coverage**: After each phase, set `realPlayerDeterminism=0` and run several sim seasons to observe rating distributions. The goal is that 22-year-olds with elite work ethic noticeably outpace average-ethic peers by age 26.
- **Backward compatibility**: All new fields (`workEthic`, `devProfile`, `focusFloor`) use `?` optional typing and default gracefully. Existing saves will not break.
- **RPD interaction**: None of these improvements conflict with RPD because focus/mentor keys are already exempt from RPD blending. Work ethic and dev profile only affect the bonus layer (Step 3), not the RPD blend (Step 2).
- **Potential inflation risk**: If implementing Improvement 8 (coached potential), ensure the Monte Carlo uses a fixed "average" work ethic regardless of the actual player's trait, to avoid potential values becoming misleadingly high for elite-ethic players.
