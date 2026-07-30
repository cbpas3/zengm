# MOBILE_FIRST_ACCESSIBILITY_PLAN.md

**Goal:** rebuild every page of this Basketball GM fork as mobile-first, with large, high-contrast,
easily readable type, generous touch targets, and no horizontal scrolling — designed for an elderly
user with reduced visual acuity and reduced motor precision.

**Audience of this document:** an LLM implementing the work. Read §1–§4 in full before editing a
single file. §1 is ground truth about how styling actually works here; §2 lists the traps that will
silently break a production build; §5–§13 are the phased work plan.

**Non-goal:** a desktop redesign. Desktop must not regress, but every decision is made for a 390 ×
844 phone held at arm's length by someone who does not want to pinch-zoom, and desktop inherits.

---

## 0. Design targets (the numbers this plan is measured against)

These are commitments, not aspirations. Every phase's acceptance criteria trace back here.

| Property                       | Target                                                                   | Rationale                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Default body text              | **18px** (currently 13px)                                                | Low-vision baseline. 16px is the general-web floor; 18px is the low-vision floor and this app's audience is stated.    |
| Absolute minimum text anywhere | **14px**                                                                 | Kills the 10px `.skill` / `.jersey-number-name` / 12px `h5` / 12px filter-input tier entirely.                         |
| User-selectable scale          | 16 / **18 (default)** / 21 / 24px                                        | One control, whole app. See Phase 6.                                                                                   |
| Line height (body)             | ≥ **1.5**                                                                | WCAG 1.4.12 Text Spacing.                                                                                              |
| Line height (headings)         | ≥ 1.25                                                                   | Same, with tighter optical setting allowed for large type.                                                             |
| Touch target — primary actions | **48 × 48** CSS px                                                       | Play button, Save, Sign, Trade, Draft, nav links, pagination. Material's floor; comfortable with tremor.                |
| Touch target — all others      | **44 × 44** CSS px                                                       | WCAG 2.5.5 (AAA). No control anywhere may fall below 24 × 24 (2.5.8 AA) — that is a hard floor, not a target.           |
| Gap between adjacent targets   | ≥ **8px**                                                                | Mis-tap prevention.                                                                                                    |
| Contrast — body text           | ≥ **7:1** (WCAG AAA)                                                     | AA's 4.5:1 is not enough for aging eyes. Secondary/muted text is the main offender today.                              |
| Contrast — large text / UI     | ≥ 4.5:1                                                                  | One step above AA's 3:1.                                                                                                |
| Reflow                         | **No two-dimensional scrolling at 320px viewport width**                 | WCAG 1.4.10. The app fails this badly today on ~60 table pages. This is the single largest piece of work (Phase 4).     |
| Hover-only information        | **Zero**                                                                 | Column definitions today live in `title=` attributes — unreachable on touch. Must become tappable.                     |
| Orientation                    | Portrait and landscape both usable                                       | WCAG 1.3.4.                                                                                                            |
| Motion                         | Respect `prefers-reduced-motion`                                         | Vestibular safety; also the sidebar/fade transitions.                                                                  |

**Reference viewports.** Author against these three, in this order:

1. **360 × 640** — the hard case. Small Android, and what 320px-at-400%-zoom effectively behaves like.
2. **390 × 844** — iPhone 14/15/16 baseline. The primary target.
3. **1280 × 800** — desktop regression check only.

---

## 1. Ground truth: how styling actually works in this repo

Do not infer this from experience with other Bootstrap apps. Verify each claim before relying on it.

### 1.1 There are exactly two stylesheets, and one imports the other

```
public/css/light.scss   1748 lines  ← the real stylesheet: Bootstrap config + imports + ~1200 lines of app CSS
public/css/dark.scss     464 lines  ← overrides SCSS colour vars, then `@import "light";` (line 48)
public/css/sidebar.scss  117 lines  ← @imported by light.scss:129
public/css/datatable.scss 110 lines ← @imported by light.scss:126
public/css/glyphicons.scss, bbgm-notifications.scss ← also @imported by light.scss
```

**Consequence:** a typography change in `light.scss` automatically applies to dark mode. You almost
never need to touch `dark.scss` — only when a *colour* needs a dark-specific value.

There are **no CSS/SCSS files under `src/`** and **no CSS-in-JS**. All styling is either in
`public/css/*.scss`, a Bootstrap utility class in TSX, or an inline `style={{...}}` object in TSX.

### 1.2 Bootstrap 5.3.8 is consumed as SCSS with variable overrides

`light.scss` sets SCSS variables (lines 1–33, 46+) **before** `@import`ing Bootstrap's partials
individually (lines 93–124). The critical one:

```scss
// public/css/light.scss:33
$font-size-base: 0.8125rem;   // = 13px. THE root cause of the whole problem.
```

Because Bootstrap 5 derives most of its sizing from `$font-size-base` in `rem`/`em`, changing this
one variable cascades correctly through buttons, inputs, tables, badges, dropdowns, modals.

**But** this fork then overrides much of it with **hardcoded `px`**, which will *not* scale:

```scss
// public/css/light.scss:142-158
h1 { font-size: 24px; }  h2 { font-size: 20px; }  h3 { font-size: 16px; }
h4 { font-size: 14px; }  h5 { font-size: 12px; }  .modal-title { font-size: 20px; }
```

Every hardcoded font size is enumerated in §3.1. Those are the work items.

### 1.3 The build: PurgeCSS and fingerprinting (read this twice)

`tools/build/buildCss.ts`:

- Compiles `light.scss` and `dark.scss` with `sass-embedded`.
- **In production only** (`watch === false`), runs **PurgeCSS** with
  `content: ["build/gen/*.js"]` — any class selector whose name does not appear as a **literal
  string somewhere in the emitted JS is deleted from the CSS.** Safelist is at
  `buildCss.ts:35-57`.
- Then minifies with lightningcss and fingerprints the filename (`light-<hash>.css`), injecting the
  hash into `index.html` via `CSS_HASH_LIGHT` / `CSS_HASH_DARK`.

**Three hard consequences:**

1. **Never build a class name dynamically.** `` className={`fs-${n}`} `` compiles to a template
   literal; PurgeCSS will not see `fs-1`, and the rule is deleted in production. Write the full
   literal (`clsx({ "zen-card-label": true })` is fine — the literal appears) or add a regex to the
   `buildCss.ts` safelist.
2. **`pnpm run dev` does not purge and does not fingerprint.** A purge bug is *invisible in dev* and
   only appears in a production build. This fork has already been bitten by exactly this class of
   dev/prod divergence (see CLAUDE.md → Deployment → "Production-build fingerprint gotcha"). **Every
   phase must be verified with a real `SPORT=basketball pnpm run build`, not just dev.**
