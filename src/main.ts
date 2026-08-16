import "./styles/app.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnnotationMode, getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { KeySequenceEngine, type SequenceResult } from "./core/KeySequenceEngine";
import { TabWorkspace, type TabId } from "./core/TabWorkspace";
import { DEFAULT_BINDINGS, isCommandEnabled, resolvePaletteBindingAction, type CommandAvailabilityContext } from "./core/defaultBindings.windows";
import type { Action } from "./core/Action";
import { createKeyboardAdapter, isNativeKeyboardCompositionOrModifierEvent, isNativeOwnedTarget, type KeyboardAdapter } from "./platform/keyboardAdapter";
import { wheelPageDirection } from "./platform/readerInput";
import { type OpenFailureNotice, type OpenRequestAdoption } from "./platform/OpenRequestClient";
import { buildCommandPaletteEntries, commandPaletteKeyAction, isPaletteClearShortcut, moveCommandPaletteIndex, type CommandPaletteCommandEntry, type RecentPaletteRecord } from "./ui/CommandPaletteModel";
import { bindSearchPrompt } from "./ui/SearchPromptController";
import { buildHelpRows } from "./ui/HelpModel";
import { createRemovedTabTeardownSupervisor, createShellOpenCoordinator, createWorkspaceTransitionQueue } from "./platform/ShellOpenCoordinator";
import { PDFJS_POLICY } from "./pdf/PdfJsPolicy";
import { DEFAULT_THEME_ID, THEME_TOKENS, adoptDurableThemeState, isThemeId, themeForId, type DurableThemeState, type ThemeId } from "./core/Theme";
import { CLOSED_THEME_PICKER, THEME_PICKER_ROWS, commitThemePicker, openThemePicker as createThemePicker, previewThemePickerRow, revertThemePicker, revertThemePickerToDurable, themePickerDialogKeyAction, type ThemePickerModel, type ThemePickerOpenModel } from "./ui/ThemePickerModel";
import { AccessibilityController, focusRestoreTarget, readerAccessibilityName, tabAccessibilitySemantics } from "./ui/AccessibilityController";
import { PdfTabSession, publishActivateAndAdoptPdfTab } from "./pdf/PdfTabSession";
import type { PdfLoadingTask } from "./pdf/PdfReaderController";
import { ResourceReservationManager } from "./pdf/ResourceBudget";

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing required element: ${selector}`);
  return value;
}

const root = required<HTMLElement>("#app");
root.innerHTML = `
<section class="app-shell" role="application" aria-label="Modeleaf PDF reader">
  <div id="tab-strip" class="tab-strip" role="tablist" aria-label="Open documents"></div>
  <section id="tab-hosts" class="tab-hosts"></section>
  <section id="prompt" class="prompt" hidden></section>
  <dialog id="theme-dialog" class="mac-overlay theme-overlay" aria-labelledby="theme-title"><form id="theme-form"><h2 id="theme-title">Theme</h2><p id="theme-description" class="visually-hidden">Arrow keys or Control J and K preview a theme. Enter saves it. Escape restores the previous theme.</p><div id="theme-list" class="theme-list" role="radiogroup" aria-describedby="theme-description"></div><menu class="visually-hidden"><button id="theme-cancel" type="button">Cancel</button><button id="theme-apply" type="submit">Apply theme</button></menu></form></dialog>
  <dialog id="help-dialog" class="mac-overlay help-overlay" aria-label="Keyboard shortcuts"><div id="help-rows" class="help-groups"></div></dialog>
  <dialog id="password-dialog" aria-labelledby="password-title"><form method="dialog" autocomplete="off"><h2 id="password-title">PDF password required</h2><label>Password <input id="password-input" type="password" autocomplete="off" data-form-type="other" spellcheck="false"></label><menu><button id="password-cancel" type="button" value="cancel">Cancel</button><button type="submit" value="submit">Open</button></menu></form></dialog>
  <dialog id="search-dialog" aria-labelledby="search-title"><form id="search-form" autocomplete="off"><h2 id="search-title">Search PDF text</h2><label>Literal text <input id="search-input" type="search" spellcheck="false"></label><p class="dialog-hint">Press <kbd>Enter</kbd> or <kbd>Shift</kbd>+<kbd>Enter</kbd> to cycle matches.</p></form></dialog>
  <dialog id="file-opener-dialog" class="mac-overlay list-overlay" aria-label="Open PDF"><form id="file-opener-form"><input id="file-opener-input" type="search" autocomplete="off" spellcheck="false" placeholder="Type to search..." aria-label="Filter recent PDFs"><ul id="file-opener-list" class="overlay-list"></ul><p class="overlay-footer"><kbd>Ctrl+J/K</kbd> move · <kbd>Ctrl+Shift+C</kbd> clear · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close</p></form></dialog>
  <dialog id="command-palette-dialog" class="mac-overlay list-overlay" aria-label="Command palette"><form id="command-palette-form"><input id="palette-input" type="search" autocomplete="off" spellcheck="false" placeholder="Type a command..." aria-label="Filter commands"><ul id="palette-list" class="overlay-list command-palette-list"></ul></form></dialog>
  <footer id="status" class="statusbar" role="status" aria-live="polite" aria-atomic="true"></footer>
  <div id="announcements-polite" class="visually-hidden" aria-live="polite" aria-atomic="true"></div>
  <div id="announcements-assertive" class="visually-hidden" aria-live="assertive" aria-atomic="true"></div>
