// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ACTION_IDS, type ActionRuntimeContext } from "../../src/domain/actions/ActionRegistry";
import { BUILT_IN_CONFIG } from "../../src/domain/config/ConfigValidator";
import { createRootKeyboardRouter, type RootKeyboardRouter } from "../../src/platform/RootKeyboardRouter";
import { overlayOwnsKey } from "../../src/ui/overlays/OverlayKeyOwnership";
import { createPrintProgress, type PrintProgressControl } from "../../src/ui/PrintProgress";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const main = source("src/main.ts");

const editableStart = main.indexOf("function isEditableTarget(");
if (editableStart < 0) throw new Error("Production editable-target guard is missing");
const editableBody = main.slice(main.indexOf("{", editableStart) + 1, main.indexOf("\n}", editableStart));
const isEditableTarget = new Function("target", editableBody) as (target: EventTarget | null) => boolean;

const overlayKeyStart = main.indexOf("function isOverlayOwnedKey(");
if (overlayKeyStart < 0) throw new Error("Production overlay-key guard is missing");
const overlayKeyBody = main.slice(main.indexOf("{", overlayKeyStart) + 1, main.indexOf("\n}", overlayKeyStart));
const isOverlayOwnedKey = new Function("event", "target", "overlayOwner", "overlayOwnsKey", overlayKeyBody) as (
  event: KeyboardEvent,
  target: Element | null,
  owner: { readonly active?: { readonly id: string } },
  ownsKey: typeof overlayOwnsKey,
) => boolean;

const rootCapturePrefix = 'window.addEventListener("keydown", (event) => {';
const rootCaptureStart = main.indexOf(rootCapturePrefix);
const rootCaptureEnd = main.indexOf("}, { capture: true });", rootCaptureStart);
if (rootCaptureStart < 0 || rootCaptureEnd < 0) throw new Error("Production root keyboard capture is missing");
const rootCaptureBody = main.slice(rootCaptureStart + rootCapturePrefix.length, rootCaptureEnd);
const routeRootKey = new Function("event", "rootKeyboard", "isEditableTarget", "isOverlayOwnedKey", "printProgressControl", "passwordModalOpen", rootCaptureBody) as (
  event: KeyboardEvent,
  rootKeyboard: RootKeyboardRouter,
  editableGuard: typeof isEditableTarget,
  overlayGuard: (event: KeyboardEvent, target: Element | null) => boolean,
  printControl: PrintProgressControl,
  passwordModalOpen: () => boolean,
) => void;

const runtime: ActionRuntimeContext = {
  hasDocument: true, canCreateSession: true, canOpenDocument: true, canCreateWindow: true,
  tabCount: 1, modalOpen: false, updateAvailable: false, configExists: false,
  searchActive: false, canHistoryBack: true, canHistoryForward: true,
};

function installRootCapture(owner: { readonly active?: { readonly id: string } } = {}, passwordModalOpen: () => boolean = () => false) {
  const printHost = document.createElement("footer");
  document.body.append(printHost);
  const onCancel = vi.fn();
  const printProgressControl = createPrintProgress(printHost, onCancel);
  const onDispatch = vi.fn();
  const rootKeyboard = createRootKeyboardRouter({
    config: BUILT_IN_CONFIG,
    getContext: () => ({ windowId: "window-a", routeRevision: "route-a", generation: 1, inputContext: "navigation", runtime }),
    onDispatch,
  });
  const capture = (event: KeyboardEvent): void => routeRootKey(
    event,
    rootKeyboard,
    isEditableTarget,
    (keyEvent, target) => isOverlayOwnedKey(keyEvent, target, owner, overlayOwnsKey),
    printProgressControl,
    passwordModalOpen,
  );
  window.addEventListener("keydown", capture, true);
  return {
    onDispatch,
    onCancel, printProgressControl, printHost,
    dispose: (): void => {
      window.removeEventListener("keydown", capture, true);
      rootKeyboard.dispose();
      printProgressControl.dispose();
      printHost.remove();
    },
  };
}

