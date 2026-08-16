import { describe, expect, it } from "vitest";
import { filterCommandPalette, MAX_PALETTE_ROWS, type PaletteEntry } from "../../../src/domain/actions/CommandPalette";

const entry = (id: string, title: string, enabled = true, recency?: number): PaletteEntry => ({
  id, title, enabled, kind: id.startsWith("recent") ? "recent" : "action", ...(recency === undefined ? {} : { recency }),
});

describe("CommandPalette", () => {
  it("orders enabled entries before disabled entries even when disabled matches better", () => {
    const rows = filterCommandPalette([
      { ...entry("disabled", "open"), enabled: false, disabledReason: "No document" },
      entry("enabled", "open document"),
    ], "open");
    expect(rows.map(({ id }) => id)).toEqual(["enabled", "disabled"]);
    expect(rows[1]!.disabledReason).toBe("No document");
  });

  it("orders exact, prefix, substring, then fuzzy with stable ties", () => {
    const rows = filterCommandPalette([
      entry("fuzzy", "open document"),
      entry("exact", "od"),
      entry("substring", "mode reader"),
      entry("prefix", "odyssey"),
    ], "od");
    expect(rows.map(({ id }) => id)).toEqual(["exact", "prefix", "substring", "fuzzy"]);
  });

  it("preserves caller-provided recent order after match quality without paths", () => {
    const rows = filterCommandPalette([entry("recent-new", "보고서.pdf", true, 2), entry("recent-old", "보고서.pdf", true, 1)], "보고");
    expect(rows.map(({ id }) => id)).toEqual(["recent-new", "recent-old"]);
    expect(rows.every((row) => !("path" in row))).toBe(true);
  });

  it("preserves input/registry order for empty queries and equal scores", () => {
    const rows = filterCommandPalette([entry("z", "Zulu"), entry("a", "Alpha"), entry("m", "Mike")], "");
    expect(rows.map(({ id }) => id)).toEqual(["z", "a", "m"]);
  });
  it("normalizes Unicode and limits output to twelve rows", () => {
    const entries = Array.from({ length: 20 }, (_, index) => entry(String(index).padStart(2, "0"), `café ${index}`));
    expect(filterCommandPalette(entries, "cafe\u0301")).toHaveLength(MAX_PALETTE_ROWS);
  });
});
