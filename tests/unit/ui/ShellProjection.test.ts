import { describe, expect, it } from "vitest";
import { currentWindowCloseIntent, projectShellStatus, projectWindowShell } from "../../../src/ui/shell/ShellProjection";

describe("ShellProjection", () => {
  it("projects a semantic empty reader with stable landmarks", () => {
    const result = projectWindowShell({ windowId: "window-a", tabs: [] });
    expect(result).toMatchObject({ ok: true, emptyState: { heading: "No PDF open", focusTarget: "empty-reader-open" } });
    if (result.ok) expect(result.landmarks.map(({ id }) => id)).toEqual(["app-shell", "tab-strip", "reader-main", "reader-status"]);
  });
  it("projects the owning window active tab", () => {
    const result = projectWindowShell({ windowId: "window-a", activeTabId: "tab-b", tabs: [
      { id: "tab-a", title: "A", hasDocument: true },
      { id: "tab-b", title: "B", hasDocument: true },
    ] });
    expect(result).toMatchObject({ ok: true, active: { windowId: "window-a", tab: { id: "tab-b" } } });
  });
  it("projects an empty state when the active tab has no document", () => {
    const result = projectWindowShell({ windowId: "window-a", activeTabId: "tab-a", tabs: [{ id: "tab-a", title: "A", hasDocument: false }] });
    expect(result).toMatchObject({ ok: true, emptyState: { heading: "No PDF open" } });
  });
  it("fails closed for stale and duplicate tab identities", () => {
    expect(projectWindowShell({ windowId: "window-a", activeTabId: "foreign", tabs: [] })).toEqual({ ok: false, code: "ACTIVE_TAB_MISSING" });
    expect(projectWindowShell({ windowId: "window-a", tabs: [{ id: "same", title: "A", hasDocument: true }, { id: "same", title: "B", hasDocument: true }] })).toEqual({ ok: false, code: "TAB_ID_DUPLICATE" });
    expect(projectWindowShell({ windowId: "   ", tabs: [] })).toEqual({ ok: false, code: "WINDOW_ID_INVALID" });
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
