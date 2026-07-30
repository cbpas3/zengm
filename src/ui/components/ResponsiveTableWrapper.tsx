import clsx from "clsx";
import type { Ref } from "react";
type Props = {
	className?: string | null;
	children: any;
	nonfluid?: boolean;
	ref?: Ref<HTMLDivElement>;
};

// This used to be needed to handle event propagation for touch events, when SideBar was swipeable
export const ResponsiveTableWrapper = ({
	className,
	children,
	nonfluid,
	ref,
}: Props) => {
	return (
		<div
			className={clsx(
				"table-responsive small-scrollbar",
				{
					"table-nonfluid": nonfluid,
				},
				className,
			)}
			ref={ref}
			// A horizontally-scrollable region has to be reachable and scrollable by keyboard
			// (axe: scrollable-region-focusable). role/aria-label give it an identity once it is
			// focusable, so it is announced as something meaningful rather than a bare group.
			tabIndex={0}
			role="region"
			aria-label="Scrollable table"
		>
			{children}
		</div>
	);
};

export default ResponsiveTableWrapper;
