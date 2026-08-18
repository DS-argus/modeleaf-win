import type { OutlineRow } from "../../domain/outlines/OutlineModel";

/**
 * Pure geometry and view state for the floating TOC widget.
 *
 * `ux-spec.md` fixes the widget's metrics, so they live here as named
 * constants rather than as CSS magic numbers: the layout is a contract the
 * tests assert, not styling.
 */
export const TOC_MAX_WIDTH_PX = 300;
export const TOC_CONTAINER_MARGIN_PX = 24;
export const TOC_EDGE_OFFSET_PX = 12;
export const TOC_ROW_HEIGHT_PX = 20;
export const TOC_FOOTER_HEIGHT_PX = 24;
export const TOC_CHILD_INDENT_PX = 6;

export interface TocContainerSize {
  readonly width: number;
  readonly height: number;
}

export interface TocGeometry {
  readonly width: number;
  readonly height: number;
  readonly visibleRows: number;
  readonly offsetTop: number;
  readonly offsetRight: number;
}

/**
 * Computes widget geometry from the owning container.
 *
 * Height fits whole rows only: a half-visible row would make `J`/`K` scrolling
 * ambiguous. The widget never exceeds half the container height, and never
 * resizes the PDF canvas — it floats above it.
 */
export function tocGeometry(container: TocContainerSize, rowCount: number): TocGeometry {
  const width = Math.max(0, Math.min(TOC_MAX_WIDTH_PX, container.width - TOC_CONTAINER_MARGIN_PX));
  const budget = Math.max(0, Math.min(container.height / 2, rowCount * TOC_ROW_HEIGHT_PX + TOC_FOOTER_HEIGHT_PX));
  const rowBudget = Math.max(0, budget - TOC_FOOTER_HEIGHT_PX);
  const visibleRows = Math.max(0, Math.min(rowCount, Math.floor(rowBudget / TOC_ROW_HEIGHT_PX)));
  return Object.freeze({
    width,
    height: visibleRows * TOC_ROW_HEIGHT_PX + TOC_FOOTER_HEIGHT_PX,
    visibleRows,
    offsetTop: TOC_EDGE_OFFSET_PX,
    offsetRight: TOC_EDGE_OFFSET_PX,
  });
}

export interface TocScrollState {
  readonly firstVisibleRow: number;
  /** True once the user scrolls the TOC, which suppresses rerender rewinding. */
  readonly userScrolled: boolean;
}

export const INITIAL_TOC_SCROLL: TocScrollState = Object.freeze({ firstVisibleRow: 0, userScrolled: false });

/** Centers `rowIndex` in the visible window, clamped to the row range. */
export function centerRow(rowIndex: number, rowCount: number, visibleRows: number): number {
  if (visibleRows <= 0 || rowCount <= visibleRows) return 0;
  const centered = rowIndex - Math.floor((visibleRows - 1) / 2);
  return Math.max(0, Math.min(rowCount - visibleRows, centered));
}

/** Scrolls the minimum distance that brings `rowIndex` into view. */
export function revealRow(
  rowIndex: number,
  scroll: TocScrollState,
  rowCount: number,
  visibleRows: number,
): TocScrollState {
  if (visibleRows <= 0 || rowCount <= visibleRows) {
    return scroll.firstVisibleRow === 0 ? scroll : { ...scroll, firstVisibleRow: 0 };
  }
  const maximumFirst = rowCount - visibleRows;
  const current = Math.max(0, Math.min(maximumFirst, scroll.firstVisibleRow));
  if (rowIndex < current) return { ...scroll, firstVisibleRow: rowIndex };
  if (rowIndex > current + visibleRows - 1) {
    return { ...scroll, firstVisibleRow: Math.min(maximumFirst, rowIndex - visibleRows + 1) };
  }
  return current === scroll.firstVisibleRow ? scroll : { ...scroll, firstVisibleRow: current };
}

/**
 * Moves the scroll window exactly one row.
 *
 * `J`/`K` scroll the list; they do not move a selection cursor. Marking the
 * state user-scrolled stops an ordinary rerender from rewinding the position.
 */
export function scrollByRow(
  direction: 1 | -1,
  scroll: TocScrollState,
  rowCount: number,
  visibleRows: number,
): TocScrollState {
  if (visibleRows <= 0 || rowCount <= visibleRows) return { firstVisibleRow: 0, userScrolled: true };
  const maximumFirst = rowCount - visibleRows;
  const next = Math.max(0, Math.min(maximumFirst, scroll.firstVisibleRow + direction));
  return { firstVisibleRow: next, userScrolled: true };
}

export interface TocRowView {
  readonly row: OutlineRow;
  readonly rowIndex: number;
  readonly indentPx: number;
  readonly isCurrent: boolean;
}

/** Projects the visible slice, tagging the current row and child indentation. */
export function visibleTocRows(
  rows: readonly OutlineRow[],
  scroll: TocScrollState,
  visibleRows: number,
  currentRowId: string | undefined,
): readonly TocRowView[] {
  const first = Math.max(0, Math.min(Math.max(0, rows.length - visibleRows), scroll.firstVisibleRow));
  return Object.freeze(rows.slice(first, first + visibleRows).map((row, offset) => Object.freeze({
    row,
    rowIndex: first + offset,
    indentPx: row.depth * TOC_CHILD_INDENT_PX,
    isCurrent: row.id === currentRowId,
  })));
}
