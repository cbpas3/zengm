// In-page accessibility assertions for the mobile-first audit.
//
// The body of `PAGE_CHECKS` is stringified and evaluated inside the browser, so it must be
// self-contained — no imports, no closure over Node-side variables. Thresholds come from
// MOBILE_FIRST_ACCESSIBILITY_PLAN.md §0.

export const THRESHOLDS = {
	// Absolute minimum font size anywhere in the app
	minFontSizePx: 14,
	// Hard floor for interactive elements (WCAG 2.5.8 AA)
	tapHardFloorPx: 24,
	// Target for interactive elements (WCAG 2.5.5 AAA)
	tapTargetPx: 44,
	// Horizontal overflow tolerance, for sub-pixel rounding
	overflowTolerancePx: 1,
};

export type Violation = {
	kind:
		| "overflow"
		| "font-size"
		| "tap-hard-floor"
		| "tap-target"
		| "navbar-overlap"
		| "axe";
	selector: string;
	detail: string;
	// Numeric measurement, for tracking improvement over time
	value?: number;
};

export type PageResult = {
	// Document scroll width vs viewport width
	scrollWidth: number;
	innerWidth: number;
	violations: Violation[];
	// Counts by kind, for the summary table
	counts: Record<string, number>;
	// Set when the page failed to render at all
	error?: string;
};