3. Element selectors (`h1`, `table`, `body`), attribute selectors (`[data-font-scale]`), and
   `:root` custom properties are **not** purged. Prefer these for the design-token layer — that is
   the design-token strategy in §4.

### 1.4 Viewport and the pre-paint theme script

`public/index.html` is a template (`GAME_NAME`, `CSS_HASH_LIGHT`, … are replaced at build time by
`tools/build/buildIndexHtml.ts`).

- Viewport meta is already correct: `width=device-width, initial-scale=1` (line 6). Do **not** add
  `maximum-scale` or `user-scalable=no` — that would violate WCAG 1.4.4 and is actively hostile to
  this audience.
- An inline `<script>` picks the theme **before first paint** to avoid a flash: `getTheme()` reads
  `localStorage.theme`, `getThemeFilename()` returns the hashed CSS path, `loadCSS()` injects the
  `<link>` and stores it on `window.themeCSSLink`. **This is the exact pattern the font-size setting
  must copy** (Phase 6).
- `window.mobile = window.screen.width < 768 || window.screen.height < 768;` (line 26).
- `<body class="h-100" style="padding-top: 52px">` (line 105) — **the fixed navbar height is an
  inline style in the HTML template.** See §1.6.

### 1.5 `window.mobile` is a trap

It is computed **once**, from `window.screen` (the *device* screen, not the viewport), and **never
updates** on resize or rotation. It is read in **43 places** outside the ad code
(`grep -rn "window\.mobile" src/ui | grep -v util/ads`), of which **28 are the single pattern
`defaultStickyCols={window.mobile ? 0 : N}`** across 28 `DataTable` views. The rest:
`PlayerNameLabels.tsx:164`, `PlayMenu.tsx:78`, `JerseyNumber.tsx:82`, `MoreLinks.tsx:349`,
`CommandPalette/index.tsx:988`, `ResponsivePopover.tsx:26`, `Skyscraper.tsx:23`, `Dashboard.tsx:295`,
`GamePlanEditor.tsx:208,223`, `PlayThroughInjuriesSliders.tsx:83,90`, `ScheduleEditor/index.tsx:761`.

Note that Phase 4's card mode makes all 28 `defaultStickyCols` reads **dead on mobile** (cards have
no sticky columns), so that pattern gets deleted rather than migrated.

**Rules:**

- Do **not** add new layout logic keyed on `window.mobile`. Use CSS media queries, or
  `window.matchMedia(...)` with a `change` listener (the pattern already used correctly in
  `SideBar.tsx:302` and `Dropdown.tsx:83`).
- Where you must branch in JS, introduce **one** shared hook — `src/ui/hooks/useBreakpoint.ts`,
  backed by `matchMedia` + `useSyncExternalStore` — and migrate existing `window.mobile` reads to it
  as you touch each file. Do not do a big-bang migration; do not leave two mechanisms in the same
  component.
- Keep `window.mobile` itself for the ad code (`src/ui/util/ads.ts`) — out of scope.

### 1.6 Magic layout numbers keyed to the 13px navbar

The navbar's 52px height is hardcoded in **eight** places that must all agree. If type grows and the
navbar grows, every one of these breaks (content hidden under the navbar, sticky headers in the wrong
place, anchor links landing off-target):

| Location                            | Value                        | What it is                        |
| ----------------------------------- | ---------------------------- | --------------------------------- |
| `public/index.html:105`             | `padding-top: 52px` (inline) | Body offset under fixed navbar    |
| `public/css/sidebar.scss:62`        | `top: 52px`                  | Sidebar top (xl and up)           |
| `public/css/light.scss:701`         | `top: 52px`                  | `.live-game-affix` sticky         |
| `public/css/light.scss:709`         | `top: 52px`                  | `.live-game-sticky`               |
| `public/css/light.scss:167`         | `top: 60px`                  | Right-rail ad sticky              |
| `public/css/light.scss:719`         | `top: 60px`                  | `.trade-affix` sticky             |
| `public/css/light.scss:1360`        | `top: 60px`                  | `.settings-shortcuts` sticky      |
| `public/css/light.scss:1339`         | `top: -60px`                 | Anchor-link scroll offset (`a.anchor`) |
| `src/ui/views/LiveGame/index.tsx:231` | `window.innerHeight - 113`  | Play-by-play pane height (JS)     |

Phase 2 replaces all of these with a single CSS custom property. Do not skip that phase and then
change type sizes — you will spend longer chasing overlap bugs than the phase would have cost.

### 1.7 `DataTable` is the application

64 of 123 view modules render `src/ui/components/DataTable/index.tsx`. A further 27 files render raw
`<table>`. Understand this component before Phase 4:

- Renders `<table class="table table-hover table-sm table-striped table-borderless">` —
  `table-sm` is on by default (`index.tsx:466`, `small !== false`; only 2 views opt out).
- `light.scss:386-388`: **`table { white-space: nowrap; }`** — globally, no table cell ever wraps. This
  single rule is why every stats page scrolls horizontally forever.
- `light.scss:867`: `.table tr { min-height: 30px; }` — below the 44px touch floor.
- Sticky columns: `light.scss:1540+` generates `.sticky-x`/`-xx`/`-xxx`/`-iv`; the `left` offsets are
  measured and applied by JS in `DataTable/useStickyXX.ts`. Sticky header via
  `useStickyTableHeader.ts`.
- Column metadata comes from `src/common/getCols.ts` (3808 lines). **Each column already has both a
  short `title` ("TRB") and a long `desc` ("Total Rebounds")** — this is the raw material for
  readable mobile labels, and it already exists. Do not invent a new label source.
- `desc` is currently surfaced **only** as `title={desc}` on the `<th>`
  (`DataTable/Header.tsx:143,386`) — a native hover tooltip, i.e. invisible on touch. Fixing this is
  a §0 requirement, not a nice-to-have.
- Row rendering (`DataTable/Row.tsx`) supports: bulk-select checkboxes, drag handles for sortable
  rows, `row.classNames` (function or string), per-cell `classNames`/`style`/`title`,
  `value.header` (render as `<th>`), and `value.colSpanToEnd`. **All of these are Phase 4 regression
  checks.**

### 1.8 Dev / build commands

```bash
pnpm install                              # node_modules is NOT present in a fresh clone here
SPORT=basketball pnpm run dev             # wipes build/, serves localhost:3000, no purge/fingerprint
SPORT=basketball pnpm run build           # the real build: purge + fingerprint. MUST pass each phase.
pnpm run lint                             # eslint + tsc, concurrently
pnpm run test                             # vitest
```

