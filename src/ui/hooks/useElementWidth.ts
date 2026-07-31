import { useEffect, useRef, useState } from "react";

// Tracks an element's client width with a ResizeObserver.
//
// Written for the roster-row layout (DataTable/RosterRows.tsx), where the player identity line is
// `position: sticky; left: 0` inside a horizontally-scrolling container. Sticky positioning pins the
// element, but it does not size it: without an explicit width the identity line is as wide as the
// scroll content (all the stat columns), so it visually overflows the viewport even though it never
// moves. CSS has no way to say "as wide as my scroll container's visible area", so the width has to
// be measured.
//
// Same approach as src/ui/hooks/useNavbarHeight.ts, which measures the navbar for --zen-navbar-h.

export const useElementWidth = <T extends HTMLElement>() => {
	const ref = useRef<T | null>(null);
	const [width, setWidth] = useState<number | undefined>(undefined);

	useEffect(() => {
		const node = ref.current;
		if (!node) {
			return;
		}

		const apply = () => {
			// clientWidth, not getBoundingClientRect().width: we want the visible area excluding any
			// scrollbar, which is exactly what the pinned element should span.
			const next = node.clientWidth;
			if (next > 0) {
				setWidth((prev) => (prev === next ? prev : next));
			}
		};

		apply();

		const observer = new ResizeObserver(apply);
		observer.observe(node);

		return () => {
			observer.disconnect();
		};
	}, []);

	return [ref, width] as const;
};
