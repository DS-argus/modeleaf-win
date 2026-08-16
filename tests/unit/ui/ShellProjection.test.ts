import { describe, expect, it } from "vitest";
import { currentWindowCloseIntent, projectShellStatus, projectWindowShell } from "../../../src/ui/shell/ShellProjection";

describe("ShellProjection", () => {
  it("projects a semantic empty reader with stable landmarks", () => {
    const result = projectWindowShell({ windowId: "window-a", activePaneId: "pane-a", panes: [{ id: "pane-a", tabs: [] }] });
    expect(result).toMatchObject({ ok: true, emptyState: { heading: "No PDF open", focusTarget: "empty-reader-open" } });
    if (result.ok) expect(result.landmarks.map(({ id }) => id)).toEqual(["app-shell", "tab-strip", "reader-main", "reader-status"]);
  });
  it("projects only the owning window active pane and tab", () => {
    const result = projectWindowShell({ windowId: "window-a", activePaneId: "pane-b", panes: [
      { id: "pane-a", activeTabId: "tab-a", tabs: [{ id: "tab-a", title: "A", hasDocument: true }] },
      { id: "pane-b", activeTabId: "tab-b", tabs: [{ id: "tab-b", title: "B", hasDocument: true }] },
    ] });
    expect(result).toMatchObject({ ok: true, active: { windowId: "window-a", paneId: "pane-b", tab: { id: "tab-b" } } });
  });
  it("fails closed for stale and cross-pane identities", () => {
    expect(projectWindowShell({ windowId: "window-a", activePaneId: "missing", panes: [] })).toEqual({ ok: false, code: "ACTIVE_PANE_MISSING" });
    expect(projectWindowShell({ windowId: "window-a", activePaneId: "pane-a", panes: [{ id: "pane-a", activeTabId: "foreign", tabs: [] }] })).toEqual({ ok: false, code: "ACTIVE_TAB_MISSING" });
    expect(projectWindowShell({ windowId: "window-a", activePaneId: "a", panes: [{ id: "a", tabs: [{ id: "same", title: "A", hasDocument: true }] }, { id: "b", tabs: [{ id: "same", title: "B", hasDocument: true }] }] })).toEqual({ ok: false, code: "TAB_ID_DUPLICATE" });
  });
  it("uses current-window close intent rather than application quit", () => {
    expect(currentWindowCloseIntent("window-a")).toEqual({ type: "window.close", windowId: "window-a" });
    expect(currentWindowCloseIntent("window-b")).not.toEqual(currentWindowCloseIntent("window-a"));
  });
  it("prioritizes pending and disabled status over ready state", () => {
    expect(projectShellStatus({ hasDocument: true, pendingSequence: "g" })).toBe("Pending: g");
    expect(projectShellStatus({ hasDocument: true, disabledReason: "No back history" })).toBe("No back history");
    expect(projectShellStatus({ hasDocument: false })).toBe("No document open");
  });
});