</section>`;

const tabStrip = required<HTMLElement>("#tab-strip");
const tabHosts = required<HTMLElement>("#tab-hosts");
const status = required<HTMLElement>("#status");
const prompt = required<HTMLElement>("#prompt");
const helpDialog = required<HTMLDialogElement>("#help-dialog");
const helpRows = required<HTMLElement>("#help-rows");
const passwordDialog = required<HTMLDialogElement>("#password-dialog");
const passwordInput = required<HTMLInputElement>("#password-input");
const passwordCancel = required<HTMLButtonElement>("#password-cancel");
const searchDialog = required<HTMLDialogElement>("#search-dialog");
const searchForm = required<HTMLFormElement>("#search-form");
const searchInput = required<HTMLInputElement>("#search-input");
const fileOpenerDialog = required<HTMLDialogElement>("#file-opener-dialog");
const fileOpenerForm = required<HTMLFormElement>("#file-opener-form");
const fileOpenerInput = required<HTMLInputElement>("#file-opener-input");
const fileOpenerList = required<HTMLElement>("#file-opener-list");
const paletteDialog = required<HTMLDialogElement>("#command-palette-dialog");
const paletteInput = required<HTMLInputElement>("#palette-input");
const paletteList = required<HTMLElement>("#palette-list");
GlobalWorkerOptions.workerSrc = PDFJS_POLICY.assets.workerSrc;
const paletteForm = required<HTMLFormElement>("#command-palette-form");
const themeDialog = required<HTMLDialogElement>("#theme-dialog");
const themeForm = required<HTMLFormElement>("#theme-form");
const themeList = required<HTMLElement>("#theme-list");
const themeCancel = required<HTMLButtonElement>("#theme-cancel");
const politeAnnouncements = required<HTMLElement>("#announcements-polite");
const assertiveAnnouncements = required<HTMLElement>("#announcements-assertive");
const accessibility = new AccessibilityController({ target: { polite: politeAnnouncements, assertive: assertiveAnnouncements } });

let durableTheme: DurableThemeState = { themeId: DEFAULT_THEME_ID, revision: 0 };
let themePicker: ThemePickerModel = CLOSED_THEME_PICKER;
let themeRestoreFocus: HTMLElement | null = null;

function isDurableThemeState(value: unknown): value is DurableThemeState {
  return typeof value === "object" && value !== null && "themeId" in value && "revision" in value
    && typeof value.themeId === "string" && isThemeId(value.themeId)
    && typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0;
}
function adoptDurableTheme(candidate: DurableThemeState): boolean {
  const previous = durableTheme;
  const accepted = candidate.revision > previous.revision
    || (candidate.revision === previous.revision && candidate.themeId === previous.themeId);
  if (!accepted) return false;
  durableTheme = adoptDurableThemeState(previous, candidate);
  return true;
}
function applyTheme(themeId: ThemeId): void {
  const palette = themeForId(themeId).palette;
  for (const token of THEME_TOKENS) root.style.setProperty(`--theme-${token}`, palette[token]);
  root.dataset.theme = themeId;
}
function activeThemePicker(): ThemePickerOpenModel | null {
  return themePicker.status === "open" ? themePicker : null;
}
function restoreThemeFocus(): void {
  const activeTab = tabStrip.querySelector<HTMLElement>("[role='tab'][aria-selected='true']");
  const reader = activeTab ? active().host : null;
  focusRestoreTarget(themeRestoreFocus, activeTab, reader)?.focus();
  themeRestoreFocus = null;
}
function renderThemePicker(): void {
  const picker = activeThemePicker();
  if (!picker) return;
  themeList.replaceChildren(...THEME_PICKER_ROWS.map((row, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-option";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(row.id === picker.transaction.previewId));
    button.tabIndex = index === picker.activeIndex ? 0 : -1;
    button.textContent = row.displayName;
    button.addEventListener("click", () => previewTheme(index));
    return button;
  }));
}
function previewTheme(index: number): void {
  const picker = activeThemePicker();
  if (!picker) return;
  const result = previewThemePickerRow(picker, index);
  themePicker = result.model;
  applyTheme(result.effect.themeId);
  accessibility.announce({ kind: "theme", themeId: result.effect.themeId });
  renderThemePicker();
  themeList.querySelectorAll<HTMLButtonElement>(".theme-option")[result.model.activeIndex]?.focus();
}
function openThemePicker(): void {
  themeRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : active().host;
  themePicker = createThemePicker(durableTheme.themeId, durableTheme.revision);
  renderThemePicker();
  themeDialog.showModal();
  themeList.querySelector<HTMLButtonElement>(".theme-option[tabindex='0']")?.focus();
}
function closeThemePicker(revert: boolean): void {
  const picker = activeThemePicker();
  if (picker && revert) {
    const result = revertThemePicker(picker);
    themePicker = result.model;
    applyTheme(result.effect.themeId);
  }
  themeDialog.close();
  restoreThemeFocus();
}
async function restoreDurableThemeAfterFailure(picker: ThemePickerOpenModel): Promise<void> {
  try {
    const response: unknown = await invoke("read_theme_state");
    if (isDurableThemeState(response)) adoptDurableTheme(response);
  } catch { /* The latest validated durable state remains authoritative. */ }
  const result = revertThemePickerToDurable(picker, durableTheme.themeId, durableTheme.revision);
  themePicker = result.model;
  applyTheme(result.effect.themeId);
  accessibility.announce({ kind: "error", error: "theme-save-failed" });
}
async function commitTheme(): Promise<void> {
  const picker = activeThemePicker();
  if (!picker) return;
  const { model, intent } = commitThemePicker(picker);
  themePicker = model;
  themeDialog.close();
  try {
    const response: unknown = await invoke("commit_theme_state", { themeId: intent.themeId, baseRevision: intent.baseRevision });
    if (!isDurableThemeState(response) || response.themeId !== intent.themeId || response.revision <= intent.baseRevision) { await restoreDurableThemeAfterFailure(picker); return; }
    adoptDurableTheme(response);
    applyTheme(durableTheme.themeId);
    accessibility.announce({ kind: "theme", themeId: durableTheme.themeId });
  } catch {
    await restoreDurableThemeAfterFailure(picker);
  } finally {
    restoreThemeFocus();
  }
}
async function loadTheme(): Promise<void> {
  try {
    const response: unknown = await invoke("read_theme_state");
    if (isDurableThemeState(response)) adoptDurableTheme(response);
  } catch { /* The default remains available when native state cannot be loaded. */ }
  applyTheme(durableTheme.themeId);
}
applyTheme(durableTheme.themeId);
void loadTheme();
let shellDisposing = false;
let themeUnlisten: (() => void) | undefined;
void listen<unknown>("theme-state-committed", (event) => {
  if (!isDurableThemeState(event.payload) || !adoptDurableTheme(event.payload)) return;
  themePicker = CLOSED_THEME_PICKER;
  applyTheme(durableTheme.themeId);
  if (themeDialog.open) { themeDialog.close(); restoreThemeFocus(); }
  accessibility.announce({ kind: "theme", themeId: durableTheme.themeId });
}).then((unlisten) => { if (shellDisposing) unlisten(); else themeUnlisten = unlisten; }, () => undefined);
themeCancel.addEventListener("click", () => closeThemePicker(true));
themeForm.addEventListener("submit", (event) => { event.preventDefault(); void commitTheme(); });
themeDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeThemePicker(true); });
themeDialog.addEventListener("keydown", (event) => {
  if (isNativeKeyboardCompositionOrModifierEvent(event)) return;
  const picker = activeThemePicker();
  if (!picker) return;
  const action = themePickerDialogKeyAction(event);
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  if (action === "commit") { void commitTheme(); return; }
  if (action === "revert") { closeThemePicker(true); return; }
  const direction = action === "next" ? 1 : -1;
  previewTheme((picker.activeIndex + direction + THEME_PICKER_ROWS.length) % THEME_PICKER_ROWS.length);
});
const native = {
  openPdfDialog: async (): Promise<never> => { throw new Error("OPEN_INGRESS_REQUIRED"); },
  readRange: async (request: { readonly sessionId: string; readonly documentGeneration: number; readonly requestId: string; readonly offset: number; readonly length: number }, _signal: AbortSignal, sessionOwnerGeneration: number) => {
    const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>("read_pdf_range", { ...request, ownerGeneration: sessionOwnerGeneration });
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  },
  cancelSession: (session: { readonly sessionId: string; readonly documentGeneration: number }, sessionOwnerGeneration: number) => invoke<{ readonly barrierId: number }>("cancel_pdf_session", { ...session, ownerGeneration: sessionOwnerGeneration }),
  closeSession: (session: { readonly sessionId: string; readonly documentGeneration: number }, barrierId: number, sessionOwnerGeneration: number) => invoke<void>("close_pdf_session", { ...session, ownerGeneration: sessionOwnerGeneration, barrierId }),
};
function requestPassword(reason: "need" | "incorrect"): Promise<string | null> {
  passwordInput.value = ""; passwordInput.placeholder = reason === "incorrect" ? "Incorrect password" : ""; passwordDialog.returnValue = "cancel"; passwordDialog.showModal(); passwordInput.focus();
  return new Promise((resolve) => passwordDialog.addEventListener("close", () => {
    const password = passwordDialog.returnValue === "submit" ? passwordInput.value : null;
    passwordInput.value = "";
    resolve(password);
  }, { once: true }));
}
passwordCancel.addEventListener("click", () => passwordDialog.close("cancel"));

type TabPayload = { readonly host: HTMLElement; readonly session: PdfTabSession; };
let workspace!: TabWorkspace<TabPayload>;
const resources = new ResourceReservationManager((needed) => {
  if (workspace === undefined || !["canvas-bytes", "canvas-cache-bytes", "text-page-bytes", "text-document-bytes", "text-process-bytes", "search-document-results", "search-process-results", "search-extractor"].includes(needed.kind)) return;
  const activeTabId = workspace.activeTabId;
  for (const tab of workspace.snapshot.tabs) {
    if (tab.id !== activeTabId) tab.payload.session.evictInactiveHeavyResources();
  }
});
let keyboard!: KeyboardAdapter;
let dialogOpenPending = false;
const OPEN_FAILURE_STATUS: Readonly<Record<OpenFailureNotice["tag"], string>> = {
  DOCUMENT_TOO_LARGE: "This PDF exceeds reader resource limits.",
  REMOTE_PATH: "Network PDFs are not supported. Copy the PDF to a local drive and open the local copy.",
  PATH_REJECTED: "Network PDFs are not supported. Copy the PDF to a local drive and open the local copy.",
  PDF_INVALID: "Could not read this PDF.",
  FILE_UNREADABLE: "Could not read this PDF.",
  SESSION_CAPACITY: "This PDF exceeds reader resource limits.",
};
function openFailureTag(value: unknown): OpenFailureNotice["tag"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("tag" in value)) return undefined;
  const tag = value.tag;
  return tag === "DOCUMENT_TOO_LARGE" || tag === "REMOTE_PATH" || tag === "PATH_REJECTED" || tag === "PDF_INVALID" || tag === "FILE_UNREADABLE" || tag === "SESSION_CAPACITY" ? tag : undefined;
}
function reportOpenInvokeFailure(error?: unknown): void {
  const tag = openFailureTag(error);
  active().session.reader.setStatus(tag === undefined ? "The PDF could not be opened." : OPEN_FAILURE_STATUS[tag]);
  const accessibleError = tag === "REMOTE_PATH" || tag === "PATH_REJECTED" ? "document-locality-denied" : tag === "PDF_INVALID" || tag === "FILE_UNREADABLE" ? "document-invalid" : "document-unavailable";
  accessibility.announce({ kind: "error", error: accessibleError });
  render();
}
const RECENT_STORAGE_FAILED = "Recent documents could not be saved. The PDF remains open.";
function reportRecentStorageFailure(session: PdfTabSession): void {
  session.reader.setStatus(RECENT_STORAGE_FAILED);
  render();
}
const SAFE_ADOPTION_FAILURE_STATUSES = new Set([
  "Could not read this PDF.",
  "Network PDFs are not supported. Copy the PDF to a local drive and open the local copy.",
  "This PDF path cannot be opened safely.",
  "This PDF exceeds reader resource limits.",
  "Opening PDF cancelled.",
  "The PDF password was not accepted.",
  "The PDF password was not accepted after five attempts.",
  "The local PDF renderer could not start.",
  "The PDF operation timed out.",
]);
function safeAdoptionFailureStatus(status: string): string {
  return SAFE_ADOPTION_FAILURE_STATUSES.has(status) ? status : "The PDF could not be opened.";
}
let paletteActiveIndex = 0;
let paletteRestoreFocus: HTMLElement | null = null;
let fileOpenerActiveIndex = 0;
let fileOpenerRecents: readonly RecentPaletteRecord[] = [];
let fileOpenerRestoreFocus: HTMLElement | null = null;
const workspaceTransitions = createWorkspaceTransitionQueue(() => {
  active().session.reader.setStatus("WORKSPACE_BUSY");
  render();
});
const removedTabTeardown = createRemovedTabTeardownSupervisor<TabPayload>({
  remove: (value) => value.host.remove(),
  close: (value) => value.session.close(),
});
function queueWorkspaceTransition(work: () => Promise<void> | void): Promise<void> { return workspaceTransitions.enqueue(work); }
function queueWorkspaceOwnership(work: () => Promise<void> | void): Promise<void> { return workspaceTransitions.enqueueOwnership(work); }
function queueWorkspaceActivation(work: () => Promise<void> | void): Promise<void> { return workspaceTransitions.enqueueActivation(work); }
function disposeWorkspaceTab(value: TabPayload): void { removedTabTeardown.remove(value); }

function active(): TabPayload { const value = workspace.getPayload(workspace.activeTabId); if (!value) throw new Error("ACTIVE_TAB_MISSING"); return value; }
function commandAvailabilityContext(): CommandAvailabilityContext {
  return {
    hasDocument: active().session.snapshot.reader.hasDocument,
    canCreateSession: workspace.snapshot.tabs.length < 8,
    tabCount: workspace.snapshot.tabs.length,
    canOpenDocument: workspace.snapshot.tabs.some((tab) => !tab.payload.session.snapshot.reader.hasDocument) || workspace.snapshot.tabs.length < 8,
    modalOpen: dialogOpenPending || passwordDialog.open || searchDialog.open || helpDialog.open || themeDialog.open,
    pagePromptActive: engine.state.kind === "pagePrompt",
  };
}
function renderHelpRows(): void {
  const groups = new Map<string, ReturnType<typeof buildHelpRows>>();
  for (const row of buildHelpRows()) {
    groups.set(row.category, [...(groups.get(row.category) ?? []), row]);
  }
  helpRows.replaceChildren(...[...groups].map(([category, rows]) => {
    const section = document.createElement("section");
    section.className = "help-group";
    const heading = document.createElement("h2");
    heading.textContent = category;
    const list = document.createElement("dl");
    for (const row of rows) {
      const description = document.createElement("dt");
      description.textContent = row.label;
      const shortcut = document.createElement("dd");
      shortcut.textContent = row.shortcut;
      list.append(description, shortcut);
    }
    section.append(heading, list);
    return section;
  }));
}
function pageNearestViewportCenter(host: HTMLElement): number | undefined {
  const frames = [...host.querySelectorAll<HTMLElement>(":scope > .pdf-page-frame")];
  if (frames.length === 0) return undefined;
  const hostRect = host.getBoundingClientRect();
  const viewportCenter = hostRect.top + host.clientHeight / 2;
  let nearest: { readonly page: number; readonly distance: number } | undefined;
  for (const frame of frames) {
    const page = Number(frame.dataset.page);
    if (!Number.isInteger(page)) continue;
    const rect = frame.getBoundingClientRect();
    if (viewportCenter >= rect.top && viewportCenter <= rect.bottom) return page;
    const distance = Math.min(Math.abs(viewportCenter - rect.top), Math.abs(viewportCenter - rect.bottom));
    if (nearest === undefined || distance < nearest.distance || (distance === nearest.distance && page < nearest.page)) {
      nearest = { page, distance };
    }
  }
  return nearest?.page;
}
const boundaryPageTurns = new WeakSet<HTMLElement>();
function turnPageAtBoundary(payload: TabPayload, direction: -1 | 1): boolean {
  if (boundaryPageTurns.has(payload.host)) return true;
  const previousPage = payload.session.snapshot.reader.page;
  payload.session.apply({ type: direction > 0 ? "page.next" : "page.previous" });
  const page = payload.session.snapshot.reader.page;
  if (page === previousPage) return false;
  boundaryPageTurns.add(payload.host);
  keyboard.syncContext();
  render();
  void payload.session.renderPage(page).then((committed) => {
    if (committed && direction < 0) {
      payload.host.scrollTop = Math.max(0, payload.host.scrollHeight - payload.host.clientHeight);
    }
  }).finally(() => {
    boundaryPageTurns.delete(payload.host);
    keyboard.syncContext();
    render();
  });
  return true;
}
function createTab(): TabPayload {
  const host = document.createElement("section");
  host.className = "reader-surface tab-host";
  host.tabIndex = 0;
  host.setAttribute("role", "tabpanel");
  host.innerHTML = '<div class="empty-state"><p><kbd>Ctrl</kbd>+<kbd>O</kbd> to open a PDF</p></div>';
  host.addEventListener("dragover", (event) => event.preventDefault());
  host.addEventListener("drop", (event) => event.preventDefault());
  tabHosts.append(host);
  let session!: PdfTabSession;
  let announcedGeneration = -1;
  session = new PdfTabSession({
    native,
    pdf: { getDocument: (options) => getDocument(options as never) as unknown as PdfLoadingTask, annotationMode: AnnotationMode.DISABLE },
    resources,
    canvasHost: host,
    requestPassword,
    createContentOptions: (opened, generation) => ({
      navigateToPage: (page) => { if (active().session === session) { session.apply({ type: "page.goTo", page }); void session.renderPage(page); } },
      navigateToDestination: (page, destination) => { if (active().session === session) void session.navigateToDestination(page, destination); },
      prepareExternalLinks: (entries, registryRevision) => invoke<void>("prepare_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision, entries: entries.map((entry) => ({ annotation_id: entry.annotationId, target: entry.target })) }),
      commitExternalLinks: (registryRevision) => invoke<void>("commit_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision }),
      finalizeExternalLinks: (registryRevision) => invoke<void>("finalize_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision }),
      abortExternalLinks: (registryRevision) => invoke<void>("abort_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision }),
      openExternal: (annotationId, registryRevision, operationId, operationSequence) => invoke<void>("open_external_link", { request: { operationId, operationSequence, sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision, annotationId } }),
    }),
    onStatus: () => {
      render();
      if (workspace === undefined || active().session !== session) return;
      const snapshot = session.snapshot;
      const reader = snapshot.reader;
      accessibility.activateTab(String(workspace.activeTabId), reader.documentGeneration);
      if (reader.hasDocument && reader.pageCount > 0) {
        accessibility.announce({ kind: "page", generation: reader.documentGeneration, page: reader.page, pageCount: reader.pageCount });
        if (reader.zoomMode === "custom") accessibility.announce({ kind: "zoom", generation: reader.documentGeneration, zoomPercent: Math.round(reader.customScale * 100) });
        if (announcedGeneration !== reader.documentGeneration) {
          announcedGeneration = reader.documentGeneration;
          accessibility.announce({ kind: "loading-complete", generation: reader.documentGeneration, pageCount: reader.pageCount });
        }
      }
      const content = snapshot.content;
      if (content.query !== "" && !content.searchPending && !content.searchIncomplete) {
        accessibility.announce({ kind: "search", generation: reader.documentGeneration, current: content.results.length === 0 ? 0 : content.currentResult + 1, total: content.results.length });
      }
      accessibility.announce({ kind: "link-hints", generation: reader.documentGeneration, visible: content.hintsVisible, count: content.hintsVisible ? host.querySelectorAll(".pdf-link-hint").length : 0 });
    },
  });
  host.addEventListener("wheel", (event) => {
    if (active().session !== session) return;
    const reader = session.snapshot.reader;
    const direction = wheelPageDirection({
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      scrollTop: host.scrollTop,
      scrollHeight: host.scrollHeight,
      clientHeight: host.clientHeight,
      page: reader.page,
      pageCount: reader.pageCount,
      ctrlKey: event.ctrlKey,
    });
    if (direction === 0) return;
    event.preventDefault();
    turnPageAtBoundary({ host, session }, direction);
  }, { passive: false });
  let viewportFrameRequest: number | undefined;
  let viewportActivation: Promise<boolean> | undefined;
  const synchronizeViewportPage = (): void => {
    viewportFrameRequest = undefined;
    if (active().session !== session || viewportActivation !== undefined) return;
    const page = pageNearestViewportCenter(host);
    if (page === undefined || page === session.snapshot.reader.page) return;
    viewportActivation = session.activateViewportPage(page);
    void viewportActivation.finally(() => {
      viewportActivation = undefined;
      keyboard.syncContext();
      render();
      if (active().session === session) synchronizeViewportPage();
    });
  };
  host.addEventListener("scroll", () => {
    if (viewportFrameRequest !== undefined) return;
    viewportFrameRequest = window.requestAnimationFrame(synchronizeViewportPage);
  }, { passive: true });
  return { host, session };
}
workspace = new TabWorkspace(createTab, 8, { dispose: disposeWorkspaceTab });
active().session.activate();

function render(): void {
  const current = active();
  const snapshot = current.session.snapshot;
  status.textContent = snapshot.status;
  if (snapshot.reader.helpVisible && !helpDialog.open) helpDialog.showModal();
  if (!snapshot.reader.helpVisible && helpDialog.open) helpDialog.close();
  renderHelpRows();
  prompt.hidden = engine.state.kind !== "pagePrompt";
  prompt.textContent = engine.state.kind === "pagePrompt" ? `Go to page: ${engine.state.digits || "_"}` : "";
  const tabs = workspace.snapshot.tabs;
  for (const [index, tab] of tabs.entries()) {
    const selected = tab.id === workspace.activeTabId;
    const title = tab.payload.session.snapshot.title;
    tab.payload.host.hidden = !selected;
    tab.payload.host.setAttribute("aria-hidden", String(!selected));
    tab.payload.host.id = `reader-panel-${String(tab.id)}`;
    tab.payload.host.setAttribute("aria-labelledby", `reader-tab-${String(tab.id)}`);
    tab.payload.host.setAttribute("aria-label", readerAccessibilityName(title, tab.payload.session.snapshot.reader.pageCount));
    if (selected) accessibility.announce({ kind: "tab", active: index + 1, total: tabs.length });
  }
  tabStrip.replaceChildren(...tabs.map((tab, index) => {
    const selected = tab.id === workspace.activeTabId;
    const semantics = tabAccessibilitySemantics({ basename: tab.payload.session.snapshot.title, ordinal: index + 1, total: tabs.length, active: selected });
    const button = document.createElement("button");
    button.type = "button"; button.className = "workspace-tab"; button.id = `reader-tab-${String(tab.id)}`;
    button.role = semantics.role; button.setAttribute("aria-label", semantics.ariaLabel); button.setAttribute("aria-selected", semantics.ariaSelected); button.setAttribute("aria-setsize", String(semantics.ariaSetSize)); button.setAttribute("aria-posinset", String(semantics.ariaPosInSet)); button.setAttribute("aria-controls", `reader-panel-${String(tab.id)}`); button.tabIndex = semantics.tabIndex; button.textContent = tab.payload.session.snapshot.title;
    button.addEventListener("click", () => void switchTab(tab.id));
    const close = document.createElement("button"); close.type = "button"; close.className = "workspace-tab-close"; close.setAttribute("aria-label", "Close tab"); close.textContent = "×"; close.addEventListener("click", (event) => { event.stopPropagation(); closeTab(tab.id); });
    const item = document.createElement("div"); item.className = "workspace-tab-item"; item.append(button, close); item.dataset.index = String(index); return item;
  }));
}
function activateCurrentTab(focus = false): void { const current = active(); current.session.activate(); render(); if (focus) current.host.focus(); }
function switchTab(id: TabId): Promise<void> { return queueWorkspaceActivation(async () => { if (id === workspace.activeTabId) return; await active().session.deactivate().catch(() => undefined); if (!workspace.activate(id)) { activateCurrentTab(); return; } activateCurrentTab(true); }); }
function closeTab(id: TabId): void { void queueWorkspaceTransition(() => { const wasActive = id === workspace.activeTabId; if (!workspace.close(id)) return; if (wasActive) activateCurrentTab(); else render(); }); }
async function adoptRequest(request: OpenRequestAdoption): Promise<void> {
  let adoptedSession: PdfTabSession | undefined;
  await queueWorkspaceOwnership(async () => {
    const priorActiveId = workspace.activeTabId;
    let id = priorActiveId;
    let payload = active();
    let staged = false;
    const emptyTab = workspace.snapshot.tabs.find((tab) => !tab.payload.session.snapshot.reader.hasDocument);
    if (emptyTab && emptyTab.id !== id) {
      await payload.session.deactivate().catch(() => undefined);
      if (!workspace.activate(emptyTab.id)) { activateCurrentTab(); throw new Error("EMPTY_TAB_MISSING"); }
      id = emptyTab.id;
      payload = emptyTab.payload;
    } else if (payload.session.snapshot.reader.hasDocument) {
      await payload.session.deactivate().catch(() => undefined);
      payload = createTab();
      const stagedId = workspace.stageAdoption(payload, { dispose: disposeWorkspaceTab });
      if (stagedId === null) { disposeWorkspaceTab(payload); activateCurrentTab(); throw new Error("TAB_CAPACITY"); }
      id = stagedId;
      staged = true;
    }
    try {
      await publishActivateAndAdoptPdfTab(render, payload.session, () => payload.session.adopt(request, request.ownerGeneration));
      if (staged && !workspace.commitAdoption(id)) throw new Error("ADOPTION_COMMIT_FAILED");
      activateCurrentTab();
      adoptedSession = payload.session;
    } catch (error) {
      const candidateStatus = safeAdoptionFailureStatus(payload.session.snapshot.status);
      if (staged) workspace.rollbackAdoption(id);
      else if (id !== priorActiveId) {
        await payload.session.deactivate().catch(() => undefined);
        workspace.activate(priorActiveId);
      }
      activateCurrentTab();
      active().session.reader.setStatus(candidateStatus);
      render();
      throw error;
    }
  });
  void invoke("record_recent", { sessionId: request.sessionId, documentGeneration: request.documentGeneration }).then(
    () => undefined,
    () => { if (adoptedSession) reportRecentStorageFailure(adoptedSession); },
  );
}
const shellOpen = createShellOpenCoordinator({
  listen,
  invoke: (command, args) => invoke(command, args),
  dialog: { setPending: (pending) => { dialogOpenPending = pending; render(); }, reportFailure: reportOpenInvokeFailure },
  adopt: adoptRequest,
  onFailure: (tag) => reportOpenInvokeFailure({ tag }),
});
function isRecentPaletteRecord(value: unknown): value is RecentPaletteRecord {
  return typeof value === "object" && value !== null
    && "recentId" in value && typeof value.recentId === "string"
    && "displayName" in value && typeof value.displayName === "string";
}
function paletteEntries(): readonly CommandPaletteCommandEntry[] {
  return buildCommandPaletteEntries(commandAvailabilityContext(), [], paletteInput.value)
    .filter((entry): entry is CommandPaletteCommandEntry => entry.kind === "command");
}
function recentEntries(): readonly RecentPaletteRecord[] {
  return buildCommandPaletteEntries(undefined, fileOpenerRecents, fileOpenerInput.value)
    .filter((entry) => entry.kind === "recent")
    .map(({ recentId, displayName }) => ({ recentId, displayName }));
}
function openPalette(): void {
  if (!paletteDialog.open) {
    paletteRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    paletteInput.value = "";
    paletteDialog.showModal();
    accessibility.announce({ kind: "palette", open: true });
  }
  paletteActiveIndex = 0;
  renderPalette();
  paletteInput.focus();
}
function closePalette(): void {
  if (paletteDialog.open) paletteDialog.close();
  accessibility.announce({ kind: "palette", open: false });
  paletteRestoreFocus?.focus();
  paletteRestoreFocus = null;
}
function dispatchPaletteEntry(index = paletteActiveIndex): void {
  const entry = paletteEntries()[index];
  if (!entry) return;
  const binding = DEFAULT_BINDINGS.find((candidate) => candidate.id === entry.id);
  if (!binding || !isCommandEnabled(binding, commandAvailabilityContext())) return;
  const paletteAction = resolvePaletteBindingAction(binding);
  closePalette();
  if (paletteAction?.kind === "dispatch") dispatch(paletteAction.action);
  if (paletteAction?.kind === "page.target") {
    const result = engine.enterPagePrompt(sequenceContext());
    for (const dispatched of result.dispatches) dispatch(dispatched.action);
    if (result.error) active().session.reader.setStatus(result.error);
  }
}
function renderPalette(): void {
  const entries = paletteEntries();
  paletteActiveIndex = Math.min(paletteActiveIndex, Math.max(0, entries.length - 1));
  paletteList.replaceChildren(...entries.map((entry, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "overlay-list-entry command-palette-entry";
    button.setAttribute("aria-selected", String(index === paletteActiveIndex));
    button.disabled = !entry.enabled;
    const label = document.createElement("span");
    label.textContent = entry.label;
    const shortcut = document.createElement("span");
    shortcut.className = "command-palette-entry-shortcut";
    shortcut.textContent = entry.shortcut;
    button.append(label, shortcut);
    button.addEventListener("click", () => { paletteActiveIndex = index; dispatchPaletteEntry(); });
    item.append(button);
    return item;
  }));
  paletteList.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
}
function renderFileOpener(): void {
  const entries = recentEntries();
  fileOpenerActiveIndex = Math.min(fileOpenerActiveIndex, entries.length);
  const browse = document.createElement("li");
  const browseButton = document.createElement("button");
  browseButton.type = "button";
  browseButton.className = "overlay-list-entry file-opener-entry";
  browseButton.textContent = "Browse...";
  browseButton.setAttribute("aria-selected", String(fileOpenerActiveIndex === 0));
  browseButton.addEventListener("click", () => { fileOpenerActiveIndex = 0; dispatchFileOpenerEntry(); });
  browse.append(browseButton);
  const recentRows = entries.map((entry, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "overlay-list-entry file-opener-entry";
    button.textContent = entry.displayName;
    button.setAttribute("aria-selected", String(fileOpenerActiveIndex === index + 1));
    button.addEventListener("click", () => { fileOpenerActiveIndex = index + 1; dispatchFileOpenerEntry(); });
    item.append(button);
    return item;
  });
  fileOpenerList.replaceChildren(browse, ...recentRows);
  fileOpenerList.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
}
function closeFileOpener(): void {
  if (fileOpenerDialog.open) fileOpenerDialog.close();
  fileOpenerRestoreFocus?.focus();
  fileOpenerRestoreFocus = null;
}
function dispatchFileOpenerEntry(): void {
  if (fileOpenerActiveIndex === 0) {
    closeFileOpener();
    shellOpen.requestOpen();
    return;
  }
  const entry = recentEntries()[fileOpenerActiveIndex - 1];
  if (!entry) return;
  closeFileOpener();
  void invoke("open_recent", { recentId: entry.recentId }).catch(reportOpenInvokeFailure);
}
function openFileOpener(): void {
  fileOpenerRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : active().host;
  fileOpenerInput.value = "";
  fileOpenerRecents = [];
  fileOpenerActiveIndex = 0;
  renderFileOpener();
  fileOpenerDialog.showModal();
  fileOpenerInput.focus();
  void invoke<unknown>("list_recents").then((value) => {
    if (!fileOpenerDialog.open || !Array.isArray(value)) return;
    fileOpenerRecents = value.filter(isRecentPaletteRecord).slice(0, 15);
    renderFileOpener();
  }, () => undefined);
}
let quitRequest: Promise<void> | undefined;
let quitUnlisten: (() => void) | undefined;
function requestApplicationQuit(beginNative = true): Promise<void> {
  if (quitRequest !== undefined) return quitRequest;
  quitRequest = (async () => {
    if (beginNative) await invoke("begin_quit");
    let rendererDrained = false;
    try {
      if (themeDialog.open) closeThemePicker(true);
      if (paletteDialog.open) closePalette();
      if (fileOpenerDialog.open) closeFileOpener();
      if (helpDialog.open) helpDialog.close();
      if (searchDialog.open) searchDialog.close();
      if (passwordDialog.open) passwordDialog.close();
      passwordInput.value = "";
      shellDisposing = true;
      themeUnlisten?.();
      quitUnlisten?.();
      shellOpen.dispose();
      const tabs = workspace.snapshot.tabs.map((tab) => ({ id: tab.id, payload: workspace.getPayload(tab.id) })).filter((entry): entry is { id: TabId; payload: TabPayload } => entry.payload !== undefined);
      await Promise.allSettled(tabs.map(({ payload }) => payload.session.close()));
      for (const { id } of tabs) workspace.close(id);
      removedTabTeardown.retryParked();
      removedTabTeardown.dispose();
      disposeSearchPrompt();
      keyboard.dispose();
      disposeDprChange();
      resources.assertEmpty();
      rendererDrained = true;
    } finally {
      await invoke("finish_quit", { rendererDrained });
    }
  })();
  return quitRequest;
}
void listen("quit-requested", () => { void requestApplicationQuit(false); }).then(
  (unlisten) => {
    if (shellDisposing) unlisten();
    else {
      quitUnlisten = unlisten;
      void invoke("renderer_ready");
    }
  },
  () => undefined,
);
function dispatch(action: Action): void {
  const type = action.type;
  if (type === "document.open") { if (!commandAvailabilityContext().canOpenDocument) { active().session.reader.setStatus("TAB_CAPACITY"); render(); return; } openFileOpener(); return; }
  if (type === "tab.activate") { const tab = action.index === -1 ? workspace.snapshot.tabs[workspace.snapshot.tabs.length - 1] : workspace.snapshot.tabs[action.index]; if (tab) void switchTab(tab.id); return; }
  if (type === "tab.close") { closeTab(workspace.activeTabId); return; }
  if (type === "application.new") { void invoke<void>("create_app_window").catch(() => { active().session.reader.setStatus("WINDOW_CREATE_FAILED"); render(); }); return; }
  if (type === "palette.toggle") { openPalette(); return; }
  if (type === "tab.next") { void switchTab(workspace.adjacentId(1)); return; }
  if (type === "tab.previous") { void switchTab(workspace.adjacentId(-1)); return; }
  if (type === "theme.open") { openThemePicker(); return; }
  if (type === "application.quit") { void requestApplicationQuit(); return; }
  const payload = active(); const session = payload.session; session.apply(action); const reader = session.snapshot.reader;
  if (type.startsWith("page.")) void session.renderPage(reader.page); if (type.startsWith("view.")) void session.renderCurrentView();
  if (type === "search.open") { searchInput.value = session.query; searchDialog.showModal(); searchInput.focus(); }
  if (type === "linkHints.toggle") session.toggleHints(); if (type === "prompt.cancel") session.cancelHints();
  if (type.startsWith("scroll.")) {
    const intent = session.reader.consumePendingScroll();
    const verticalCssPixels = intent.verticalCssPixels + intent.viewportFactor * payload.host.clientHeight;
    const direction = wheelPageDirection({
      deltaX: intent.horizontalCssPixels,
      deltaY: verticalCssPixels,
      scrollTop: payload.host.scrollTop,
      scrollHeight: payload.host.scrollHeight,
      clientHeight: payload.host.clientHeight,
      page: reader.page,
      pageCount: reader.pageCount,
    });
    if (direction === 0 || !turnPageAtBoundary(payload, direction)) {
      payload.host.scrollBy({ left: intent.horizontalCssPixels, top: verticalCssPixels });
    }
  }
  keyboard.syncContext(); render();
}
const engine = new KeySequenceEngine();
function sequenceContext() {
  const snapshot = active().session.snapshot.reader;
  const commandAvailability = commandAvailabilityContext();
  return {
    hasDocument: commandAvailability.hasDocument,
    pageCount: snapshot.pageCount,
    documentGeneration: snapshot.documentGeneration,
    commandAvailability,
  };
}
keyboard = createKeyboardAdapter({
  engine,
  getContext: sequenceContext,
  onDispatch: ({ action }) => dispatch(action),
  onResult: (result?: SequenceResult) => { if (result?.error) active().session.reader.setStatus(result.error); render(); },
});
window.addEventListener("keydown", (event) => {
  const session = active().session;
  if (!session.hintsVisible || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || isNativeKeyboardCompositionOrModifierEvent(event) || isNativeOwnedTarget(event.target)) return;
  if (event.key !== "Escape" && event.key.length !== 1) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  session.handleHintKey(event.key);
  render();
}, { capture: true });
window.addEventListener("keydown", keyboard.handleKeyDown);

const DPR_POLL_DELAY_MS = 250;
let dprMediaQuery: MediaQueryList | undefined;
let dprPollTimer: ReturnType<typeof setTimeout> | undefined;
let devicePixelRatio = window.devicePixelRatio;
const onDprChange = (): void => {
  devicePixelRatio = window.devicePixelRatio;
  bindDprChange();
  void active().session.renderCurrentView();
};
function bindDprChange(): void {
  dprMediaQuery?.removeEventListener?.("change", onDprChange);
  dprMediaQuery = typeof window.matchMedia === "function" ? window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`) : undefined;
  dprMediaQuery?.addEventListener?.("change", onDprChange);
}
function scheduleDprPollFallback(): void {
  if (dprPollTimer !== undefined) return;
  dprPollTimer = setTimeout(() => {
    dprPollTimer = undefined;
    if (devicePixelRatio !== window.devicePixelRatio) onDprChange();
    scheduleDprPollFallback();
  }, DPR_POLL_DELAY_MS);
}
function disposeDprChange(): void {
  dprMediaQuery?.removeEventListener?.("change", onDprChange);
  dprMediaQuery = undefined;
  if (dprPollTimer !== undefined) clearTimeout(dprPollTimer);
  dprPollTimer = undefined;
}
bindDprChange();
scheduleDprPollFallback();
const disposeSearchPrompt = bindSearchPrompt(
  { dialog: searchDialog, form: searchForm, input: searchInput },
  () => active().session,
  render,
);
window.addEventListener("resize", () => { scheduleDprPollFallback(); void active().session.renderCurrentView(); });
window.addEventListener("blur", keyboard.cancelPending);
window.addEventListener("compositionstart", keyboard.cancelPending);
window.addEventListener("focusin", (event) => { if (isNativeOwnedTarget(event.target)) keyboard.cancelPending(); });
fileOpenerInput.addEventListener("input", () => { fileOpenerActiveIndex = 0; renderFileOpener(); });
fileOpenerForm.addEventListener("submit", (event) => { event.preventDefault(); dispatchFileOpenerEntry(); });
fileOpenerDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeFileOpener(); });
fileOpenerDialog.addEventListener("keydown", (event) => {
  if (isPaletteClearShortcut(event)) {
    event.preventDefault();
    event.stopPropagation();
    fileOpenerInput.value = "";
    fileOpenerActiveIndex = 0;
    renderFileOpener();
    return;
  }
  const action = commandPaletteKeyAction(event);
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  if (action === "close") { closeFileOpener(); return; }
  if (action === "submit") { dispatchFileOpenerEntry(); return; }
  fileOpenerActiveIndex = moveCommandPaletteIndex(fileOpenerActiveIndex, recentEntries().length + 1, action);
  renderFileOpener();
}, { capture: true });
paletteInput.addEventListener("input", renderPalette);
paletteForm.addEventListener("submit", (event) => { event.preventDefault(); dispatchPaletteEntry(); });
window.addEventListener("focus", () => removedTabTeardown.retryParked());
paletteDialog.addEventListener("keydown", (event) => {
  const action = commandPaletteKeyAction(event);
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  if (action === "close") { closePalette(); return; }
  if (action === "submit") { dispatchPaletteEntry(); return; }
  const count = paletteEntries().length;
  paletteActiveIndex = moveCommandPaletteIndex(paletteActiveIndex, count, action);
  if (count > 0) renderPalette();
}, { capture: true });
helpDialog.addEventListener("cancel", (event) => { event.preventDefault(); active().session.apply({ type: "prompt.cancel" }); helpDialog.close(); render(); });
window.addEventListener("beforeunload", () => {
  disposeSearchPrompt();
  themeUnlisten?.();
  quitUnlisten?.();
  shellDisposing = true;
  shellOpen.dispose();
  removedTabTeardown.dispose();
  keyboard.dispose();
  passwordInput.value = "";
  for (const tab of workspace.snapshot.tabs) workspace.close(tab.id);
  disposeDprChange();
});
paletteDialog.addEventListener("cancel", (event) => { event.preventDefault(); closePalette(); });
render();
