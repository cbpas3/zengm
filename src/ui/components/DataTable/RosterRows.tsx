import { use, type ReactNode } from "react";
import clsx from "clsx";
import { DataTableContext } from "./contexts.ts";
import { useElementWidth } from "../../hooks/useElementWidth.ts";
import type { Col, DataTableRow, DataTableRowMetadata, SortBy } from "./index.tsx";

// Yahoo-Fantasy-style roster layout for DataTable, an alternative to MobileCards.tsx.
//
// The card layout solved legibility but reads poorly for rosters: every player's numbers sit at a
// different vertical position, so you cannot compare two players at a glance, and one player fills
// most of a phone screen. This is the layout the Yahoo Fantasy app uses for the same data — a shared
// column-header strip, then per player a two-line block:
//
//   line 1  [badge] [headshot] [Name cell ..............] [controls]     <- pinned, full width
//   line 2  [ 10/16 ][ .625 ][ 4/7 ][ .571 ][ 0 ][ 24 ][ 15 ][ 4 ]      <- aligned to the header
//
// Line 2 and the header share one grid template, so the numbers line up down the whole list.
//
// Nothing here decomposes a player into fields: the Name cell that views already build (via
// `wrappedPlayerNameLabels`) contains the jersey number, name, injury icon, skills and watch toggle
// — exactly the identity content this layout wants. Views only say *which column indices* belong on
// line 1; everything else falls through to the stat strip. That keeps this a generic DataTable
// layout rather than a bespoke roster component, so sorting/filtering/pagination/bulk-select/CSV all
// still work.

type MyRow = Omit<DataTableRow, "data"> & { data: any[] };

// Cells are either a bare value or `{ value, classNames, style, title, colSpanToEnd, header }`
const unwrap = (cell: any) =>
	cell !== null && cell !== undefined && Object.hasOwn(cell, "value")
		? cell.value
		: cell;