// Serialised into the page by audit.ts. Returns a PageResult minus the axe violations, which are
// collected separately (axe runs as its own injected script).
export const PAGE_CHECKS = `(thresholds) => {
	const violations = [];

	const describe = (el) => {
		if (!el || !el.tagName) return "?";
		let out = el.tagName.toLowerCase();
		if (el.id) out += "#" + el.id;
		if (typeof el.className === "string" && el.className) {
			out += "." + el.className.trim().split(/\\s+/).slice(0, 3).join(".");
		}
		return out;
	};

	const isVisible = (el, rect) => {
		if (rect.width === 0 && rect.height === 0) return false;
		const cs = getComputedStyle(el);
		if (cs.display === "none" || cs.visibility === "hidden") return false;
		if (Number.parseFloat(cs.opacity) === 0) return false;
		return true;
	};

	// ---- 1. Horizontal overflow (WCAG 1.4.10 Reflow) ----------------------------------------
	const scrollWidth = document.documentElement.scrollWidth;
	const innerWidth = window.innerWidth;
	if (scrollWidth > innerWidth + thresholds.overflowTolerancePx) {
		// Find which elements actually stick out, so the report is actionable
		const offenders = [];
		for (const el of document.querySelectorAll("body *")) {
			const rect = el.getBoundingClientRect();
			if (!isVisible(el, rect)) continue;
			if (rect.right > innerWidth + thresholds.overflowTolerancePx) {
				// Skip elements inside a legitimately scrollable container
				let inScroller = false;
				let p = el.parentElement;
				while (p && p !== document.body) {
					const pcs = getComputedStyle(p);
					if (
						(pcs.overflowX === "auto" || pcs.overflowX === "scroll") &&
						p.scrollWidth > p.clientWidth
					) {
						inScroller = true;
						break;
					}
					p = p.parentElement;
				}
				if (!inScroller) {
					offenders.push({ sel: describe(el), right: Math.round(rect.right) });
				}
			}
		}
		// Report the widest few; the rest are usually descendants of the same culprit
		offenders.sort((a, b) => b.right - a.right);
		violations.push({
			kind: "overflow",
			selector: offenders.length > 0 ? offenders[0].sel : "document",
			detail:
				"document scrollWidth " +
				scrollWidth +
				" > innerWidth " +
				innerWidth +
				(offenders.length > 0
					? "; widest: " +
						offenders
							.slice(0, 5)
							.map((o) => o.sel + "@" + o.right)
							.join(", ")
					: ""),
			value: scrollWidth - innerWidth,
		});
	}

	// ---- 2. Font size floor ------------------------------------------------------------------
	// Only elements that directly own a non-empty text node, so we don't report a container
	// whose child is the real text holder.
	const seenFontSel = new Set();
	for (const el of document.querySelectorAll("body *")) {
		let ownsText = false;
		for (const node of el.childNodes) {
			if (node.nodeType === 3 && node.nodeValue && node.nodeValue.trim() !== "") {
				ownsText = true;
				break;
			}
		}
		if (!ownsText) continue;
		const rect = el.getBoundingClientRect();
		if (!isVisible(el, rect)) continue;
		const size = Number.parseFloat(getComputedStyle(el).fontSize);
		if (size < thresholds.minFontSizePx) {
			const sel = describe(el);
			if (seenFontSel.has(sel)) continue;
			seenFontSel.add(sel);
			violations.push({
				kind: "font-size",
				selector: sel,
				detail: size.toFixed(1) + "px < " + thresholds.minFontSizePx + "px",
				value: size,
			});
		}
	}

	// ---- 3. Touch targets --------------------------------------------------------------------
	const interactive = document.querySelectorAll(
		'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [tabindex]:not([tabindex="-1"])',
	);
	const seenTapSel = new Set();
	for (const el of interactive) {
		const rect = el.getBoundingClientRect();
		if (!isVisible(el, rect)) continue;
		// An inline link inside a paragraph is exempt from 2.5.8 ("inline" exception)
		const cs = getComputedStyle(el);
		if (el.tagName === "A" && cs.display === "inline") {
			continue;
		}
		// Documented exceptions:
		// - react-select renders a ~5px autosizing text input as its caret; the actual target is
		//   the .dark-select__control wrapper around it, which does clear 44px.
		// - A hidden-by-opacity file input behind a styled button.
		if (
			el.classList.contains("dark-select__input") ||
			el.closest(".dark-select__control") !== null
		) {
			continue;
		}
		const w = rect.width;
		const h = rect.height;
		const smallest = Math.min(w, h);
		const sel = describe(el);
		if (smallest < thresholds.tapHardFloorPx) {
			const key = "hard:" + sel;
			if (!seenTapSel.has(key)) {
				seenTapSel.add(key);
				violations.push({
					kind: "tap-hard-floor",
					selector: sel,
					detail: Math.round(w) + "x" + Math.round(h) + " < " + thresholds.tapHardFloorPx,
					value: smallest,
				});
			}
		} else if (smallest < thresholds.tapTargetPx) {
			const key = "soft:" + sel;
			if (!seenTapSel.has(key)) {
				seenTapSel.add(key);
				violations.push({
					kind: "tap-target",
					selector: sel,
					detail: Math.round(w) + "x" + Math.round(h) + " < " + thresholds.tapTargetPx,
					value: smallest,
				});
			}
		}
	}

	// ---- 4. Content hidden under the fixed navbar --------------------------------------------
	const navbar = document.querySelector("nav.navbar, .navbar.fixed-top");
	if (navbar) {
		const nb = navbar.getBoundingClientRect();
		if (nb.height > 0) {
			const main = document.querySelector("#actual-actual-content");
			// The title bar sits between navbar and main, so measure whichever comes first
			const firstBelow = document.querySelector(".league-top-bar, .title-bar") ?? main;
			if (firstBelow) {
				const fr = firstBelow.getBoundingClientRect();
				// Only meaningful at scrollTop 0
				if (window.scrollY === 0 && fr.height > 0 && fr.top < nb.bottom - 2) {
					violations.push({
						kind: "navbar-overlap",
						selector: describe(firstBelow),
						detail:
							"top " +
							Math.round(fr.top) +
							" is above navbar bottom " +
							Math.round(nb.bottom),
						value: Math.round(nb.bottom - fr.top),
					});
				}
			}
		}
	}

	const counts = {};
	for (const v of violations) {
		counts[v.kind] = (counts[v.kind] ?? 0) + 1;
	}

	return { scrollWidth, innerWidth, violations, counts };
}`;
