import "./styles/app.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnnotationMode, getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { KeySequenceEngine, type SequenceResult } from "./core/KeySequenceEngine";
import { TabWorkspace, type TabId } from "./core/TabWorkspace";
import { DEFAULT_BINDINGS, isCommandEnabled, resolvePaletteBindingAction, type CommandAvailabilityContext } from "./core/defaultBindings.windows";
import type { Action } from "./core/Action";
import { createKeyboardAdapter, getPromptKeyAction, isNativeKeyboardCompositionOrModifierEvent, isNativeOwnedTarget, type KeyboardAdapter } from "./platform/keyboardAdapter";
import { type OpenFailureNotice, type OpenRequestAdoption } from "./platform/OpenRequestClient";
import { buildCommandPaletteEntries, type RecentPaletteRecord } from "./ui/CommandPaletteModel";
import { buildHelpRows } from "./ui/HelpModel";
import { createRemovedTabTeardownSupervisor, createShellOpenCoordinator, createWorkspaceTransitionQueue } from "./platform/ShellOpenCoordinator";
import { PDFJS_POLICY } from "./pdf/PdfJsPolicy";
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
<section class="app-shell" aria-label="Modeleaf PDF reader">
  <header class="titlebar"><h1>Modeleaf</h1><span class="platform-badge">Windows foundation</span></header>
  <div id="tab-strip" class="tab-strip" role="tablist" aria-label="Open documents"></div>
  <section id="tab-hosts" class="tab-hosts"></section>
  <section id="prompt" class="prompt" aria-live="polite" hidden></section>
  <dialog id="help-dialog" aria-labelledby="help-title"><header><h2 id="help-title">Keyboard shortcuts</h2><p class="dialog-hint">Limitations: keyboard range selection, reading-order remediation, and OCR/scanned-PDF remediation are unavailable.</p></header><dl id="help-rows"></dl></dialog>
  <dialog id="password-dialog" aria-labelledby="password-title"><form method="dialog" autocomplete="off"><h2 id="password-title">PDF password required</h2><label>Password <input id="password-input" type="password" autocomplete="off" data-form-type="other" spellcheck="false"></label><menu><button id="password-cancel" type="button" value="cancel">Cancel</button><button type="submit" value="submit">Open</button></menu></form></dialog>
  <dialog id="search-dialog" aria-labelledby="search-title"><form id="search-form" autocomplete="off"><h2 id="search-title">Search PDF text</h2><label>Literal text <input id="search-input" type="search" spellcheck="false"></label><p class="dialog-hint">Press <kbd>Enter</kbd> or <kbd>Shift</kbd>+<kbd>Enter</kbd> to cycle matches.</p></form></dialog>
  <dialog id="command-palette-dialog" aria-labelledby="palette-title"><form id="command-palette-form"><h2 id="palette-title">Command palette</h2><input id="palette-input" type="search" autocomplete="off" spellcheck="false"><ul id="palette-list" class="command-palette-list"></ul></form></dialog>
  <footer id="status" class="statusbar" role="status" aria-live="polite"></footer>
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
const paletteDialog = required<HTMLDialogElement>("#command-palette-dialog");
const paletteInput = required<HTMLInputElement>("#palette-input");
const paletteList = required<HTMLElement>("#palette-list");
GlobalWorkerOptions.workerSrc = PDFJS_POLICY.assets.workerSrc;
const paletteForm = required<HTMLFormElement>("#command-palette-form");
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
let recents: readonly RecentPaletteRecord[] = [];
let paletteActiveIndex = 0;
let paletteRestoreFocus: HTMLElement | null = null;
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
    modalOpen: dialogOpenPending || passwordDialog.open || searchDialog.open || helpDialog.open,
    pagePromptActive: engine.state.kind === "pagePrompt",
  };
}
function renderHelpRows(): void {
  const rows = buildHelpRows(commandAvailabilityContext());
  helpRows.replaceChildren(...rows.flatMap((row) => {
    const term = document.createElement("dt");
    term.textContent = row.shortcut;
    const description = document.createElement("dd");
    description.textContent = row.label;
    description.setAttribute("aria-disabled", String(!row.enabled));
    return [term, description];
  }));
}
function createTab(): TabPayload {
  const host = document.createElement("section");
  host.className = "reader-surface tab-host"; host.tabIndex = -1; host.setAttribute("role", "tabpanel");
  host.innerHTML = '<div class="empty-state"><strong>Keyboard-first PDF reading for Windows</strong><p>Press <kbd>Ctrl</kbd>+<kbd>O</kbd> to open a local PDF.</p></div>';
  host.addEventListener("dragover", (event) => event.preventDefault());
  host.addEventListener("drop", (event) => event.preventDefault());
  tabHosts.append(host);
  let session!: PdfTabSession;
  session = new PdfTabSession({ native, pdf: { getDocument: (options) => getDocument(options as never) as unknown as PdfLoadingTask, annotationMode: AnnotationMode.DISABLE }, resources, canvasHost: host, requestPassword,
    createContentOptions: (opened, generation) => ({
      navigateToPage: (page) => { if (active().session === session) { session.apply({ type: "page.goTo", page }); void session.renderPage(page); } },
      navigateToDestination: (page, destination) => { if (active().session === session) void session.navigateToDestination(page, destination); },
      prepareExternalLinks: (entries, registryRevision) => invoke<void>("prepare_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision, entries: entries.map((entry) => ({ annotation_id: entry.annotationId, target: entry.target })) }),
      commitExternalLinks: (registryRevision) => invoke<void>("commit_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision }),
      finalizeExternalLinks: (registryRevision) => invoke<void>("finalize_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision }),
      abortExternalLinks: (registryRevision) => invoke<void>("abort_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision }),
      openExternal: (annotationId, registryRevision, operationId, operationSequence) => invoke<void>("open_external_link", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, annotationId, registryRevision, operationId, operationSequence }),
    }), onStatus: () => render(),
  });
  return { host, session };
}
workspace = new TabWorkspace(createTab, 8, { dispose: disposeWorkspaceTab });
active().session.activate();

function render(): void {
  const current = active(); const snapshot = current.session.snapshot;
  status.textContent = snapshot.status;
  if (snapshot.reader.helpVisible && !helpDialog.open) helpDialog.showModal();
  if (!snapshot.reader.helpVisible && helpDialog.open) helpDialog.close();
  renderHelpRows();
  prompt.hidden = engine.state.kind !== "pagePrompt";
  prompt.textContent = engine.state.kind === "pagePrompt" ? `Go to page: ${engine.state.digits || "_"}` : "";
  for (const tab of workspace.snapshot.tabs) { const selected = tab.id === workspace.activeTabId; tab.payload.host.hidden = !selected; tab.payload.host.setAttribute("aria-hidden", String(!selected)); }
  tabStrip.replaceChildren(...workspace.snapshot.tabs.map((tab, index) => {
    const button = document.createElement("button"); button.type = "button"; button.className = "workspace-tab"; button.role = "tab"; button.setAttribute("aria-selected", String(tab.id === workspace.activeTabId)); button.textContent = tab.payload.session.snapshot.title;
    button.addEventListener("click", () => void switchTab(tab.id));
    const close = document.createElement("button"); close.type = "button"; close.className = "workspace-tab-close"; close.setAttribute("aria-label", `Close ${tab.payload.session.snapshot.title}`); close.textContent = "×"; close.addEventListener("click", (event) => { event.stopPropagation(); closeTab(tab.id); });
    const item = document.createElement("div"); item.className = "workspace-tab-item"; item.append(button, close); item.dataset.index = String(index); return item;
  }));
}
function activateCurrentTab(focus = false): void { const current = active(); current.session.activate(); render(); if (focus) current.host.focus(); }
function switchTab(id: TabId): Promise<void> { return queueWorkspaceActivation(async () => { if (id === workspace.activeTabId) return; await active().session.deactivate().catch(() => undefined); if (!workspace.activate(id)) { activateCurrentTab(); return; } activateCurrentTab(true); }); }
function closeTab(id: TabId): void { void queueWorkspaceTransition(() => { const wasActive = id === workspace.activeTabId; if (!workspace.close(id)) return; if (wasActive) activateCurrentTab(); else render(); }); }
function appendTab(): void { void queueWorkspaceTransition(async () => { if (workspace.snapshot.tabs.length >= 8) { active().session.reader.setStatus("TAB_CAPACITY"); render(); return; } await active().session.deactivate().catch(() => undefined); const payload = createTab(); const id = workspace.appendAndActivate(payload, { dispose: disposeWorkspaceTab }); if (id === null) { disposeWorkspaceTab(payload); activateCurrentTab(); return; } activateCurrentTab(); }); }
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
    () => { void loadRecents().catch(() => undefined); },
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
async function loadRecents(): Promise<void> { const value = await invoke<RecentPaletteRecord[]>("list_recents"); recents = value.slice(0, 15); }
void loadRecents().catch(() => undefined);
function openPalette(): void { if (!paletteDialog.open) { paletteRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; paletteDialog.showModal(); } paletteActiveIndex = 0; renderPalette(); paletteInput.focus(); }
function closePalette(): void { paletteDialog.close(); paletteRestoreFocus?.focus(); paletteRestoreFocus = null; }
function dispatchPaletteEntry(index = paletteActiveIndex): void {
  const entries = buildCommandPaletteEntries(commandAvailabilityContext(), recents, paletteInput.value); const entry = entries[index]; if (!entry) return;
  if (entry.kind === "recent") { if (!commandAvailabilityContext().canOpenDocument) { active().session.reader.setStatus("TAB_CAPACITY"); render(); return; } void invoke("open_recent", { recentId: entry.recentId }).catch(reportOpenInvokeFailure); closePalette(); return; }
  const binding = DEFAULT_BINDINGS.find((candidate) => candidate.id === entry.id); if (!binding || !isCommandEnabled(binding, commandAvailabilityContext())) return;
  const paletteAction = resolvePaletteBindingAction(binding); if (paletteAction?.kind === "dispatch") dispatch(paletteAction.action);
  if (paletteAction?.kind === "page.target") { const result = engine.enterPagePrompt(sequenceContext()); for (const dispatched of result.dispatches) dispatch(dispatched.action); if (result.error) active().session.reader.setStatus(result.error); } closePalette();
}
function renderPalette(): void {
  const entries = buildCommandPaletteEntries(commandAvailabilityContext(), recents, paletteInput.value); paletteActiveIndex = Math.min(paletteActiveIndex, Math.max(0, entries.length - 1));
  paletteList.replaceChildren(...entries.map((entry, index) => { const item = document.createElement("li"); const button = document.createElement("button"); button.type = "button"; button.className = "command-palette-entry"; button.textContent = entry.kind === "recent" ? entry.displayName : entry.label; button.setAttribute("aria-selected", String(index === paletteActiveIndex)); button.disabled = entry.kind === "recent" ? !commandAvailabilityContext().canOpenDocument : !entry.enabled; button.addEventListener("click", () => { paletteActiveIndex = index; dispatchPaletteEntry(); }); item.append(button); return item; }));
}
function dispatch(action: Action): void {
  const type = action.type;
  if (type === "document.open") { if (!commandAvailabilityContext().canOpenDocument) { active().session.reader.setStatus("TAB_CAPACITY"); render(); return; } shellOpen.requestOpen(); return; }
  if (type === "tab.activate") { const tab = action.index === -1 ? workspace.snapshot.tabs[workspace.snapshot.tabs.length - 1] : workspace.snapshot.tabs[action.index]; if (tab) void switchTab(tab.id); return; }
  if (type === "tab.close") { closeTab(workspace.activeTabId); return; }
  if (type === "tab.new") { appendTab(); return; }
  if (type === "palette.toggle") { openPalette(); return; }
  const payload = active(); const session = payload.session; session.apply(action); const reader = session.snapshot.reader;
  if (type.startsWith("page.")) void session.renderPage(reader.page); if (type.startsWith("view.")) void session.renderCurrentView();
  if (type === "search.open") { searchInput.value = session.query; searchDialog.showModal(); searchInput.focus(); }
  if (type === "linkHints.toggle") session.toggleHints(); if (type === "prompt.cancel") session.cancelHints();
  if (type.startsWith("scroll.")) { const intent = session.reader.consumePendingScroll(); payload.host.scrollBy({ left: intent.horizontalCssPixels, top: intent.verticalCssPixels + intent.viewportFactor * payload.host.clientHeight }); }
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
searchInput.addEventListener("input", () => active().session.invalidateSearch());
window.addEventListener("resize", () => { scheduleDprPollFallback(); void active().session.renderCurrentView(); });
window.addEventListener("blur", keyboard.cancelPending);
window.addEventListener("compositionstart", keyboard.cancelPending);
window.addEventListener("focusin", (event) => { if (isNativeOwnedTarget(event.target)) keyboard.cancelPending(); });
searchForm.addEventListener("submit", (event) => event.preventDefault());
searchInput.addEventListener("keydown", (event) => {
  if (isNativeKeyboardCompositionOrModifierEvent(event)) return;
  const action = getPromptKeyAction(event);
  if (action === "close") {
    event.preventDefault();
    searchDialog.close();
  } else if (action === "search" || action === "searchReverse") {
    event.preventDefault();
    active().session.submitSearch(searchInput.value, action === "searchReverse");
  }
});
paletteInput.addEventListener("input", renderPalette);
paletteForm.addEventListener("submit", (event) => { event.preventDefault(); dispatchPaletteEntry(); });
window.addEventListener("focus", () => removedTabTeardown.retryParked());
paletteInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); closePalette(); return; }
  const down = event.key === "ArrowDown" || (event.ctrlKey && event.key.toLowerCase() === "j");
  const up = event.key === "ArrowUp" || (event.ctrlKey && event.key.toLowerCase() === "k");
  if (event.key === "Enter") { event.preventDefault(); dispatchPaletteEntry(); return; }
  if (!down && !up) return;
  event.preventDefault();
  const count = buildCommandPaletteEntries(commandAvailabilityContext(), recents, paletteInput.value).length;
  if (count > 0) { paletteActiveIndex = (paletteActiveIndex + (down ? 1 : count - 1)) % count; renderPalette(); }
});
helpDialog.addEventListener("cancel", (event) => { event.preventDefault(); active().session.apply({ type: "prompt.cancel" }); helpDialog.close(); render(); });
window.addEventListener("beforeunload", () => {
  shellOpen.dispose();
  removedTabTeardown.dispose();
  keyboard.dispose();
  passwordInput.value = "";
  for (const tab of workspace.snapshot.tabs) workspace.close(tab.id);
  disposeDprChange();
});
paletteDialog.addEventListener("cancel", (event) => { event.preventDefault(); closePalette(); });
render();
