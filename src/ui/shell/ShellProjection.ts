export type WindowId = string;
export type PaneId = string;
export type TabId = string;
export interface ShellTabSnapshot { readonly id: TabId; readonly title: string; readonly hasDocument: boolean }
export interface ShellPaneSnapshot { readonly id: PaneId; readonly activeTabId?: TabId; readonly tabs: readonly ShellTabSnapshot[] }
export interface WindowShellSnapshot { readonly windowId: WindowId; readonly activePaneId: PaneId; readonly panes: readonly ShellPaneSnapshot[] }
export interface ActiveShellRoute { readonly windowId: WindowId; readonly paneId: PaneId; readonly tab?: ShellTabSnapshot }
export interface ShellLandmark { readonly id: "app-shell" | "tab-strip" | "reader-main" | "reader-status"; readonly role: "application" | "tablist" | "main" | "status"; readonly label: string }
export interface EmptyReaderState { readonly testId: "empty-reader"; readonly heading: "No PDF open"; readonly description: "Open a PDF to start reading."; readonly focusTarget: "empty-reader-open" }
export type ShellProjectionResult =
  | { readonly ok: true; readonly active: ActiveShellRoute; readonly emptyState?: EmptyReaderState; readonly landmarks: readonly ShellLandmark[] }
  | { readonly ok: false; readonly code: "WINDOW_ID_INVALID" | "PANE_ID_DUPLICATE" | "TAB_ID_DUPLICATE" | "ACTIVE_PANE_MISSING" | "ACTIVE_TAB_MISSING" };
export type ShellStatusInput = { readonly disabledReason?: string; readonly pendingSequence?: string; readonly hasDocument: boolean };
export type CurrentWindowCloseIntent = { readonly type: "window.close"; readonly windowId: WindowId };

export const SHELL_LANDMARKS: readonly ShellLandmark[] = Object.freeze([
  Object.freeze({ id: "app-shell", role: "application", label: "Modeleaf PDF reader" }),
  Object.freeze({ id: "tab-strip", role: "tablist", label: "Open PDFs" }),
  Object.freeze({ id: "reader-main", role: "main", label: "PDF reader" }),
  Object.freeze({ id: "reader-status", role: "status", label: "Reader status" }),
]);
const EMPTY_READER: EmptyReaderState = Object.freeze({ testId: "empty-reader", heading: "No PDF open", description: "Open a PDF to start reading.", focusTarget: "empty-reader-open" });

export function projectWindowShell(snapshot: WindowShellSnapshot): ShellProjectionResult {
  if (snapshot.windowId.trim().length === 0) return { ok: false, code: "WINDOW_ID_INVALID" };
  const paneIds = new Set<string>();
  const tabIds = new Set<string>();
  for (const pane of snapshot.panes) {
    if (paneIds.has(pane.id)) return { ok: false, code: "PANE_ID_DUPLICATE" };
    paneIds.add(pane.id);
    for (const tab of pane.tabs) {
      if (tabIds.has(tab.id)) return { ok: false, code: "TAB_ID_DUPLICATE" };
      tabIds.add(tab.id);
    }
  }
  const pane = snapshot.panes.find(({ id }) => id === snapshot.activePaneId);
  if (pane === undefined) return { ok: false, code: "ACTIVE_PANE_MISSING" };
  const tab = pane.activeTabId === undefined ? undefined : pane.tabs.find(({ id }) => id === pane.activeTabId);
  if (pane.activeTabId !== undefined && tab === undefined) return { ok: false, code: "ACTIVE_TAB_MISSING" };
  const active = Object.freeze({ windowId: snapshot.windowId, paneId: pane.id, ...(tab === undefined ? {} : { tab }) });
  return Object.freeze({ ok: true, active, ...((tab?.hasDocument ?? false) ? {} : { emptyState: EMPTY_READER }), landmarks: SHELL_LANDMARKS });
}
export function projectShellStatus(input: ShellStatusInput): string {
  if (input.pendingSequence !== undefined && input.pendingSequence.length > 0) return `Pending: ${input.pendingSequence}`;
  if (input.disabledReason !== undefined) return input.disabledReason;
  return input.hasDocument ? "Ready" : "No document open";
}
export function currentWindowCloseIntent(windowId: WindowId): CurrentWindowCloseIntent {
  if (windowId.trim().length === 0) throw new Error("WINDOW_ID_INVALID");
  return Object.freeze({ type: "window.close", windowId });
}
