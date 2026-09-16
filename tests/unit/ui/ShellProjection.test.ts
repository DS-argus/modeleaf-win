import { describe, expect, it } from "vitest";
import { currentWindowCloseIntent, projectShellStatus, projectWindowShell } from "../../../src/ui/shell/ShellProjection";

describe("ShellProjection", () => {
  it.each(["Page 1 of 233 · 0°", "Page 2 of 233 · 90°", "Page 3 of 233 · Custom 125.25% · 180°", "Page 4 of 233 · Custom 800% · 270°"])("suppresses only routine page prose: %s", (status) => {
    expect(projectShellStatus({ hasDocument: true, zoomMode: "custom", searchPromptOpen: false, query: "", status }).message).toBe("");
  });
  it.each(["Page 1 of 233 failed", "Could not render · 90°", "Searching…", "Page 1 of 233 · 0°: error"])("retains diagnostic prose: %s", (status) => {
    expect(projectShellStatus({ hasDocument: true, zoomMode: "fit-page", searchPromptOpen: false, query: "", status }).message).toBe(status);
  });
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
  it.each([
    [false, "fit-page", true, "query", false, false, false],
    [false, "fit-width", true, "query", false, false, false],
    [true, "fit-width", true, "", false, true, true],
    [true, "custom", false, "query", false, false, true],
    [true, "fit-page", false, "query", true, false, true],
    [true, "fit-page", false, "", true, false, false],
    [true, "fit-width", false, "", false, true, false],
    [true, "custom", false, "", false, false, false],
  ] as const)("projects typed modes (%s, %s, %s, %s)", (hasDocument, zoomMode, searchPromptOpen, query, fitPage, fitWidth, search) => {
    expect(projectShellStatus({ hasDocument, zoomMode, searchPromptOpen, query, status: "Searching · Fit page · Fit width", pendingSequence: "g" })).toEqual({
      message: "Searching · Fit page · Fit width", pending: "Pending: g", fitPage, fitWidth, search,
    });
  });
  it.each(["Searching…", "No matches", "No searchable text", "Search results are partial: TEXT_LIMIT", "Search failed"])("retains applied search independently of diagnostics: %s", (status) => {
    expect(projectShellStatus({ hasDocument: true, zoomMode: "fit-width", searchPromptOpen: false, query: "needle", status })).toEqual({ message: status, pending: "", fitPage: false, fitWidth: true, search: true });
  });
});