`SPORT` is mandatory for non-interactive runs — without it both scripts prompt an interactive sport
selector (`tools/lib/getSport.ts`).

Chromium + Playwright are preinstalled in this environment
(`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`). **Never run
`playwright install`.**

---

## 2. Constraints — violate these and the work silently breaks

1. **Verify with a production build every phase.** Dev does not purge CSS. (§1.3)
2. **No dynamically-constructed class names.** (§1.3)
3. **Change `light.scss` only** for shared typography/spacing; `dark.scss` only for colour. (§1.1)
4. **Never add `maximum-scale` / `user-scalable=no`.** (§1.4)
5. **Mobile-first authoring direction.** The existing CSS is desktop-first: it uses
   `@include media-breakpoint-down(...)` in ~15 places. For any rule you touch, invert it — base
   styles are the phone, `media-breakpoint-up()` adds desktop. Do not mix directions inside one
   component's rules.
6. **Breakpoints stay in `px`.** Bootstrap's grid is px-based; `em` breakpoints combined with a
   user-scalable root font size will make the grid and the media queries disagree. Accept that at
   the 24px scale a tablet behaves like a phone — that is correct behaviour, not a bug.
7. **Do not touch the worker.** `src/worker/**` is simulation logic. This is a UI-only project. The
   one exception is `src/worker/views/*.ts` if a view genuinely needs a new field plumbed to the UI —
   and that needs an explicit note in the commit message.
8. **Do not touch the fork's gameplay features.** Features 1–10 in `CLAUDE.md` (dev system,
   OpenRouter, Game Plan, story export) are load-bearing. You *will* restyle their UI
   (`GamePlanEditor.tsx`, `PlayerDevelopmentControls.tsx`, `SeasonStory.tsx`, `ExportStory.tsx`,
   `TradingBlock/index.tsx`) — restyle only; change no behaviour, no prompts, no tuning constants.
9. **`pnpm run lint` and `pnpm run test` must pass before every commit.** `lint` runs `tsc`, so type
   errors in a new `Col` field or DataTable prop surface here.
10. **Preserve semantic HTML.** Do not convert tables to `display: block` divs to force wrapping —
    that destroys the accessibility tree and screen-reader row/column association. Phase 4 does a
    real DOM swap with correct semantics instead.

---

## 3. Complete inventory of what has to change

This is the audit. Treat it as the checklist; add to it if you find more, never silently skip a row.

### 3.1 Hardcoded font sizes in SCSS (all must become tokens or `rem`)

| File:line                  | Selector / context             | Current   | Target                          |
| -------------------------- | ------------------------------ | --------- | ------------------------------- |
| `light.scss:33`            | `$font-size-base`              | `0.8125rem` | `1rem`                        |
| `light.scss:143`           | `h1`                           | `24px`    | `1.75rem`                       |
| `light.scss:146`           | `h2`                           | `20px`    | `1.5rem`                        |
| `light.scss:149`           | `h3`                           | `16px`    | `1.25rem`                       |
| `light.scss:152`           | `h4`                           | `14px`    | `1.125rem`                      |
| `light.scss:155`           | `h5`                           | `12px`    | `1rem`                          |
| `light.scss:158`           | `.modal-title`                 | `20px`    | `1.5rem`                        |
| `light.scss:237`           | `.play-button`                 | `1.01562rem` | `1.125rem` + 48px min-height |
| `light.scss:290,295,300`   | `.dashboard-top-link-*`        | `20/16/15px` | `1.5/1.25/1.125rem`          |
| `light.scss:383`           | `.help-icon`                   | `13px`    | `1.125rem` (it is a tap target) |
| `light.scss:475`           | `.skill`                       | `10px`    | `0.8125rem`, line-height 1.4    |
| `light.scss:488`           | `.jersey-number-name`          | `10px`    | `0.8125rem`                     |
| `light.scss:500`           | `.jersey-number-popover`       | `10px`    | `0.875rem`                      |
| `light.scss:625`           | `.popover-body`                | `13px`    | `1rem`                          |
| `light.scss:752`           | `.btn-xs` `line-height`        | `0.9`     | `1.5`, and see §3.3             |
| `light.scss:979,1043`      | `.title-bar h1`                | `20/24px` | `1.375rem` / `1.75rem`          |
| `light.scss:983`           | `.title-bar option`            | `12px`    | `1rem`                          |
| `light.scss:1030,1038`     | `.dropdown-select`             | `13/14px` | `1.0625rem` / `1.125rem`        |
| `light.scss:1490`          | `.dark-select__group-heading`  | `90%`     | `1rem`                          |
| `light.scss:1675`          | `.compare-players-heading`     | `0.75rem` | `0.9375rem`                     |
| `sidebar.scss:33`          | `.sidebar-heading`             | `0.75rem` | `0.9375rem`                     |
| `sidebar.scss:83`          | `.sidebar-heading` (< xl)      | `0.875rem` | `1rem`                         |
| `datatable.scss:27`        | `.datatable-filter-input`      | `12px`    | `1rem`                          |

### 3.2 Inline `style={{ fontSize }}` in TSX — 42 occurrences

Full list from `grep -rn "fontSize" src/ui --include=*.tsx`. Every one below 1rem is a defect for
this audience. Ranked by how bad:

**Must fix (below-baseline text this fork itself introduced):**

- `src/ui/views/Roster/GamePlanEditor.tsx:166` (`0.65rem`), `:189` (`0.75rem`), `:250`, `:265`
  (`0.7rem`) — the execution-quality badges and slider labels (CLAUDE.md Feature 9).
- `src/ui/views/Roster/PlayerDevelopmentControls.tsx:64` (`0.8rem`), `:155`, `:194` (`0.7rem`) —
  Feature 1's controls.
- `src/ui/views/TradingBlock/index.tsx:211` (`0.9rem`), `:891` (`0.85rem`) — Feature 2's GM reasoning.

**Must fix (upstream):**

- `src/ui/components/DataTable/Controls.tsx:130` (`16`), `CommandPalette/index.tsx:927` (`15`),
  `ScoreBox/index.tsx:469` (`16`) — numeric px, will not scale with the root size.
- `src/ui/views/Settings/RowsEditor.tsx:55` (`100`) — verify what this is before touching.
- `JerseyNumber.tsx:66-73` — a JS size ladder (32/26/20/17) based on digit count. Rewrite in `em`
  relative to a container size so it scales.

