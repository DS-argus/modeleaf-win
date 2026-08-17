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
    expect(generateHintLabels(3)).toEqual(["f", "j", "d"]);
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

  it("filters case-insensitively and commits the sole prefix candidate", () => {
    const hints = buildLinkHints(Array.from({ length: 27 }, (_, index) => link(index * 20, 10)));
    expect(filterLinkHints(hints, "J").selected).toBe(hints[26]);
    expect(filterLinkHints(hints, "1").matches).toEqual([]);
  });

  it("accepts Shift and Caps letters while rejecting owned or invalid input", () => {
    expect(appendHintInput("a", { key: "b" })).toBe("ab");
    expect(appendHintInput("a", { key: "B", shiftKey: true })).toBe("ab");
    expect(appendHintInput("A", { key: "B" })).toBe("ab");
    for (const input of [
      { key: "b", ctrlKey: true },
      { key: "b", altGraph: true },
      { key: "b", keyCode: 229 },
      { key: "Dead" },
      { key: "Process" },
      { key: "Unidentified" },
      { key: "b", isComposing: true },
      { key: "1" },
    ]) expect(appendHintInput("a", input)).toBeNull();
  });
});
