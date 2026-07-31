import clsx, { type ClassValue } from "clsx";
import { csvFormatRows } from "d3-dsv";
import {
	type SyntheticEvent,
	type MouseEvent,
	type ReactNode,
	useRef,
	type CSSProperties,
	useImperativeHandle,
	type RefCallback,
} from "react";
import Controls from "./Controls.tsx";
import CustomizeColumns from "./CustomizeColumns.tsx";
import Footer, { type FooterRow } from "./Footer.tsx";
import Header from "./Header.tsx";
import Info from "./Info.tsx";
import Row from "./Row.tsx";
import Pagination from "./Pagination.tsx";
import PerPage from "./PerPage.tsx";
import getSearchVal from "./getSearchVal.tsx";
import getSortVal from "./getSortVal.tsx";
import { ResponsiveTableWrapper } from "../ResponsiveTableWrapper.tsx";
import { helpers } from "../../util/helpers.ts";
import type { SortOrder, SortType } from "../../../common/types.ts";
import { arrayMove } from "@dnd-kit/sortable";
import updateSortBys from "./updateSortBys.ts";
import useStickyXX from "./useStickyXX.ts";
import { useDataTableState } from "./useDataTableState.ts";
import { processRows } from "./processRows.ts";
import { useBulkSelectRows, type SelectedRows } from "./useBulkSelectRows.ts";
import { BulkActions, type BulkAction } from "./BulkActions.tsx";
import {
	DraggableRow,
	getId,
	MyDragOverlay,
	SortableContextWrappers,
	type DisableRow,
	type HighlightHandle,
} from "./sortableRows.tsx";
import { DataTableContext } from "./contexts.ts";
import { useStickyTableHeader } from "./useStickyTableHeader.ts";
import { downloadFile } from "../../util/downloadFile.ts";
import { safeLocalStorage } from "../../util/safeLocalStorage.ts";
import { MobileCards } from "./MobileCards.tsx";
import { MobileControls } from "./MobileControls.tsx";
import { useBreakpointUp } from "../../hooks/useBreakpoint.ts";
import { ColumnDefinitions } from "./ColumnDefinitions.tsx";
import { RosterRows } from "./RosterRows.tsx";

export type SortBy = [number, SortOrder];

export type Col = {
	classNames?: any; // Just header
	desc?: string;
	noSearch?: boolean;
	sortSequence?: SortOrder[];
	sortType?: SortType;
	searchType?: SortType;
	title: string;
	titleReact?: ReactNode;
	width?: string;

	// Lower = more important. Used only by the mobile card layout (MobileCards.tsx) to decide which
	// columns show before the "Show all N" disclosure. Defaults to the column's display index, so a
	// table that sets nothing still gets a sensible order.
	mobilePriority?: number;
};

export type SuperCol = {
	colspan: number;
	desc?: string;
	title: ReactNode;
};

type Season = number | "career";

export type DataTableRowMetadata =
	| {
			type: "player";
			pid: number;
			season:
				| Season
				| {
						// Use this to specify different seasons for different actions
						compare?: Season;
						export?: Season;
						default: Season;
				  };
			playoffs: "playoffs" | "regularSeason" | "combined";
	  }
	| {
			type: "row";
	  };

export type DataTableRow = {
	key: number | string;
	data: (
		| ReactNode
		| {
				classNames?: ClassValue;
				value: ReactNode;
				searchValue?: string | number;
				sortValue?: string | number;
				header?: boolean;
				title?: string;
				colSpanToEnd?: boolean; // Maybe dangerous unless disableSort
		  }
	)[];
	classNames?:
		| ClassValue
		| ((args: {
				isDragged: boolean;
				isFiltered: boolean;
				sortBys: SortBy[] | undefined;
		  }) => ClassValue);
	metadata?: DataTableRowMetadata;
	rowLabel?: ReactNode;
};

export type StickyCols = 0 | 1 | 2 | 3;

export type DataTableHandle = {
	setFilters: (filters: string[], enableFilters: boolean) => void;
	getEnableFilters: () => boolean;
	getFilters: () => string[];
};

