import { useEffect, useRef } from "react";

// Publishes the fixed navbar's real rendered height as --zen-navbar-h on <html>.
//
// public/css/_tokens.scss ships a static default so the first paint is close, but the navbar's
// actual height is content-driven and varies: the phase/status block is two lines of text that wrap
// differently per phase, the Play button is present only in a league, and every child grew a
// min-height in the accessibility pass. Measured in practice it lands anywhere from ~73px to ~85px
// at the 18px scale — and the static token was 63px, which put the league score strip 13px under the
// navbar on 101 of 116 audited routes.
//
// Everything that positions itself against the navbar reads this property (body padding, the sidebar
// top, the sticky offsets on Live Game / Trade / Settings, the anchor-link offset), so measuring it
// once here fixes all of them. See MOBILE_FIRST_ACCESSIBILITY_PLAN.md §1.6.

export const useNavbarHeight = () => {
	const ref = useRef<HTMLElement | null>(null);

	useEffect(() => {
		const node = ref.current;
		if (!node) {
			return;
		}

		const apply = () => {
			const height = node.getBoundingClientRect().height;
			if (height > 0) {
				// px, not rem: this is a measured value, and re-expressing it in rem would make it
				// wrong the moment the root font size changes (the measurement already accounts for
				// the new scale, because ResizeObserver fires when the navbar reflows).
				document.documentElement.style.setProperty(
					"--zen-navbar-h",
					`${Math.ceil(height)}px`,
				);
			}
		};

		apply();

		const observer = new ResizeObserver(apply);
		observer.observe(node);

		return () => {
			observer.disconnect();
			// Fall back to the stylesheet's default rather than leaving a stale measurement behind
			document.documentElement.style.removeProperty("--zen-navbar-h");
		};
	}, []);

	return ref;
};
