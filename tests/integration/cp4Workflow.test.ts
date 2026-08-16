import { describe, expect, it } from "vitest";
import { MAX_TAB_COUNT, TabWorkspace } from "../../src/core/TabWorkspace";
import { buildCommandPaletteEntries } from "../../src/ui/CommandPaletteModel";

describe("CP4 workspace workflow", () => {
  it("keeps ordered tabs bounded and restores the right neighbor after close", () => {
    const disposed: number[] = []; const workspace = new TabWorkspace(() => 0);
    const first = workspace.activeTabId; const second = workspace.appendAndActivate(2, { dispose: (value) => disposed.push(value) }); const third = workspace.appendAndActivate(3, { dispose: (value) => disposed.push(value) });
    expect(second).not.toBeNull(); expect(third).not.toBeNull();
    workspace.activate(first); workspace.close(first); expect(workspace.activeTabId).toBe(second);
    workspace.close(second!); expect(disposed).toEqual([2]);
    while (workspace.snapshot.tabs.length < MAX_TAB_COUNT) workspace.appendAndActivate(0);
    expect(workspace.appendAndActivate(0)).toBeNull();
  });

  it("keeps staged adoption rollback isolated and exposes opaque recent entries", () => {
    const workspace = new TabWorkspace(() => "empty"); const original = workspace.activeTabId;
    const staged = workspace.stageAdoption("candidate"); workspace.rollbackAdoption(staged!);
    expect(workspace.activeTabId).toBe(original); expect(workspace.snapshot.tabs).toHaveLength(1);
    expect(buildCommandPaletteEntries(undefined, [{ recentId: "opaque-id", displayName: "report.pdf" }], "report.pdf")).toContainEqual(expect.objectContaining({ kind: "recent", recentId: "opaque-id" }));
  });
});