export type Props = {
	className?: string;
	classNameWrapper?: string;
	clickable?: boolean;
	cols: Col[];
	defaultSort: SortBy | "disableSort";
	disableSettingsCache?: boolean;
	defaultStickyCols?: StickyCols;
	extraBulkActions?: BulkAction[];
	footer?: FooterRow | FooterRow[];
	hideAllControls?: boolean; // When ReactNode, display as a title above the table
	hideHeader?: boolean;
	hideMenuToo?: boolean;
	name: string;
	nonfluid?: boolean;
	pagination?: boolean;
	rankCol?: number;
	ref?: RefCallback<DataTableHandle>;
	rows: DataTableRow[];
	showRowLabels?: boolean;
	small?: boolean;
	sortableRows?: {
		disableRow?: DisableRow;
		highlightHandle?: HighlightHandle;
		onChange: (a: { oldIndex: number; newIndex: number }) => void;
		onSwap: (index1: number, index2: number) => void;
	};
	stickyHeader?: boolean;
	striped?: boolean;
	style?: CSSProperties;
	superCols?: SuperCol[];
	title?: ReactNode;

	// Below `md`, render each row as a card instead of a table row, so wide stat tables reflow
	// instead of scrolling sideways (WCAG 1.4.10). "auto" is the default; pass false for tables
	// where a card per row makes no sense (a bracket, a 2-column key/value table that already
	// fits). Automatically disabled when `sortableRows` is set — drag-to-reorder is a table
	// interaction. See MOBILE_FIRST_ACCESSIBILITY_PLAN.md §4.3.
	mobileCards?: false | "auto";

	// Which mobile layout to use. "cards" (default) is the generic label/value card; "roster" is the
	// Yahoo-Fantasy-style two-line player row — identity on top, stats aligned to a shared header —
	// which reads far better for roster-shaped pages. See DataTable/RosterRows.tsx.
	mobileLayout?: "cards" | "roster";
	// Only for mobileLayout="roster". Indices into `cols`. `identity` renders on line 1 (the Name
	// cell and friends), `controls` renders at the end of line 1 (interactive widgets like the
	// Roster page's PT/Dev/Release). Everything else becomes an aligned stat column on line 2.
	rosterBands?: {
		identity: number[];
		controls?: number[];
	};
	// Optional left-hand badge (the Yahoo C/Util/BN circle) and headshot for each player row.
	rosterBadge?: (row: DataTableRow, index: number) => ReactNode;
	rosterAvatar?: (row: DataTableRow) => ReactNode;
	// Which visible column is the card's heading. Defaults to the first non-rank column.
	mobileCardPrimaryCol?: number;
	// How many label/value pairs to show before the "Show all" disclosure.
	mobileCardVisiblePairs?: number;

	// Pass this to control selectedRows from outside of this component (like if you want to have a button external to the table that does something with selected players). Otherwise, leave this undefined.
	controlledSelectedRows?: SelectedRows;
	alwaysShowBulkSelectRows?: boolean; // Often used along with controlledSelectedRows,
	disableBulkSelectKeys?: Set<DataTableRow["key"]>;
};