**Leave alone (charts — Phase 8):** `PlayerGraphs/ScatterPlot.tsx`, `Message/OwnerMoodsChart.tsx`,
`TradeSummary/Charts.tsx`, `components/BoxPlot.tsx` — SVG `fontSize` props are handled separately.

**Already fine:** `Dashboard.tsx:125` and `Roster/TopStuff.tsx:17` (`"larger"`),
`Player/AwardsSummary.tsx:5` (`120%`), `LeagueDashboard/index.tsx:92,98` (`3rem`/`1.5rem`) — all
relative. Verify, do not change.

### 3.3 Touch targets below the floor

| Location                                        | Problem                                                   |
| ----------------------------------------------- | --------------------------------------------------------- |
| `light.scss:749-754` `.btn-xs`                  | `padding: 3px 0.4rem; line-height: 0.9` — ~18px tall      |
| `light.scss:867` `.table tr`                    | `min-height: 30px`                                        |
| `sidebar.scss:19` `.sidebar-inner .nav-link`    | `padding: 4px` — the entire primary navigation            |
| `light.scss:1030` `.dropdown-select`            | `padding: 1px 13px 0 2px` — the season/team switcher       |
| `light.scss:28-31` `.form-switch .form-check-input` | `width: 1.75rem; height: 1rem` — every Settings toggle |
| `datatable.scss:6-8` `.datatable-perpage select` | `width: 50px`                                             |
| `datatable.scss:14`, `:16-20` `.datatable-search` | `max-width: 200px` / `158px` on small — the search box shrinks *on mobile*, backwards |
| `DataTable/Pagination.tsx`                      | Bootstrap `.page-link` at 13px base ≈ 28px               |
| `light.scss:1165-1168` `.form-check-input`      | `margin-top: 3px` — a comment admits it is a base-size hack |

### 3.4 Hardcoded `px` widths/heights that will clip when type grows

`light.scss`: `.negotiation-team-years` 110px (:373), `.negotiation-team-amount` 180px (:377),
`.player-photo` 128px (:469), `.dashboard-top-link` 155 × 77px (:285), `.playoff-matchup`
max-width 200px (:897), `.playoff-matchup-logo` 40px, `.score-box-score` min-width 44px,
`.score-box-*` heights 94/54/47/96px, `.league-top-bar` height 63px (:1065),
`.league-top-bar-toggle` height 56px, `.play-button` height 51px (:240),
`.dropdown-links .nav-item` height 51px (:784), `.title-bar-right-links .nav-item` 39/38px,
`.player-bio` min-width 370px (:1260), `.standings-name` min-width 100/228px (:1632,:1637),
`.play-through-injuries` 200px, `.dark-select__control` min-height 33px, `$jersey-number-width` 15px,
`#messages-table .year` 40px / `.from` 130px, `.legend-square` 15px, `.baseball-base` 20px.
`sidebar.scss`: `$sidebar-width` 150px (:2), mobile drawer 190px (:78-80).

Rule: heights become `min-height`; widths become `min-width`/`max-width` in `rem` or `ch`, or are
deleted in favour of flex/grid. A fixed `height` on anything containing text is a bug at large scale.

### 3.5 Desktop-first media queries to invert

`grep -n "media-breakpoint-down" public/css/*.scss` — **11 sites**, all of them:

| Site                          | Guards                                            |
| ----------------------------- | ------------------------------------------------- |
| `light.scss:327` `down(sm)`   | `.dashboard-top-wrapper` / `-link-flatten`        |
| `light.scss:433` `down(sm)`   | `.mx-xs-auto`                                     |
| `light.scss:1002` `down(sm)`  | `.title-bar { padding-right: 0 }`                 |
| `light.scss:1224` `down(sm)`  | `.player-stats-summary` fake-`table-responsive`   |
| `light.scss:1296` `down(sm)`  | `.fake-list-group-item`                           |
| `light.scss:1306` `down(md)`  | `.settings-col` / `.fake-list-group-item` padding |
| `light.scss:1324` `down(lg)`  | `.settings-buttons`                               |
| `light.scss:1695` `down(md)`  | `.filter-wrapper`                                 |
| `light.scss:1729` `down(md)`  | `.live-game-score-wrapper` / `-actual`            |
| `datatable.scss:16` `down(sm)` | `.datatable-search { max-width: 158px }`         |
| `sidebar.scss:75` `down(xl)`  | the entire mobile sidebar drawer                  |

---

## 4. The design system to build

Everything else in this plan depends on this layer existing first.

### 4.1 Token layer — new file `public/css/_tokens.scss`

`@import` it from `light.scss` **immediately after** the Bootstrap variable overrides and **before**
the Bootstrap partials, so tokens are available to both. Because `:root` and `[data-*]` selectors are
not class-based, **PurgeCSS will not strip them** (§1.3) — this is why the token layer is CSS custom
properties rather than utility classes.

```scss
:root {
	/* ---- Type scale. All app CSS references these, never a raw px value. ---- */
	--zen-fs-xs:   0.8125rem;  /* absolute floor: badges, skill chips. 14.6px @18px root */
	--zen-fs-sm:   0.875rem;
	--zen-fs-body: 1rem;       /* tables, body copy, form controls */
	--zen-fs-lg:   1.125rem;   /* h4, emphasised numbers, primary buttons */
	--zen-fs-xl:   1.25rem;    /* h3 */
	--zen-fs-2xl:  1.5rem;     /* h2, modal title */
	--zen-fs-3xl:  1.75rem;    /* h1 */

	--zen-lh-tight: 1.25;      /* headings only */
	--zen-lh-body:  1.5;       /* WCAG 1.4.12 minimum */

	/* ---- Touch targets ---- */
	--zen-tap-min:     2.75rem;  /* 44px @16px — every interactive element */
	--zen-tap-primary: 3rem;     /* 48px — Play, Save, Sign, Trade, nav */
	--zen-tap-gap:     0.5rem;

	/* ---- Chrome geometry: single source of truth, replaces the 8 magic numbers in §1.6 ---- */
	--zen-navbar-h: 3.5rem;
	--zen-sticky-top: var(--zen-navbar-h);
}

@include media-breakpoint-up(md) {
	:root { --zen-navbar-h: 4rem; }
}
```

**Do not** put the user-selectable scale in these tokens. The tokens are `rem`-relative; the scale is
applied once at the root (§4.2). That separation is what makes one setting rescale the entire app.

### 4.2 Root scale mechanism

