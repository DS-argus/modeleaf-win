import "./styles/app.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnnotationMode, getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { TabWorkspace, type TabId } from "./core/TabWorkspace";
import type { Action } from "./core/Action";
import { wheelPageDirection } from "./platform/readerInput";
import { type OpenFailureNotice, type OpenRequestAdoption } from "./platform/OpenRequestClient";
import { validateProductConfig } from "./domain/config/ConfigValidator";
import { createRootKeyboardRouter } from "./platform/RootKeyboardRouter";
import type { ActionId, ActionRuntimeContext } from "./domain/actions/ActionRegistry";
import { nativeOpenError } from "./domain/navigation/OpenError";
import { buildCommandPaletteEntries, commandPaletteKeyAction, isPaletteClearShortcut, moveCommandPaletteIndex, type CommandPaletteCommandEntry, type RecentPaletteRecord } from "./ui/CommandPaletteModel";
import { bindSearchPrompt } from "./ui/SearchPromptController";
import { buildHelpRows } from "./ui/HelpModel";
import { buildWindowsMenuModel } from "./application/commands/WindowsMenuModel";
import { createRemovedTabTeardownSupervisor, createShellOpenCoordinator, createWorkspaceTransitionQueue } from "./platform/ShellOpenCoordinator";
import { PDFJS_POLICY } from "./pdf/PdfJsPolicy";
import { DEFAULT_THEME_ID, THEME_TOKENS, adoptDurableThemeState, isThemeId, themeForId, type DurableThemeState, type ThemeId } from "./domain/theme/Theme";
import { CLOSED_THEME_PICKER, THEME_PICKER_ROWS, commitThemePicker, openThemePicker as createThemePicker, previewThemePickerRow, revertThemePicker, revertThemePickerToDurable, themePickerDialogKeyAction, type ThemePickerModel, type ThemePickerOpenModel } from "./ui/ThemePickerModel";
import { createOverlayOwner, reduceOverlayOwner, type OverlayId, type OverlayOwnerState } from "./ui/overlays/OverlayOwner";
import { overlayOwnsKey } from "./ui/overlays/OverlayKeyOwnership";
import { bindCopyContextMenu } from "./ui/reader/CopyContextMenu";
import { projectWindowShell } from "./ui/shell/ShellProjection";
import { AccessibilityController, readerAccessibilityName, tabAccessibilitySemantics } from "./ui/AccessibilityController";
import { PdfTabSession, publishActivateAndAdoptPdfTab } from "./pdf/PdfTabSession";
import type { PdfLoadingTask } from "./pdf/PdfReaderController";
import { ResourceReservationManager } from "./pdf/ResourceBudget";
import { DEFAULT_INDICATOR_SETTINGS, type IndicatorSettings } from "./domain/links/IndicatorSettings";
import { readIndicatorState } from "./platform/tauri-commands";

const shellConfigResult = validateProductConfig({});
if (!shellConfigResult.ok) throw new Error("BUILT_IN_CONFIG_INVALID");
const shellConfig = shellConfigResult.value;
let indicatorSettings: IndicatorSettings = DEFAULT_INDICATOR_SETTINGS;
void readIndicatorState(invoke).then((value) => { if (value !== undefined) indicatorSettings = value; }, () => undefined);
const IMPLEMENTED_ACTION_IDS: ReadonlySet<ActionId> = new Set<ActionId>([
  "document.open", "document.close", "document.print", "app.quit", "app.new", "palette.open", "help.show",
  "tab.next", "tab.previous", "tab.select.1", "tab.select.2", "tab.select.3", "tab.select.4", "tab.select.5", "tab.select.6", "tab.select.7", "tab.select.8", "tab.select.9",
  "scroll.left", "scroll.down", "scroll.up", "scroll.right", "scroll.largeDown", "scroll.largeUp",
  "page.next", "page.previous", "page.first", "page.last", "page.prompt", "prompt.commit", "prompt.cancel",
  "search.prompt", "search.next", "search.previous", "search.cancel", "view.zoomIn", "view.zoomOut", "view.zoomReset", "view.fitWidth", "view.fitPage", "view.rotateLeft", "view.rotateRight", "link.hint",
  "config.writeDefault", "config.resetDefault", "theme.picker",
  "history.back", "history.forward",
]);
function isNativeCompositionEvent(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229 || event.key === "Dead" || event.key === "Process" || event.key === "Unidentified" || event.getModifierState("AltGraph") || (event.ctrlKey && event.altKey);
}
function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  return element !== null && element.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']") !== null;
}
function isOverlayOwnedKey(event: KeyboardEvent, target: Element | null): boolean {
  const dialog = target?.closest("dialog");
  return dialog instanceof HTMLDialogElement && overlayOwnsKey({ dialogId: dialog.id, key: event.key, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey });
}
function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing required element: ${selector}`);
  return value;
}

const root = required<HTMLElement>("#app");
root.innerHTML = `
<section id="app-shell" data-testid="app-shell" class="app-shell" tabindex="-1" role="application" aria-label="Modeleaf PDF reader">
  <nav id="windows-menu" data-testid="windows-menu" class="windows-menu" aria-label="Application menu"></nav>
  <div id="tab-strip" data-testid="tab-strip" class="tab-strip" role="tablist" aria-label="Open PDFs"></div>
  <main id="reader-main" data-testid="reader-main" aria-label="PDF reader"><section id="tab-hosts" class="tab-hosts"></section><section id="empty-reader" data-testid="empty-reader" class="empty-reader" aria-labelledby="empty-reader-title"><h1 id="empty-reader-title">No PDF open</h1><p>Open a PDF to start reading.</p><button id="empty-reader-open" type="button">Open PDF…</button></section></main>
  <section id="prompt" class="prompt" hidden></section>
  <dialog id="theme-dialog" class="mac-overlay theme-overlay" aria-labelledby="theme-title"><form id="theme-form"><h2 id="theme-title">Theme</h2><p id="theme-description" class="visually-hidden">Arrow keys or Control J and K preview a theme. Enter saves it. Escape restores the previous theme.</p><div id="theme-list" class="theme-list" role="radiogroup" aria-describedby="theme-description"></div><menu class="visually-hidden"><button id="theme-cancel" type="button">Cancel</button><button id="theme-apply" type="submit">Apply theme</button></menu></form></dialog>
  <dialog id="help-dialog" class="mac-overlay help-overlay" aria-label="Keyboard shortcuts"><div id="help-rows" class="help-groups"></div></dialog>
  <dialog id="search-dialog" aria-labelledby="search-title"><form id="search-form" autocomplete="off"><h2 id="search-title">Search PDF text</h2><label>Literal text <input id="search-input" type="search" spellcheck="false"></label><p class="dialog-hint">Press <kbd>Enter</kbd> to start or restart the search. Close the prompt to use configured next and previous shortcuts.</p></form></dialog>
  <dialog id="file-opener-dialog" class="mac-overlay list-overlay" aria-label="Open PDF"><form id="file-opener-form"><input id="file-opener-input" type="search" autocomplete="off" spellcheck="false" placeholder="Type to search..." aria-label="Filter recent PDFs"><ul id="file-opener-list" class="overlay-list"></ul><p class="overlay-footer"><kbd>Ctrl+J/K</kbd> move · <kbd>Ctrl+Shift+C</kbd> clear · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close</p></form></dialog>
  <dialog id="command-palette-dialog" class="mac-overlay list-overlay" aria-label="Command palette"><form id="command-palette-form"><input id="palette-input" type="search" autocomplete="off" spellcheck="false" placeholder="Type a command..." aria-label="Filter commands"><ul id="palette-list" class="overlay-list command-palette-list"></ul></form></dialog>
  <footer id="status" data-testid="reader-status" class="statusbar" role="status" aria-live="polite" aria-atomic="true"></footer>
  <div id="announcements-polite" class="visually-hidden" aria-live="polite" aria-atomic="true"></div>
  <div id="announcements-assertive" class="visually-hidden" aria-live="assertive" aria-atomic="true"></div>
