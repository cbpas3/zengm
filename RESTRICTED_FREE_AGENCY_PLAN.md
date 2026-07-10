# Restricted Free Agency — Plan

Status: **plan only — not yet implemented.** Written 2026-07-08. Problem: players coming off
rookie contracts hit unrestricted free agency and walk; the user loses their young players too
early. Implementer: every item has WHERE (file), WHAT, and TEST (§7).

## 1. How it works today (why rookies leave)

- Rookie contracts are flagged (`contract.rookie`) and short — `rookieContractLengths` defaults
  via `getRookieContractLength` (`src/worker/core/draft/getRookieContractLength.ts`), basketball
  1st round = 3 years.
- At `newPhaseResignPlayers` (`src/worker/core/phase/newPhaseResignPlayers.ts`), expiring players
  get `contract.rookieResign = true` if they're coming off a rookie contract
  (`expiredRookieContractPids`), which grants a **+8 mood component**
  (`moodComponents.ts` ~line 311) — but that's it. If `mood.willing` still comes up false
  (`moodInfo.ts` line ~139: bad team → low winning/hype components overwhelm the +8), the player
  goes straight to the unrestricted FA pool and anyone can sign him. The original team has no
  recourse. `rookieResign` is deleted for AI players at the end of the phase (line ~283) and
  destroyed for everyone on any signing (`player/sign.ts` → `setContract` replaces the contract).
