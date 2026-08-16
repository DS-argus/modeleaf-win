import { describe, expect, it } from "vitest";
import { MAX_RECENT_FILES, filterRecentFiles, recordSuccessfulPdfOpen, shouldPruneRecent, type RecentFile } from "../../../src/domain/recent/RecentFiles";

const file = (index: number, filename = `${index}.pdf`): RecentFile => ({ id: String(index), path: `C:\\files\\${filename}`, filename, openedAt: index });

describe("RecentFiles", () => {
  it("admits only authoritative PDF paths and moves exact path identity to the front", () => {
    expect(recordSuccessfulPdfOpen([], file(1, "ONE.PDF")).ok).toBe(true);
    expect(recordSuccessfulPdfOpen([], file(1, "one.txt"))).toEqual({ ok: false, error: "RECENT_NOT_PDF" });
    expect(recordSuccessfulPdfOpen([], { ...file(1), filename: "fake.pdf" })).toEqual({ ok: false, error: "RECENT_FILENAME_MISMATCH" });
    const result = recordSuccessfulPdfOpen([file(1), file(2)], { ...file(1), openedAt: 9 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries.map(({ path }) => path)).toEqual(["C:\\files\\1.pdf", "C:\\files\\2.pdf"]);
  });

  it("evicts only the oldest entry on the sixteenth distinct success", () => {
    const entries = Array.from({ length: MAX_RECENT_FILES }, (_, index) => file(index)).reverse();
    const result = recordSuccessfulPdfOpen(entries, file(16));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(15);
      expect(result.entries[0]!.id).toBe("16");
      expect(result.entries.some(({ id }) => id === "0")).toBe(false);
    }
  });

  it("prunes only missing/path-not-found failures", () => {
    expect(shouldPruneRecent("missing")).toBe(true);
    expect(shouldPruneRecent("path-not-found")).toBe(true);
    expect(shouldPruneRecent("permission")).toBe(false);
    expect(shouldPruneRecent("transient")).toBe(false);
    expect(shouldPruneRecent("invalid-pdf")).toBe(false);
  });

  it("preserves input order for empty filters and returns Unicode code-point match indices without paths", () => {
    const entries = [file(1, "모드리프.pdf"), file(2, "mode-leaf-notes.pdf"), file(3, "other.pdf")];
    expect(filterRecentFiles(entries, "").map(({ id }) => id)).toEqual(["1", "2", "3"]);
    const matches = filterRecentFiles(entries, "mdlf");
    expect(matches.map(({ filename }) => filename)).toEqual(["mode-leaf-notes.pdf"]);
    expect(matches[0]!.matchedIndices).toEqual([0, 2, 5, 8]);
    expect(matches[0]).not.toHaveProperty("path");
    expect(filterRecentFiles(entries, "모드")[0]).toMatchObject({ id: "1", matchedIndices: [0, 1] });
  });
});