```scss
html {
	font-size: 112.5%;              /* 18px — the elderly-first default */
	-webkit-text-size-adjust: 100%; /* stop iOS Safari from re-scaling in landscape */
}
html[data-font-scale="compact"] { font-size: 100%;   } /* 16px */
html[data-font-scale="large"]   { font-size: 131.25%; } /* 21px */
html[data-font-scale="xlarge"]  { font-size: 150%;   } /* 24px */
```

Using `%` (not `px`) keeps the user's own browser/OS font-size preference in the chain — a `px` root
would override it, which for this audience is exactly the wrong call.

`$font-size-base: 1rem` (§3.1) then makes every Bootstrap-emitted `rem` value real, and every token
above resolves against the chosen root. **One attribute on `<html>` rescales the entire app**, with
no per-component work and nothing for PurgeCSS to strip.

### 4.3 Mobile-first table strategy (the design decision behind Phase 4)

A 25-column player-stats table cannot be made readable at 18px on a 390px screen by tweaking CSS. It
has to become a different layout. The design:

- **< 768px (`md`): card list.** One card per row. Card header = the row's primary identifier
  (player or team name) at `--zen-fs-lg`, full-strength. Body = a two-column `label: value` grid,
  where **label is `col.desc ?? col.title`** — "Total Rebounds", not "TRB". Labels at
  `--zen-fs-sm` in secondary colour; values at `--zen-fs-body`, tabular-nums, full-strength.
- **Progressive disclosure inside the card.** Show the first *N* priority columns (default 5);
  a full-width "Show all 25 stats" button expands the rest. Without this, a 25-stat row becomes a
  25-line wall of text, which is worse than the scroll it replaced.
- **Column priority.** Add `mobilePriority?: number` to `Col` (`DataTable/index.tsx:47-57`). Default
  when absent: the column's index. Views progressively annotate their important columns. **No
  `getCols.ts` change is required to ship** — index-order default works immediately.
- **Controls become mobile-shaped.** Sorting by tapping a 20px-wide `<th>` arrow does not work with
  a tremor. In card mode render a full-width `<select>` "Sort by …" plus an asc/desc toggle, both at
  `--zen-tap-primary` height, and a full-width search input (fixing §3.3's backwards
  `max-width: 158px`).
- **≥ 768px: today's table, with `white-space: nowrap` scoped** so it applies to numeric cells only,
  never to name cells. Sticky columns and sticky header stay, unchanged.
- **Column definitions become tappable.** Replace `title={desc}` (`Header.tsx:143,386`) with the
  existing `HelpPopover`/`ResponsivePopover` components; in card mode the label *is* the definition,
  so the problem disappears there.

**Implementation note:** do a **real DOM swap** (render cards instead of `<tr>`), not
`display: block` on table elements. Table-to-block CSS destroys the accessibility tree, and Bootstrap's
`.table-*` classes fight it. Consequence to handle explicitly: `useStickyXX` and
`useStickyTableHeader` must no-op in card mode.

### 4.4 Navigation and the Play button

The Play button advances the simulation — it is *the* control of this game, and today it lives in the
top navbar (`PlayMenu.tsx`, `.play-button` 51px tall) at the top of a phone screen, the hardest place
for a thumb to reach.

**Design:** below `md`, move the primary Play control to a **fixed bottom action bar**, full-width,
`--zen-tap-primary` tall, with its dropdown opening *upward*. Reuse the existing
`components/StickyBottomButtons.tsx` (which already handles the `MOBILE_AD_BOTTOM_MARGIN` offset) —
do not build a parallel mechanism. Add matching `padding-bottom` to `body` so the bar never covers
the last row of content.

The sidebar drawer (`sidebar.scss`, 190px wide on mobile, `nav-link` `padding: 4px`) becomes: 85vw
max 22rem wide, `nav-link` at `--zen-tap-primary` min-height with `--zen-tap-gap` separation,
`--zen-fs-body` text, and section headings at `--zen-fs-sm` uppercase. It already closes on
outside-tap (`SideBar.tsx:339`) and on item click (`:370`) — preserve both.

---

## 5. Phase 0 — verification harness (do this first)

"Every page" is ~190 routes over 123 view modules. Auditing that by eye per change is not viable, and
an LLM without a feedback loop will produce confident, wrong CSS. Build the loop first.

**Deliverables** (all under `tools/a11y/`, not shipped to users):

1. `tools/a11y/bootstrapLeague.ts` — Playwright script: launch Chromium at
   `/opt/pw-browsers/chromium`, open `localhost:3000`, create a new basketball league with real
   players, sim ~2 seasons (so playoffs/history/awards pages have data), then save the IndexedDB
   state — or simply leave the browser profile directory on disk for reuse. **Most pages are empty
   without a populated league**, and a fresh origin starts with an empty IndexedDB (CLAUDE.md →
   Deployment).
2. `tools/a11y/routes.ts` — the page inventory: every route from `src/ui/util/routeInfos.ts`, with
   concrete param values substituted (`:lid` → `1`, `:pid` → a real pid from the bootstrapped league,
   `:season` → a simmed season, `:abbrev` → a real team). Group each route by archetype (§10).
3. `tools/a11y/audit.ts` — for each route × each of `[360×640, 390×844, 1280×800]` × each of
   `[compact, default(18), xlarge]` font scales:
   - screenshot to `tools/a11y/out/<scale>/<viewport>/<route>.png`;
   - assert **no horizontal document overflow**:
     `document.documentElement.scrollWidth <= window.innerWidth + 1`;
   - assert **no text below 14px**: walk all elements with a non-empty text node, read
     `getComputedStyle().fontSize`, report violations with selector + size;
   - assert **no interactive element below 24 × 24** and report everything below 44 × 44:
     query `a, button, input, select, textarea, [role="button"], [tabindex]`, read
     `getBoundingClientRect()`;
   - assert **no element overlapping the fixed navbar**;
   - run **axe-core** (inject from `node_modules`, no CDN — the sandbox blocks external hosts) and
     collect violations, with contrast checked against the §0 targets.
   - Emit `tools/a11y/out/report.json` + a markdown summary.
4. `tools/a11y/baseline.json` — commit the **pre-work** violation counts per route. Every subsequent
   phase must show this number **monotonically decreasing**, and must never introduce a new
   horizontal-overflow route.

**Acceptance:** `node tools/a11y/audit.ts` runs green-to-completion against a dev server and produces
a baseline report. Commit the baseline **before** changing any CSS. That baseline is what makes every
later "done" claim checkable rather than asserted.

---

## 6. Phase 1 — typography foundation

1. Create `public/css/_tokens.scss` per §4.1; `@import` from `light.scss` after the Bootstrap
   variable overrides, before the Bootstrap partials.
