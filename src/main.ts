import "./styles/app.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AnnotationMode, getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { TabWorkspace, type TabId } from "./core/TabWorkspace";
import type { Action } from "./core/Action";
import { type OpenFailureNotice, type OpenRequestAdoption } from "./platform/OpenRequestClient";
import { validateProductConfig } from "./domain/config/ConfigValidator";
import { createRootKeyboardRouter } from "./platform/RootKeyboardRouter";
import type { ActionId, ActionRuntimeContext } from "./domain/actions/ActionRegistry";
import { createOpenChooser, chooserRows, updateChooserQuery, moveChooserSelection, selectChooserIndex, adoptChooserSnapshot, retainChooserFailure, type OpenChooserModel } from "./ui/OpenChooserModel";
import { createRecentChooserRenderer } from "./ui/RecentChooserRenderer";
import { openFailureAccessibilityError, openFailurePhase, openFailureStatus, type OpenFailurePhase } from "./domain/navigation/OpenFailureIdentifier";
import { nativeOpenError } from "./domain/navigation/OpenError";
import { buildCommandPaletteEntries, commandPaletteKeyAction, isPaletteClearShortcut, moveCommandPaletteIndex, type CommandPaletteCommandEntry } from "./ui/CommandPaletteModel";
import { renderCommandPalette } from "./ui/CommandPaletteRenderer";
import { bindSearchPrompt } from "./ui/SearchPromptController";
import { buildHelpRows } from "./ui/HelpModel";
import { buildWindowsMenuModel } from "./application/commands/WindowsMenuModel";
import { createShellOpenCoordinator } from "./platform/ShellOpenCoordinator";
import { beginPagePromptCommit, editPagePrompt, navigationFailureStatus, openPagePrompt, revokePagePromptOwnership, settlePagePromptCommit, type PagePromptNavigationKind, type PagePromptState } from "./application/PagePromptTransaction";
import type { InitiatedTerminal } from "./application/OpenFlowCoordinator";
import { performTabActivation, performTabClose, queueRelativeTabActivation } from "./application/TabActivationCoordinator";
import { adoptWithCommittedPresentation, OpenAdoptionPresentationError, rollbackOpenAdoptionOwnership, withOpenAdoptionOwnership } from "./application/OpenAdoptionOwnership";
import { createRemovedTabTeardownSupervisor, createWorkspaceTransitionQueue } from "./application/WorkspaceTransitionQueue";
import { PDFJS_POLICY } from "./pdf/PdfJsPolicy";
import { DEFAULT_THEME_ID, THEME_TOKENS, isThemeId, shouldAdoptDurableThemeState, themeForId, themeContrastEndpoint, type DurableThemeState, type ThemeId } from "./domain/theme/Theme";
import { CLOSED_THEME_PICKER, THEME_PICKER_FOOTER, THEME_PICKER_ROWS, commitThemePicker, openThemePicker as createThemePicker, previewThemePickerRow, revertThemePicker, revertThemePickerToDurable, themePickerDialogKeyAction, type ThemePickerModel, type ThemePickerOpenModel } from "./ui/ThemePickerModel";
import { createOverlayOwner, reduceOverlayOwner, type OverlayId, type OverlayOwnerState } from "./ui/overlays/OverlayOwner";
import { overlayOwnsKey } from "./ui/overlays/OverlayKeyOwnership";
import { bindCopyContextMenu } from "./ui/reader/CopyContextMenu";
import { projectWindowShell } from "./ui/shell/ShellProjection";
import { createTabStripRenderer } from "./ui/shell/TabStripRenderer";
import { loadInstalledVersion } from "./platform/InstalledVersion";
import { createShellStatusRenderer } from "./ui/shell/ShellStatusRenderer";
import { AccessibilityController, readerAccessibilityName, tabAccessibilitySemantics } from "./ui/AccessibilityController";
import { PdfTabSession, publishActivateAndAdoptPdfTab, type PdfTabViewAction } from "./pdf/PdfTabSession";
import { createPasswordPrompt } from "./ui/PasswordPrompt";
import type { PdfLoadingTask } from "./pdf/PdfReaderController";
import { LinkHints, type LinkHintHostContext } from "./ui/LinkHints";
import { ResourceReservationManager } from "./pdf/ResourceBudget";
import { TauriPdfPrintBoundary } from "./pdf/TauriPdfPrintBoundary";
import { createPrintProgress } from "./ui/PrintProgress";
import { PrintProgressOwner } from "./ui/PrintProgressOwner";
import { bindApplicationMenuOwner } from "./ui/shell/ApplicationMenuOwner";
import { projectConfigDiagnostics, summarizeConfigReload, type ConfigReloadOutcome } from "./ui/ConfigDiagnosticsModel";
import { projectUpdateNotice, releasePageUrl, HIDDEN_UPDATE_NOTICE, type UpdateNoticeState } from "./ui/UpdateNoticeModel";
import { clearRecentDocuments, listRecentDocuments, listRecentDisplayAliases, decodeRecentStateChanged, openRecentDocument, readProductConfig, recordRecentDocument } from "./platform/tauri-commands";

