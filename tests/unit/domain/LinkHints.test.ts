import { describe, expect, it } from "vitest";
import {
  appendHintInput,
  buildLinkHints,
  filterLinkHints,
  generateHintLabels,
  mergeLinks,
  type RawLink,
} from "../../../src/domain/links/LinkHints";

const link = (x: number, y: number, url = "https://example.invalid/"): RawLink => ({
  sourcePageIndex: 0,
  pageSpaceBounds: { x, y, width: 20, height: 10 },
  target: { kind: "url", url },
});

describe("LinkHints", () => {
  it("uses fixed-length prefix-free lowercase labels and rolls over deterministically", () => {
    expect(generateHintLabels(3, "ab")).toEqual(["aa", "ab", "ba"]);
    expect(generateHintLabels(0)).toEqual([]);
    expect(() => generateHintLabels(2, "aa")).toThrow();
  });

  it("orders by page/top/left and removes exact annotation duplicates only", () => {
    const exact = link(1, 100);
    const merged = mergeLinks([
      link(2, 100),
      exact,
      { ...exact, pageSpaceBounds: { ...exact.pageSpaceBounds } },
      link(1, 100, "https://example.invalid/other"),
      link(1, 99),
    ]);
    expect(merged).toHaveLength(4);
    expect(merged.map((entry) => entry.primaryLabelRect.y)).toEqual([100, 100, 100, 99]);
    expect(merged.filter((entry) => entry.primaryLabelRect.x === 1 && entry.primaryLabelRect.y === 100)).toHaveLength(2);
  });

  it("preserves adjacent and same-destination annotations", () => {
    expect(mergeLinks([link(0, 10), link(20, 10), link(0, 9)])).toHaveLength(3);
  });

  it("filters by lowercase prefix and selects exact unique labels", () => {
    const hints = buildLinkHints([link(0, 10), link(20, 10)]);
    expect(filterLinkHints(hints, hints[0]!.label).selected).toBe(hints[0]);
    expect(filterLinkHints(hints, "A").matches).toEqual([]);
  });

  it("rejects modified, composing, uppercase, dead, and non-letter input", () => {
    expect(appendHintInput("a", { key: "b" })).toBe("ab");
    for (const input of [
      { key: "b", ctrlKey: true },
      { key: "b", shiftKey: true },
      { key: "B" },
      { key: "Dead" },
      { key: "b", isComposing: true },
    ]) expect(appendHintInput("a", input)).toBeNull();
  });
});