2. `light.scss:33`: `$font-size-base: 0.8125rem` → `1rem`.
3. Add the `html` root-scale rules per §4.2 (default `112.5%` = 18px, `data-font-scale` variants).
4. Set Bootstrap heading variables (`$h1-font-size` … `$h6-font-size`, `$line-height-base`,
   `$headings-line-height`) from the tokens **and delete** the px overrides at `light.scss:142-158`.
5. Work §3.1 top to bottom. Every SCSS `font-size` in the app becomes a `var(--zen-fs-*)`.
6. Work §3.2's "must fix" lists. Prefer deleting the inline style and using a Bootstrap utility
   class (`fs-5`, `small`) or a semantic class over swapping one magic number for another.
7. `light.scss:1165-1168`'s `.form-check-input { margin-top: 3px }` — the comment says it is a
   `$font-size-base` hack. Re-derive it or delete it.

**Expect breakage.** Type is now ~38% larger; the navbar overflows, sticky offsets are wrong, fixed
heights clip. That is Phase 2. Do not patch it with more magic numbers here.

**Acceptance:** `pnpm run lint` + `pnpm run test` pass; `SPORT=basketball pnpm run build` succeeds;
audit reports **zero** text below 14px at every scale; no new axe violations; the heading hierarchy
is visibly a hierarchy at 360px.

---

## 7. Phase 2 — de-hardcode the chrome

1. Consume `--zen-navbar-h` at all nine sites in §1.6:
   - Delete the inline `style="padding-top: 52px"` from `public/index.html:105`; add
     `body { padding-top: var(--zen-navbar-h); }` in `light.scss`. (Check for a flash of unstyled
     offset on load; if present, keep a matching inline fallback that the CSS then overrides.)
   - `sidebar.scss:62` → `top: var(--zen-navbar-h)`.
   - `light.scss:701,709,167,719,1360` → `top: var(--zen-sticky-top)`.
   - `a.anchor` → `top: calc(-1 * var(--zen-sticky-top))`.
   - `LiveGame/index.tsx:231` — replace `window.innerHeight - 113` by reading the resolved custom
     property (`getComputedStyle(document.documentElement).getPropertyValue("--zen-navbar-h")`) or,
     better, by measuring the navbar element. Keep the `optimizedResize` listener.
2. Make the navbar itself fluid: `min-height: var(--zen-navbar-h)`, no fixed `height`. Fix
   `.navbar-brand` (`light.scss:176`, `height: 35px`) and the `height: 51px` rules at `:240`/`:784`
   → `min-height`.
3. `.title-bar` (`light.scss:970-1050`): invert to mobile-first, `min-height` not `height`, h1 at
   `--zen-fs-2xl` on phones. The `.dropdown-select` season/team switcher becomes a real
   `--zen-tap-primary`-tall control — it is one of the most-used controls in the game and is
   currently ~16px tall.
4. `.league-top-bar` (`light.scss:1061-1071`, `height: 63px`) — the horizontally-scrolling score
   strip. `min-height`, larger scores, and verify its scroll behaviour survives at 24px scale.
5. Sidebar drawer + Play bottom bar per §4.4.
6. Sweep §3.4: every `height` containing text → `min-height`; every fixed `width` → `min-width`/
   `max-width` in `rem`/`ch`, or deleted for flex/grid.

**Acceptance:** at all three viewports × all four scales — no content under the navbar; no clipped or
truncated chrome text; sidebar drawer opens, all items reachable and ≥ 48px; Play reachable one-thumb
at 390 × 844; sticky headers land correctly on Live Game, Trade, and Settings; audit shows no new
horizontal overflow.

---

## 8. Phase 3 — controls and touch targets

Work §3.3 exhaustively.

- `.btn-xs`: either raise to `--zen-tap-min` with `line-height: var(--zen-lh-body)`, or (better)
  delete it and migrate its call sites to `btn-sm`. Grep the call sites first and decide once.
- `.table tr { min-height: 30px }` → `--zen-tap-min`, and give `.table-sm` real vertical padding via
  `$table-cell-padding-y-sm` rather than fighting it per-selector.
- `.form-switch .form-check-input` (`light.scss:28-31`): the Settings page is wall-to-wall toggles.
  Size to `--zen-tap-min` and give the label a matching hit area.
- `.datatable-search`: full-width on mobile. **Delete** the `max-width: 158px` block at `datatable.scss:16-20`.
- `.datatable-perpage select { width: 50px }` → `auto` with `--zen-tap-min` height.
- `DataTable/Pagination.tsx`: `.page-link` to `--zen-tap-min`, ≥ 8px gaps. On phones prefer
  Prev / "Page 3 of 12" / Next over a long numeric row.
- All `<select>` elements: `font-size: var(--zen-fs-body)` — **and never below 16px at the compact
  scale**, or iOS Safari auto-zooms the whole page on focus. This is why `--zen-fs-body` is `1rem`
  and the compact root is `100%`, not less. Do not "optimise" that.
- Inputs: `inputMode` / `autocomplete` where a numeric or email keypad helps.
- Focus visibility: a ≥ 3:1, ≥ 2px `:focus-visible` outline that is never `outline: none`.
- `prefers-reduced-motion`: neutralise the `.sidebar-inner` `transition: left 0.3s`, `.sidebar-fade`
  opacity transition, `.spin`, `oscillate-bg`, and `.dashboard-play-loading`.

**Acceptance:** audit reports **zero** interactive elements below 24 × 24 and **zero** below 44 × 44
outside a documented exception list; every form control keyboard-focusable with a visible ring; no
iOS focus-zoom (verify in a WebKit context if available, else verify computed `font-size` ≥ 16px on
every `input`/`select`/`textarea` at the compact scale).

---

## 9. Phase 4 — `DataTable` mobile card mode (the largest phase)

Implement §4.3. Ship it behind one prop so it can be rolled out per view.

1. `src/ui/hooks/useBreakpoint.ts` — `matchMedia` + `useSyncExternalStore`, exposing
   `isBelow("md")`. One implementation, reused. (§1.5)
2. `DataTable/index.tsx`: add `mobileCards?: false | "auto"` (default `"auto"`) and
   `mobileCardPrimaryCol?: number` (default: first non-checkbox, non-handle column). Add
   `mobilePriority?: number` to `Col`.
3. `DataTable/MobileCards.tsx` — new component rendering `processedRowsPage` as cards. It must
   reuse the **already-processed** rows (`processRows.ts` output), so filtering, sorting, and
   pagination behave identically to table mode. Do not fork the data pipeline.