- Poaching happens in two places: AI teams via `freeAgents/autoSign.ts` (daily during
  `PHASE.FREE_AGENCY`, via `freeAgents/play.ts` — note `autoSign` never checks mood, it just takes
  `getBest`'s pick), and the user via `contractNegotiation/accept.ts`.

## 2. Tier 0 — ships today, zero code

**`rookiesCanRefuse` already exists** (Settings → Rookie Contracts → "Can Refuse After Rookie
Contract"; `moodInfo.ts` line ~119; default `true`; God Mode required to change in an existing
league). Setting it to **false** forces every player coming off a rookie contract to be _willing_
to re-sign during the re-sign phase — upstream's own description calls it the substitute for RFA
not existing. Limitations: retention is guaranteed-if-you-pay (no market tension, no matching,
also applies symmetrically to AI teams), and it only helps during the re-sign window — a player
you let hit FA is still unrestricted.

**Recommendation: flip this today** to stop the bleeding while Tier 1 is built. With Tier 1 on,
set it back to `true` (RFA supersedes it; keeping both would make the match mechanic dead code
for the user since players would never test the market).

## 3. Tier 1 design — match rights with a pre-authorized ceiling

NBA-style offer sheets with an interactive "match?" interrupt mid-sim is the heavyweight design
(new pause/resume machinery in `freeAgents/play.ts`, new modal flow — deferred to §8). The v1
design gets ~90% of the value with none of the interrupt risk:

- **Eligibility (automatic, no qualifying-offer step):** any player entering free agency whose
  expiring contract has `contract.rookie` — the existing `expiredRookieContractPids` set. Mark him
  with a new optional root field `p.rfaTid = <original tid>` (optional field ⇒ no schema
  migration, same pattern as `Team.gamePlan`). `contract.rookieResign` can't be reused — it's
  deleted for AI players mid-phase and lives on the contract object that `setContract` replaces.
- **Match rights:** whenever another team is about to sign an RFA, the original team gets to match
  — signing the player itself at the same contract.
  - **Original team = AI:** match iff (a) cap-legal (see below), (b) roster spot exists, and
    (c) the valueChange heuristic says keeping him is right — mirror the AI re-sign decision in
    `newPhaseResignPlayers.ts` (~line 247), inverted for adding: match when
    `team.valueChange(rfaTid, [p.pid], [], [], []) > 0` (verify exact signature semantics at
    implementation; the intent is "adding him at this contract is net-positive").
  - **Original team = user:** no mid-sim question. During the re-sign phase and free agency, each
    user RFA carries a **match policy** the user can set ahead of time:
    `match any offer` (default) / `match up to $X/yr` / `don't match`. Stored as
    `p.rfaMatchLimit?: number` (`Infinity` semantics via `undefined` = match any; `0` = don't).
    When an AI signing lands at-or-under the limit and is cap-legal, it auto-matches and logs an
    event ("You matched Team Y's offer sheet for Player Z: $A/B yrs"); over the limit → he walks
    (event logged either way). Default-match-on directly solves "rookies leave too early" with
    zero interaction; the cost is you eat the contract, which is the correct price.
- **Market premium (the RFA tax):** an AI team signing someone else's RFA bids above his
  normalized demand — `offer = min(maxContract, demand × uniform(1.05, 1.25))` — because it knows
  the match is coming. This is what makes RFA a _decision_ rather than free retention: keep the
  kid at an inflated number, or let him go.
- **Chilling effect:** in `autoSign`, AI teams skip RFA targets with probability ~0.5 (real
  front offices don't love tying up cap space in offers that get matched). Also keeps
  offer-sheet event volume reasonable.
- **Cap rules for matching:** soft cap → original team may match over the cap (Bird rights —
  precedent: `birdException` in `contractNegotiation/accept.ts` ~line 38). Hard cap → the match
  must fit or it's disallowed. Roster must have a spot in either case.
- **User poaching an AI RFA:** in `accept.ts`, after the mood/cap checks pass and before
  `player.sign`, run the AI match heuristic for `p.rfaTid`. If the AI matches, return a string
  error (the function already returns user-facing error strings): "The [team] matched your offer
  sheet — [player] returns to them." The user's money was never spent; the AI signs him at the
  user's offered amount.
- **Flag lifecycle:** set in `newPhaseResignPlayers` wherever an eligible player is added to free
  agents (both the user branch ~line 178 and the AI `!reSignPlayer` branch ~line 280). Cleared on
  any successful signing (`player/sign.ts` — clear `p.rfaTid`/`p.rfaMatchLimit` after
  `setContract`) and for stragglers in `newPhasePreseason` (unsigned RFAs become unrestricted;
  clear the fields league-wide). Skip the whole feature when `g.get("forceHistoricalRosters")`
  or `repeatSeason` is active.
- **What this doesn't fix (scope honesty):** if the real pain is contract _demands_ being
  unaffordable rather than willingness, RFA makes retention possible but pricier (premium bids).
  That would be a mood/demand tuning task, separate lever — don't conflate them in this PR.

## 4. Implementation spec

| File                                                                       | Change                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/common/types.ts`                                                      | `rfaTid?: number`, `rfaMatchLimit?: number` on `PlayerWithoutKey`; `restrictedFreeAgency: boolean` on `GameAttributesLeague`; add `"offerSheet"` (or reuse generic) to `LogEventType` (~line 839 near `"refuseToSign"`)                                                            |
| `src/common/defaultGameAttributes.ts`                                      | Register `restrictedFreeAgency`, default **true** for basketball (this fork's point; `false` if upstream-merge-friendliness matters more — §8)                                                                                                                                     |
| Settings plumbing                                                          | Follow the `rookiesCanRefuse` checklist exactly: `ui/views/Settings/settings.tsx` (category "Rookie Contracts", right next to it), `ui/views/Settings/types.ts`, `worker/views/settings.ts` (union + returned object), `worker/views/newLeague.ts`                                 |
| `src/worker/core/phase/newPhaseResignPlayers.ts`                           | Set `rfaTid` on eligible players entering FA (both branches); leave existing `rookieResign` behavior alone                                                                                                                                                                         |
| `src/worker/core/freeAgents/rfa.ts` (new)                                  | Pure-ish helpers: `isRfaEligible(p)`, `aiWantsToMatch(rfaTid, p, contract)` (valueChange + cap + roster checks), `applyOfferPremium(demand)` — single home for the tuning constants (premium range, chill probability), following `gamePlanTuning.ts`'s one-file-tuning convention |
| `src/worker/core/freeAgents/autoSign.ts`                                   | After `getBest` picks an RFA: chill-skip roll; compute premium offer; resolve match (AI heuristic or user `rfaMatchLimit`); sign with winner; log event both ways                                                                                                                  |
| `src/worker/core/contractNegotiation/accept.ts`                            | AI-match check before `player.sign`; string-error return on match                                                                                                                                                                                                                  |
| `src/worker/core/player/sign.ts`                                           | Clear `rfaTid`/`rfaMatchLimit` on signing                                                                                                                                                                                                                                          |
| `src/worker/core/phase/newPhasePreseason.ts`                               | Clear lingering flags                                                                                                                                                                                                                                                              |
| `src/worker/views/freeAgents.ts` + `src/ui/views/FreeAgents.tsx`           | "RFA (Team X)" badge column; for the user's own RFAs, the match-policy control (default "Match any offer")                                                                                                                                                                         |
| `src/worker/views/negotiationList.ts` + `src/ui/views/NegotiationList.tsx` | "Becomes RFA" tag on expiring rookie contracts so the user knows what letting him hit FA means; optionally the same match-policy control here                                                                                                                                      |
| `src/worker/api/index.ts`                                                  | `updateRfaMatchLimit({ pid, limit })` endpoint (mirror `updateGamePlan`'s shape)                                                                                                                                                                                                   |

Edge cases to handle: multi-team mode / spectator / `local.autoPlayUntil` → resolve user matches
via the AI heuristic (same guard pattern as `newPhaseResignPlayers` ~line 171); disabled original
team → clear flag; matching team at max roster size → cannot match.

## 5. Interplay with existing systems

- `rookiesCanRefuse`: recommend leaving `true` once RFA ships (§2). Document in the setting's
  description that RFA supersedes it.
- Mood: keep the +8 `rookieContract` component — re-signing during the window should stay the
  cheap path; RFA is the safety net, not the default route.
- Team chemistry (Feature 7): retained players preserve continuity — no code interaction, but
  T-4 below should confirm chemistry's continuity fraction sees matched players as staying.
- Gemini trade engine: RFAs are on rosters or in FA — no interaction. Sign-and-trade out of scope.

## 6. Tuning targets

| Metric (league-seasons with toggle on vs off)               | Target                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| Players retained by their team after rookie contract expiry | 55–75% (from whatever baseline measures, expect ~30–45%) |
| Matched contracts vs normalized demand                      | +5–25% premium                                           |
| FA pool still clears / rosters fill                         | no stuck players, `ensureEnoughPlayers` never strains    |
| Toggle off                                                  | byte-identical behavior to today (T-1)                   |

## 7. Test plan

New file `src/worker/core/freeAgents/rfa.test.ts` (use the `resetG`/`resetCache` worker-test
pattern; assert **bands, not just direction** — the game-plan-rebalance lesson).

- T-1 backward compat: toggle off → no `rfaTid` ever set; re-sign phase output identical.
- T-2 eligibility: expiring rookie contract → `rfaTid` set on entering FA; expiring veteran
  contract → not set; draft-year rookies (`draft.year === season`) unaffected.
- T-3 AI-vs-AI match: crafted rosters where valueChange clearly favors matching → player stays
  with original team at the premium contract; clearly unfavorable → player moves. Both events
  logged.
- T-4 user auto-match: user RFA with default policy → AI offer auto-matched, player back on user
  roster, payroll reflects the premium; with `rfaMatchLimit` below the offer → player leaves.
- T-5 cap rules: soft cap + original team over cap → match succeeds (Bird); hard cap + over →
  match disallowed, player moves; full roster → match disallowed.
- T-6 user poaching: `accept()` on an AI RFA the AI wants to keep → string error returned, player
  on original team at user's offered amount, no negotiation left dangling; AI declines → signing
  completes normally.
- T-7 lifecycle: flags cleared after any signing and at preseason; no `rfaTid` survives into the
  regular season.
- T-8 season smoke (band test): 2–3 simulated resign+FA cycles, toggle on: retention of
  expiring-rookie-contract players lands in 55–75% vs ≤45% toggle-off baseline; league completes
  seasons without roster-size errors.

Manual playtest: let a good young user player hit FA with default policy → verify the matched-
offer event and the inflated price; set "don't match" → verify he walks; flip the toggle off and
confirm old behavior.

## 8. Open decisions & deferred (v2)

1. **`restrictedFreeAgency` default:** recommend **true** (the feature exists because the current
   behavior is the bug). Toggle covers old saves.
2. **Interactive offer sheets** (pause FA sim, modal Match/Decline): deferred — the ceiling
   pre-authorization covers the decision with zero interrupt machinery. Revisit if the
   pre-commit UX feels flat in play.
3. **Qualifying-offer tender step** (choose _whether_ to make someone an RFA, QO counts as a
   1-year offer he can accept): deferred — automatic eligibility is simpler and matches the
   actual complaint.
4. Sign-and-trades, no-trade-to-offering-team-for-a-year, Arenas-provision second-rounder rules:
   out of scope.
