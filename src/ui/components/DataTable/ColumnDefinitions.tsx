import { useState } from "react";
import type { Col } from "./index.tsx";

// Tappable column definitions.
//
// A column's full name lives in `Col.desc` ("Total Rebounds" for "TRB") and used to be exposed only
// as `title={desc}` on the `<th>` — a native tooltip, which requires hover and is therefore
// unreachable on any touch device. The mobile card layout solves this by using `desc` as the label
// directly; this covers the case where the table itself is showing (md and up, including tablets).
//
// See MOBILE_FIRST_ACCESSIBILITY_PLAN.md §0 ("Hover-only information: zero").

export const ColumnDefinitions = ({ cols }: { cols: Col[] }) => {
	const [show, setShow] = useState(false);

	// Only abbreviations are worth explaining — a column whose title already is its full name, or
	// which has no desc at all, would just be noise.
	const explained = cols.filter(
		(col) => col.desc !== undefined && col.desc !== col.title && col.title !== "",
	);

	if (explained.length === 0) {
		return null;
	}

	return (
		<div className="dt-col-defs">
			<button
				type="button"
				className="btn btn-link p-0"
				aria-expanded={show}
				onClick={() => {
					setShow(!show);
				}}
			>
				{show ? "Hide column meanings" : "What do these columns mean?"}
			</button>
			{show ? (
				<dl className="dt-col-defs-list">
					{explained.map((col, i) => (
						<div key={i}>
							<dt>{col.title}</dt>
							<dd>{col.desc}</dd>
						</div>
					))}
				</dl>
			) : null}
		</div>
	);
};
