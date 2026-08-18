import { describe, expect, it } from "vitest";
import {
  centerRow,
  INITIAL_TOC_SCROLL,
  revealRow,
  scrollByRow,
  tocGeometry,
  visibleTocRows,
  TOC_CHILD_INDENT_PX,
  TOC_FOOTER_HEIGHT_PX,
  TOC_MAX_WIDTH_PX,
  TOC_ROW_HEIGHT_PX,
} from "../../../src/ui/reader/TocWidgetModel";
import type { OutlineRow } from "../../../src/domain/outlines/OutlineModel";

const row = (id: string, depth: 0 | 1, enabled = true): OutlineRow => Object.freeze({
  id,
  title: `Row ${id}`,
  depth,
  enabled,
  ...(enabled ? { selector: id, destination: { pageIndex: 0, x: 0, y: 0 } } : {}),
});

const rows = (count: number): readonly OutlineRow[] =>
  Array.from({ length: count }, (_, index) => row(String(index + 1), 0));

describe("TOC geometry", () => {
  it("caps width at the maximum and otherwise insets from the container", () => {
    expect(tocGeometry({ width: 1000, height: 800 }, 5).width).toBe(TOC_MAX_WIDTH_PX);
    // Narrow container: width is container minus the 24px margin.
    expect(tocGeometry({ width: 200, height: 800 }, 5).width).toBe(176);
  });

  it("never exceeds half the container height", () => {
    // 40 rows would want 824px, but half of 400 is the ceiling.
    const geometry = tocGeometry({ width: 1000, height: 400 }, 40);
    expect(geometry.height).toBeLessThanOrEqual(200);
    expect(geometry.visibleRows).toBe(Math.floor((200 - TOC_FOOTER_HEIGHT_PX) / TOC_ROW_HEIGHT_PX));
  });

  it("fits whole rows only, so no row is half visible", () => {
    // A half-visible row would make single-row scrolling ambiguous.
    const geometry = tocGeometry({ width: 1000, height: 411 }, 40);
    expect((geometry.height - TOC_FOOTER_HEIGHT_PX) % TOC_ROW_HEIGHT_PX).toBe(0);
  });

  it("shrinks to content when the outline is shorter than the budget", () => {
    const geometry = tocGeometry({ width: 1000, height: 2000 }, 3);
    expect(geometry.visibleRows).toBe(3);
    expect(geometry.height).toBe(3 * TOC_ROW_HEIGHT_PX + TOC_FOOTER_HEIGHT_PX);
  });

  it("degrades safely in a container too small to show any row", () => {
    const geometry = tocGeometry({ width: 40, height: 30 }, 10);
    expect(geometry.visibleRows).toBe(0);
    expect(geometry.width).toBeGreaterThanOrEqual(0);
  });

  it("floats at the top-right inset without resizing the canvas", () => {
    const geometry = tocGeometry({ width: 1000, height: 800 }, 5);
    expect(geometry).toMatchObject({ offsetTop: 12, offsetRight: 12 });
  });
});

describe("TOC scrolling", () => {
  it("centers the current row when opening a long outline", () => {
    // 5 visible of 20: row 10 centers at first-visible 8.
    expect(centerRow(10, 20, 5)).toBe(8);
  });

  it("clamps centering at both ends", () => {
    expect(centerRow(0, 20, 5)).toBe(0);
    expect(centerRow(19, 20, 5)).toBe(15);
  });

  it("does not scroll when every row already fits", () => {
    expect(centerRow(3, 4, 10)).toBe(0);
  });

  it("moves exactly one row per J or K", () => {
    const start = { firstVisibleRow: 5, userScrolled: false };
    expect(scrollByRow(1, start, 20, 5).firstVisibleRow).toBe(6);
    expect(scrollByRow(-1, start, 20, 5).firstVisibleRow).toBe(4);
  });

  it("stops at the ends instead of wrapping", () => {
    expect(scrollByRow(-1, { firstVisibleRow: 0, userScrolled: false }, 20, 5).firstVisibleRow).toBe(0);
    expect(scrollByRow(1, { firstVisibleRow: 15, userScrolled: false }, 20, 5).firstVisibleRow).toBe(15);
  });

  it("marks the state user-scrolled so rerender cannot rewind it", () => {
    expect(scrollByRow(1, INITIAL_TOC_SCROLL, 20, 5).userScrolled).toBe(true);
  });

  it("reveals an off-window row by the minimum distance", () => {
    const scroll = { firstVisibleRow: 10, userScrolled: true };
    // Above the window: it becomes the first visible row.
    expect(revealRow(3, scroll, 30, 5).firstVisibleRow).toBe(3);
    // Below the window: it becomes the last visible row.
    expect(revealRow(20, scroll, 30, 5).firstVisibleRow).toBe(16);
  });

  it("leaves scroll untouched when the row is already visible", () => {
    const scroll = { firstVisibleRow: 10, userScrolled: true };
    expect(revealRow(12, scroll, 30, 5)).toBe(scroll);
  });
});

describe("TOC row projection", () => {
  it("projects only the visible slice", () => {
    const view = visibleTocRows(rows(20), { firstVisibleRow: 5, userScrolled: true }, 4, undefined);
    expect(view.map((entry) => entry.row.id)).toEqual(["6", "7", "8", "9"]);
    expect(view.map((entry) => entry.rowIndex)).toEqual([5, 6, 7, 8]);
  });

  it("indents child rows by exactly six pixels", () => {
    const view = visibleTocRows([row("1", 0), row("2", 1)], INITIAL_TOC_SCROLL, 2, undefined);
    expect(view.map((entry) => entry.indentPx)).toEqual([0, TOC_CHILD_INDENT_PX]);
  });

  it("tags the current row by stable id", () => {
    const view = visibleTocRows(rows(5), INITIAL_TOC_SCROLL, 5, "3");
    expect(view.filter((entry) => entry.isCurrent).map((entry) => entry.row.id)).toEqual(["3"]);
  });

  it("clamps an out-of-range scroll offset instead of projecting nothing", () => {
    // Defends against a stale offset after the outline shrinks.
    const view = visibleTocRows(rows(6), { firstVisibleRow: 99, userScrolled: true }, 3, undefined);
    expect(view.map((entry) => entry.row.id)).toEqual(["4", "5", "6"]);
  });

  it("keeps disabled rows visible in the projection", () => {
    // Invalid destinations stay in the hierarchy, disabled and selector-less.
    const view = visibleTocRows([row("1", 0), row("x", 1, false)], INITIAL_TOC_SCROLL, 2, undefined);
    expect(view).toHaveLength(2);
    expect(view[1]?.row.enabled).toBe(false);
    expect(view[1]?.row.selector).toBeUndefined();
  });
});
