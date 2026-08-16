import { describe, expect, it } from "vitest";
import { currentOutlineRow, normalizeOutline, type RawOutlineNode } from "../../../src/domain/outlines/OutlineModel";

const destination = (pageIndex: number, x = 0, y = 100) => ({ pageIndex, x, y, pageWidth: 100, pageHeight: 100 });

describe("OutlineModel", () => {
  it("hides a single wrapper, clamps display depth, uses structural IDs, and trims titles", () => {
    const rows = normalizeOutline([{ title: "Wrapper", children: [{ title: " A ", destination: destination(0), children: [{ title: "", destination: destination(1), children: [{ title: "Deep", destination: destination(2) }] }] }] }]);
    expect(rows.map(({ id, title, depth }) => ({ id, title, depth }))).toEqual([
      { id: "0", title: "A", depth: 0 },
      { id: "0.0", title: "Untitled section", depth: 1 },
    ]);
  });

  it("preserves duplicate destinations and assigns selectors only to valid rows", () => {
    const rows = normalizeOutline([
      { title: "One", destination: destination(0) },
      { title: "Invalid", destination: { ...destination(0), y: 109 } },
      { title: "Duplicate", destination: destination(0) },
    ]);
    expect(rows.map(({ title, enabled, selector }) => ({ title, enabled, selector }))).toEqual([
      { title: "One", enabled: true, selector: "1" },
      { title: "Invalid", enabled: false, selector: undefined },
      { title: "Duplicate", enabled: true, selector: "2" },
    ]);
  });

  it("clamps only destinations within eight points and rejects invalid geometry", () => {
    const rows = normalizeOutline([
      { title: "Edge", destination: { ...destination(0), y: 108 } },
      { title: "Far", destination: { ...destination(0), y: 108.01 } },
      { title: "NaN", destination: { ...destination(0), y: Number.NaN } },
    ]);
    expect(rows[0]!.destination?.y).toBe(100);
    expect(rows.slice(1).every(({ enabled }) => !enabled)).toBe(true);
  });

  it("detects cycles and freezes output", () => {
    const cyclic: { title: string; destination: ReturnType<typeof destination>; children?: RawOutlineNode[] } = { title: "Cycle", destination: destination(0) };
    cyclic.children = [cyclic];
    const rows = normalizeOutline([cyclic]);
    expect(rows).toHaveLength(1);
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
  });

  it("selects the first duplicate current row by page then y/x ordering", () => {
    const rows = normalizeOutline([
      { title: "First", destination: destination(0, 0, 90) },
      { title: "Duplicate", destination: destination(0, 0, 90) },
      { title: "Later", destination: destination(0, 0, 20) },
    ]);
    expect(currentOutlineRow(rows, { pageIndex: 0, x: 0, y: 50 })?.title).toBe("First");
    expect(currentOutlineRow(rows, { pageIndex: 0, x: 0, y: 10 })?.title).toBe("Later");
  });
});