describe("Retired reader features", () => {
  it("leaves root keyboard inert while the password modal owns the window", () => {
    const target = document.createElement("button");
    document.body.append(target);
    const reachedTarget = vi.fn();
    target.addEventListener("keydown", reachedTarget);
    const root = installRootCapture({}, () => true);
    try {
      const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
      expect(target.dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
      expect(reachedTarget).toHaveBeenCalledOnce();
      expect(root.onDispatch).not.toHaveBeenCalled();
    } finally {
      root.dispose();
      target.remove();
    }
  });
  it("removes TOC, hints, and destination indicators without removing ordinary reader behavior", () => {
    for (const id of ["toc.toggle", "toc.scrollDown", "toc.scrollUp", "link.hint", "indicator.picker"]) expect(ACTION_IDS).not.toContain(id);
    expect(ACTION_IDS).toEqual(expect.arrayContaining(["history.back", "history.forward", "search.prompt"]));

    for (const path of [
      "src/domain/outlines/OutlineModel.ts", "src/domain/outlines/OutlineSelector.ts",
      "src/pdf/PdfOutlineAdapter.ts", "src/pdf/PdfOutlineProbe.ts",
      "src/ui/reader/TocController.ts", "src/ui/reader/TocWidgetModel.ts", "src/ui/reader/TocWidgetView.ts",
      "src/domain/links/LinkHints.ts", "src/domain/links/IndicatorSettings.ts", "src/ui/IndicatorPickerModel.ts",
    ]) expect(existsSync(resolve(process.cwd(), path))).toBe(false);

    const styles = source("src/styles/app.css");
    const content = source("src/pdf/PdfContentController.ts");
    const session = source("src/pdf/PdfTabSession.ts");
    const facade = source("src/platform/tauri-commands.ts");
    const commandCatalog = source("src/application/commands/CommandCatalog.ts");
    const helpModel = source("src/ui/HelpModel.ts");
    const overlayOwner = source("src/ui/overlays/OverlayOwner.ts");
    const nativeIndicatorApi = `${source("src-tauri/src/lib.rs")}\n${source("src-tauri/src/commands/state.rs")}`;

    for (const text of [main, styles, content]) {
      for (const retired of ["toc-widget", "pdf-link-hint", "handleHintKey", "toggleHints", "hintsVisible"]) expect(text).not.toContain(retired);
    }
    for (const retired of [
      "IndicatorSettings", "IndicatorPickerModel", "indicator-picker", "destination-indicator",
      "indicatorPicker", "indicatorSettings", "readIndicatorState", "commitIndicatorState",
      "indicator.picker", "indicator.open", "linkIndicatorVisible", "dismissLinkIndicator", "indicatorPublicationPending",
    ]) expect(main).not.toContain(retired);
    for (const retired of ["IndicatorSettings", "indicatorSettings", "indicatorElement", "indicatorTimer", "indicatorPublicationPending", "linkIndicatorVisible", "dismissLinkIndicator", "showDestinationIndicator", "pdf-destination-indicator"]) {
      expect(`${content}\n${session}`).not.toContain(retired);
    }
    for (const retired of [".pdf-destination-indicator", "destination-indicator-", "--indicator-color", "--indicator-duration"]) expect(styles).not.toContain(retired);
    for (const retired of ["IndicatorSettings", "readIndicatorState", "commitIndicatorState", "read_indicator_state", "commit_indicator_state"]) expect(facade).not.toContain(retired);
    for (const retired of ["read_indicator_state", "commit_indicator_state"]) expect(nativeIndicatorApi).not.toContain(retired);
    expect(commandCatalog).not.toContain('["indicator.", "settings"]');
    expect(helpModel).not.toContain('id.startsWith("indicator.")');
    expect(overlayOwner).not.toMatch(/["']indicator["']/u);

    const keymap = BUILT_IN_CONFIG.keymap as Readonly<Record<string, readonly string[] | undefined>>;
    expect(keymap["indicator.picker"]).toBeUndefined();
    expect(Object.values(keymap).flatMap((bindings) => bindings ?? [])).not.toContain("I");

    expect(content).toContain("pdf-link-overlay");
    expect(main).toContain('invoke<number>("open_external_link"');
    expect(styles).toContain(".pdf-link-overlay:focus-visible {");
    expect(styles).toContain("--theme-active-search-highlight");
    expect(styles).toContain("--theme-focus-indicator");
  });

  it("keeps ordinary PDF link overlays neutral until keyboard focus, including forced colors", () => {
    const styles = source("src/styles/app.css");
    const idleStart = styles.indexOf(".pdf-link-overlay {");
    const focusStart = styles.indexOf(".pdf-link-overlay:focus-visible {");
    const forcedStart = styles.indexOf("@media (forced-colors: active)");
    const forcedEnd = styles.indexOf("@media (min-resolution", forcedStart);
    expect([idleStart, focusStart, forcedStart, forcedEnd].every((offset) => offset >= 0)).toBe(true);

    const idleRule = styles.slice(idleStart, focusStart);
    expect(idleRule).toContain("--pdf-link-border-color: transparent;");
    expect(idleRule).toContain("appearance: none;");
    expect(idleRule).toContain("border: 0 solid var(--pdf-link-border-color);");
    expect(idleRule).toContain("background: transparent;");
    expect(idleRule).toContain("box-shadow: none;");
    expect(idleRule).toContain("cursor: pointer;");
    expect(idleRule).not.toContain("color-mix");
    expect(styles).not.toContain(".pdf-link-overlay:hover");
    expect(styles.slice(focusStart, forcedStart)).toContain("outline: 2px solid var(--theme-focus-indicator);");

    const forcedRules = styles.slice(forcedStart, forcedEnd);
    expect(forcedRules).toContain(".pdf-link-overlay { background: transparent; box-shadow: none; forced-color-adjust: none; }");
    expect(forcedRules).toContain(".pdf-link-overlay:focus-visible { outline: 3px solid Highlight; outline-offset: 1px; }");
  });
  it.each([
    { label: "plain Escape", key: "Escape" },
    { label: "retired f hint", key: "f" },
    { label: "retired t hint", key: "t" },
    { label: "unrelated Shift+J", key: "J", shiftKey: true },
    { label: "unrelated Shift+K", key: "K", shiftKey: true },
    { label: "modified Escape", key: "Escape", ctrlKey: true },
    { label: "IME Escape", key: "Escape", isComposing: true },
    { label: "legacy IME Escape", key: "Escape", keyCode: 229 },
  ])("leaves $label unclaimed by the retained root capture", ({ label: _label, ...init }) => {
    const target = document.createElement("button");
    document.body.append(target);
    const reachedTarget = vi.fn();
    target.addEventListener("keydown", reachedTarget);
    const root = installRootCapture();
    try {
      const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      expect(target.dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
      expect(reachedTarget).toHaveBeenCalledOnce();
      expect(root.onDispatch).not.toHaveBeenCalled();
    } finally {
      root.dispose();
      target.remove();
    }
  });

  it.each([
    { label: "owned search overlay", tag: "button", dialogId: "search-dialog", activeOverlay: "search" },
    { label: "editable input", tag: "input" },
  ])("leaves $label Escape to its ordinary owner", ({ label: _label, tag, dialogId, activeOverlay }) => {
    const target = document.createElement(tag);
    const container = dialogId === undefined ? target : document.createElement("dialog");
    if (dialogId !== undefined) {
      container.id = dialogId;
      container.append(target);
    }
    document.body.append(container);
    const reachedTarget = vi.fn();
    target.addEventListener("keydown", reachedTarget);
    const root = installRootCapture(activeOverlay === undefined ? {} : { active: { id: activeOverlay } });
    try {
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      expect(target.dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
      expect(reachedTarget).toHaveBeenCalledOnce();
      expect(root.onDispatch).not.toHaveBeenCalled();
    } finally {
      root.dispose();
      container.remove();
    }
  });

  it.each([
    { label: "plain", ctrlKey: false, isComposing: false, cancelled: true },
    { label: "modified", ctrlKey: true, isComposing: false, cancelled: false },
    { label: "IME", ctrlKey: false, isComposing: true, cancelled: false },
  ])("scopes $label print Escape to the active control", ({ ctrlKey, isComposing, cancelled }) => {
    const root = installRootCapture();
    try {
      root.printProgressControl.update({ phase: "preparing", preparedPages: 1, totalPages: 4, fraction: 0.25 });
      const button = root.printHost.querySelector<HTMLButtonElement>("button")!;
      button.focus();
      const event = new KeyboardEvent("keydown", { key: "Escape", ctrlKey, isComposing, bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(cancelled);
      expect(root.onCancel).toHaveBeenCalledTimes(cancelled ? 1 : 0);
      expect(root.onDispatch).not.toHaveBeenCalled();
    } finally { root.dispose(); }
  });
  it("has no dedicated global indicator dismissal capture", () => {
    expect(main.match(/window\.addEventListener\("keydown"/gu) ?? []).toHaveLength(1);
    expect(rootCaptureBody.toLocaleLowerCase()).not.toContain("indicator");
  });
});