const RowCheckbox = ({
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
		<label className="dt-roster-check">
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

const Player = ({
	row,
	cols,
	identityIndexes,
	controlIndexes,
	statIndexes,
	badge,
	avatar,
	identityWidth,
	onMove,
	canMoveUp,
	canMoveDown,
}: {
	row: MyRow;
	// Narrowed to visible columns in display order, so indices line up with row.data
	cols: Col[];
	identityIndexes: number[];
	controlIndexes: number[];
	statIndexes: number[];
	badge: ReactNode;
	avatar: ReactNode;
	identityWidth: number | undefined;
	onMove: ((direction: -1 | 1) => void) | undefined;
	canMoveUp: boolean;
	canMoveDown: boolean;
}) => {
	// row.rowLabel is only used by table mode's showRowLabels <td> (Row.tsx) - carried over here too,
	// otherwise a view like Depth.tsx (batting order slot, pitcher role) would silently lose it on
	// mobile since neither this nor MobileCards previously rendered it.
	const rowLabel = row.rowLabel;
	const { showBulkSelectCheckboxes, sortBys, isFiltered } = use(DataTableContext);

	let classNames;
	if (typeof row.classNames === "function") {
		classNames = row.classNames({ isDragged: false, isFiltered, sortBys });
	} else {
		classNames = row.classNames;
	}

	// A colSpanToEnd cell is a full-width message row ("No players"), not player data
	const spanIndex = row.data.findIndex((cell) => cell?.colSpanToEnd);
	if (spanIndex !== -1) {
		return (
			<div className={clsx("dt-roster-span", classNames)}>
				<div style={identityWidth ? { width: identityWidth } : undefined}>
					{unwrap(row.data[spanIndex])}
				</div>
			</div>
		);
	}

	// display: contents, so identity/stats/controls become direct children of the one grid in
	// RosterRows. That's what makes the header and every player's values share a single set of column
	// tracks: with separate grids the tracks sized independently and a wide value (a contract) either
	// overflowed its column or wrapped mid-token while the header stayed narrow.
	//
	// Consequence: this wrapper has no box, so row tinting can't live on it - the tint class goes on
	// each child instead.
	return (
		<div className="dt-roster-player">
			<div
				className={clsx("dt-roster-identity", classNames)}
				// Sticky pins it, but only an explicit width stops it spanning the full scroll
				// width. See useElementWidth for why this can't be pure CSS.
				style={identityWidth ? { width: identityWidth } : undefined}
			>
				{showBulkSelectCheckboxes && row.metadata ? (
					<RowCheckbox rowKey={row.key} metadata={row.metadata} />
				) : null}
				{rowLabel ? <div className="dt-roster-rowlabel">{rowLabel}</div> : null}
				{badge ? <div className="dt-roster-badge">{badge}</div> : null}
				{avatar ? <div className="dt-roster-avatar">{avatar}</div> : null}
				<div className="dt-roster-names">
					{identityIndexes.map((i) => (
						<span className="dt-roster-name-part" key={i}>
							{unwrap(row.data[i])}
						</span>
					))}
				</div>
				{onMove ? (
					<div className="dt-roster-reorder">
						{(
							// Reordering by explicit buttons rather than drag. dnd-kit's handle is
							// bound to <td> and its overlay measures table cell widths, so drag
							// can't cross into this layout without a parallel implementation - and
							// for a low-vision / reduced-motor-precision user, two 44px buttons beat
							// a drag target anyway. Uses the same onSwap the table drag ends up in.
							<>
								<button
									type="button"
									className="btn btn-light-bordered dt-roster-move"
									disabled={!canMoveUp}
									aria-label="Move up"
									onClick={() => {
										onMove(-1);
									}}
								>
									▲
								</button>
								<button
									type="button"
									className="btn btn-light-bordered dt-roster-move"
									disabled={!canMoveDown}
									aria-label="Move down"
									onClick={() => {
										onMove(1);
									}}
								>
									▼
								</button>
							</>
						)}
					</div>
				) : null}
			</div>

			{statIndexes.map((i) => {
					const cell = row.data[i];
					const value = unwrap(cell);
					return (
						<span
							className={clsx("dt-roster-stat", classNames, cell?.classNames)}
							key={i}
							// The header is visually separate from the value, so name each value for
							// screen readers rather than relying on column position alone.
							aria-label={cols[i]?.desc ?? cols[i]?.title}
						>
							{value === null || value === undefined || value === "" ? "—" : value}
						</span>
					);
				})}

			{controlIndexes.length > 0 ? (
				// Their own line, pinned to the identity width. These are not small inline widgets:
				// on the Roster page "Dev" is a whole panel (checkbox + archetype select + work-ethic
				// badges) and "Mood" is a popover trigger. Inline on line 1 they crushed the player's
				// name down to an initial.
				<div
					className={clsx("dt-roster-controls", classNames)}
					style={identityWidth ? { width: identityWidth } : undefined}
				>
					{controlIndexes.map((i) => (
						<span className="dt-roster-control" key={i}>
							{unwrap(row.data[i])}
						</span>
					))}
				</div>
			) : null}
		</div>
	);
};

export const RosterRows = ({
	rows,
	cols,
	identityIndexes,
	controlIndexes,
	statIndexes,
	sortBys,
	onSortChange,
	renderBadge,
	renderAvatar,
	onSwap,
}: {
	rows: MyRow[];
	cols: Col[];
	identityIndexes: number[];
	controlIndexes: number[];
	statIndexes: number[];
	sortBys: SortBy[] | undefined;
	// Receives an index into `cols` (visible order); resolved to a real col index by the caller
	onSortChange: (visibleIndex: number) => void;
	renderBadge?: (row: DataTableRow, index: number) => ReactNode;
	renderAvatar?: (row: DataTableRow) => ReactNode;
	// Present only when the view enabled reordering AND sorting is off, so display index ==
	// underlying roster index and a swap means what the user sees.
	onSwap?: (index1: number, index2: number) => void;
}) => {
	const [scrollRef, identityWidth] = useElementWidth<HTMLDivElement>();

	if (rows.length === 0) {
		return (
			<div className="dt-roster">
				<div className="dt-roster-span text-body-secondary">
					<div>No players</div>
				</div>
			</div>
		);
	}

	return (
		<div className="dt-roster">
			<div className="dt-roster-scroll" ref={scrollRef}>
				{/* Header and every stat strip share this template, which is what makes the
				    columns line up down the list. */}
				<div
					className="dt-roster-grid"
					style={{ "--dt-roster-cols": statIndexes.length } as any}
				>
					{statIndexes.map((i) => {
						const col = cols[i];
						const unsortable = col?.sortSequence && col.sortSequence.length === 0;
						const sortedBy = sortBys?.find((s) => s[0] === i);
						return (
							<button
								type="button"
								className={clsx("dt-roster-th", {
									"dt-roster-th-sorted": sortedBy !== undefined,
								})}
								key={i}
								disabled={unsortable}
								aria-label={col?.desc ?? col?.title}
								onClick={() => {
									if (!unsortable) {
										onSortChange(i);
									}
								}}
							>
								{col?.title}
								{sortedBy ? (
									<span aria-hidden="true">
										{sortedBy[1] === "asc" ? " ▲" : " ▼"}
									</span>
								) : null}
							</button>
						);
					})}

				{rows.map((row, index) => (
						<Player
							key={row.key}
							row={row}
							cols={cols}
							identityIndexes={identityIndexes}
							controlIndexes={controlIndexes}
							statIndexes={statIndexes}
							badge={renderBadge?.(row, index)}
							avatar={renderAvatar?.(row)}
							identityWidth={identityWidth}
							onMove={
								onSwap
									? (direction) => {
											onSwap(index, index + direction);
										}
									: undefined
							}
							canMoveUp={index > 0}
							canMoveDown={index < rows.length - 1}
						/>
					))}
				</div>
			</div>
		</div>
	);
};