const shellConfigResult = validateProductConfig({});
if (!shellConfigResult.ok) throw new Error("BUILT_IN_CONFIG_INVALID");
const shellConfig = shellConfigResult.value;
const IMPLEMENTED_ACTION_IDS: ReadonlySet<ActionId> = new Set<ActionId>([
  "document.open", "document.close", "document.print", "app.quit", "app.new", "palette.open", "help.show",
  "tab.next", "tab.previous",
  "scroll.left", "scroll.down", "scroll.up", "scroll.right", "scroll.largeDown", "scroll.largeUp",
  "page.next", "page.previous", "page.first", "page.last", "page.prompt", "prompt.commit", "prompt.cancel",
  "links.hint",
  "search.prompt", "search.next", "search.previous", "search.cancel", "view.zoomIn", "view.zoomOut", "view.zoomReset", "view.fitWidth", "view.fitPage", "view.rotateLeft", "view.rotateRight",
  "path.showParent", "path.copy",
  "config.writeDefault", "config.resetDefault", "theme.picker",
  "config.reload", "update.show",
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
  const activeOverlay = overlayOwner.active?.id;
  const expectedDialogId = activeOverlay === "commandPalette" ? "command-palette-dialog"
    : activeOverlay === "search" ? "search-dialog"
    : activeOverlay === "help" ? "help-dialog"
    : activeOverlay === "theme" ? "theme-dialog"
    : activeOverlay === "recent" ? "file-opener-dialog"
    : undefined;
  const dialog = target?.closest("dialog");
  return expectedDialogId !== undefined && dialog instanceof HTMLDialogElement && dialog.id === expectedDialogId
    && overlayOwnsKey({ dialogId: expectedDialogId, key: event.key, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey });
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
  <main id="reader-main" data-testid="reader-main" aria-label="PDF reader"><section id="tab-hosts" class="tab-hosts"></section><section id="empty-reader" data-testid="empty-reader" class="empty-reader"><button id="empty-reader-open" type="button" class="empty-reader-action"><span>Open PDF</span><kbd id="empty-reader-shortcut"></kbd></button></section></main>
  <section id="prompt" class="prompt" role="group" aria-label="Go to page" hidden></section>
  <dialog id="theme-dialog" class="mac-overlay theme-overlay" aria-labelledby="theme-title"><form id="theme-form"><h2 id="theme-title">Theme</h2><p id="theme-description" class="visually-hidden">j or k previews a theme. Enter saves it. Escape restores the previous theme.</p><div id="theme-list" class="theme-list" role="radiogroup" aria-describedby="theme-description"></div><p class="overlay-footer theme-footer">${THEME_PICKER_FOOTER.map(({ key, action }) => `<kbd>${key}</kbd> ${action}`).join(" · ")}</p><menu class="visually-hidden"><button id="theme-cancel" type="button">Cancel</button><button id="theme-apply" type="submit">Apply theme</button></menu></form></dialog>
  <dialog id="help-dialog" class="mac-overlay help-overlay" aria-label="Keyboard shortcuts"><div id="help-rows" class="help-groups"></div></dialog>
  <dialog id="search-dialog" class="search-prompt" aria-labelledby="search-title"><form id="search-form" autocomplete="off"><label id="search-title" class="visually-hidden" for="search-input">Search PDF text</label><span class="search-prefix" aria-hidden="true">/</span><input id="search-input" type="search" spellcheck="false" aria-label="Search PDF text" placeholder="Search PDF text"><p class="search-footer"><kbd>Enter</kbd> search · <kbd>Esc</kbd> close</p></form></dialog>
  <dialog id="file-opener-dialog" class="mac-overlay list-overlay file-opener-overlay" aria-labelledby="file-opener-title"><form id="file-opener-form"><label id="file-opener-title" class="visually-hidden" for="file-opener-input">Open PDF</label><input id="file-opener-input" type="search" autocomplete="off" spellcheck="false" placeholder="Filter recent PDFs" aria-label="Filter recent PDFs"><ul id="file-opener-list" class="overlay-list file-opener-list" aria-label="Open PDF choices"></ul><p class="overlay-footer file-opener-footer"><kbd>Ctrl+j/k</kbd> move · <kbd>Ctrl+Shift+c</kbd> clear history · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close</p></form></dialog>
  <dialog id="command-palette-dialog" class="mac-overlay list-overlay" aria-label="Command palette"><form id="command-palette-form"><input id="palette-input" type="search" autocomplete="off" spellcheck="false" placeholder="Type a command..." aria-label="Filter commands"><ul id="palette-list" class="overlay-list command-palette-list"></ul></form></dialog>
  <footer id="status" data-testid="reader-status" class="statusbar" role="status" aria-live="polite" aria-atomic="true"></footer>
  <div id="announcements-polite" class="visually-hidden" aria-live="polite" aria-atomic="true"></div>
  <div id="announcements-assertive" class="visually-hidden" aria-live="assertive" aria-atomic="true"></div>
</section>`;

const windowsMenu = required<HTMLElement>("#windows-menu");
const tabStrip = required<HTMLElement>("#tab-strip");
const shellTabs = createTabStripRenderer(tabStrip, {
  activate: (id) => { const tab = workspace.snapshot.tabs.find((entry) => String(entry.id) === id); if (tab !== undefined) void switchTab(tab.id); },
  close: (id) => { const tab = workspace.snapshot.tabs.find((entry) => String(entry.id) === id); if (tab !== undefined) closeTab(tab.id); },
});
const tabHosts = required<HTMLElement>("#tab-hosts");
const emptyReader = required<HTMLElement>("#empty-reader");
const emptyReaderOpen = required<HTMLButtonElement>("#empty-reader-open");
const emptyReaderShortcut = required<HTMLElement>("#empty-reader-shortcut");
const status = required<HTMLElement>("#status");
const shellStatus = createShellStatusRenderer(status, () => {
  const session = active().session;
  const reader = session.reader.snapshot;
  const presentation = session.committedPresentation ?? reader;
  return {
    hasDocument: reader.hasDocument,
    zoomMode: presentation.zoomMode,
    searchPromptOpen: overlayOwner.active?.id === "search",
    query: session.query,
    status: reader.status,
    page: presentation.page,
    pageCount: reader.pageCount,
    ...(presentation.zoomMode === "custom" ? { zoom: presentation.customScale } : {}),
  };
}, { onHelp: () => dispatch({ type: "help.toggle" }) });
void loadInstalledVersion().then((version) => shellStatus.setVersion(version));
const observedKeyboardViewSettlements = new WeakSet<Promise<boolean>>();
const printProgressOwner = new PrintProgressOwner<PdfTabSession>();
const printProgressControl = createPrintProgress(shellStatus.printHost, () => printProgressOwner.cancel());
let printFocusOwner: { readonly session: PdfTabSession; readonly element?: HTMLElement } | undefined;
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
const fileOpenerRenderer = createRecentChooserRenderer(fileOpenerList, index => {
  fileOpenerModel = selectChooserIndex(fileOpenerModel, index);
  dispatchFileOpenerEntry();
});
const paletteDialog = required<HTMLDialogElement>("#command-palette-dialog");
const paletteInput = required<HTMLInputElement>("#palette-input");
const SHELL_WINDOW_ID = "current-window";
let cancelPendingShellInput: () => void = () => undefined;
let syncPendingShellInput: () => void = () => undefined;
let focusOwnerSequence = 0;
let overlayOwner: OverlayOwnerState = createOverlayOwner(SHELL_WINDOW_ID, "empty-reader-open");
let protectedOpenSession: PdfTabSession | undefined;
const passwordPrompt = createPasswordPrompt({ onCancel: () => protectedOpenSession?.cancelPasswordOpening() });
function passwordModalOpen(): boolean { return protectedOpenSession !== undefined; }
function dismissPasswordPrompt(): void {
  passwordPrompt.dismiss();
  protectedOpenSession = undefined;
  cancelPendingShellInput();
}
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
      if (effect.prompt.kind === "page") {
        const transaction = suspendedPagePrompt;
        suspendedPagePrompt = undefined;
        if (transaction !== undefined && ownsPagePrompt(transaction)) {
          pagePromptTransaction = { ...transaction, digits: effect.prompt.text, committing: false, revision: ++pagePromptRevision };
          prompt.hidden = false;
          prompt.textContent = `Go to page: ${effect.prompt.text || "_"}`;
        } else prompt.hidden = true;
      } else { searchInput.value = effect.prompt.text; searchInput.setSelectionRange(effect.prompt.selectionStart, effect.prompt.selectionEnd); }
    }
    else if (effect.type === "focus") restoreOwnedFocus(effect.target);
  }
}
const applicationMenuOwner = bindApplicationMenuOwner({ menu: windowsMenu,
  canOpen: () => overlayOwner.active === undefined && !nativePickerOpen && !passwordModalOpen(),
  onOpen: () => cancelPendingShellInput(),
  onCommand: (actionId) => dispatchActionId(actionId as ActionId),
});
function claimOverlay(id: OverlayId): void {
  applicationMenuOwner.close();
  if (overlayOwner.active === undefined) overlayOwner = createOverlayOwner(SHELL_WINDOW_ID, currentFocusFallback());
  const focusedTarget = focusTargetId(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const activePrompt = pagePromptTransaction;
  const suspendedPrompt = activePrompt === undefined ? undefined : { kind: "page" as const, text: activePrompt.digits, selectionStart: activePrompt.digits.length, selectionEnd: activePrompt.digits.length };
  if (activePrompt !== undefined) {
    activePrompt.payload.session.cancelPendingNavigation();
    suspendedPagePrompt = { ...activePrompt, committing: false, revision: ++pagePromptRevision };
    pagePromptTransaction = undefined;
  }
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
let durableThemeIsProvisional = true;
let themePicker: ThemePickerModel = CLOSED_THEME_PICKER;

function isDurableThemeState(value: unknown): value is DurableThemeState {
  return typeof value === "object" && value !== null && "themeId" in value && "revision" in value
    && typeof value.themeId === "string" && isThemeId(value.themeId)
    && typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0;
}
function adoptDurableTheme(candidate: DurableThemeState): boolean {
  if (!shouldAdoptDurableThemeState(durableTheme, candidate, durableThemeIsProvisional)) return false;
  durableTheme = candidate;
  durableThemeIsProvisional = false;
  return true;
}
function applyTheme(themeId: ThemeId): void {
  const palette = themeForId(themeId).palette;
  for (const token of THEME_TOKENS) root.style.setProperty(`--theme-${token}`, palette[token]);
  root.style.setProperty("--theme-contrast", themeContrastEndpoint(palette));
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

  themeList.querySelector<HTMLButtonElement>(".theme-option[tabindex='0']")?.focus();
}
function closeThemePicker(revert: boolean): void {
  const picker = activeThemePicker();
  if (picker && revert) {
    const result = revertThemePicker(picker);
    themePicker = result.model;
    applyTheme(result.effect.themeId);
  }

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
  if (overlayOwner.active?.id === "theme") restoreThemeFocus();
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

let linkHints: LinkHints | undefined;
const cancelLinkHints = (): void => { linkHints?.cancel(); };
type TabPayload = { readonly host: HTMLElement; readonly session: PdfTabSession; readonly disposeUi: () => void };
let workspace!: TabWorkspace<TabPayload>;
const resources = new ResourceReservationManager((needed) => {
  if (workspace === undefined || !["canvas-bytes", "canvas-cache-bytes", "text-page-bytes", "text-document-bytes", "text-process-bytes", "search-document-results", "search-process-results", "search-extractor"].includes(needed.kind)) return;
  cancelLinkHints();
  const activeTabId = workspace.activeTabId;
  for (const tab of workspace.snapshot.tabs) {
    if (tab.id !== activeTabId) tab.payload.session.evictInactiveHeavyResources();
  }
});
type PagePromptTransaction = PagePromptState<{
  readonly ownerTabId: TabId;
  readonly documentGeneration: number;
  readonly payload: TabPayload;
}>;
let pagePromptTransaction: PagePromptTransaction | undefined;
let suspendedPagePrompt: PagePromptTransaction | undefined;
let pagePromptRevision = 0;
function ownsPagePrompt(transaction: PagePromptTransaction): boolean {
  return workspace.activeTabId === transaction.ownerTabId
    && workspace.getPayload(transaction.ownerTabId)?.session === transaction.payload.session
    && transaction.payload.session.snapshot.reader.documentGeneration === transaction.documentGeneration;
}
let configExists = false;
let nativeOpenPending = false;
let nativePickerOpen = false;
const OPEN_FAILURE_STATUS: Readonly<Record<OpenFailureNotice["tag"], string>> = {
  DOCUMENT_TOO_LARGE: "This PDF exceeds reader resource limits.",
  MISSING_FILE: "This PDF no longer exists.",
  PATH_REJECTED: "This PDF path cannot be opened safely.",
  PDF_INVALID: "Could not read this PDF.",
  FILE_UNREADABLE: "Could not read this PDF.",
  SESSION_CAPACITY: "This PDF exceeds reader resource limits.",
};
function openFailureTag(value: unknown): OpenFailureNotice["tag"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("tag" in value)) return undefined;
  const tag = value.tag === "SELECTION_REJECTED" && "reason" in value ? value.reason : value.tag;
  return tag === "DOCUMENT_TOO_LARGE" || tag === "MISSING_FILE" || tag === "PATH_REJECTED" || tag === "PDF_INVALID" || tag === "FILE_UNREADABLE" || tag === "SESSION_CAPACITY" ? tag : undefined;
}
function reportOpenInvokeFailure(error?: unknown, fallbackStatus = openFailureStatus("unknown"), fallbackPhase: OpenFailurePhase = "unknown"): void {
  const tag = openFailureTag(error);
  const phase = openFailurePhase(error) ?? fallbackPhase;
  active().session.reader.setStatus(tag === undefined ? fallbackStatus : OPEN_FAILURE_STATUS[tag]);
  const openError = tag === undefined ? undefined : nativeOpenError(tag);
  const accessibleError = openError === "unsupportedLocation" ? "document-locality-denied"
    : openError === "malformedDocument" || openError === "unreadableFile" || openError === "missingFile" ? "document-invalid"
    : tag === undefined ? openFailureAccessibilityError(phase)
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
  "PDF presentation could not be updated.",
  "Could not read this PDF.",
  "This PDF path cannot be opened safely.",
  "This PDF exceeds reader resource limits.",
  "Opening PDF cancelled.",
  "The PDF password was not accepted.",
  "The local PDF renderer could not start.",
  "The PDF operation timed out.",
]);
function safeAdoptionFailureStatus(status: string, fallbackPhase: OpenFailurePhase = "adoption"): string {
  return SAFE_ADOPTION_FAILURE_STATUSES.has(status) ? status : openFailureStatus(fallbackPhase);
}
let paletteActiveIndex = 0;
let fileOpenerModel: OpenChooserModel = createOpenChooser({ tag: "READY", snapshot: { revision: "0", entries: [] } }, 0);
const workspaceTransitions = createWorkspaceTransitionQueue(() => {
  active().session.reader.setStatus("WORKSPACE_BUSY");
  render();
});
const removedTabTeardown = createRemovedTabTeardownSupervisor<TabPayload>({
  remove: (value) => { cancelLinkHints(); value.disposeUi(); value.host.remove(); },
  close: (value) => { cancelLinkHints(); return value.session.close(); },
});
function queueWorkspaceTransition(work: () => Promise<void> | void): Promise<void> { return workspaceTransitions.enqueue(work); }
function queueWorkspaceOwnership(work: () => Promise<void> | void): Promise<void> { return workspaceTransitions.enqueueOwnership(work); }
function queueWorkspaceActivation(work: () => Promise<void> | void): Promise<void> { return workspaceTransitions.enqueueActivation(work); }
function disposeWorkspaceTab(value: TabPayload): void { removedTabTeardown.remove(value); }

function active(): TabPayload { const value = workspace.getPayload(workspace.activeTabId); if (!value) throw new Error("ACTIVE_TAB_MISSING"); return value; }
type PathShortcutOutcome = { readonly tag: "SHOWN" | "COPIED"; readonly text: string } | { readonly tag: "REJECTED"; readonly reason: string };
let pathNoticeTimer: number | undefined;
let pathNoticeOwnerTabId: number | undefined;
let pathNoticeRequest = 0;
function publishPathNotice(tabId: number, text: string, copied: boolean): void {
  pathNoticeOwnerTabId = tabId;
  if (pathNoticeTimer !== undefined) window.clearTimeout(pathNoticeTimer);
  shellStatus.setPathNotice({ text, copied });
  pathNoticeTimer = window.setTimeout(() => {
    if (pathNoticeOwnerTabId !== tabId || workspace.activeTabId !== tabId) return;
    pathNoticeOwnerTabId = undefined;
    pathNoticeTimer = undefined;
    shellStatus.setPathNotice(undefined);
  }, 3_000);
}
function runPathShortcut(action: "y" | "yy"): void {
  const tabId = workspace.activeTabId;
  const payload = active();
  const identity = payload.session.activeSessionIdentity;
  const request = ++pathNoticeRequest;
  if (identity === undefined) { publishPathNotice(tabId, "No document open", false); return; }
  void invoke<unknown>("path_shortcut", { action, sessionId: identity.sessionId, documentGeneration: identity.documentGeneration, ownerGeneration: identity.ownerGeneration }).then((raw) => {
    const current = workspace.getPayload(tabId)?.session.activeSessionIdentity;
    if (request !== pathNoticeRequest || workspace.activeTabId !== tabId || current?.sessionId !== identity.sessionId || current.documentGeneration !== identity.documentGeneration || current.ownerGeneration !== identity.ownerGeneration) return;
    const outcome = raw as Partial<PathShortcutOutcome>;
    if ((outcome.tag === "SHOWN" || outcome.tag === "COPIED") && typeof outcome.text === "string") publishPathNotice(tabId, outcome.text, outcome.tag === "COPIED");
    else if (outcome.tag === "REJECTED") publishPathNotice(tabId, "Path action failed: " + (outcome.reason ?? "Unknown error"), false);
    else publishPathNotice(tabId, "Path action failed: Invalid native response", false);
  }, () => { if (request === pathNoticeRequest && workspace.activeTabId === tabId) publishPathNotice(tabId, "Path action failed", false); });
}
function commandAvailabilityContext(): ActionRuntimeContext {
  const hasDocument = active().session.snapshot.reader.hasDocument;
  const canCreateSession = workspace.snapshot.tabs.length < 8;
  return {
    hasDocument,
    canCreateSession,
    canOpenDocument: !nativeOpenPending && (workspace.snapshot.tabs.some((tab) => !tab.payload.session.snapshot.reader.hasDocument) || canCreateSession),
    canCreateWindow: true,
    tabCount: workspace.snapshot.tabs.length,
    modalOpen: overlayOwner.active !== undefined || passwordModalOpen(),
    updateAvailable: false,
    configExists,
    searchActive: active().session.query.length > 0,
    canHistoryBack: active().session.canHistoryBack,
    canHistoryForward: active().session.canHistoryForward,
    implementedActionIds: IMPLEMENTED_ACTION_IDS,
  };
}
function renderWindowsMenu(model: ReturnType<typeof buildWindowsMenuModel>): void {
  const retainedSections = new Set(model.map(({ id }) => id as string));
  for (const group of Array.from(windowsMenu.children)) {
    if (!retainedSections.has((group as HTMLElement).dataset.menuSection ?? "")) group.remove();
  }
  for (const [index, section] of model.entries()) {
    let group = windowsMenu.querySelector<HTMLDetailsElement>(`details[data-menu-section="${section.id}"]`);
    if (group === null) {
      group = document.createElement("details");
      group.dataset.menuSection = section.id;
      const summary = document.createElement("summary");
      summary.setAttribute("aria-haspopup", "menu");
      const commands = document.createElement("div");
      commands.className = "windows-menu-commands";
      commands.hidden = true;
      commands.inert = true;
      commands.setAttribute("role", "menu");
      group.append(summary, commands);
    }
    if (windowsMenu.children[index] !== group) windowsMenu.insertBefore(group, windowsMenu.children[index] ?? null);
    const summary = group.querySelector("summary")!;
    if (summary.textContent !== section.label) summary.textContent = section.label;
    const commands = group.querySelector<HTMLElement>(".windows-menu-commands")!;
    commands.setAttribute("aria-label", section.label);
    const retainedCommands = new Set(section.commands.map(({ id }) => id as string));
    for (const button of Array.from(commands.children)) {
      if (!retainedCommands.has((button as HTMLElement).dataset.menuCommand ?? "")) button.remove();
    }
    for (const [commandIndex, command] of section.commands.entries()) {
      let button = commands.querySelector<HTMLButtonElement>(`button[data-menu-command="${command.id}"]`);
      if (button === null) {
        button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.dataset.menuCommand = command.id;
        const label = document.createElement("span");
        label.className = "windows-menu-label";
        const shortcut = document.createElement("span");
        shortcut.className = "windows-menu-shortcut";
        button.append(label, shortcut);
      }
      button.disabled = !command.enabled;
      const label = button.querySelector<HTMLElement>(".windows-menu-label")!;
      const shortcut = button.querySelector<HTMLElement>(".windows-menu-shortcut")!;
      if (label.textContent !== command.title) label.textContent = command.title;
      const shortcutText = command.shortcuts.join(", ");
      if (shortcut.textContent !== shortcutText) shortcut.textContent = shortcutText;
      shortcut.hidden = shortcutText.length === 0;
      button.setAttribute("aria-label", shortcutText.length === 0 ? command.title : `${command.title}, ${shortcutText}`);
      button.title = command.disabledReason ?? "";
      if (!command.enabled && command.disabledReason !== undefined) button.setAttribute("aria-description", command.disabledReason);
      else button.removeAttribute("aria-description");
      if (commands.children[commandIndex] !== button) commands.insertBefore(button, commands.children[commandIndex] ?? null);
    }
  }
  applicationMenuOwner.reconcile();
}
function renderHelpRows(): void {
  const groups = new Map<string, ReturnType<typeof buildHelpRows>>();
  for (const row of buildHelpRows(commandAvailabilityContext(), shellConfig, overlayOwner.active?.id === "help" ? { modalOwner: "help" } : {})) {
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
      description.textContent = row.disabledReason === undefined ? row.label : `${row.label} — ${row.disabledReason}`;
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
function bindReaderWheelInput(
  host: HTMLElement,
  session: PdfTabSession,
  isActive: () => boolean,
  onSettled: () => void,
  onFailure: (error: unknown) => void,
): () => void {
  let disposed = false;
  const onWheel = (event: WheelEvent): void => {
    if (event.ctrlKey) event.preventDefault();
    if (disposed || !isActive()) return;
    if (!event.ctrlKey) { session.cancelWheelZoom(); return; }
    void session.handleWheelInput({
      ctrlKey: event.ctrlKey, deltaX: event.deltaX, deltaY: event.deltaY,
      deltaMode: event.deltaMode, timeStamp: event.timeStamp,
      clientX: event.clientX, clientY: event.clientY,
    }).then(() => { if (!disposed && isActive()) onSettled(); }, (error: unknown) => {
      if (!disposed && isActive()) onFailure(error);
    });
  };
  const reset = (): void => session.resetWheelZoom();
  const cancel = (): void => session.cancelWheelZoom();
  const onKeyUp = (event: KeyboardEvent): void => { if (event.key === "Control") reset(); };
  host.addEventListener("wheel", onWheel, { passive: false });
  host.addEventListener("pointerleave", reset);
  host.addEventListener("pointerdown", cancel);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", cancel);
  return () => {
    disposed = true;
    cancel();
    host.removeEventListener("wheel", onWheel);
    host.removeEventListener("pointerleave", reset);
    host.removeEventListener("pointerdown", cancel);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", cancel);
  };
}
function createTab(): TabPayload {
  const host = document.createElement("section");
  host.className = "reader-surface tab-host";
  host.tabIndex = 0;
  host.setAttribute("role", "tabpanel");
  host.replaceChildren();
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
  let viewportSyncDocumentGeneration = -1;
  session = new PdfTabSession({
    native,
    onPassword: (request) => {
      if (shellDisposing || request.signal.aborted) return Promise.resolve(null);
      protectedOpenSession = session;
      applicationMenuOwner.close();
      const overlay = overlayOwner.active?.id;
      if (overlay === "theme") closeThemePicker(true);
      else if (overlay === "commandPalette") closePalette();
      else if (overlay === "recent") closeFileOpener();
      else if (overlay !== undefined) releaseOverlay(overlay);
      cancelPendingShellInput();
      return passwordPrompt.request(request);
    },
    printNative: (opened, generation) => new TauriPdfPrintBoundary(opened, generation),
    onPrintProgress: (progress) => {
      if (shellDisposing || workspace === undefined) return;
      printProgressOwner.report(session, progress);
      // The status footer is window-owned, so redraw it even when the
      // printing document's presentation tab is inactive.
      render();
      if (active().session !== session) return;
      if (progress === undefined && printProgressControl.containsFocus()) {
        const target = printFocusOwner?.session === session ? printFocusOwner.element : undefined;
        if (target?.isConnected) target.focus({ preventScroll: true });
        else host.focus({ preventScroll: true });
      }
    },
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
      navigateToPage: (page) => { if (!passwordModalOpen() && active().session === session) { session.apply({ type: "page.goTo", page }); void session.renderPage(page).catch((error: unknown) => reportPresentationFailure(session, error)); } },
      navigateToDestination: async (page, destination, cause, isActivationCurrent, returnLanding) => {
        if (passwordModalOpen() || active().session !== session) return { kind: "stale" };
        try { return await session.navigateToDestination(page, destination, cause, isActivationCurrent, returnLanding); }
        catch (error: unknown) { reportPresentationFailure(session, error); return { kind: "failed" }; }
      },
      resolveDestinationPage: (reference) => session.resolveDestinationPage(reference),
      prepareExternalLinks: (entries, registryRevision) => invoke<void>("prepare_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision, entries: entries.map((entry) => ({ annotation_id: entry.annotationId, target: entry.target })) }),
      commitExternalLinks: (registryRevision) => invoke<void>("commit_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision }),
      finalizeExternalLinks: (registryRevision) => invoke<void>("finalize_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision }),
      abortExternalLinks: (registryRevision) => invoke<void>("abort_external_links", { sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision }),
      openExternal: (annotationId, registryRevision, operationId, operationSequence) => invoke<number>("open_external_link", { request: { operationId, operationSequence, sessionId: opened.sessionId, documentGeneration: opened.documentGeneration, ownerGeneration: generation, registryRevision, annotationId } }),
    }),
    onStatus: () => {
      render();
      if (workspace === undefined || active().session !== session) return;
      const snapshot = session.snapshot;
      const reader = snapshot.reader;
      const presentation = session.committedPresentation ?? reader;
      if (reader.hasDocument && reader.documentGeneration !== viewportSyncDocumentGeneration) {
        viewportSyncDocumentGeneration = reader.documentGeneration;
        queueMicrotask(scheduleViewportSync);
      }
      accessibility.activateTab(String(workspace.activeTabId), reader.documentGeneration);
      if (reader.hasDocument && reader.pageCount > 0) {
        accessibility.announce({ kind: "page", generation: reader.documentGeneration, page: presentation.page, pageCount: reader.pageCount });
        if (presentation.zoomMode === "custom") accessibility.announce({ kind: "zoom", generation: reader.documentGeneration, zoomPercent: Math.round(presentation.customScale * 100) });
        if (announcedGeneration !== reader.documentGeneration) {
          announcedGeneration = reader.documentGeneration;
          accessibility.announce({ kind: "loading-complete", generation: reader.documentGeneration, pageCount: reader.pageCount });
        }
      }
      const content = snapshot.content;
      if (content.query !== "" && !content.searchPending && !content.searchIncomplete) {
        accessibility.announce({ kind: "search", generation: reader.documentGeneration, current: content.results.length === 0 ? 0 : content.currentResult + 1, total: content.results.length });
      }
    },
  });
  const disposeWheelInput = bindReaderWheelInput(host, session, () => !passwordModalOpen() && active().session === session,
    () => { rootKeyboard.syncContext(); render(); },
    (error) => reportPresentationFailure(session, error));
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
    if (session.navigationLandingInProgress) return;
    cancelLinkHints();
    session.cancelVisibleLinkActivation();
    scheduleViewportSync();
  };
  host.addEventListener("scroll", onReaderScroll, { passive: true });
  let readerResizeFrame: number | undefined;
  // Resident-page commits can toggle scrollbars. Only external box resizing
  // may cancel that materialization; observing client geometry creates a loop.
  let readerWidth = host.offsetWidth;
  let readerHeight = host.offsetHeight;
  const onReaderResize = (): void => {
    cancelLinkHints();
    if (viewportDisposed || active().session !== session) return;
    session.cancelWheelZoom();
    session.invalidateViewportSynchronization();
    if (readerResizeFrame !== undefined) return;
    readerResizeFrame = window.requestAnimationFrame(() => {
      readerResizeFrame = undefined;
      if (viewportDisposed || active().session !== session) return;
      void session.renderCurrentView().then(() => scheduleViewportSync()).catch((error: unknown) => reportPresentationFailure(session, error));
    });
  };
  const readerResizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
    const width = host.offsetWidth;
    const height = host.offsetHeight;
    if (width === readerWidth && height === readerHeight) return;
    readerWidth = width;
    readerHeight = height;
    onReaderResize();
  });
  readerResizeObserver?.observe(host, { box: "border-box" });
  window.addEventListener("resize", onReaderResize);
  queueMicrotask(scheduleViewportSync);
  return { host, session, disposeUi: () => {
    viewportDisposed = true;
    if (viewportFrameRequest !== undefined) window.cancelAnimationFrame(viewportFrameRequest);
    host.removeEventListener("scroll", onReaderScroll);
    disposeWheelInput();
    readerResizeObserver?.disconnect();
    window.removeEventListener("resize", onReaderResize);
    if (readerResizeFrame !== undefined) window.cancelAnimationFrame(readerResizeFrame);
    copyContextMenu.dispose();
  } };
}
workspace = new TabWorkspace(createTab, 8, { dispose: disposeWorkspaceTab });
active().session.activate();
linkHints = new LinkHints({
  getContext: (): LinkHintHostContext | undefined => {
    if (workspace === undefined) return undefined;
    const current = workspace.getPayload(workspace.activeTabId);
    if (current === undefined || !current.session.snapshot.reader.hasDocument) return undefined;
    return { authority: current.session, host: current.host };
  },
  onFeedback: (message) => {
    if (workspace === undefined) return;
    active().session.reader.setStatus(message);
    render();
  },
});

let updateNotice: UpdateNoticeState = HIDDEN_UPDATE_NOTICE;
const RELEASE_REPOSITORY = "DS-argus/modeleaf-win";

/**
 * Reloads config.toml and reports the outcome truthfully.
 *
 * A rejected or unreadable file leaves the live configuration untouched, so a
 * broken edit can never degrade the running app to defaults.
 */
async function reloadConfiguration(): Promise<ConfigReloadOutcome> {
  let outcome: ConfigReloadOutcome;
  try {
    const raw = await readProductConfig(invoke);
    const validated = validateProductConfig(raw ?? {});
    outcome = validated.ok
      ? { kind: "applied", config: validated.value }
      : { kind: "rejected", rows: projectConfigDiagnostics(validated.diagnostics) };
  } catch {
    outcome = { kind: "unavailable", rows: [] };
  }
  active().session.reader.setStatus(summarizeConfigReload(outcome));
  render();
  return outcome;
}

/** Opens the release page for an available update. Notify-only: never installs. */
async function showUpdateNotice(): Promise<void> {
  const url = releasePageUrl(updateNotice, RELEASE_REPOSITORY);
  if (url === undefined) {
    active().session.reader.setStatus("No update is available.");
    render();
    return;
  }
  try {
    await invoke<void>("open_external_link", { url });
  } catch {
    active().session.reader.setStatus("Could not open the release page.");
  }
  render();
}
function render(): void {
  syncPendingShellInput();
  const current = active();
  if (pathNoticeOwnerTabId !== undefined && pathNoticeOwnerTabId !== workspace.activeTabId) {
    pathNoticeOwnerTabId = undefined;
    if (pathNoticeTimer !== undefined) { window.clearTimeout(pathNoticeTimer); pathNoticeTimer = undefined; }
    shellStatus.setPathNotice(undefined);
  }
  const snapshot = current.session.snapshot;
  const shell = projectWindowShell({
    windowId: SHELL_WINDOW_ID,
    activeTabId: String(workspace.activeTabId),
    tabs: workspace.snapshot.tabs.map((tab) => { const payload = workspace.getPayload(tab.id); if (payload === undefined) throw new Error("SHELL_TAB_PAYLOAD_MISSING"); const tabSnapshot = payload.session.snapshot; return { id: String(tab.id), title: tabSnapshot.title, hasDocument: tabSnapshot.reader.hasDocument, status: tabSnapshot.status }; }),
  });
  if (!shell.ok) throw new Error(`SHELL_PROJECTION_INVALID:${shell.code}`);
  const menuModel = buildWindowsMenuModel(commandAvailabilityContext(), shellConfig);
  root.dataset.menuCommandCount = String(menuModel.reduce((count, section) => count + section.commands.length, 0));
  renderWindowsMenu(menuModel);
  const openCommand = menuModel.flatMap((section) => section.commands).find(({ id }) => id === "document.open");
  if (openCommand !== undefined) {
    // The label is the keyboard hint itself; only availability is projected.
    emptyReaderOpen.disabled = !openCommand.enabled;
    const shortcut = openCommand.shortcuts[0];
    emptyReaderShortcut.hidden = shortcut === undefined;
    emptyReaderShortcut.textContent = shortcut ?? "";
    emptyReaderOpen.title = openCommand.disabledReason ?? "";
  }
  shellStatus.render();
  printProgressControl.update(printProgressOwner.progress);
  // The positioned host container otherwise intercepts clicks over the empty action.
  tabHosts.hidden = shell.emptyState !== undefined;
  emptyReader.hidden = shell.emptyState === undefined;
  emptyReader.setAttribute("aria-hidden", String(shell.emptyState === undefined));
  if (snapshot.reader.helpVisible && overlayOwner.active?.id !== "help") claimOverlay("help");
  tabStrip.inert = shell.emptyState !== undefined;
  if (!snapshot.reader.helpVisible && overlayOwner.active?.id === "help") releaseOverlay("help");
  renderHelpRows();
  prompt.hidden = pagePromptTransaction === undefined;
  prompt.textContent = pagePromptTransaction === undefined ? "" : `Go to page: ${pagePromptTransaction.digits || "_"}${pagePromptTransaction.committing ? " · Moving…" : pagePromptTransaction.validationMessage === undefined ? "" : ` · ${pagePromptTransaction.validationMessage}`}`;
  const tabs = workspace.snapshot.tabs;
  const documentTabs = tabs.filter((tab) => tab.payload.session.snapshot.reader.hasDocument);
  tabStrip.hidden = documentTabs.length === 0;
  for (const tab of tabs) {
    const selected = tab.id === workspace.activeTabId;
    const title = tab.payload.session.snapshot.title;
    tab.payload.host.hidden = !selected || !tab.payload.session.snapshot.reader.hasDocument;
    tab.payload.host.setAttribute("aria-hidden", String(!selected || !tab.payload.session.snapshot.reader.hasDocument));
    tab.payload.host.id = `reader-panel-${String(tab.id)}`;
    tab.payload.host.setAttribute("aria-labelledby", `reader-tab-${String(tab.id)}`);
    tab.payload.host.setAttribute("aria-label", readerAccessibilityName(title, tab.payload.session.snapshot.reader.pageCount));
    if (selected && tab.payload.session.snapshot.reader.hasDocument) accessibility.announce({ kind: "tab", active: documentTabs.findIndex((entry) => entry.id === tab.id) + 1, total: documentTabs.length });
  }
  shellTabs.render(documentTabs.map((tab) => ({
    id: String(tab.id),
    title: tab.payload.session.snapshot.title,
    selected: tab.id === workspace.activeTabId,
  })));
}
function cancelPagePromptOwnership(): void {
  const revoked = revokePagePromptOwnership(pagePromptTransaction, suspendedPagePrompt);
  const transaction = revoked.transaction;
  pagePromptTransaction = revoked.live;
  suspendedPagePrompt = revoked.suspended;
  cancelPendingShellInput();
  if (transaction === undefined) return;
  pagePromptRevision += 1;
  transaction.payload.session.cancelPendingNavigation();
}
async function activateCurrentTab(focus = false): Promise<void> { const current = active(); await current.session.activate(); render(); if (focus) current.host.focus({ preventScroll: true }); }
function switchTabNow(id: TabId): Promise<void> {
  if (passwordModalOpen()) return Promise.resolve();
  const sameTab = id === workspace.activeTabId;
  return performTabActivation(id, {
    activeId: () => workspace.activeTabId,
    payload: (tabId) => workspace.getPayload(tabId),
    isActive: (payload) => payload.session.snapshot.active,
    cancelPending: () => { cancelPagePromptOwnership(); },
    deactivate: (payload) => payload.session.deactivate(),
    activateWorkspace: (tabId) => workspace.activate(tabId),
    activateCurrent: (restoreFocus) => activateCurrentTab(restoreFocus),
    publish: render,
    reportFailure: (payload, failure) => {
      const message = sameTab ? "Could not activate this tab." : "Could not switch tabs.";
      const recovery = failure.recoveryCode === undefined ? "" : `; restore-prior: ${failure.recoveryCode}`;
      payload.session.reader.setStatus(`${message} [${failure.phase}: ${failure.code}${recovery}]`);
    },
  });
}
function switchTab(id: TabId): Promise<void> { return passwordModalOpen() ? Promise.resolve() : queueWorkspaceActivation(() => switchTabNow(id)); }
function switchAdjacentTab(direction: -1 | 1): Promise<void> {
  if (passwordModalOpen()) return Promise.resolve();
  return queueRelativeTabActivation(direction, queueWorkspaceActivation, (step) => workspace.adjacentId(step), switchTabNow);
}
function closeTab(id: TabId): void {
  if (passwordModalOpen()) return;
  void queueWorkspaceTransition(() => performTabClose(id, {
    activeId: () => workspace.activeTabId,
    cancelPending: cancelPagePromptOwnership,
    closeWorkspace: (tabId) => workspace.close(tabId),
    publish: render,
    activateCurrent: () => activateCurrentTab(),
  })).catch(() => {
    active().session.reader.setStatus("Could not activate the tab after closing.");
    render();
  });
}
interface PendingOpenAdoption {
  readonly failureStatus?: string;
  readonly request: OpenRequestAdoption;
  readonly id?: TabId;
  readonly payload?: TabPayload;
  readonly priorActiveId?: TabId;
}
let cancelledOpenFocus: { readonly requestId: string; readonly element: HTMLElement } | undefined;
const pendingOpenAdoptions = new Map<string, PendingOpenAdoption>();
async function adoptRequest(request: OpenRequestAdoption): Promise<void> {
  if (shellDisposing) throw new Error("OPEN_WINDOW_CLOSING");
  const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  pendingOpenAdoptions.set(request.requestId, { request });
  try {
    await queueWorkspaceOwnership(() => withOpenAdoptionOwnership({
      requestPending: () => pendingOpenAdoptions.has(request.requestId),
      activeId: () => workspace.activeTabId,
      cancelPagePrompt: cancelPagePromptOwnership,
    }, async (priorActiveId) => {
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
      pendingOpenAdoptions.set(request.requestId, { request, id, payload, priorActiveId });
      try {
        await adoptWithCommittedPresentation(
          () => publishActivateAndAdoptPdfTab(render, payload.session, async () => {
            try { return await payload.session.adopt(request, request.ownerGeneration); }
            finally { if (protectedOpenSession === payload.session) dismissPasswordPrompt(); }
          }),
          async () => {
            if (staged && !workspace.commitAdoption(id)) throw new Error("ADOPTION_COMMIT_FAILED");
            await activateCurrentTab(true);
          },
        );
      } catch (error) {
        if (shellDisposing) throw error;
        const candidateStatus = safeAdoptionFailureStatus(payload.session.snapshot.status, error instanceof OpenAdoptionPresentationError ? "presentation" : "adoption");
        if (error instanceof OpenAdoptionPresentationError) {
          const pending = pendingOpenAdoptions.get(request.requestId);
          if (pending !== undefined) pendingOpenAdoptions.set(request.requestId, { ...pending, failureStatus: candidateStatus });
          throw error;
        }
        pendingOpenAdoptions.delete(request.requestId);
        if (staged) workspace.rollbackAdoption(id);
        else if (id !== priorActiveId) {
          await payload.session.deactivate();
          workspace.activate(priorActiveId);
        }
        render();
        await activateCurrentTab();
        active().session.reader.setStatus(candidateStatus);
        render();
        if (candidateStatus === "Opening PDF cancelled.") {
          const element = priorFocus?.isConnected && priorFocus !== document.body && !priorFocus.closest("[hidden], [inert]")
            ? priorFocus : active().session.snapshot.reader.hasDocument ? active().host : emptyReaderOpen;
          element.focus({ preventScroll: true });
          cancelledOpenFocus = { requestId: request.requestId, element };
        }
        throw error;
      }
    }));
  } catch (error) {
    if (!(error instanceof OpenAdoptionPresentationError)) pendingOpenAdoptions.delete(request.requestId);
    throw error;
  }
}
function restoreOpenFocus(terminal: InitiatedTerminal): void {
  if (terminal.tag === "DISPOSED") return;
  if ("requestId" in terminal && terminal.requestId !== undefined && terminal.requestId.length > 0 && pendingOpenAdoptions.has(terminal.requestId)) return;
  const current = active();
  if ("requestId" in terminal && cancelledOpenFocus?.requestId === terminal.requestId) {
    cancelledOpenFocus.element.focus({ preventScroll: true });
    cancelledOpenFocus = undefined;
    return;
  }
  if (current.session.snapshot.reader.hasDocument) current.host.focus({ preventScroll: true });
  else emptyReaderOpen.focus({ preventScroll: true });
}
function handleOpenTerminal(terminal: InitiatedTerminal): void {
  if (shellDisposing) {
    if ("requestId" in terminal && terminal.requestId !== undefined) pendingOpenAdoptions.delete(terminal.requestId);
    return;
  }
  if (!("requestId" in terminal) || terminal.requestId === undefined || terminal.requestId.length === 0) {
    if (terminal.tag !== "DISPOSED") {
      const current = active();
      if (current.session.snapshot.reader.hasDocument) current.host.focus({ preventScroll: true });
      else emptyReaderOpen.focus({ preventScroll: true });
    }
    return;
  }
  if (cancelledOpenFocus?.requestId === terminal.requestId) cancelledOpenFocus = undefined;
  const pending = pendingOpenAdoptions.get(terminal.requestId);
  if (pending === undefined) return;
  pendingOpenAdoptions.delete(terminal.requestId);
  const accepted = terminal.tag === "ADOPTED" || terminal.tag === "ADOPTED_WITH_WARNING";
  if (pending.id === undefined || pending.payload === undefined) {
    if (accepted) reportOpenInvokeFailure(new Error("OPEN_ADOPTION_DESCRIPTOR_MISSING"));
    return;
  }
  const settled = { ...pending, id: pending.id, payload: pending.payload };
  void queueWorkspaceOwnership(async () => {
    if (accepted) {
      await activateCurrentTab(true);
      if (terminal.tag === "ADOPTED_WITH_WARNING") {
        active().session.reader.setStatus("The PDF opened, but native acknowledgement expired.");
        render();
      }
      return;
    }
    cancelPagePromptOwnership();
    rollbackOpenAdoptionOwnership(settled.id, settled.priorActiveId, {
      close: (id) => { workspace.close(id); },
      has: (id) => workspace.getPayload(id) !== undefined,
      activate: (id) => { workspace.activate(id); },
    });
    render();
    await activateCurrentTab(terminal.tag !== "DISPOSED");
    if (terminal.tag !== "DISPOSED") {
      active().session.reader.setStatus(pending.failureStatus ?? "The PDF open transaction was rolled back.");
      render();
    }
  }).then(() => {
    if (!accepted) return;
    void recordRecentDocument(invoke, pending.request.sessionId, pending.request.documentGeneration, pending.request.ownerGeneration).then((outcome) => {
      if (outcome.tag === "COMMITTED") {
        fileOpenerModel = adoptChooserSnapshot(fileOpenerModel, fileOpenerModel.generation, { revision: outcome.revision, entries: outcome.entries });
      } else {
        const diagnostic = outcome.tag === "STATE_UNAVAILABLE" ? RECENT_STATE_UNAVAILABLE : "The recent PDF could not be saved to application state.";
        fileOpenerModel = retainChooserFailure(fileOpenerModel, fileOpenerModel.generation, diagnostic);
        reportRecentStorageFailure(settled.payload.session);
      }
      if (overlayOwner.active?.id === "recent") renderFileOpener();
    }, () => reportRecentStorageFailure(settled.payload.session));
  }, (error: unknown) => reportOpenInvokeFailure(error));
}
const shellOpen = createShellOpenCoordinator({
  canAdmitOpen: () => !shellDisposing && !passwordModalOpen(),
  listen,
  invoke: async (command, args) => {
    if (command !== "open_pdf_dialog") return invoke(command, args);
    nativePickerOpen = true;
    applicationMenuOwner.close();
    cancelPendingShellInput();
    try { return await invoke(command, args); }
    finally { nativePickerOpen = false; }
  },
  dialog: {
    setPending: (pending) => { nativeOpenPending = pending; render(); },
    reportFailure: reportOpenInvokeFailure,
    restoreFocus: restoreOpenFocus,
  },
  adopt: adoptRequest,
  onTerminal: handleOpenTerminal,
  onFailure: (tag) => reportOpenInvokeFailure({ tag }),
});
emptyReaderOpen.addEventListener("click", () => dispatchActionId("document.open"));
void invoke<{ readonly tag?: string }>("read_config").then((outcome) => { configExists = outcome.tag === "LOADED"; render(); }, () => undefined);
const RECENT_STATE_UNAVAILABLE = "Recent documents are unavailable because application state could not be read.";
let recentStateHealth: "LOADING" | "READY" | "UNAVAILABLE" = "LOADING";
function reportRecentStateUnavailable(): void {
  const hasValidSnapshot = recentStateHealth !== "LOADING" && fileOpenerModel.prepared.tag === "READY";
  recentStateHealth = "UNAVAILABLE";
  fileOpenerModel = hasValidSnapshot
    ? retainChooserFailure(fileOpenerModel, fileOpenerModel.generation, RECENT_STATE_UNAVAILABLE)
    : createOpenChooser({ tag: "STATE_UNAVAILABLE", reason: RECENT_STATE_UNAVAILABLE }, fileOpenerModel.generation);
  if (overlayOwner.active?.id === "recent") renderFileOpener();
  accessibility.flush();
  politeAnnouncements.textContent = RECENT_STATE_UNAVAILABLE;
}
let recentSnapshotUnlisten: (() => void) | undefined;
const recentListenerReady = listen("recent-state-changed", (event) => {
  try {
    const outcome = decodeRecentStateChanged(event.payload);
    recentStateHealth = "READY";
    fileOpenerModel = adoptChooserSnapshot(fileOpenerModel, fileOpenerModel.generation, { revision: outcome.revision, entries: outcome.entries });
    if (overlayOwner.active?.id === "recent") renderFileOpener();
  } catch {
    reportRecentStateUnavailable();
  }
}).then((unlisten) => {
  recentSnapshotUnlisten = unlisten;
}, () => {
  reportRecentStateUnavailable();
});
const initialRecentsReady = recentListenerReady.then(() => listRecentDocuments(invoke)).then((outcome) => {
  if (outcome.tag === "READY") {
    const diagnostic = recentStateHealth === "UNAVAILABLE" ? RECENT_STATE_UNAVAILABLE : undefined;
    fileOpenerModel = adoptChooserSnapshot(fileOpenerModel, fileOpenerModel.generation, { revision: outcome.revision, entries: outcome.entries }, diagnostic);
    if (diagnostic === undefined) recentStateHealth = "READY";
  } else {
    reportRecentStateUnavailable();
  }
}, () => {
  reportRecentStateUnavailable();
});
function paletteEntries(): readonly CommandPaletteCommandEntry[] {
  return buildCommandPaletteEntries(commandAvailabilityContext(), [], paletteInput.value, shellConfig, overlayOwner.active?.id === "commandPalette" ? { modalOwner: "palette" } : {})
    .filter((entry): entry is CommandPaletteCommandEntry => entry.kind === "command");
}
function openPalette(): void {
  if (overlayOwner.active?.id !== "commandPalette") {
    claimOverlay("commandPalette");
    paletteInput.value = "";

    accessibility.announce({ kind: "palette", open: true });
  }
  paletteActiveIndex = 0;
  renderPalette();
  paletteInput.focus();
}
function closePalette(): void {

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
  renderCommandPalette(paletteList, entries, paletteActiveIndex, (index) => {
    paletteActiveIndex = index;
    dispatchPaletteEntry(index);
  });
  paletteList.querySelector<HTMLElement>("[aria-selected='true']")?.scrollIntoView({ block: "nearest" });
}
let fileOpenerAliases: { readonly revision: string; readonly paths: ReadonlyMap<string, string> } | undefined;
let fileOpenerAliasRequest: { readonly generation: number; readonly revision: string } | undefined;
function renderFileOpener(): void {
  const prepared = fileOpenerModel.prepared;
  const diagnostic = fileOpenerModel.diagnostic ?? (prepared.tag === "STATE_UNAVAILABLE" ? prepared.reason : undefined);
  const aliases = prepared.tag === "READY" && fileOpenerAliases?.revision === prepared.snapshot.revision ? fileOpenerAliases.paths : undefined;
  fileOpenerRenderer.render(chooserRows(fileOpenerModel), fileOpenerModel.activeIndex, diagnostic, aliases);
  if (overlayOwner.active?.id !== "recent" || prepared.tag !== "READY") return;
  const generation = fileOpenerModel.generation, revision = prepared.snapshot.revision;
  if (fileOpenerAliasRequest?.generation === generation && fileOpenerAliasRequest.revision === revision) return;
  const request = { generation, revision };
  fileOpenerAliasRequest = request;
  void listRecentDisplayAliases(invoke).then(outcome => {
    if (fileOpenerAliasRequest !== request || overlayOwner.active?.id !== "recent"
      || fileOpenerModel.generation !== generation || fileOpenerModel.prepared.tag !== "READY"
      || fileOpenerModel.prepared.snapshot.revision !== revision || outcome.tag !== "READY" || outcome.revision !== revision) return;
    fileOpenerAliases = { revision, paths: new Map(outcome.aliases.map(alias => [alias.recentId, alias.displayPath])) };
    renderFileOpener();
  }, () => {
    // Aliases are optional presentation metadata; retain truthful canonical paths.
    // No retry loop or filesystem authority is derived from a display alias.
  });
}
let clearingRecents = false;
async function clearFileOpenerHistory(): Promise<void> {
  if (clearingRecents || nativeOpenPending || overlayOwner.active?.id !== "recent") return;
  clearingRecents = true;
  const generation = fileOpenerModel.generation;
  try {
    const outcome = await clearRecentDocuments(invoke);
    if (outcome.tag === "COMMITTED") {
      fileOpenerModel = adoptChooserSnapshot(fileOpenerModel, fileOpenerModel.generation, { revision: outcome.revision, entries: outcome.entries });
    } else if (fileOpenerModel.generation === generation) {
      fileOpenerModel = retainChooserFailure(fileOpenerModel, generation,
        outcome.tag === "STATE_UNAVAILABLE" ? RECENT_STATE_UNAVAILABLE : "Recent history could not be cleared because application state could not be saved.");
    }
  } catch {
    if (fileOpenerModel.generation === generation) fileOpenerModel = retainChooserFailure(fileOpenerModel, generation, "Recent history could not be cleared.");
  } finally {
    clearingRecents = false;
    if (!shellDisposing && overlayOwner.active?.id === "recent") renderFileOpener();
  }
}
function closeFileOpener(): void {
  fileOpenerRenderer.stop();
  releaseOverlay("recent");
}
function dispatchFileOpenerEntry(): void {
  if (nativeOpenPending || passwordModalOpen()) return;
  const row = chooserRows(fileOpenerModel)[fileOpenerModel.activeIndex];
  if (row === undefined) return;
  if (row.kind === "browse") {
    closeFileOpener();
    shellOpen.requestOpen();
    return;
  }
  const generation = fileOpenerModel.generation;
  nativeOpenPending = true;
  render();
  void openRecentDocument(invoke, row.recentId).then((outcome) => {
    nativeOpenPending = false;
    const tag = outcome.tag;
    if (tag === "ADMITTED") {
      if (!shellOpen.admitOpen(outcome)) reportOpenInvokeFailure(undefined, openFailureStatus("request-admission"), "request-admission");
      closeFileOpener();
      render();
      return;
    }
    if (tag === "MISSING_PRUNED" || tag === "STALE_SELECTION") {
      const diagnostic = tag === "MISSING_PRUNED" ? "The recent PDF no longer exists." : "Recent documents changed; the list was refreshed.";
      fileOpenerModel = adoptChooserSnapshot(fileOpenerModel, generation, { revision: outcome.revision, entries: outcome.entries }, diagnostic);
      active().session.reader.setStatus(diagnostic);
      renderFileOpener();
      render();
      return;
    }
    const diagnostic = ({
      STATE_UNAVAILABLE: RECENT_STATE_UNAVAILABLE,
      MISSING_PRUNE_FAILED: "The missing recent PDF could not be removed because application state could not be saved.",
      ACCESS_DENIED: "Access to this recent PDF was denied.",
      TRANSIENT_FAILURE: "The recent PDF is temporarily unavailable.",
      DOCUMENT_REJECTED: "The recent PDF could not be read.",
    } as const)[tag];
    fileOpenerModel = retainChooserFailure(fileOpenerModel, generation, diagnostic);
    active().session.reader.setStatus(diagnostic);
    renderFileOpener();
    render();
  }, (error: unknown) => {
    nativeOpenPending = false;
    const diagnostic = "The recent PDF could not be opened.";
    fileOpenerModel = retainChooserFailure(fileOpenerModel, generation, diagnostic);
    renderFileOpener();
    reportOpenInvokeFailure(error, diagnostic);
  });
}
async function openFileOpener(): Promise<void> {
  if (nativeOpenPending || overlayOwner.active !== undefined || passwordModalOpen()) return;
  await Promise.all([initialRecentsReady, shellOpen.ready]);
  if (nativeOpenPending || overlayOwner.active !== undefined || passwordModalOpen()) return;
  fileOpenerAliases = undefined;
  fileOpenerAliasRequest = undefined;
  fileOpenerModel = createOpenChooser(fileOpenerModel.prepared, fileOpenerModel.generation + 1);
  if (recentStateHealth === "UNAVAILABLE" && fileOpenerModel.prepared.tag === "READY") {
    fileOpenerModel = retainChooserFailure(fileOpenerModel, fileOpenerModel.generation, RECENT_STATE_UNAVAILABLE);
  }
  fileOpenerInput.value = "";
  claimOverlay("recent");
  renderFileOpener();
  if (fileOpenerModel.prepared.tag === "STATE_UNAVAILABLE") active().session.reader.setStatus(fileOpenerModel.prepared.reason);
  fileOpenerInput.focus();
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
      const ownedOverlay = overlayOwner.active?.id;
      if (ownedOverlay === "theme") closeThemePicker(true);
      else if (ownedOverlay === "commandPalette") closePalette();
      else if (ownedOverlay === "recent") closeFileOpener();
      else if (ownedOverlay !== undefined) releaseOverlay(ownedOverlay);
      cancelPagePromptOwnership();
      shellDisposing = true;
      protectedOpenSession?.cancelPasswordOpening();
      passwordPrompt.dismiss();
      // Drain the password candidate before rejecting its native open request.
      // Both paths own cancellation barriers; they must not race the same handle.
      await protectedOpenSession?.close();
      themeUnlisten?.();
      recentSnapshotUnlisten?.();
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
      applicationMenuOwner.dispose();
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
// Global Any listeners also receive other windows' targeted close events.
void getCurrentWindow().listen<{ readonly requestId?: number }>("window-close-requested", (event) => {
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
  if (passwordModalOpen() && id !== "app.quit") return;
  if (id !== "links.hint" && id !== "app.quit") cancelLinkHints();
  if (id === "links.hint") {
    cancelPendingShellInput();
    if (overlayOwner.active !== undefined || nativeOpenPending || nativePickerOpen || passwordModalOpen()) return;
    linkHints?.show();
    return;
  }
  if (id === "history.back") { void active().session.navigateHistoryBack().then(render, (error: unknown) => reportPresentationFailure(active().session, error)); return; }
  if (id === "path.showParent" || id === "path.copy") { runPathShortcut(id === "path.showParent" ? "y" : "yy"); return; }
  if (id === "history.forward") { void active().session.navigateHistoryForward().then(render, (error: unknown) => reportPresentationFailure(active().session, error)); return; }
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
    "theme.picker": { type: "theme.open" }, "prompt.cancel": { type: "prompt.cancel" },
    "config.reload": { type: "config.reload" }, "update.show": { type: "update.show" },
  };
  if (id === "page.prompt") {
    const payload = active();
    pagePromptTransaction = openPagePrompt({
      ownerTabId: workspace.activeTabId,
      documentGeneration: payload.session.snapshot.reader.documentGeneration,
      payload,
    }, ++pagePromptRevision);
    payload.session.reader.setStatus("Go to page");
    render();
    payload.host.focus({ preventScroll: true });
    return;
  }
  if (id === "prompt.cancel" && pagePromptTransaction !== undefined) {
    const transaction = pagePromptTransaction;
    pagePromptTransaction = undefined;
    pagePromptRevision += 1;
    transaction.payload.session.cancelPendingNavigation();
    transaction.payload.session.apply({ type: "prompt.cancel" });
    rootKeyboard.syncContext();
    render();
    if (ownsPagePrompt(transaction)) transaction.payload.host.focus({ preventScroll: true });
    return;
  }
  if (id === "prompt.commit" && pagePromptTransaction !== undefined) {
    const transaction = pagePromptTransaction;
    if (transaction.committing) return;
    const revision = ++pagePromptRevision;
    const start = beginPagePromptCommit(transaction, transaction.payload.session.snapshot.reader.pageCount, revision);
    pagePromptTransaction = start.state;
    if (start.kind === "invalid") {
      transaction.payload.session.reader.setStatus(start.message);
      render();
      return;
    }
    render();
    const settle = (outcome: PagePromptNavigationKind | "exception"): void => {
      const current = pagePromptTransaction;
      const nextRevision = pagePromptRevision + 1;
      const settlement = settlePagePromptCommit(current, start.revision, current !== undefined && ownsPagePrompt(current), outcome, nextRevision);
      if (settlement.kind === "stale") return;
      pagePromptRevision = nextRevision;
      pagePromptTransaction = settlement.state;
      if (settlement.kind === "failed") current?.payload.session.reader.setStatus(settlement.message);
      rootKeyboard.syncContext();
      render();
      if ("restoreFocus" in settlement && settlement.restoreFocus) current?.payload.host.focus({ preventScroll: true });
    };
    void transaction.payload.session.navigatePagePrompt(start.page).then((result) => settle(result.kind), () => settle("exception"));
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
function navigateAdjacentReaderPage(payload: TabPayload, direction: -1 | 1): void {
  void payload.session.navigateAdjacentPage(direction).then((result) => {
    if (result.kind !== "verifiedLanding" && result.kind !== "noOp" && result.kind !== "stale") payload.session.reader.setStatus(navigationFailureStatus(result.kind));
    render();
    if (active().session === payload.session && overlayOwner.active === undefined && result.kind === "verifiedLanding") payload.host.focus({ preventScroll: true });
  }, (error: unknown) => reportPresentationFailure(payload.session, error));
}

function dispatch(action: Action): void {
  if (passwordModalOpen() && action.type !== "application.quit") return;
  cancelLinkHints();
  const type = action.type;
  if (type === "document.open") { if (nativeOpenPending) return; if (!commandAvailabilityContext().canOpenDocument) { active().session.reader.setStatus("TAB_CAPACITY"); render(); return; } void openFileOpener(); return; }
  if (type === "document.print") {
    const session = active().session;
    if (session.printProgress !== undefined) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    printProgressOwner.begin(session);
    printFocusOwner = { session, ...(focused === undefined ? {} : { element: focused }) };
    void session.printCurrent().finally(() => {
      if (session.printProgress === undefined) printProgressOwner.report(session, undefined);
      if (shellDisposing) return;
      if (printFocusOwner?.session === session) {
        if (active().session === session && overlayOwner.active === undefined
          && (document.activeElement === document.body || printProgressControl.containsFocus())) {
          const target = printFocusOwner.element;
          if (target?.isConnected) target.focus({ preventScroll: true });
          else active().host.focus({ preventScroll: true });
        }
        printFocusOwner = undefined;
      }
      render();
    });
    return;
  }
  if (type === "tab.activate") { const tab = action.index === -1 ? workspace.snapshot.tabs[workspace.snapshot.tabs.length - 1] : workspace.snapshot.tabs[action.index]; if (tab) void switchTab(tab.id); return; }
  if (type === "tab.close") { closeTab(workspace.activeTabId); return; }
  if (type === "application.new") { void invoke<void>("create_app_window").catch(() => { active().session.reader.setStatus("WINDOW_CREATE_FAILED"); render(); }); return; }
  if (type === "palette.toggle") { openPalette(); return; }
  if (type === "tab.next") { void switchAdjacentTab(1); return; }
  if (type === "tab.previous") { void switchAdjacentTab(-1); return; }
  if (type === "page.next" || type === "page.previous") {
    navigateAdjacentReaderPage(active(), type === "page.next" ? 1 : -1);
    return;
  }
  const currentPresentation = active().session.committedPresentation ?? active().session.snapshot.reader;
  const fitPageScrollDirection: -1 | 1 | undefined = type === "scroll.byCssPixels" && action.axis === "vertical"
    ? action.delta > 0 ? 1 : action.delta < 0 ? -1 : undefined
    : type === "scroll.byViewport" ? action.factor > 0 ? 1 : action.factor < 0 ? -1 : undefined
    : undefined;
  if (fitPageScrollDirection !== undefined && currentPresentation.zoomMode === "fit-page") {
    navigateAdjacentReaderPage(active(), fitPageScrollDirection);
    return;
  }
  if (type === "page.first" || type === "page.last") {
    const payload = active();
    const navigation = type === "page.first" ? payload.session.navigateFirstPage() : payload.session.navigateLastPage();
    void navigation.then((result) => {
      if (result.kind !== "verifiedLanding" && result.kind !== "noOp" && result.kind !== "stale") payload.session.reader.setStatus(navigationFailureStatus(result.kind));
      render();
      if (active().session === payload.session && overlayOwner.active === undefined && result.kind === "verifiedLanding") payload.host.focus({ preventScroll: true });
    }, (error: unknown) => reportPresentationFailure(payload.session, error));
    return;
  }
  if (type === "theme.open") { openThemePicker(); return; }
  if (type === "config.reload") { void reloadConfiguration(); return; }
  if (type === "update.show") { void showUpdateNotice(); return; }
  if (type === "application.quit") { void requestApplicationQuit(false, true); return; }
  if (type.startsWith("view.")) {
    const payload = active();
    const settlement = payload.session.requestKeyboardView(action as PdfTabViewAction);
    if (!observedKeyboardViewSettlements.has(settlement)) {
      observedKeyboardViewSettlements.add(settlement);
      void settlement.then((committed) => {
        if (committed && active().session === payload.session) {
          rootKeyboard.syncContext();
          render();
        }
      }, (error: unknown) => reportPresentationFailure(payload.session, error));
    }
    return;
  }
  const payload = active(); const session = payload.session; session.apply(action); const reader = session.snapshot.reader;
  if (type.startsWith("page.")) void session.renderPage(reader.page).catch((error: unknown) => reportPresentationFailure(session, error));
  if (type === "search.open") { claimOverlay("search"); searchInput.value = session.query; searchInput.focus(); }
  if (type.startsWith("scroll.")) {
    const intent = session.reader.consumePendingScroll();
    const verticalCssPixels = intent.verticalCssPixels + intent.viewportFactor * payload.host.clientHeight;
    payload.host.scrollBy({ left: intent.horizontalCssPixels, top: verticalCssPixels, behavior: "instant" });
  }
  rootKeyboard.syncContext(); render();
}
const rootKeyboard = createRootKeyboardRouter({
  config: shellConfig,
  getContext: () => ({
    windowId: SHELL_WINDOW_ID,
    routeRevision: String(workspace.activeTabId),
    generation: active().session.snapshot.reader.documentGeneration,
    inputContext: pagePromptTransaction !== undefined ? "pagePrompt" : overlayOwner.active?.id === "search" ? "searchPrompt" : active().session.query.length > 0 ? "searchResults" : "navigation",
    runtime: commandAvailabilityContext(),
  }),
  onPriorityKeyDown: (event) => linkHints?.handleKeyDown(event) ?? false,
  onPriorityCancel: cancelLinkHints,
  onDispatch: (id, sequenceDispatch) => {
    dispatchActionId(id);
    const transaction = pagePromptTransaction;
    if (sequenceDispatch.replay !== undefined && transaction !== undefined) {
      const revision = pagePromptRevision + 1;
      const edited = editPagePrompt(transaction, sequenceDispatch.replay.token, revision, ownsPagePrompt(transaction));
      if (edited !== undefined) {
        pagePromptRevision = revision;
        pagePromptTransaction = edited;
        transaction.payload.session.reader.setStatus(`Go to page: ${edited.digits || "_"}`);
        render();
      }
    }
  },
  onUnboundToken: (key, context) => {
    const transaction = pagePromptTransaction;
    if (context.inputContext !== "pagePrompt" || transaction === undefined) return false;
    if (transaction.committing) return /^[0-9]$/u.test(key) || key === "<BS>";
    const revision = pagePromptRevision + 1;
    const edited = editPagePrompt(transaction, key, revision, ownsPagePrompt(transaction));
    if (edited === undefined) return false;
    pagePromptRevision = revision;
    pagePromptTransaction = edited;
    transaction.payload.session.reader.setStatus(`Go to page: ${edited.digits || "_"}`);
    render();
    return true;
  },
  onDisabled: (_id, reason) => { active().session.reader.setStatus(reason); render(); },
  onState: (state) => {
    if (state.kind === "pending" && state.sequence === "y") { shellStatus.setPendingSequence(""); runPathShortcut("y"); }
    else shellStatus.setPendingSequence(state.kind === "pending" ? state.sequence : "");
  },
});
cancelPendingShellInput = rootKeyboard.cancelPending;
syncPendingShellInput = rootKeyboard.syncContext;
window.addEventListener("keydown", (event) => {
  if (passwordModalOpen()) return;
  const target = event.target instanceof Element ? event.target : null;
  if (printProgressControl.containsFocus() && !event.isComposing && event.keyCode !== 229
    && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
    && (event.key === "Escape" || event.key === "Enter" || event.key === " ")) {
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); printProgressControl.cancel(); }
    return;
  }
  const claimed = rootKeyboard.handleKeyDown({
    key: event.key, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
    repeat: event.repeat, isComposing: event.isComposing, keyCode: event.keyCode,
    altGraph: event.getModifierState("AltGraph"),
    priorityOwnedTarget: isEditableTarget(event.target) || (target !== null && target.closest("dialog[open]") !== null) || isOverlayOwnedKey(event, target),
    nativeOwnedTarget: (isEditableTarget(event.target) && !event.ctrlKey && !event.altKey && !event.metaKey) || isOverlayOwnedKey(event, target),
    preventDefault: () => event.preventDefault(),
  });
  if (claimed) event.stopImmediatePropagation();
}, { capture: true });
const DPR_POLL_DELAY_MS = 250;
let dprMediaQuery: MediaQueryList | undefined;
let dprPollTimer: ReturnType<typeof setTimeout> | undefined;
let devicePixelRatio = window.devicePixelRatio;
const onDprChange = (): void => {
  cancelLinkHints();
  devicePixelRatio = window.devicePixelRatio;
  bindDprChange();
  const session = active().session;
  session.cancelWheelZoom();
  session.invalidateViewportSynchronization();
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
  () => releaseOverlay("search"),
  render,
);
window.addEventListener("resize", () => {
  cancelLinkHints();
  scheduleDprPollFallback();
  if (overlayOwner.active?.id === "recent") fileOpenerRenderer.requestFit();
});
window.addEventListener("blur", rootKeyboard.cancelPending);
window.addEventListener("compositionstart", rootKeyboard.cancelPending);
window.addEventListener("focusin", () => cancelLinkHints());
window.addEventListener("focusin", (event) => { if (isEditableTarget(event.target)) rootKeyboard.cancelPending(); });
fileOpenerForm.addEventListener("submit", (event) => { event.preventDefault(); dispatchFileOpenerEntry(); });
fileOpenerInput.addEventListener("input", () => { fileOpenerModel = updateChooserQuery(fileOpenerModel, fileOpenerInput.value); renderFileOpener(); });
fileOpenerDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeFileOpener(); });
fileOpenerDialog.addEventListener("close", () => {
  fileOpenerRenderer.stop();
  if (overlayOwner.active?.id !== "recent") return;
  releaseOverlay("recent");
  render();
});
fileOpenerDialog.addEventListener("keydown", (event) => {
  if (isNativeCompositionEvent(event)) return;
  if (isPaletteClearShortcut(event)) {
    event.preventDefault();
    event.stopPropagation();
    void clearFileOpenerHistory();
    return;
  }
  const action = commandPaletteKeyAction(event);
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  if (action === "close") { closeFileOpener(); return; }
  if (action === "submit") { dispatchFileOpenerEntry(); return; }
  fileOpenerModel = moveChooserSelection(fileOpenerModel, action === "next" ? 1 : -1);
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
helpDialog.addEventListener("cancel", (event) => { event.preventDefault(); active().session.apply({ type: "prompt.cancel" }); releaseOverlay("help"); render(); });
window.addEventListener("beforeunload", () => {
  printProgressControl.dispose();
  fileOpenerRenderer.stop();
  disposeSearchPrompt();
  themeUnlisten?.();
  recentSnapshotUnlisten?.();
  quitUnlisten?.();
  windowCloseUnlisten?.();
  shellDisposing = true;
  passwordPrompt.dispose();
  shellOpen.dispose();
  removedTabTeardown.dispose();
  rootKeyboard.dispose();
  for (const tab of workspace.snapshot.tabs) workspace.close(tab.id);
  applicationMenuOwner.dispose();
  disposeDprChange();
});
paletteDialog.addEventListener("cancel", (event) => { event.preventDefault(); closePalette(); });
render();
