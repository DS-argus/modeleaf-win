import { describe, expect, it } from "vitest";
import { MAX_RECENT_FILES, adoptRecentSnapshot, filterRecentFiles, type RecentFile } from "../../../src/domain/recent/RecentFiles";

const file = (index: number, displayName = `${index}.pdf`, displayPath = `C:\\Recent\\${displayName}`): RecentFile => ({
  recentId: `recent-${index.toString(16).padStart(32, "0")}`,
  displayName,
  displayPath,
});

describe("RecentFiles", () => {
  it("adopts only monotonic full snapshots and preserves display-only paths", () => {
    const displayPath = "C:\\자료\\résumé.pdf";
    const first = adoptRecentSnapshot(undefined, { revision: "1", entries: [file(1, "résumé.pdf", displayPath)] });
    expect(first.entries[0]).toEqual({ recentId: file(1).recentId, displayName: "résumé.pdf", displayPath });
    expect(first.entries[0]!.displayPath).toBe(displayPath);
    expect(first.entries[0]).not.toHaveProperty("path");

    const stale = adoptRecentSnapshot(first, { revision: "0", entries: [file(2)] });
    expect(stale).toBe(first);
  });

  it("caps snapshots at the native product limit", () => {
    const entries = Array.from({ length: MAX_RECENT_FILES + 4 }, (_, index) => file(index));
    expect(adoptRecentSnapshot(undefined, { revision: "1", entries }).entries).toHaveLength(MAX_RECENT_FILES);
  });

  it("filters and ranks by filename only while preserving native paths and order", () => {
    const entries = [
      file(1, "모드리프.pdf", "C:\\한국\\모드리프.pdf"),
      file(2, "mode-leaf-notes.pdf", "D:\\notes\\mode-leaf-notes.pdf"),
      file(3, "other.pdf", "E:\\directory-only-needle\\other.pdf"),
    ];
    expect(filterRecentFiles(entries, "").map(({ recentId }) => recentId)).toEqual(entries.map(({ recentId }) => recentId));

    const matches = filterRecentFiles(entries, "mdlf");
    expect(matches.map(({ displayName }) => displayName)).toEqual(["mode-leaf-notes.pdf"]);
    expect(matches[0]!.displayPath).toBe(entries[1]!.displayPath);
    expect(matches[0]!.matchedIndices).toEqual([0, 2, 5, 8]);
    expect(matches[0]).not.toHaveProperty("path");
    expect(filterRecentFiles(entries, "directory-only-needle")).toEqual([]);
    expect(filterRecentFiles(entries, "모드")[0]).toMatchObject({ recentId: file(1).recentId, matchedIndices: [0, 1] });
  });
});
