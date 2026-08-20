import { describe, expect, it } from "vitest";
import { MAX_RECENT_FILES, adoptRecentSnapshot, filterRecentFiles, type RecentFile } from "../../../src/domain/recent/RecentFiles";

const file = (index: number, displayName = `${index}.pdf`): RecentFile => ({ recentId: `recent-${index.toString(16).padStart(32, "0")}`, displayName });

describe("RecentFiles", () => {
  it("adopts only monotonic full snapshots and remains path-free", () => {
    const first = adoptRecentSnapshot(undefined, { revision: "1", entries: [file(1, "résumé.pdf")] });
    expect(first.entries[0]).toEqual({ recentId: file(1).recentId, displayName: "résumé.pdf" });
    expect(first.entries[0]).not.toHaveProperty("path");
    const stale = adoptRecentSnapshot(first, { revision: "0", entries: [file(2)] });
    expect(stale).toBe(first);
  });

  it("caps snapshots at the native product limit", () => {
    const entries = Array.from({ length: MAX_RECENT_FILES + 4 }, (_, index) => file(index));
    expect(adoptRecentSnapshot(undefined, { revision: "1", entries }).entries).toHaveLength(MAX_RECENT_FILES);
  });

  it("preserves native order for empty filters and returns Unicode code-point indices", () => {
    const entries = [file(1, "모드리프.pdf"), file(2, "mode-leaf-notes.pdf"), file(3, "other.pdf")];
    expect(filterRecentFiles(entries, "").map(({ recentId }) => recentId)).toEqual(entries.map(({ recentId }) => recentId));
    const matches = filterRecentFiles(entries, "mdlf");
    expect(matches.map(({ displayName }) => displayName)).toEqual(["mode-leaf-notes.pdf"]);
    expect(matches[0]!.matchedIndices).toEqual([0, 2, 5, 8]);
    expect(matches[0]).not.toHaveProperty("path");
    expect(filterRecentFiles(entries, "모드")[0]).toMatchObject({ recentId: file(1).recentId, matchedIndices: [0, 1] });
  });
});
