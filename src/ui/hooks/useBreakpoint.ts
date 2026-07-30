import { useSyncExternalStore } from "react";

// Viewport-width breakpoint hook, backed by matchMedia.
//
// This exists to replace `window.mobile` for anything layout-related. `window.mobile` is computed
// once in public/index.html from `window.screen` — the *device* screen, not the viewport — and never
// updates on resize or rotation, so it's wrong for a rotated phone, a resized desktop window, and
// the app's own popup windows. It stays in use for the ad code, which genuinely wants a
// device-class signal.
//
// Values match Bootstrap's $grid-breakpoints, which are px-based. That's deliberate: the app's grid
// is px-based, and em-based media queries combined with the user-selectable root font size would
// make the grid and the queries disagree. See MOBILE_FIRST_ACCESSIBILITY_PLAN.md §2.6.

export const BREAKPOINTS = {
	sm: 576,
	md: 768,
	lg: 992,
	xl: 1200,
	xxl: 1400,
} as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

// One MediaQueryList per breakpoint, shared across every subscriber, created lazily. Cheaper than
// a resize listener that fires continuously, and the browser dedupes identical queries anyway.
const queries = new Map<string, MediaQueryList>();

const getQuery = (query: string) => {
	let mql = queries.get(query);
	if (!mql) {
		mql = window.matchMedia(query);
		queries.set(query, mql);
	}
	return mql;
};

const subscribe = (query: string) => (onStoreChange: () => void) => {
	const mql = getQuery(query);
	mql.addEventListener("change", onStoreChange);
	return () => {
		mql.removeEventListener("change", onStoreChange);
	};
};

const useMediaQuery = (query: string) => {
	return useSyncExternalStore(
		subscribe(query),
		() => getQuery(query).matches,
		// Server/prerender fallback - this app is client-only, but useSyncExternalStore wants it
		() => false,
	);
};

/**
 * True when the viewport is at least `breakpoint` wide — the mobile-first direction, matching
 * Sass's `media-breakpoint-up()`.
 */
export const useBreakpointUp = (breakpoint: Breakpoint) =>
	useMediaQuery(`(min-width: ${BREAKPOINTS[breakpoint]}px)`);

/**
 * True when the viewport is narrower than `breakpoint`, matching Sass's `media-breakpoint-down()`.
 * Prefer `useBreakpointUp` where the choice is arbitrary, so JS and CSS read the same direction.
 */
export const useBreakpointDown = (breakpoint: Breakpoint) =>
	useMediaQuery(`(max-width: ${BREAKPOINTS[breakpoint] - 0.02}px)`);