4. `DataTable/MobileControls.tsx` — full-width "Sort by" `<select>` + direction toggle + search.
5. In card mode, no-op `useStickyXX` and `useStickyTableHeader`.
6. Scope `light.scss:386-388`'s global `table { white-space: nowrap; }` to numeric cells only.
7. Roll out: `Roster` → `PlayerStats` → `Standings` → `FreeAgents` → `PlayerRatings` →
   `DraftHistory` → `HallOfFame` → `Leaders` → the rest. Screenshot-verify each before moving on.
8. Then the 27 raw-`<table>` files (`grep -rln "<table" src/ui`). `BoxScore.basketball.tsx`,
   `Standings.tsx`, `Playoffs.tsx`, `DraftLottery.tsx`, and `Player/RatingsOverview.tsx` each need
   individual design attention — a box score is not a list of players and should not become one.
   `Playoffs.tsx`'s bracket in particular needs a vertical/round-paged mobile form.

**Regression checks — every one of these must still work in both modes** (§1.7): bulk-select
checkboxes and their whole-cell click area; drag-to-reorder (Roster, Depth, ScheduleEditor); footer
totals; `colSpanToEnd`; `row.classNames` as string *and* as function; per-cell `title`/`style`;
`highlightCols`; the player-name popover from `row.metadata`; CSV export; column
customise/hide/reorder; `defaultStickyCols` on desktop.

**Acceptance:** audit reports **zero** routes with horizontal document overflow at 360 × 640 at every
font scale — this is the WCAG 1.4.10 Reflow gate and the headline result of the whole project. No
column definition reachable only by hover. Desktop table rendering byte-identical where untouched
(diff the 1280 × 800 screenshots against baseline).

---

## 10. Phase 5 — per-page sweep by archetype

Do **not** walk 190 routes individually. Group by archetype, fix the archetype, then verify each
member. Inventory from `src/ui/util/routeInfos.ts` (223 lines) and `src/ui/views/` (123 modules).

| # | Archetype                | Representative pages                                                                                                                | Work                                                        |
| - | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1 | Pure `DataTable` page    | PlayerStats, PlayerRatings, PlayerBios, FreeAgents, Leaders(+Years/Progressive), HallOfFame, DraftHistory, Transactions, Injuries, WatchList, Notes, Colleges, Countries, Frivolities\*, AwardsRecords, TeamRecords, UpcomingFreeAgents, ExportPlayers, ImportPlayers, AdvancedPlayerSearch, DraftPicks, GmHistory, ScheduledEvents | Phase 4 handles these. Verify + set `mobilePriority`.       |
| 2 | Dashboard / summary      | LeagueDashboard, Dashboard, SeasonPreview, DailySchedule, Inbox, News, Frivolities index                                              | Single-column stack; card order = importance; `3rem` stat readouts already good |
| 3 | Roster-family (mixed)    | Roster, Depth, ProtectPlayers, ExpansionDraft, FantasyDraft                                                                          | TopStuff header reflow + Phase 4 table + this fork's `GamePlanEditor` / `PlayerDevelopmentControls` / `ChemistryMeter` / `RosterBalance` |
| 4 | Player detail            | Player, PlayerGameLog, CustomizePlayer, ComparePlayers, Relatives                                                                    | `.player-bio` min-width 370px must go; `RatingsOverview` bars; face/photo sizing |
| 5 | Bracket / structured viz | Playoffs, DraftLottery, AllStar\*, HeadToHead(All), RosterContinuity                                                                 | Bespoke mobile layouts. Highest design effort per page.      |
| 6 | Long forms               | Settings (3002 lines), GlobalSettings, GodMode, NewLeague (1778), CustomizeTeams, ManageTeams, ManageConfs, ScheduleEditor, DefaultNewLeagueSettings, Settings/PlayerBioInfo\* | One field per row; 48px controls; sticky save bar; `.fake-list-group-item` / `.settings-col` inversion |
| 7 | Transactional flows      | Trade, TradingBlock, TradeProposals, SavedTrades, Negotiation, NegotiationList, TradeSummary                                          | Two-panel → stacked with a sticky summary; `.trade-affix`; Feature 2's reasoning + banners |
| 8 | Live / real-time         | LiveGame (1139), ExhibitionGame, Exhibition                                                                                          | Play-by-play pane height (§1.6); score header; play/pause at 48px |
| 9 | Box score / game log     | GameLog, BoxScore.\* (4 sports), BoxScoreWrapper                                                                                     | Per-player card or 2-level table; Feature 3a's `GameRecap`   |
| 10 | Charts                  | PlayerGraphs, TeamGraphs, PlayerRatingDists, PlayerStatDists, TeamStatDists, Message/OwnerMoodsChart, TradeSummary/Charts             | Phase 8                                                       |
| 11 | Tools / utility          | ExportLeague, ExportStats, ExportStory, ImportPlayersReal, DeleteOldData, DangerZone, Dropbox, MultiTeamMode, Account\*, LoginOrRegister, LostPassword, ResetPassword, KeyboardShortcuts, Achievements, AutoExpand, AutoRelocate, EditAwards, NewTeam, Message | Mostly single-column already; type + tap targets only        |

For each archetype: fix the shared component/CSS once, then screenshot-verify **every listed page**
at 360 × 640 @ 18px and @ 24px. A phase is not done because the archetype is fixed; it is done when
each member is verified. Record per-page pass/fail in the audit report.

---

## 11. Phase 6 — user-facing font-size setting

Mirror the existing theme mechanism exactly (§1.4). Do not invent a second mechanism.

1. **`public/index.html`** — extend the pre-paint inline script:
   ```js
   function getFontScale() {
       try {
           var v = localStorage.getItem("fontScale");
           return v === "compact" || v === "large" || v === "xlarge" ? v : "default";
       } catch (error) { return "default"; }
   }
   document.documentElement.setAttribute("data-font-scale", getFontScale());
   ```
   Set the attribute **before** the stylesheet `<link>` is appended, so there is no reflow flash.
   Expose `window.getFontScale` alongside `window.getTheme` (declare it in `src/common/types.ts`'s `Window`
   interface, next to `getTheme`/`themeCSSLink` (around `:22-27`)).
2. **`src/ui/views/GlobalSettings/index.tsx`** — a new `<select>` in the same row grid as Color
   Scheme / Units (around `:129-175`), labelled **"Text Size"**, with plain-language options:
   *Standard (16px) · Large (18px, recommended) · Larger (21px) · Largest (24px)*. Persist via
   `safeLocalStorage.setItem("fontScale", …)` in `handleFormSubmit` (`:67-101`), next to the existing
   `theme` write, and apply immediately by setting the attribute — no reload.
