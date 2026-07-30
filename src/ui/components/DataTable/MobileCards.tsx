import { use, useState, type ReactNode } from "react";
import clsx from "clsx";
import { DataTableContext } from "./contexts.ts";
import type { Col, DataTableRow, DataTableRowMetadata } from "./index.tsx";

// Mobile card layout for DataTable.
//
// A 25-column stats table cannot be made readable at 18px on a 390px screen by adjusting CSS — the
// app fails WCAG 1.4.10 (Reflow) on ~60 pages for exactly this reason. Below `md` each row becomes a
// card: the primary identifier as a heading, then label/value pairs where the label is the column's
// full `desc` ("Total Rebounds") rather than its abbreviation ("TRB"). That also fixes the
// hover-only column definitions, which were only reachable as a `title=` tooltip on the `<th>`.
//
// See MOBILE_FIRST_ACCESSIBILITY_PLAN.md §4.3.
//
// This is a real DOM swap rather than `display: block` on the table elements: block-ifying a table
// destroys the row/column association in the accessibility tree, and Bootstrap's `.table-*` classes
// fight it. Consequences handled by the caller: sticky columns and the sticky header are
// meaningless here and are not rendered.

// How many pairs to show before the "Show all" disclosure. Enough to be useful at a glance without
// turning one row into a screenful.
const DEFAULT_VISIBLE_PAIRS = 5;

type MyRow = Omit<DataTableRow, "data"> & { data: any[] };

const CardCheckbox = ({
	rowKey,
	metadata,
}: {
	rowKey: DataTableRow["key"];
	metadata: DataTableRowMetadata;
}) => {
	const { disableBulkSelectKeys, selectedRows } = use(DataTableContext);
	const checked = selectedRows.map.has(rowKey);
	const disabled = !!disableBulkSelectKeys?.has(rowKey);

	return (
		<label className="dt-card-check">
			<input
				className="form-check-input"
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={() => {
					selectedRows.toggle(rowKey, metadata);
				}}
			/>
			<span className="visually-hidden">Select row</span>
		</label>
	);
};

// Cells are either a bare value or `{ value, classNames, style, title, colSpanToEnd, header }`
const unwrap = (cell: any) =>
	cell !== null && cell !== undefined && Object.hasOwn(cell, "value")
		? cell.value
		: cell;

const cellIsEmpty = (value: ReactNode) =>
	value === null || value === undefined || value === "" || value === false;

const Card = ({
	row,
	cols,
	primaryIndex,
	visiblePairs,
}: {
	row: MyRow;
	// Already narrowed to the visible columns, in display order, so indices line up with row.data
	cols: Col[];
	primaryIndex: number;
	visiblePairs: number;
}) => {
	const [expanded, setExpanded] = useState(false);
	const { clickable, showBulkSelectCheckboxes, sortBys, isFiltered } =
		use(DataTableContext);

	let classNames;
	if (typeof row.classNames === "function") {
		classNames = row.classNames({ isDragged: false, isFiltered, sortBys });
	} else {
		classNames = row.classNames;
	}

	// A colSpanToEnd cell is a full-width message row ("No games played"), not data
	const spanIndex = row.data.findIndex((cell) => cell?.colSpanToEnd);
	if (spanIndex !== -1) {
		return (
			<div className={clsx("dt-card", "dt-card-span", classNames)}>
				{row.data.slice(0, spanIndex).map((cell, i) => (
					<div key={i}>{unwrap(cell)}</div>
				))}
				<div>{unwrap(row.data[spanIndex])}</div>
			</div>
		);
	}

	const primary = row.data[primaryIndex];

	// Everything except the primary column becomes a label/value pair, ordered by mobilePriority
	// (falling back to display order) so the most useful values are above the fold.
	const pairs = row.data
		.map((cell, i) => ({ cell, i }))
		.filter(({ i }) => i !== primaryIndex)
		.filter(({ cell }) => !cellIsEmpty(unwrap(cell)))
		.sort(
			(a, b) =>
				(cols[a.i]?.mobilePriority ?? a.i) - (cols[b.i]?.mobilePriority ?? b.i),
		);

	const shown = expanded ? pairs : pairs.slice(0, visiblePairs);
	const hiddenCount = pairs.length - shown.length;

	return (
		<div className={clsx("dt-card", classNames, { "dt-card-clickable": clickable })}>
			<div className="dt-card-head">
				{showBulkSelectCheckboxes && row.metadata ? (
					<CardCheckbox rowKey={row.key} metadata={row.metadata} />
				) : null}
				<div className="dt-card-title">{unwrap(primary)}</div>
			</div>

			{shown.length > 0 ? (
				<dl className="dt-card-grid">
					{shown.map(({ cell, i }) => {
						const col = cols[i];
						return (
							<div className="dt-card-pair" key={i}>
								{/* The full name, not the abbreviation - this is the whole point */}
								<dt>{col?.desc ?? col?.title ?? ""}</dt>
								<dd className={cell?.classNames ? clsx(cell.classNames) : undefined}>
									{unwrap(cell)}
								</dd>
							</div>
						);
					})}
				</dl>
			) : null}

			{hiddenCount > 0 || expanded ? (
				<button
					type="button"
					className="btn btn-link dt-card-more"
					aria-expanded={expanded}
					onClick={() => {
						setExpanded(!expanded);
					}}
				>
					{expanded ? "Show less" : `Show all ${pairs.length} details`}
				</button>
			) : null}
		</div>
	);
};

export const MobileCards = ({
	rows,
	cols,
	primaryIndex,
	visiblePairs = DEFAULT_VISIBLE_PAIRS,
}: {
	rows: MyRow[];
	cols: Col[];
	primaryIndex: number;
	visiblePairs?: number;
}) => {
	if (rows.length === 0) {
		return <div className="dt-card dt-card-span text-body-secondary">No rows</div>;
	}

	return (
		<div className="dt-cards">
			{rows.map((row) => (
				<Card
					key={row.key}
					row={row}
					cols={cols}
					primaryIndex={primaryIndex}
					visiblePairs={visiblePairs}
				/>
			))}
		</div>
	);
};