</section>`;

const windowsMenu = required<HTMLElement>("#windows-menu");
const tabStrip = required<HTMLElement>("#tab-strip");
const tabHosts = required<HTMLElement>("#tab-hosts");
const emptyReader = required<HTMLElement>("#empty-reader");
const emptyReaderOpen = required<HTMLButtonElement>("#empty-reader-open");
const status = required<HTMLElement>("#status");
const prompt = required<HTMLElement>("#prompt");
const helpDialog = required<HTMLDialogElement>("#help-dialog");
const helpRows = required<HTMLElement>("#help-rows");
const searchDialog = required<HTMLDialogElement>("#search-dialog");
const searchForm = required<HTMLFormElement>("#search-form");
const searchInput = required<HTMLInputElement>("#search-input");
const fileOpenerDialog = required<HTMLDialogElement>("#file-opener-dialog");
const fileOpenerForm = required<HTMLFormElement>("#file-opener-form");
const fileOpenerInput = required<HTMLInputElement>("#file-opener-input");
const fileOpenerList = required<HTMLElement>("#file-opener-list");
const paletteDialog = required<HTMLDialogElement>("#command-palette-dialog");
const paletteInput = required<HTMLInputElement>("#palette-input");
const SHELL_WINDOW_ID = "current-window";
let cancelPendingShellInput: () => void = () => undefined;
let focusOwnerSequence = 0;
let overlayOwner: OverlayOwnerState = createOverlayOwner(SHELL_WINDOW_ID, "empty-reader-open");
function focusTargetId(element: HTMLElement | null): string | undefined {
  if (element === null || element === document.body) return undefined;
  if (element.id.length === 0) { focusOwnerSequence += 1; element.id = `shell-focus-${focusOwnerSequence}`; }
  return element.id;
}
function isRestorableFocusTarget(target: string): boolean {
  const element = document.getElementById(target);
  if (!(element instanceof HTMLElement) || !element.isConnected || element === document.body) return false;
  if (element.matches(":disabled") || element.closest("[hidden], [inert], dialog:not([open])") !== null) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && (element.tabIndex >= 0 || element.isContentEditable);
}
function restoreOwnedFocus(target: string): void {
  const candidates = [target, currentFocusFallback(), "app-shell"];
  for (const candidate of candidates) {
    if (candidate !== "app-shell" && !isRestorableFocusTarget(candidate)) continue;
    const element = document.getElementById(candidate);
    if (!(element instanceof HTMLElement)) continue;
    element.focus({ preventScroll: true });
    if (document.activeElement === element) return;
  }
}
function currentFocusFallback(): string { return active().session.snapshot.reader.hasDocument ? focusTargetId(active().host) ?? "empty-reader-open" : "empty-reader-open"; }
function overlayDialog(id: OverlayId): HTMLDialogElement | undefined {
  if (id === "theme") return themeDialog;
  if (id === "commandPalette") return paletteDialog;
  if (id === "recent") return fileOpenerDialog;
  if (id === "search") return searchDialog;
  if (id === "help") return helpDialog;
  return undefined;
}
function applyOverlayEffects(effects: ReturnType<typeof reduceOverlayOwner>["effects"]): void {
  for (const effect of effects) {
    if (effect.type === "hide") { const dialog = overlayDialog(effect.overlay); if (dialog?.open === true) dialog.close(); }
    else if (effect.type === "show") { const dialog = overlayDialog(effect.overlay); if (dialog !== undefined && !dialog.open) dialog.showModal(); }
    else if (effect.type === "restorePrompt") {
      if (effect.prompt.kind === "page") { pagePromptDigits = effect.prompt.text; prompt.hidden = false; prompt.textContent = `Go to page: ${pagePromptDigits || "_"}`; }
      else { searchInput.value = effect.prompt.text; searchInput.setSelectionRange(effect.prompt.selectionStart, effect.prompt.selectionEnd); }
    }
    else if (effect.type === "focus") restoreOwnedFocus(effect.target);
  }
}
function claimOverlay(id: OverlayId): void {
  active().session.dismissLinkDecorations();
  if (overlayOwner.active === undefined) overlayOwner = createOverlayOwner(SHELL_WINDOW_ID, currentFocusFallback());
  const focusedTarget = focusTargetId(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const suspendedPrompt = pagePromptDigits === undefined ? undefined : { kind: "page" as const, text: pagePromptDigits, selectionStart: pagePromptDigits.length, selectionEnd: pagePromptDigits.length };
  if (suspendedPrompt !== undefined) pagePromptDigits = undefined;
  const transition = reduceOverlayOwner(overlayOwner, { type: "open", windowId: SHELL_WINDOW_ID, overlay: id, ...(focusedTarget === undefined ? {} : { focusedTarget }), ...(suspendedPrompt === undefined ? {} : { suspendedPrompt }) }, (target) => isRestorableFocusTarget(target));
  overlayOwner = transition.state;
  applyOverlayEffects(transition.effects);
  cancelPendingShellInput();
}
function releaseOverlay(id: OverlayId): void {
  const transition = reduceOverlayOwner(overlayOwner, { type: "close", windowId: SHELL_WINDOW_ID, overlay: id }, (target) => isRestorableFocusTarget(target));
  overlayOwner = transition.state;
  applyOverlayEffects(transition.effects);
}
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
function restoreThemeFocus(): void { releaseOverlay("theme"); }
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
  claimOverlay("theme");
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
  if (isNativeCompositionEvent(event)) return;
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
  cancelSession: (session: { readonly sessionId: string; readonly documentGeneration: number }, sessionOwnerGeneration: number) => invoke<{ readonly barrierId: number }>("cancel_pdf_session", { ...session, ownerGeneration: sessionOwnerGeneration }),
  closeSession: (session: { readonly sessionId: string; readonly documentGeneration: number }, barrierId: number, sessionOwnerGeneration: number) => invoke<void>("close_pdf_session", { ...session, ownerGeneration: sessionOwnerGeneration, barrierId }),
};

type TabPayload = { readonly host: HTMLElement; readonly session: PdfTabSession; readonly disposeUi: () => void };
let workspace!: TabWorkspace<TabPayload>;
const resources = new ResourceReservationManager((needed) => {
  if (workspace === undefined || !["canvas-bytes", "canvas-cache-bytes", "text-page-bytes", "text-document-bytes", "text-process-bytes", "search-document-results", "search-process-results", "search-extractor"].includes(needed.kind)) return;
  const activeTabId = workspace.activeTabId;
  for (const tab of workspace.snapshot.tabs) {
    if (tab.id !== activeTabId) tab.payload.session.evictInactiveHeavyResources();
  }
});
let pagePromptDigits: string | undefined;
let configExists = false;
let dialogOpenPending = false;
const OPEN_FAILURE_STATUS: Readonly<Record<OpenFailureNotice["tag"], string>> = {
  DOCUMENT_TOO_LARGE: "This PDF exceeds reader resource limits.",
  MISSING_FILE: "This PDF no longer exists.",
  REMOTE_PATH: "Network PDFs are not supported. Copy the PDF to a local drive and open the local copy.",
  PATH_REJECTED: "Network PDFs are not supported. Copy the PDF to a local drive and open the local copy.",
  PDF_INVALID: "Could not read this PDF.",
  FILE_UNREADABLE: "Could not read this PDF.",
  SESSION_CAPACITY: "This PDF exceeds reader resource limits.",
};
function openFailureTag(value: unknown): OpenFailureNotice["tag"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("tag" in value)) return undefined;
  const tag = value.tag;
  return tag === "DOCUMENT_TOO_LARGE" || tag === "MISSING_FILE" || tag === "REMOTE_PATH" || tag === "PATH_REJECTED" || tag === "PDF_INVALID" || tag === "FILE_UNREADABLE" || tag === "SESSION_CAPACITY" ? tag : undefined;
}
function reportOpenInvokeFailure(error?: unknown): void {
  const tag = openFailureTag(error);
  active().session.reader.setStatus(tag === undefined ? "The PDF could not be opened." : OPEN_FAILURE_STATUS[tag]);
  const openError = tag === undefined ? undefined : nativeOpenError(tag);
  const accessibleError = openError === "unsupportedLocation" ? "document-locality-denied"
    : openError === "malformedDocument" || openError === "unreadableFile" || openError === "missingFile" ? "document-invalid"
    : "document-unavailable";
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
let fileOpenerActiveIndex = 0;
let fileOpenerRecents: readonly RecentPaletteRecord[] = [];
const workspaceTransitions = createWorkspaceTransitionQueue(() => {
  active().session.reader.setStatus("WORKSPACE_BUSY");
  render();
});
const removedTabTeardown = createRemovedTabTeardownSupervisor<TabPayload>({
  remove: (value) => { value.disposeUi(); value.host.remove(); },
  close: (value) => value.session.close(),
});
function queueWorkspaceTransition(work: () => Promise<void> | void): Promise<void> { return workspaceTransitions.enqueue(work); }
function queueWorkspaceOwnership(work: () => Promise<void> | void): Promise<void> { return workspaceTransitions.enqueueOwnership(work); }
function queueWorkspaceActivation(work: () => Promise<void> | void): Promise<void> { return workspaceTransitions.enqueueActivation(work); }
function disposeWorkspaceTab(value: TabPayload): void { removedTabTeardown.remove(value); }

function active(): TabPayload { const value = workspace.getPayload(workspace.activeTabId); if (!value) throw new Error("ACTIVE_TAB_MISSING"); return value; }
function commandAvailabilityContext(): ActionRuntimeContext {
  const hasDocument = active().session.snapshot.reader.hasDocument;
  const canCreateSession = workspace.snapshot.tabs.length < 8;
  return {
    hasDocument,
    canCreateSession,
    canOpenDocument: workspace.snapshot.tabs.some((tab) => !tab.payload.session.snapshot.reader.hasDocument) || canCreateSession,
    canCreateWindow: true,
    tabCount: workspace.snapshot.tabs.length,
    paneCount: 1,
    modalOpen: dialogOpenPending || searchDialog.open || helpDialog.open || themeDialog.open || paletteDialog.open || fileOpenerDialog.open,
    updateAvailable: false,
    configExists,
    searchActive: active().session.query.length > 0,
    canHistoryBack: active().session.canHistoryBack,
    canHistoryForward: active().session.canHistoryForward,
    linkCount: active().session.visibleLinkCount,
    implementedActionIds: IMPLEMENTED_ACTION_IDS,
  };
}
function renderWindowsMenu(model: ReturnType<typeof buildWindowsMenuModel>): void {
  windowsMenu.replaceChildren(...model.map((section) => {
    const group = document.createElement("details");
    const summary = document.createElement("summary"); summary.textContent = section.label;
    const commands = document.createElement("div"); commands.className = "windows-menu-commands"; commands.setAttribute("role", "menu");
    commands.replaceChildren(...section.commands.map((command) => {
      const button = document.createElement("button"); button.type = "button"; button.setAttribute("role", "menuitem"); button.disabled = !command.enabled;
      button.textContent = command.shortcuts.length === 0 ? command.title : `${command.title}  ${command.shortcuts.join(", ")}`;
      if (!command.enabled && command.disabledReason !== undefined) { button.title = command.disabledReason; button.setAttribute("aria-description", command.disabledReason); }
      button.addEventListener("click", () => { group.open = false; dispatchActionId(command.id); });
      return button;
    }));
    group.append(summary, commands); return group;
  }));
}
function renderHelpRows(): void {
  const groups = new Map<string, ReturnType<typeof buildHelpRows>>();
  for (const row of buildHelpRows(commandAvailabilityContext())) {
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
      description.textContent = row.enabled ? row.label : `${row.label} — ${row.disabledReason ?? "Unavailable"}`;
      description.setAttribute("aria-disabled", String(!row.enabled));
      const shortcut = document.createElement("dd");
      shortcut.textContent = row.shortcut;
      list.append(description, shortcut);
    }
    section.append(heading, list);
    return section;
  }));
}
function reportPresentationFailure(session: PdfTabSession, error: unknown): void {
  if (!(error instanceof Error && error.message === "PDF_RESIDENT_AUTHORITY_INCOMPLETE")) {
    session.reader.setStatus("PDF presentation could not be updated.");
  }
  render();
}
const boundaryPageTurns = new WeakSet<HTMLElement>();
function turnPageAtBoundary(payload: Pick<TabPayload, "host" | "session">, direction: -1 | 1): boolean {
  if (boundaryPageTurns.has(payload.host)) return true;
  const previousPage = payload.session.snapshot.reader.page;
  payload.session.apply({ type: direction > 0 ? "page.next" : "page.previous" });
  const page = payload.session.snapshot.reader.page;
  if (page === previousPage) return false;
  boundaryPageTurns.add(payload.host);
  rootKeyboard.syncContext();
  render();
  void payload.session.renderPage(page).then((committed) => {
    if (committed && direction < 0) {
      payload.host.scrollTop = Math.max(0, payload.host.scrollHeight - payload.host.clientHeight);
    }
  }).catch((error: unknown) => reportPresentationFailure(payload.session, error)).finally(() => {
    boundaryPageTurns.delete(payload.host);
    rootKeyboard.syncContext();
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
  const copyContextMenu = bindCopyContextMenu({
    readerHost: host,
    writeText: async (text) => {
      if (navigator.clipboard?.writeText === undefined) throw new Error("CLIPBOARD_UNAVAILABLE");
      await navigator.clipboard.writeText(text);
    },
  });
  let session!: PdfTabSession;
  let announcedGeneration = -1;
  session = new PdfTabSession({
    native,
    pdf: { getDocument: (options) => getDocument(options as never) as unknown as PdfLoadingTask, annotationMode: AnnotationMode.DISABLE },
    resources,
    canvasHost: host,
    createContentOptions: (opened, generation) => ({
      onSearchResults: () => undefined,
      requestSearchLanding: async (request) => {
        if (active().session !== session) return "stale";
        const decision = await session.navigateSearchLanding(request);
        if (decision.kind === "verifiedLanding") return "displayedDistinct";
        if (decision.kind === "noOp" || decision.kind === "search-epoch-recorded") return "displayedSame";
        if (decision.kind === "stale") return "stale";
        if (decision.kind === "uncompensatedInvariantFailure") return "displayedAfterUnverifiedMovement";
        return "failedWithoutMovement";
      },
      navigateToPage: (page) => { if (active().session === session) { session.apply({ type: "page.goTo", page }); void session.renderPage(page).catch((error: unknown) => reportPresentationFailure(session, error)); } },
      navigateToDestination: async (page, destination, cause, isActivationCurrent) => {
        if (active().session !== session) return { kind: "stale" };
        try { return await session.navigateToDestination(page, destination, cause, isActivationCurrent); }
        catch (error: unknown) { reportPresentationFailure(session, error); return { kind: "failed" }; }
      },
      prepareExternalLinks: (entries, registryRevision) => invoke<void>("prepare_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision, entries: entries.map((entry) => ({ annotation_id: entry.annotationId, target: entry.target })) }),
      commitExternalLinks: (registryRevision) => invoke<void>("commit_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision }),
      finalizeExternalLinks: (registryRevision) => invoke<void>("finalize_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision }),
      abortExternalLinks: (registryRevision) => invoke<void>("abort_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision }),
      indicatorSettings: () => indicatorSettings,
      openExternal: (annotationId, registryRevision, operationId, operationSequence) => invoke<number>("open_external_link", { request: { operationId, operationSequence, sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision, annotationId } }),
    }),
    onStatus: () => {
      render();
      if (workspace === undefined || active().session !== session) return;
      const snapshot = session.snapshot;
      const reader = snapshot.reader;
      if (reader.hasDocument) queueMicrotask(scheduleViewportSync);
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
  let viewportSynchronization: Promise<boolean> | undefined;
  let viewportDisposed = false;
  let viewportResyncRequested = false;
  const synchronizeContinuousViewport = (): void => {
    viewportFrameRequest = undefined;
    viewportResyncRequested = false;
    if (viewportDisposed || active().session !== session || viewportSynchronization !== undefined) return;
    viewportSynchronization = session.synchronizeViewport(host.scrollTop, host.clientHeight);
    const viewportSettlement = viewportSynchronization.catch((error: unknown) => {
      reportPresentationFailure(session, error);
      return false;
    });
    void viewportSettlement.finally(() => {
      viewportSynchronization = undefined;
      rootKeyboard.syncContext();
      render();
      if (viewportResyncRequested && !viewportDisposed && active().session === session) scheduleViewportSync();
    });
  };
  const scheduleViewportSync = (): void => {
    if (viewportDisposed || viewportFrameRequest !== undefined) return;
    if (viewportSynchronization !== undefined) { viewportResyncRequested = true; return; }
    viewportFrameRequest = window.requestAnimationFrame(synchronizeContinuousViewport);
  };
  const onReaderScroll = (): void => {
    if (!session.indicatorPublicationPending) session.dismissLinkDecorations();
    session.clearVisibleLinkAuthority();
    session.invalidateViewportSynchronization();
    scheduleViewportSync();
  }
  host.addEventListener("scroll", onReaderScroll, { passive: true });
  queueMicrotask(scheduleViewportSync);
  return { host, session, disposeUi: () => {
    viewportDisposed = true;
    if (viewportFrameRequest !== undefined) window.cancelAnimationFrame(viewportFrameRequest);
    host.removeEventListener("scroll", onReaderScroll);
    copyContextMenu.dispose();
  } };
}
workspace = new TabWorkspace(createTab, 8, { dispose: disposeWorkspaceTab });
active().session.activate();

function render(): void {
  const current = active();
  const snapshot = current.session.snapshot;
  const shell = projectWindowShell({
    windowId: SHELL_WINDOW_ID,
    activePaneId: "primary",
    panes: [{ id: "primary", activeTabId: String(workspace.activeTabId), tabs: workspace.snapshot.tabs.map((tab) => { const payload = workspace.getPayload(tab.id); if (payload === undefined) throw new Error("SHELL_TAB_PAYLOAD_MISSING"); const tabSnapshot = payload.session.snapshot; return { id: String(tab.id), title: tabSnapshot.title, hasDocument: tabSnapshot.reader.hasDocument, status: tabSnapshot.status }; }) }],
  });
  if (!shell.ok) throw new Error(`SHELL_PROJECTION_INVALID:${shell.code}`);
  const menuModel = buildWindowsMenuModel(commandAvailabilityContext(), shellConfig);
  root.dataset.menuCommandCount = String(menuModel.reduce((count, section) => count + section.commands.length, 0));
  renderWindowsMenu(menuModel);
  const openCommand = menuModel.flatMap((section) => section.commands).find(({ id }) => id === "document.open");
  if (openCommand !== undefined) {
    emptyReaderOpen.textContent = openCommand.shortcuts.length === 0 ? openCommand.title : `${openCommand.title} (${openCommand.shortcuts.join(", ")})`;
    emptyReaderOpen.disabled = !openCommand.enabled;
    emptyReaderOpen.title = openCommand.disabledReason ?? "";
  }
  status.textContent = snapshot.status;
  emptyReader.hidden = shell.emptyState === undefined;
  emptyReader.setAttribute("aria-hidden", String(shell.emptyState === undefined));
  if (snapshot.reader.helpVisible && !helpDialog.open) { claimOverlay("help"); helpDialog.showModal(); }
  if (!snapshot.reader.helpVisible && helpDialog.open) { helpDialog.close(); releaseOverlay("help"); }
  renderHelpRows();
  prompt.hidden = pagePromptDigits === undefined;
  prompt.textContent = pagePromptDigits === undefined ? "" : `Go to page: ${pagePromptDigits || "_"}`;
  const tabs = workspace.snapshot.tabs;
  for (const [index, tab] of tabs.entries()) {
    const selected = tab.id === workspace.activeTabId;
    const title = tab.payload.session.snapshot.title;
    tab.payload.host.hidden = !selected || !tab.payload.session.snapshot.reader.hasDocument;
    tab.payload.host.setAttribute("aria-hidden", String(!selected || !tab.payload.session.snapshot.reader.hasDocument));
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
async function activateCurrentTab(focus = false): Promise<void> { const current = active(); await current.session.activate(); render(); if (focus) current.host.focus(); }
function switchTab(id: TabId): Promise<void> { return queueWorkspaceActivation(async () => {
  if (id === workspace.activeTabId) {
    if (active().session.snapshot.active) return;
    try { await activateCurrentTab(true); } catch { active().session.reader.setStatus("Could not activate this tab."); render(); }
    return;
  }
  const priorId = workspace.activeTabId;
  const prior = active();
  try {
    await prior.session.deactivate();
    if (!workspace.activate(id)) { await prior.session.activate(); render(); return; }
    try { await activateCurrentTab(true); } catch (error) {
      workspace.activate(priorId);
      await prior.session.activate();
      render();
      throw error;
    }
  } catch {
    prior.session.reader.setStatus("Could not switch tabs.");
    render();
  }
}); }
function closeTab(id: TabId): void {
  void queueWorkspaceTransition(async () => {
    const wasActive = id === workspace.activeTabId;
    if (!workspace.close(id)) return;
    if (wasActive) await activateCurrentTab(); else render();
  }).catch(() => {
    active().session.reader.setStatus("Could not activate the tab after closing.");
    render();
  });
}
async function adoptRequest(request: OpenRequestAdoption): Promise<void> {
  let adoptedSession: PdfTabSession | undefined;
  await queueWorkspaceOwnership(async () => {
    const priorActiveId = workspace.activeTabId;
    let id = priorActiveId;
    let payload = active();
    let staged = false;
    const emptyTab = workspace.snapshot.tabs.find((tab) => !tab.payload.session.snapshot.reader.hasDocument);
    if (emptyTab && emptyTab.id !== id) {
      await payload.session.deactivate();
      if (!workspace.activate(emptyTab.id)) { await activateCurrentTab(); throw new Error("EMPTY_TAB_MISSING"); }
      id = emptyTab.id;
      payload = emptyTab.payload;
    } else if (payload.session.snapshot.reader.hasDocument) {
      await payload.session.deactivate();
      payload = createTab();
      const stagedId = workspace.stageAdoption(payload, { dispose: disposeWorkspaceTab });
      if (stagedId === null) { disposeWorkspaceTab(payload); await activateCurrentTab(); throw new Error("TAB_CAPACITY"); }
      id = stagedId;
      staged = true;
    }
    try {
      await publishActivateAndAdoptPdfTab(render, payload.session, () => payload.session.adopt(request, request.ownerGeneration));
      if (staged && !workspace.commitAdoption(id)) throw new Error("ADOPTION_COMMIT_FAILED");
      await activateCurrentTab();
      adoptedSession = payload.session;
    } catch (error) {
      const candidateStatus = safeAdoptionFailureStatus(payload.session.snapshot.status);
      if (staged) workspace.rollbackAdoption(id);
      else if (id !== priorActiveId) {
        await payload.session.deactivate();
        workspace.activate(priorActiveId);
      }
      await activateCurrentTab();
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
emptyReaderOpen.addEventListener("click", () => dispatchActionId("document.open"));
void invoke<{ readonly tag?: string }>("read_config").then((outcome) => { configExists = outcome.tag === "LOADED"; render(); }, () => undefined);
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
    claimOverlay("commandPalette");
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
  releaseOverlay("commandPalette");
}
function dispatchPaletteEntry(index = paletteActiveIndex): void {
  const entry = paletteEntries()[index];
  if (!entry) return;
  if (!entry.enabled) {
    active().session.reader.setStatus(entry.disabledReason ?? "ACTION_DISABLED");
    render();
    return;
  }
  closePalette();
  dispatchActionId(entry.id);
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
    button.setAttribute("aria-disabled", String(!entry.enabled));
    const label = document.createElement("span");
    label.textContent = entry.label;
    const shortcut = document.createElement("span");
    shortcut.className = "command-palette-entry-shortcut";
    shortcut.textContent = entry.shortcut;
    if (!entry.enabled && entry.disabledReason !== undefined) {
      const reason = document.createElement("span");
      reason.className = "command-palette-entry-reason";
      reason.textContent = entry.disabledReason;
      button.setAttribute("aria-description", entry.disabledReason);
      button.append(reason);
    }
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
  releaseOverlay("recent");
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
  claimOverlay("recent");
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
let windowCloseUnlisten: (() => void) | undefined;
function requestApplicationQuit(beginNative = true, currentWindowOnly = false, closeRequestId?: number): Promise<void> {
  if (quitRequest !== undefined) return quitRequest;
  quitRequest = (async () => {
    if (beginNative && !currentWindowOnly) await invoke("begin_quit");
    let rendererDrained = false;
    try {
      if (themeDialog.open) closeThemePicker(true);
      if (paletteDialog.open) closePalette();
      if (fileOpenerDialog.open) closeFileOpener();
      if (helpDialog.open) helpDialog.close();
      if (searchDialog.open) searchDialog.close();
      shellDisposing = true;
      themeUnlisten?.();
      quitUnlisten?.();
      windowCloseUnlisten?.();
      shellOpen.dispose();
      const tabs = workspace.snapshot.tabs.map((tab) => ({ id: tab.id, payload: workspace.getPayload(tab.id) })).filter((entry): entry is { id: TabId; payload: TabPayload } => entry.payload !== undefined);
      await Promise.allSettled(tabs.map(({ payload }) => payload.session.close()));
      for (const { id } of tabs) workspace.close(id);
      removedTabTeardown.retryParked();
      removedTabTeardown.dispose();
      disposeSearchPrompt();
      rootKeyboard.dispose();
      disposeDprChange();
      resources.assertEmpty();
      rendererDrained = true;
    } finally {
      if (currentWindowOnly) await invoke("close_current_window", closeRequestId === undefined ? { rendererDrained } : { requestId: closeRequestId, rendererDrained });
      else await invoke("finish_quit", { rendererDrained });
    }
  })();
  return quitRequest;
}
void listen<{ readonly requestId?: number }>("window-close-requested", (event) => {
  if (typeof event.payload.requestId === "number" && Number.isSafeInteger(event.payload.requestId)) void requestApplicationQuit(false, true, event.payload.requestId);
}).then(
  (unlisten) => { if (shellDisposing) unlisten(); else { windowCloseUnlisten = unlisten; void invoke("window_close_ready"); } },
  () => undefined,
);
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
function dispatchActionId(id: ActionId): void {
  if (id === "history.back") { void active().session.navigateHistoryBack().then(render, (error: unknown) => reportPresentationFailure(active().session, error)); return; }
  if (id === "history.forward") { void active().session.navigateHistoryForward().then(render, (error: unknown) => reportPresentationFailure(active().session, error)); return; }
  const tabSelection = /^tab\.select\.(\d)$/u.exec(id);
  if (tabSelection !== null) { dispatch({ type: "tab.activate", index: Number(tabSelection[1]) - 1 }); return; }
  const direct: Partial<Record<ActionId, Action>> = {
    "document.open": { type: "document.open" }, "document.close": { type: "tab.close" }, "document.print": { type: "document.print" },
    "app.quit": { type: "application.quit" }, "app.new": { type: "application.new" }, "palette.open": { type: "palette.toggle" }, "help.show": { type: "help.toggle" },
    "tab.next": { type: "tab.next" }, "tab.previous": { type: "tab.previous" },
    "scroll.left": { type: "scroll.byCssPixels", axis: "horizontal", delta: -32 }, "scroll.right": { type: "scroll.byCssPixels", axis: "horizontal", delta: 32 },
    "scroll.down": { type: "scroll.byCssPixels", axis: "vertical", delta: 32 }, "scroll.up": { type: "scroll.byCssPixels", axis: "vertical", delta: -32 },
    "scroll.largeDown": { type: "scroll.byViewport", factor: 0.8 }, "scroll.largeUp": { type: "scroll.byViewport", factor: -0.8 },
    "page.next": { type: "page.next" }, "page.previous": { type: "page.previous" }, "page.first": { type: "page.first" }, "page.last": { type: "page.last" },
    "search.prompt": { type: "search.open" },
    "view.zoomIn": { type: "view.zoom", factor: 1.1 }, "view.zoomOut": { type: "view.zoom", factor: 1 / 1.1 }, "view.zoomReset": { type: "view.actualSize" },
    "view.fitWidth": { type: "view.fitWidth" }, "view.fitPage": { type: "view.fitPage" }, "view.rotateLeft": { type: "view.rotate", quarterTurns: -1 }, "view.rotateRight": { type: "view.rotate", quarterTurns: 1 },
    "link.hint": { type: "linkHints.toggle" }, "theme.picker": { type: "theme.open" }, "prompt.cancel": { type: "prompt.cancel" },
  };
  if (id === "page.prompt") {
    pagePromptDigits = "";
    active().session.reader.setStatus("Go to page");
    render();
    return;
  }
  if (id === "prompt.cancel" && pagePromptDigits !== undefined) {
    pagePromptDigits = undefined;
    active().session.apply({ type: "prompt.cancel" });
    render();
    return;
  }
  if (id === "prompt.commit" && pagePromptDigits !== undefined) {
    const page = Number(pagePromptDigits);
    if (pagePromptDigits.length === 0) active().session.reader.setStatus("Enter a page number.");
    else if (!Number.isSafeInteger(page)) active().session.reader.setStatus("Page number is too large.");
    else if (page < 1) active().session.reader.setStatus("Page numbers start at 1.");
    else if (page > active().session.snapshot.reader.pageCount) active().session.reader.setStatus(`Page ${page} is outside 1–${active().session.snapshot.reader.pageCount}.`);
    else { pagePromptDigits = undefined; void active().session.navigatePagePrompt(page).then(render, (error: unknown) => reportPresentationFailure(active().session, error)); }
    render();
    return;
  }
  if (id === "search.next" || id === "search.previous") {
    active().session.cycleSearch(id === "search.previous");
    render();
    return;
  }
  if (id === "search.cancel") {
    active().session.invalidateSearch();
    render();
    return;
  }
  if (id === "config.writeDefault") {
    void invoke<{ readonly tag?: string }>("write_default_config").then((outcome) => {
      configExists = outcome.tag === "CREATED" || outcome.tag === "ALREADY_EXISTS";
      active().session.reader.setStatus(outcome.tag === "CREATED" ? "Default config written." : outcome.tag === "ALREADY_EXISTS" ? "Config already exists" : "Config could not be written.");
      render();
    });
    return;
  }
  if (id === "config.resetDefault") {
    void invoke<{ readonly tag?: string }>("reset_config").then((outcome) => {
      configExists = outcome.tag !== "MISSING";
      active().session.reader.setStatus(outcome.tag === "REPLACED" || outcome.tag === "UNCHANGED" ? "Config reset to defaults." : "Config could not be reset.");
      render();
    });
    return;
  }
  const action = direct[id];
  if (action !== undefined) { dispatch(action); return; }
  throw new Error(`UNIMPLEMENTED_ACTION_DISPATCH:${id}`);
}
function dispatch(action: Action): void {
  const type = action.type;
  if (type === "document.open") { if (!commandAvailabilityContext().canOpenDocument) { active().session.reader.setStatus("TAB_CAPACITY"); render(); return; } openFileOpener(); return; }
  if (type === "document.print") { void active().session.printCurrent().then(() => render()); return; }
  if (type === "tab.activate") { const tab = action.index === -1 ? workspace.snapshot.tabs[workspace.snapshot.tabs.length - 1] : workspace.snapshot.tabs[action.index]; if (tab) void switchTab(tab.id); return; }
  if (type === "tab.close") { closeTab(workspace.activeTabId); return; }
  if (type === "application.new") { void invoke<void>("create_app_window").catch(() => { active().session.reader.setStatus("WINDOW_CREATE_FAILED"); render(); }); return; }
  if (type === "palette.toggle") { openPalette(); return; }
  if (type === "tab.next") { void switchTab(workspace.adjacentId(1)); return; }
  if (type === "tab.previous") { void switchTab(workspace.adjacentId(-1)); return; }
  if (type === "page.first") { void active().session.navigateFirstPage().then(render, (error: unknown) => reportPresentationFailure(active().session, error)); return; }
  if (type === "page.last") { void active().session.navigateLastPage().then(render, (error: unknown) => reportPresentationFailure(active().session, error)); return; }
  if (type === "theme.open") { openThemePicker(); return; }
  if (type === "application.quit") { void requestApplicationQuit(false, true); return; }
  const payload = active(); const session = payload.session; session.apply(action); const reader = session.snapshot.reader;
  if (type.startsWith("page.")) void session.renderPage(reader.page).catch((error: unknown) => reportPresentationFailure(session, error)); if (type.startsWith("view.")) void session.renderCurrentView().catch((error: unknown) => reportPresentationFailure(session, error));
  if (type === "search.open") { claimOverlay("search"); searchInput.value = session.query; searchDialog.showModal(); searchInput.focus(); }
  if (type === "linkHints.toggle") session.toggleHints(); if (type === "prompt.cancel") session.cancelHints();
  if (type.startsWith("scroll.")) {
    const intent = session.reader.consumePendingScroll();
    const verticalCssPixels = intent.verticalCssPixels + intent.viewportFactor * payload.host.clientHeight;
    const fitPageDirection = reader.zoomMode === "fit-page" && verticalCssPixels !== 0 ? (verticalCssPixels > 0 ? 1 : -1) : 0;
    if (fitPageDirection !== 0) {
      turnPageAtBoundary(payload, fitPageDirection);
      rootKeyboard.syncContext(); render();
      return;
    }
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
  rootKeyboard.syncContext(); render();
}
const rootKeyboard = createRootKeyboardRouter({
  config: shellConfig,
  getContext: () => ({
    windowId: SHELL_WINDOW_ID,
    routeRevision: String(workspace.activeTabId),
    generation: active().session.snapshot.reader.documentGeneration,
    inputContext: pagePromptDigits !== undefined ? "pagePrompt" : searchDialog.open ? "searchPrompt" : active().session.query.length > 0 ? "searchResults" : "navigation",
    runtime: commandAvailabilityContext(),
  }),
  onDispatch: (id, sequenceDispatch) => {
    dispatchActionId(id);
    if (sequenceDispatch.replay !== undefined && pagePromptDigits !== undefined) {
      pagePromptDigits += sequenceDispatch.replay.token;
      active().session.reader.setStatus(`Go to page: ${pagePromptDigits}`);
      render();
    }
  },
  onUnboundToken: (key, context) => {
    if (context.inputContext !== "pagePrompt" || pagePromptDigits === undefined) return false;
    if (/^[0-9]$/u.test(key) && pagePromptDigits.length < 16) pagePromptDigits += key;
    else if (key === "<BS>") pagePromptDigits = pagePromptDigits.slice(0, -1);
    else return false;
    active().session.reader.setStatus(`Go to page: ${pagePromptDigits || "_"}`);
    render();
    return true;
  },
  onDisabled: (_id, reason) => { active().session.reader.setStatus(reason); render(); },
  onState: (state) => { status.textContent = state.kind === "pending" ? `Pending: ${state.sequence}` : active().session.snapshot.status; },
});
cancelPendingShellInput = rootKeyboard.cancelPending;
window.addEventListener("keydown", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const claimed = rootKeyboard.handleKeyDown({
    key: event.key, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
    repeat: event.repeat, isComposing: event.isComposing, keyCode: event.keyCode,
    altGraph: event.getModifierState("AltGraph"),
    nativeOwnedTarget: active().session.hintsVisible || (isEditableTarget(event.target) && !event.ctrlKey && !event.altKey && !event.metaKey) || isOverlayOwnedKey(event, target),
    preventDefault: () => event.preventDefault(),
  });
  if (claimed) event.stopImmediatePropagation();
}, { capture: true });
window.addEventListener("keydown", (event) => {
  const session = active().session;
  if (!session.hintsVisible && !(event.key === "Escape" && session.linkDecorationsVisible)) return;
  const consumed = session.handleHintKey({
    key: event.key,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isComposing: event.isComposing || isNativeCompositionEvent(event),
    keyCode: event.keyCode,
    altGraph: event.getModifierState("AltGraph"),
  });
  if (!consumed) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  render();
}, { capture: true });
const DPR_POLL_DELAY_MS = 250;
let dprMediaQuery: MediaQueryList | undefined;
let dprPollTimer: ReturnType<typeof setTimeout> | undefined;
let devicePixelRatio = window.devicePixelRatio;
const onDprChange = (): void => {
  devicePixelRatio = window.devicePixelRatio;
  bindDprChange();
  const session = active().session;
  session.dismissLinkDecorations();
  void session.renderCurrentView().catch((error: unknown) => reportPresentationFailure(session, error));
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
searchDialog.addEventListener("close", () => releaseOverlay("search"));
const disposeSearchPrompt = bindSearchPrompt(
  { dialog: searchDialog, form: searchForm, input: searchInput },
  () => active().session,
  render,
);
window.addEventListener("resize", () => {
  scheduleDprPollFallback();
  const session = active().session;
  session.dismissLinkDecorations();
  void session.renderCurrentView().catch((error: unknown) => reportPresentationFailure(session, error));
});
window.addEventListener("blur", rootKeyboard.cancelPending);
window.addEventListener("compositionstart", rootKeyboard.cancelPending);
window.addEventListener("focusin", (event) => { if (isEditableTarget(event.target)) rootKeyboard.cancelPending(); });
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
helpDialog.addEventListener("cancel", (event) => { event.preventDefault(); active().session.apply({ type: "prompt.cancel" }); helpDialog.close(); releaseOverlay("help"); render(); });
window.addEventListener("blur", () => active().session.dismissLinkDecorations());
window.addEventListener("beforeunload", () => {
  disposeSearchPrompt();
  themeUnlisten?.();
  quitUnlisten?.();
  windowCloseUnlisten?.();
  shellDisposing = true;
  shellOpen.dispose();
  removedTabTeardown.dispose();
  rootKeyboard.dispose();
  for (const tab of workspace.snapshot.tabs) workspace.close(tab.id);
  disposeDprChange();
});
paletteDialog.addEventListener("cancel", (event) => { event.preventDefault(); closePalette(); });
render();