export const DataTable = ({
	alwaysShowBulkSelectRows,
	className,
	classNameWrapper,
	clickable = true,
	cols,
	controlledSelectedRows,
	defaultSort,
	defaultStickyCols = 0,
	disableBulkSelectKeys,
	disableSettingsCache,
	extraBulkActions,
	footer,
	hideAllControls,
	hideHeader,
	hideMenuToo,
	mobileCards = "auto",
	mobileCardPrimaryCol,
	mobileCardVisiblePairs,
	mobileLayout = "cards",
	rosterBands,
	rosterBadge,
	rosterAvatar,
	name,
	nonfluid,
	pagination,
	rankCol,
	ref,
	rows,
	showRowLabels,
	small,
	sortableRows,
	stickyHeader,
	striped,
	style,
	superCols,
	title,
}: Props) => {
	if (sortableRows) {
		if (!hideAllControls) {
			throw new Error(
				`If you enable sortableRows, you must also enable hideAllControls`,
			);
		}
		if (!hideAllControls) {
			throw new Error(
				`If you enable sortableRows, you cannot enable pagination`,
			);
		}
		if (defaultSort !== "disableSort") {
			throw new Error(
				`If you enable sortableRows, you must set defaultSort to "disableSort"`,
			);
		}
	}

	const hideAllControlsBool = !!hideAllControls;
	const { state, setStatePartial, resetState } = useDataTableState({
		cols,
		defaultSort,
		defaultStickyCols,
		disableSettingsCache,
		hideAllControls: hideAllControlsBool,
		name,
	});

	const {
		bulkSelectRows,
		metadataType,
		selectedRows,
		showBulkSelectCheckboxes,
		toggleBulkSelectRows,
	} = useBulkSelectRows({
		alwaysShowBulkSelectRows,
		controlledSelectedRows,
		rows,
	});

	const handleColClick = (event: MouseEvent, i: number) => {
		if (state.sortBys !== undefined) {
			const sortBys = updateSortBys({
				cols,
				event,
				i,
				prevSortBys: state.sortBys,
			});

			state.settingsCache.set("DataTableSort", sortBys);
			setStatePartial({
				currentPage: 1,
				sortBys,
			});
		}
	};

	const handleBulkSelectRows = () => {
		toggleBulkSelectRows();
	};

	const handleExportCSV = () => {
		const colOrderFiltered = state.colOrder.filter(
			({ hidden, colIndex }) => !hidden && cols[colIndex],
		);
		const columns = colOrderFiltered.map(({ colIndex }) => cols[colIndex]!);
		const colNames = columns.map((col) => col.title);
		const processedRows = processRows({
			cols,
			rankCol,
			rows,
			state,
		}).map((row) =>
			row.data.map((val, i) => {
				const sortType = columns[i]!.sortType;
				if (sortType === "number") {
					return getSortVal(val, sortType, true);
				}
				return getSearchVal(val, false);
			}),
		);
		const output = csvFormatRows([colNames, ...processedRows]);
		downloadFile(`${name}.csv`, output, "text/csv");
	};

	const handleResetTable = () => {
		state.settingsCache.clear("DataTableColOrder");
		state.settingsCache.clear("DataTableFilters");
		state.settingsCache.clear("DataTableSort");
		state.settingsCache.clear("DataTableStickyCols");

		resetState({
			cols,
			defaultSort,
			defaultStickyCols,
			disableSettingsCache,
			hideAllControls: hideAllControlsBool,
			name,
		});

		if (bulkSelectRows) {
			toggleBulkSelectRows();
		}
	};

	const handleSelectColumns = () => {
		setStatePartial({
			showSelectColumnsModal: true,
		});
	};

	const handleToggleFilters = () => {
		// Remove filter cache if hiding, add filter cache if displaying
		if (state.enableFilters) {
			state.settingsCache.clear("DataTableFilters");
		} else {
			state.settingsCache.set("DataTableFilters", state.filters);
		}

		setStatePartial({
			enableFilters: !state.enableFilters,
		});
	};

	const handleFilterUpdate = (
		event: SyntheticEvent<HTMLInputElement>,
		i: number,
	) => {
		const filters = helpers.deepCopy(state.filters);

		filters[i] = event.currentTarget.value;
		setStatePartial({
			currentPage: 1,
			filters,
		});
		state.settingsCache.set("DataTableFilters", filters);
	};

	const handlePagination = (newPage: number) => {
		if (newPage !== state.currentPage) {
			setStatePartial({
				currentPage: newPage,
			});
		}
	};

	const handlePerPage = (perPage: number) => {
		if (perPage !== state.perPage) {
			safeLocalStorage.setItem("perPage", String(perPage));
			setStatePartial({
				currentPage: 1,
				perPage,
			});
		}
	};

	const handleSearch = (event: SyntheticEvent<HTMLInputElement>) => {
		setStatePartial({
			currentPage: 1,
			searchText: event.currentTarget.value,
		});
	};

	// If name changes, it means this is a whole new table and it has a different state (example: Player Stats switching between regular and advanced stats).
	// If colOrder does not match cols, need to run reconciliation code in loadStateFromCache (example: current vs past seasons in League Finances).
	if (
		name !== state.prevName ||
		cols.length > state.colOrder.length ||
		state.hideAllControls !== hideAllControlsBool
	) {
		resetState({
			cols,
			defaultSort,
			defaultStickyCols,
			disableSettingsCache,
			hideAllControls: hideAllControlsBool,
			name,
		});
	}

	useImperativeHandle(ref, () => {
		return {
			setFilters(filters: string[], enableFilters: boolean) {
				state.settingsCache.set("DataTableFilters", filters);
				setStatePartial({
					enableFilters,
					filters,
				});
			},
			getEnableFilters() {
				return state.enableFilters;
			},
			getFilters() {
				return state.filters;
			},
		};
	}, [
		setStatePartial,
		state.enableFilters,
		state.filters,
		state.settingsCache,
	]);

	const processedRows = processRows({
		cols,
		rankCol,
		rows,
		state,
	});
	const numRowsFiltered = processedRows.length;
	const start = 1 + (state.currentPage - 1) * state.perPage;
	let end = start + state.perPage - 1;

	if (end > processedRows.length) {
		end = processedRows.length;
	}

	const processedRowsPage = pagination
		? processedRows.slice(start - 1, end)
		: processedRows;

	const colOrderFiltered = state.colOrder.filter(
		({ hidden, colIndex }) => !hidden && cols[colIndex],
	);

	// ---- Mobile card layout ----------------------------------------------------------------
	// processedRows[].data is already reordered to match colOrderFiltered, so the card layout needs
	// the same narrowed, display-ordered col list for its indices to line up.
	const mdUp = useBreakpointUp("md");
	const mobileEligible = mobileCards !== false && !mdUp;
	const visibleCols = colOrderFiltered.map(({ colIndex }) => cols[colIndex]!);

	// Default card heading: the first visible column that isn't the rank number, since "1" is not a
	// useful title for a card.
	let cardPrimaryIndex = mobileCardPrimaryCol;
	if (cardPrimaryIndex === undefined) {
		const firstNonRank = colOrderFiltered.findIndex(
			({ colIndex }) => colIndex !== rankCol,
		);
		cardPrimaryIndex = firstNonRank === -1 ? 0 : firstNonRank;
	}

	// Columns the mobile sort control offers: sortable ones only, expressed as indices into `cols`
	// so they can be handed straight to the same sort state the table uses.
	const mobileSortableColIndexes = colOrderFiltered
		.map(({ colIndex }) => colIndex)
		.filter((colIndex) => {
			const sortSequence = cols[colIndex]?.sortSequence;
			return !(sortSequence && sortSequence.length === 0);
		});

	const handleMobileSortChange = (colIndex: number, order: SortOrder) => {
		const sortBys: SortBy[] = [[colIndex, order]];
		state.settingsCache.set("DataTableSort", sortBys);
		setStatePartial({
			currentPage: 1,
			sortBys,
		});
	};

	// ---- Roster-row layout bands -------------------------------------------------------------
	// rosterBands is expressed in `cols` indices (what the view author knows); everything downstream
	// works in visible-column indices, since processedRows[].data is reordered to colOrderFiltered.
	// Unlike cards, the roster layout CAN carry a reorderable list: each player is a single node and
	// reordering is done with buttons rather than dnd-kit, so sortableRows no longer forces the
	// table. That matters because the editable roster - the page this layout exists for - is exactly
	// the one that sets sortableRows.
	const useRosterRows =
		mobileEligible && mobileLayout === "roster" && rosterBands !== undefined;
	// Cards still can't do drag-to-reorder, so they keep opting out of it
	const useCards = mobileEligible && !useRosterRows && !sortableRows;
	const toVisible = (colIndexes: number[]) =>
		colIndexes
			.map((colIndex) =>
				colOrderFiltered.findIndex((c) => c.colIndex === colIndex),
			)
			.filter((i) => i !== -1);
	const rosterIdentityIndexes = toVisible(rosterBands?.identity ?? []);
	const rosterControlIndexes = toVisible(rosterBands?.controls ?? []);
	// Anything not explicitly placed becomes an aligned stat column, so a view that gains a column
	// later gets it in the strip automatically rather than silently dropping it.
	const rosterStatIndexes = colOrderFiltered
		.map((_, i) => i)
		.filter(
			(i) =>
				!rosterIdentityIndexes.includes(i) && !rosterControlIndexes.includes(i),
		);

	// Header taps reuse the table's own sort cycling, so asc/desc/sortSequence behave identically
	const handleRosterSort = (visibleIndex: number) => {
		const colIndex = colOrderFiltered[visibleIndex]?.colIndex;
		if (colIndex === undefined || state.sortBys === undefined) {
			return;
		}
		const sortBys = updateSortBys({
			cols,
			event: { shiftKey: false } as MouseEvent,
			i: colIndex,
			prevSortBys: state.sortBys,
		});
		state.settingsCache.set("DataTableSort", sortBys);
		setStatePartial({ currentPage: 1, sortBys });
	};

	// The roster header shows sort state per visible column, so map sortBys into that space
	const rosterSortBys = state.sortBys?.map(
		([colIndex, order]) =>
			[
				colOrderFiltered.findIndex((c) => c.colIndex === colIndex),
				order,
			] as SortBy,
	);

	const highlightCols =
		state.sortBys === undefined
			? []
			: state.sortBys
					.map((sortBy) => sortBy[0])
					.map((i) =>
						colOrderFiltered.findIndex(({ colIndex }) => {
							if (colIndex !== i) {
								return false;
							}

							// Make sure sortSequence is not an empty array - same code is in Header
							const sortSequence = cols[colIndex]!.sortSequence;
							if (sortSequence && sortSequence.length === 0) {
								return false;
							}

							return true;
						}),
					);

	const dataTableContext = {
		clickable,
		disableBulkSelectKeys,
		isFiltered: processedRows.length !== rows.length,
		highlightCols,
		selectedRows,
		showRowLabels,
		showBulkSelectCheckboxes,
		sortBys: state.sortBys,
	};

	const { stickyClass, tableRef } = useStickyXX(
		state.stickyCols,
		showBulkSelectCheckboxes,
	);

	const wrapperRef = useRef<HTMLDivElement>(null);
	const responsiveTableWrapperRef = useRef<HTMLDivElement>(null);

	useStickyTableHeader({
		className,
		containerRef: responsiveTableWrapperRef,
		stickyHeader,
		tableRef,
	});

	const table = (
		<DataTableContext value={dataTableContext}>
			<table
				className={clsx(
					"table table-hover",
					{
						"table-sm": small !== false,
						"table-striped": striped !== false,
						"table-borderless": striped !== false,
					},
					stickyClass,
				)}
				ref={tableRef}
			>
				{hideHeader ? null : (
					<Header
						bulkSelectProps={{
							disableBulkSelectKeys,
							filteredRows: processedRows,
							filteredRowsPage: processedRowsPage,
							selectedRows,
						}}
						colOrder={colOrderFiltered}
						cols={cols}
						enableFilters={state.enableFilters}
						filters={state.filters}
						handleColClick={handleColClick}
						handleFilterUpdate={handleFilterUpdate}
						showBulkSelectCheckboxes={showBulkSelectCheckboxes}
						showRowLabels={showRowLabels}
						sortable={!!sortableRows}
						sortBys={state.sortBys}
						superCols={superCols}
					/>
				)}
				<tbody>
					{processedRowsPage.map((row) => {
						if (sortableRows) {
							return <DraggableRow key={row.key} id={getId(row)} row={row} />;
						}

						return <Row key={row.key} row={row} />;
					})}
				</tbody>
				{sortableRows ? <MyDragOverlay /> : null}
				<Footer colOrder={colOrderFiltered} footer={footer} />
			</table>
		</DataTableContext>
	);

	return (
		<>
			<CustomizeColumns
				cols={cols}
				colOrder={state.colOrder}
				hasSuperCols={!!superCols}
				show={state.showSelectColumnsModal}
				onHide={() => {
					setStatePartial({
						showSelectColumnsModal: false,
					});
				}}
				onReset={() => {
					const newOrder = cols.map((col, i) => ({
						colIndex: i,
					}));
					setStatePartial({
						colOrder: newOrder,
						stickyCols: defaultStickyCols,
					});
					state.settingsCache.set("DataTableColOrder", newOrder);
					state.settingsCache.clear("DataTableStickyCols");
				}}
				onChange={({ oldIndex, newIndex }) => {
					const newOrder = arrayMove(state.colOrder, oldIndex, newIndex);
					setStatePartial({
						colOrder: newOrder,
					});
					state.settingsCache.set("DataTableColOrder", newOrder);
				}}
				onToggleHidden={(i: number) => () => {
					const newOrder = [...state.colOrder];
					if (newOrder[i]) {
						newOrder[i] = {
							...newOrder[i],
						};
						if (newOrder[i].hidden) {
							delete newOrder[i].hidden;
						} else {
							newOrder[i].hidden = true;
						}
						setStatePartial({
							colOrder: newOrder,
						});
						state.settingsCache.set("DataTableColOrder", newOrder);
					}
				}}
				onChangeStickyCols={(stickyCols) => {
					setStatePartial({
						stickyCols,
					});
					state.settingsCache.set("DataTableStickyCols", stickyCols);
				}}
				stickyCols={state.stickyCols}
			/>
			<div className={className} style={style}>
				<div
					className={clsx({
						"d-inline-block mw-100": nonfluid,
					})}
				>
					{!hideAllControls || !hideMenuToo || title ? (
						<div
							className="d-flex align-items-end"
							style={{
								// minHeight rather than height allows title to expanad this, like on player profile pages for the tabs above stat tables
								minHeight: 35,
							}}
							ref={wrapperRef}
						>
							{bulkSelectRows ? (
								<BulkActions
									extraActions={extraBulkActions}
									hasTitle={title !== undefined}
									hideAllControls={hideAllControls}
									name={name}
									selectedRows={selectedRows}
									wrapperRef={wrapperRef}
								/>
							) : pagination && !hideAllControls ? (
								<PerPage onChange={handlePerPage} value={state.perPage} />
							) : null}
							{title ? (
								<div
									className={clsx(
										"datatable-header-text text-truncate d-flex align-items-center",
										bulkSelectRows ? "ms-2" : undefined,
									)}
								>
									{title}
								</div>
							) : null}
							{!hideMenuToo ? (
								<Controls
									alwaysShowBulkSelectRows={!!alwaysShowBulkSelectRows}
									bulkSelectRows={bulkSelectRows}
									enableFilters={state.enableFilters}
									hideAllControls={hideAllControls}
									metadataType={metadataType}
									name={name}
									onBulkSelectRows={handleBulkSelectRows}
									onExportCSV={handleExportCSV}
									onResetTable={handleResetTable}
									onSearch={handleSearch}
									onSelectColumns={handleSelectColumns}
									onToggleFilters={handleToggleFilters}
									searchText={state.searchText}
								/>
							) : null}
						</div>
					) : null}
					{useCards || useRosterRows ? (
						<DataTableContext value={dataTableContext}>
							{hideAllControls ? null : (
								<MobileControls
									cols={cols}
									sortableColIndexes={mobileSortableColIndexes}
									sortBys={state.sortBys}
									onSortChange={handleMobileSortChange}
									searchText={state.searchText}
									onSearch={(searchText) => {
										setStatePartial({ currentPage: 1, searchText });
									}}
									// The standard Controls row above already renders a search input
									// whenever it is shown, so only supply one here when it isn't —
									// otherwise the user sees two identical search boxes.
									hideSearch={!hideMenuToo}
								/>
							)}
							{useRosterRows ? (
								<RosterRows
									rows={processedRowsPage}
									cols={visibleCols}
									identityIndexes={rosterIdentityIndexes}
									controlIndexes={rosterControlIndexes}
									statIndexes={rosterStatIndexes}
									sortBys={rosterSortBys}
									onSortChange={handleRosterSort}
									renderBadge={rosterBadge}
									renderAvatar={rosterAvatar}
									// Only offer reordering when sorting is off, otherwise the
									// displayed index wouldn't match the underlying roster index and
									// a swap would move the wrong player.
									onSwap={
										sortableRows && state.sortBys === undefined
											? sortableRows.onSwap
											: undefined
									}
								/>
							) : (
								<MobileCards
									rows={processedRowsPage}
									cols={visibleCols}
									primaryIndex={cardPrimaryIndex}
									visiblePairs={mobileCardVisiblePairs}
								/>
							)}
						</DataTableContext>
					) : (
					<ResponsiveTableWrapper
						className={clsx(
							classNameWrapper,
							pagination ? "fix-margin-pagination" : null,
						)}
						nonfluid={nonfluid}
						ref={responsiveTableWrapperRef}
					>
						{sortableRows ? (
							<SortableContextWrappers
								{...sortableRows}
								renderRow={(renderRowProps) => {
									const row = renderRowProps.row;
									return (
										<Row
											key={row.key}
											row={row}
											sortableRows={renderRowProps}
										/>
									);
								}}
								rows={rows}
								tableRef={tableRef}
							>
								{table}
							</SortableContextWrappers>
						) : (
							table
						)}
					</ResponsiveTableWrapper>
					)}
					{!hideAllControls && pagination ? (
						<div className="d-flex align-items-center flex-wrap">
							<Info
								end={end}
								numRows={numRowsFiltered}
								numRowsUnfiltered={rows.length}
								start={start}
							/>
							<Pagination
								currentPage={state.currentPage}
								numRows={numRowsFiltered}
								onClick={handlePagination}
								perPage={state.perPage}
							/>
						</div>
					) : null}
					{/* Card labels already spell the columns out, so this is only for table mode */}
					{!useCards && !hideAllControls ? (
						<ColumnDefinitions cols={visibleCols} />
					) : null}
				</div>
			</div>
		</>
	);
};
