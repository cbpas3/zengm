import type { Col, SortBy } from "./index.tsx";
import type { SortOrder } from "../../../common/types.ts";

// Sort/search controls for the mobile card layout.
//
// In table mode you sort by tapping a ~20px-wide arrow inside a `<th>`. That is not a usable target
// with reduced motor precision, and in card mode there are no headers to tap at all. This replaces
// it with a full-width "Sort by" select plus an explicit direction toggle, both at the primary tap
// size. See MOBILE_FIRST_ACCESSIBILITY_PLAN.md §4.3.

export const MobileControls = ({
	cols,
	// Indices into `cols`, in display order, that are actually sortable
	sortableColIndexes,
	sortBys,
	onSortChange,
	searchText,
	onSearch,
	hideSearch,
}: {
	cols: Col[];
	sortableColIndexes: number[];
	sortBys: SortBy[] | undefined;
	onSortChange: (colIndex: number, order: SortOrder) => void;
	searchText: string;
	onSearch: (text: string) => void;
	hideSearch?: boolean;
}) => {
	const current = sortBys?.[0];
	const currentCol = current?.[0];
	const currentOrder: SortOrder = current?.[1] ?? "asc";

	return (
		<div className="dt-mobile-controls">
			{hideSearch ? null : (
				<input
					className="form-control"
					type="search"
					// A real search keyboard, and no autocorrect mangling player names
					autoCorrect="off"
					autoCapitalize="off"
					spellCheck={false}
					placeholder="Search"
					aria-label="Search this table"
					value={searchText}
					onChange={(event) => {
						onSearch(event.currentTarget.value);
					}}
				/>
			)}

			{sortableColIndexes.length > 0 ? (
				<div className="dt-mobile-sort">
					<label className="form-label" htmlFor="dt-mobile-sort-select">
						Sort by
					</label>
					<div className="d-flex gap-2">
						<select
							id="dt-mobile-sort-select"
							className="form-select"
							value={currentCol ?? ""}
							onChange={(event) => {
								const colIndex = Number.parseInt(event.currentTarget.value);
								if (!Number.isNaN(colIndex)) {
									onSortChange(colIndex, currentOrder);
								}
							}}
						>
							{sortableColIndexes.map((colIndex) => {
								const col = cols[colIndex];
								if (!col) {
									return null;
								}
								return (
									<option key={colIndex} value={colIndex}>
										{/* Full name, so the option list is readable */}
										{col.desc ?? col.title}
									</option>
								);
							})}
						</select>
						<button
							type="button"
							className="btn btn-light-bordered flex-shrink-0"
							aria-label={
								currentOrder === "asc"
									? "Sorted lowest first. Switch to highest first."
									: "Sorted highest first. Switch to lowest first."
							}
							onClick={() => {
								if (currentCol !== undefined) {
									onSortChange(currentCol, currentOrder === "asc" ? "desc" : "asc");
								}
							}}
						>
							{/* Text, not just an arrow glyph - an unlabelled icon is not enough here */}
							{currentOrder === "asc" ? "Low to high" : "High to low"}
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
};