3. **`src/ui/index.tsx:41-45`** — the `storage` event handler already syncs `theme` across tabs. Add a
   `fontScale` branch so the setting follows across tabs/windows (the game opens popup windows).
4. This is a **device** preference, not a league setting — `localStorage`, not the league DB, exactly
   like `theme`. Do not add it to `Options` / `updateOptions`.
5. Make it discoverable: the audience will not find it under a "Global Settings" menu. Add a one-time
   dismissible prompt on first run, or a text-size control in the sidebar footer.

**Acceptance:** all four scales render every archetype without overflow or clipping; no flash of
wrong size on load; the setting survives reload and syncs across tabs; the audit's full route × scale
matrix is clean.

---

## 12. Phase 7 — contrast, colour, and remaining accessibility

1. **Contrast audit.** `dark.scss:43` sets `$min-contrast-ratio: 3` — *below* WCAG AA for body text.
   Raise toward the §0 targets and fix whatever button/badge colours that breaks. Specific suspects:
   `$body-secondary-color: $gray-400` (`dark.scss:34`), `.text-warning` (`light.scss`, darkened yellow),
   `.bg-orange` (lightened `#fd7e14` with black text), `.bg-warning`/`.bg-info`/`.bg-light` forcing
   `color: $black`, `.watch` (`$gray-500`), `.help-icon`, `tr.text-body-secondary`, and the
   `god-mode` purple.
2. **Never colour-only.** Verify every state carrying meaning (injury, hot/cold, playoff-clinched,
   god-mode, `RatingWithChange`, `StatWithChange`, `MovOrDiff`, `PlusMinus`,
   `CheckmarkOrCross`, the Feature 9 execution badges) also carries text or an icon. WCAG 1.4.1.
3. **Kill hover-only information** beyond Phase 4's table headers: sweep `title=` attributes across
   `src/ui`, and check `RatingsStatsPopover`, `HelpPopover`, `Mood`, `SkillsBlock`, `InjuryIcon`,
   `JerseyNumber` — each must be tappable and keyboard-reachable.
4. **`.small-scrollbar`** grows only on `:hover` (`light.scss:1088-1119`) — on touch it is
   permanently 3–6px wide. Make horizontally-scrollable regions obviously scrollable without hover
   (visible scrollbar, edge fade, or explicit affordance).
5. **Landmarks and headings.** `Controller/index.tsx` already emits `<main id="actual-actual-content">`
   and `<nav aria-label="side navigation">`; `TitleBar` renders `<aside>` containing the page `<h1>` —
   an `<h1>` inside `<aside>` is wrong for screen-reader document structure. Fix the landmark, verify
   one `<h1>` per page, no skipped levels.
6. **`prefers-contrast: more`** — optional, but cheap once tokens exist.

**Acceptance:** axe-core reports zero contrast violations at the §0 thresholds in both themes; zero
serious/critical axe violations of any kind; a full keyboard pass on one page per archetype.

---

## 13. Phase 8 — charts and SVG

`@visx` charts set `fontSize` numerically in SVG props, which does not inherit the root scale.

- `PlayerGraphs/ScatterPlot.tsx` (`:151-194`, `:272` `fontSize: 10`), `TeamGraphs`,
  `Message/OwnerMoodsChart.tsx:245`, `TradeSummary/Charts.tsx:163`, `components/BoxPlot.tsx`.
- Drive axis/tick/label sizes from the token scale (read the resolved custom property once, or pass
  `em`-relative values and set `font-size` on the SVG root in CSS).
- Increase point/line/stroke sizes proportionally — a 2px line at 24px type is invisible.
- On phones, prefer fewer ticks and a legend below the chart over a cramped overlay
  (`.chart-legend` is absolutely positioned at `top: 42px; left: 20px`).
- Ensure every chart has a text alternative — a table or summary — since a scatter plot is
  unreadable to this audience regardless of type size.

**Acceptance:** every chart legible at 360px × 24px scale; no clipped axis labels; each chart has a
non-visual equivalent.

---

## 14. Execution protocol

**Branch:** `claude/basketball-gm-mobile-first-8ge05p`, based on `origin/master`. Push with
`git push -u origin claude/basketball-gm-mobile-first-8ge05p`. Do not open a PR unless asked.

**Commit cadence:** one commit per phase minimum; for Phases 4 and 5, one commit per archetype or per
view rollout. Each commit message states the phase, what changed, and the audit delta
(e.g. `Phase 3: touch targets — 412 sub-44px targets → 0; audit violations 1,847 → 631`).

**Before every commit:**

```bash
pnpm run lint                       # eslint + tsc
pnpm run test                       # vitest
SPORT=basketball pnpm run build     # MUST pass — this is the only place PurgeCSS runs (§1.3)
node tools/a11y/audit.ts            # violation counts must not increase
```

**Order is not optional.** Phase 0 → 1 → 2 before anything else: Phase 1 without Phase 2 leaves the
app visibly broken, and Phases 3–8 without Phase 0 have no way to tell success from confident
failure.

**When you find something this document got wrong** — a line number moved, a claim does not hold —
fix the document in the same commit. It is the working spec, not a historical record.

**On finishing:** add a "Feature 11: Mobile-First Accessibility" section to `CLAUDE.md` following the
existing per-feature format (what it does / architecture / key files table / gotchas), so the next
session inherits the context. Note the `--zen-*` token layer, the PurgeCSS constraint, the
`data-font-scale` mechanism, and the DataTable card mode as the four things a future change must not
break.

---

## 15. Anti-goals — do not do these

- **Do not** add `maximum-scale=1` or `user-scalable=no`. (WCAG 1.4.4)
- **Do not** ship a separate "mobile site", a `?mobile=1` route, or duplicated mobile view
  components. One responsive codebase.
- **Do not** solve wide tables with a global `transform: scale()`, a zoom hack, or a horizontally
  scrolling container presented as a solution. Reflow is the requirement.
- **Do not** convert tables to `display: block` divs. (§2.10)
- **Do not** build class names dynamically. (§1.3)
- **Do not** touch `src/worker/**` simulation logic, the OpenRouter prompts, `GAME_PLAN_TUNING`,
  `CANON_TUNING`, or any other tuning constants. UI only.
- **Do not** remove information density from desktop to make mobile easier. Desktop keeps its tables.
- **Do not** claim a phase is complete from a dev-server screenshot. Production build + audit, or it
  is not done.
- **Do not** add a UI library, a CSS framework, or a CSS-in-JS runtime. Bootstrap 5.3.8 + SCSS is the
  stack.
