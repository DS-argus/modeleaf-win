// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { ScriptTarget, transpileModule } from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  adoptChooserSnapshot,
  chooserRows,
  createOpenChooser,
  moveChooserSelection,
  retainChooserFailure,
  selectChooserIndex,
  updateChooserQuery,
  type OpenChooserModel,
} from "../../src/ui/OpenChooserModel";
import { commandPaletteKeyAction, isPaletteClearShortcut } from "../../src/ui/CommandPaletteModel";
import { createOverlayOwner, reduceOverlayOwner, type OverlayOwnerState } from "../../src/ui/overlays/OverlayOwner";
import { createShellOpenCoordinator, type ShellOpenCoordinator } from "../../src/platform/ShellOpenCoordinator";
import type { NativeDialogOutcome } from "../../src/platform/tauri-commands";

const main = readFileSync("src/main.ts", "utf8");

function sourceFragment(start: string, end: string, label: string): string {
  const startIndex = main.indexOf(start);
  const endIndex = startIndex < 0 ? -1 : main.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) throw new Error(`Production ${label} anchors are missing`);
  return main.slice(startIndex, endIndex);
}
function inclusiveMarkup(start: string, end: string, label: string): string {
  return `${sourceFragment(start, end, label)}${end}`;
}
function sourceLine(start: string, label: string): string {
  const startIndex = main.indexOf(start);
  const endIndex = startIndex < 0 ? -1 : main.indexOf("\n", startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Production ${label} anchor is missing`);
  return main.slice(startIndex, endIndex);
}

const APP_SHELL_OPEN = sourceLine('<section id="app-shell"', "app-shell markup");
const TAB_HOSTS_MARKUP = inclusiveMarkup('<section id="tab-hosts"', "</section>", "tab-host markup");
const EMPTY_READER_MARKUP = inclusiveMarkup('<section id="empty-reader"', "</section>", "empty-reader markup");
const CHOOSER_MARKUP = sourceFragment(
  '<dialog id="file-opener-dialog"',
  '  <dialog id="command-palette-dialog"',
  "file chooser markup",
).trimEnd();

const readerHostSource = sourceFragment(
  '  const host = document.createElement("section");',
  '  const copyContextMenu =',
  "reader host creation",
);
const readerHostCode = transpileModule(readerHostSource, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;
const createProductionReaderHost = new Function(
  "document",
  "tabHosts",
  `${readerHostCode}\nreturn host;`,
) as (documentValue: Document, tabHosts: HTMLElement) => HTMLElement;

const productionFragments = [
  sourceFragment("function isNativeCompositionEvent(", "function isOverlayOwnedKey(", "native composition guard"),
  sourceFragment('const SHELL_WINDOW_ID = "current-window";', "const applicationMenuOwner =", "overlay focus prelude"),
  sourceFragment("function claimOverlay(", "const paletteList =", "overlay open/close functions"),
  sourceFragment("function restoreOpenFocus(", "function handleOpenTerminal(", "native terminal focus restoration"),
  sourceFragment("const shellOpen = createShellOpenCoordinator({", 'emptyReaderOpen.addEventListener("click"', "shell open coordinator initializer"),
  sourceFragment("function renderFileOpener(", "let fileOpenerPathFitFrame", "chooser renderer"),
  sourceFragment("function closeFileOpener(", "let quitRequest", "chooser open/close/dispatch functions"),
  sourceFragment('fileOpenerForm.addEventListener("submit"', 'paletteInput.addEventListener("input"', "chooser DOM listeners"),
].join("\n");
const productionCode = transpileModule(productionFragments, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: () => boolean;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let isSettled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    settled: () => isSettled,
    resolve: (value) => { if (!isSettled) { isSettled = true; resolvePromise(value); } },
    reject: (error) => { if (!isSettled) { isSettled = true; rejectPromise(error); } },
  };
}

interface ProductionApi {
  readonly openFileOpener: () => Promise<void>;
  readonly closeFileOpener: () => void;
  readonly dispatchFileOpenerEntry: () => void;
  readonly renderFileOpener: () => void;
  readonly restoreOpenFocus: (terminal: { readonly tag: string; readonly requestId?: string }) => void;
  readonly isNativeCompositionEvent: (event: KeyboardEvent) => boolean;
  readonly shellOpen: ShellOpenCoordinator;
  readonly nativeOpenPending: boolean;
  readonly overlayOwner: OverlayOwnerState;
  readonly fileOpenerModel: OpenChooserModel;
}
interface NativeBoundarySnapshot {
  readonly dialogOpen: boolean;
  readonly activeElementId: string | null;
}
interface ChooserHarness {
  readonly api: ProductionApi;
  readonly dialog: HTMLDialogElement;
  readonly form: HTMLFormElement;
  readonly input: HTMLInputElement;
  readonly list: HTMLElement;
  readonly emptyOpen: HTMLButtonElement;
  readonly host: HTMLElement;
  readonly reportFailure: ReturnType<typeof vi.fn>;
  readonly invoke: ReturnType<typeof vi.fn>;
  readonly nativeGates: Deferred<NativeDialogOutcome>[];
  readonly boundaries: NativeBoundarySnapshot[];
  readonly openChooser: () => Promise<void>;
  readonly browseButton: () => HTMLButtonElement;
  readonly commandCalls: (command: string) => readonly unknown[][];
  readonly cleanup: () => Promise<void>;
}

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  if (originalScrollIntoView === undefined) delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  else Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
});

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function createHarness(hasDocument = false): Promise<ChooserHarness> {
  document.body.innerHTML = `${APP_SHELL_OPEN}
    <main>${TAB_HOSTS_MARKUP}${EMPTY_READER_MARKUP}</main>
    ${CHOOSER_MARKUP}
  </section>`;
  const appShell = document.querySelector<HTMLElement>("#app-shell");
  const tabHosts = document.querySelector<HTMLElement>("#tab-hosts");
  const emptyOpen = document.querySelector<HTMLButtonElement>("#empty-reader-open");
  const dialog = document.querySelector<HTMLDialogElement>("#file-opener-dialog");
  const form = document.querySelector<HTMLFormElement>("#file-opener-form");
  const input = document.querySelector<HTMLInputElement>("#file-opener-input");
  const list = document.querySelector<HTMLElement>("#file-opener-list");
  if (appShell === null || tabHosts === null || emptyOpen === null || dialog === null || form === null || input === null || list === null) {
    throw new Error("Production chooser markup did not create its required DOM");
  }

  Object.defineProperties(dialog, {
    showModal: {
      configurable: true,
      value: () => { dialog.setAttribute("open", ""); },
    },
    close: {
      configurable: true,
      value: () => {
        if (!dialog.hasAttribute("open")) return;
        dialog.removeAttribute("open");
        dialog.dispatchEvent(new Event("close"));
      },
    },
  });

  const host = createProductionReaderHost(document, tabHosts);
  const session = {
    snapshot: { reader: { hasDocument } },
    reader: { setStatus: vi.fn() },
  };
  const active = () => ({ host, session });
  (hasDocument ? host : emptyOpen).focus();

  const nativeGates: Deferred<NativeDialogOutcome>[] = [];
  const boundaries: NativeBoundarySnapshot[] = [];
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (command === "list_pending_open_ingress") return [];
    if (command === "open_pdf_dialog") {
      boundaries.push({
        dialogOpen: dialog.hasAttribute("open"),
        activeElementId: document.activeElement instanceof HTMLElement ? document.activeElement.id : null,
      });
      const gate = deferred<NativeDialogOutcome>();
      nativeGates.push(gate);
      return gate.promise;
    }
    if (command === "reject_open_request") {
      if (typeof args?.requestId !== "string") throw new Error("Late rejection omitted its request ID");
      return undefined;
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
  const listen = vi.fn(async () => () => undefined);
  const reportFailure = vi.fn();
  const render = vi.fn();
  const startFileOpenerPathFitting = vi.fn();
  const stopFileOpenerPathFitting = vi.fn();
  const applicationMenuOwner = { close: vi.fn() };
  const prompt = document.createElement("section");
  const themeDialog = document.createElement("dialog");
  const paletteDialog = document.createElement("dialog");
  const searchDialog = document.createElement("dialog");
  const helpDialog = document.createElement("dialog");
  const searchInput = document.createElement("input");
  appShell.append(prompt, themeDialog, paletteDialog, searchDialog, helpDialog, searchInput);

  const dependencies = {
    createOpenChooser,
    chooserRows,
    updateChooserQuery,
    moveChooserSelection,
    selectChooserIndex,
    adoptChooserSnapshot,
    retainChooserFailure,
    commandPaletteKeyAction,
    isPaletteClearShortcut,
    createOverlayOwner,
    reduceOverlayOwner,
    createShellOpenCoordinator,
    fileOpenerModel: createOpenChooser({ tag: "READY" as const, snapshot: { revision: "0", entries: [] } }, 0),
    nativeOpenPending: false,
    initialRecentsReady: Promise.resolve(),
    fileOpenerDialog: dialog,
    fileOpenerForm: form,
    fileOpenerInput: input,
    fileOpenerList: list,
    emptyReaderOpen: emptyOpen,
    active,
    applicationMenuOwner,
    prompt,
    themeDialog,
    paletteDialog,
    searchDialog,
    helpDialog,
    searchInput,
    pagePromptTransaction: undefined,
    suspendedPagePrompt: undefined,
    pagePromptRevision: 0,
    ownsPagePrompt: () => false,
    startFileOpenerPathFitting,
    stopFileOpenerPathFitting,
    render,
    openRecentDocument: () => { throw new Error("Recent dispatch is outside this chooser-input harness"); },
    clearFileOpenerHistory: () => { throw new Error("Recent clearing is outside this chooser-input harness"); },
    RECENT_STATE_UNAVAILABLE: "Recent documents unavailable",
    shellDisposing: false,
    reportOpenInvokeFailure: reportFailure,
    pendingOpenAdoptions: new Map(),
    adoptRequest: () => { throw new Error("Adoption is outside these native-terminal cases"); },
    handleOpenTerminal: vi.fn(),
    listen,
    invoke,
  };
  const names = Object.keys(dependencies);
  const factory = new Function(
    ...names,
    `${productionCode}
return {
  openFileOpener,
  closeFileOpener,
  dispatchFileOpenerEntry,
  renderFileOpener,
  restoreOpenFocus,
  isNativeCompositionEvent,
  shellOpen,
  get nativeOpenPending() { return nativeOpenPending; },
  get overlayOwner() { return overlayOwner; },
  get fileOpenerModel() { return fileOpenerModel; },
};`,
  );
  const api = factory(...Object.values(dependencies)) as ProductionApi;
  await api.shellOpen.ready;

  const harness: ChooserHarness = {
    api,
    dialog,
    form,
    input,
    list,
    emptyOpen,
    host,
    reportFailure,
    invoke,
    nativeGates,
    boundaries,
    openChooser: async () => {
      await api.openFileOpener();
      if (!dialog.hasAttribute("open") || document.activeElement !== input) throw new Error("Production chooser failed to open and focus its filter");
    },
    browseButton: () => {
      const button = list.querySelector<HTMLButtonElement>(".file-opener-browse");
      if (button === null) throw new Error("Production chooser did not render Browse");
      return button;
    },
    commandCalls: (command) => invoke.mock.calls.filter(([candidate]) => candidate === command),
    cleanup: async () => {
      for (const gate of nativeGates) if (!gate.settled()) gate.resolve({ tag: "CANCELLED" });
      await settleMicrotasks();
      api.shellOpen.dispose();
      await settleMicrotasks();
      document.body.replaceChildren();
    },
  };
  return harness;
}

interface KeyOptions extends KeyboardEventInit {
  readonly keyCode?: number;
  readonly altGraph?: boolean;
}
function keyboard(type: "keydown" | "keyup", options: KeyOptions): KeyboardEvent {
  const { keyCode, altGraph, ...init } = options;
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { configurable: true, value: keyCode });
  if (altGraph === true) {
    Object.defineProperty(event, "getModifierState", {
      configurable: true,
      value: (modifier: string) => modifier === "AltGraph",
    });
  }
  return event;
}

const CANCELLED: NativeDialogOutcome = { tag: "CANCELLED" };

describe("Open chooser production input wiring", () => {
  it("closes and restores empty-state focus before filter Enter invokes native exactly once, without waiting for keyup", async () => {
    const subject = await createHarness();
    try {
      await subject.openChooser();
      subject.input.value = "no recent match";
      subject.input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(subject.api.fileOpenerModel.query).toBe("no recent match");

      const enter = keyboard("keydown", { key: "Enter" });
      subject.input.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(true);
      expect(subject.commandCalls("open_pdf_dialog")).toHaveLength(1);
      expect(subject.boundaries).toEqual([{ dialogOpen: false, activeElementId: "empty-reader-open" }]);
      expect(document.activeElement).toBe(subject.emptyOpen);
      expect(subject.dialog.hasAttribute("open")).toBe(false);
      expect(subject.api.nativeOpenPending).toBe(true);

      subject.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      subject.browseButton().click();
      subject.input.dispatchEvent(keyboard("keydown", { key: "Enter", repeat: true }));
      expect(subject.commandCalls("open_pdf_dialog")).toHaveLength(1);

      // Deliberately send no keyup: native terminal ownership must release this epoch.
      subject.nativeGates[0]!.resolve(CANCELLED);
      await vi.waitFor(() => expect(subject.api.nativeOpenPending).toBe(false));
      expect(document.activeElement).toBe(subject.emptyOpen);
      await subject.openChooser();
      expect(subject.api.overlayOwner.active?.id).toBe("recent");
    } finally {
      await subject.cleanup();
    }
  });

  it("uses focused-button Enter and suppresses the browser-generated duplicate click while native is pending", async () => {
    const subject = await createHarness(true);
    try {
      await subject.openChooser();
      const browse = subject.browseButton();
      browse.focus();
      const enter = keyboard("keydown", { key: "Enter" });
      browse.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(true);
      expect(subject.commandCalls("open_pdf_dialog")).toHaveLength(1);
      expect(subject.boundaries).toEqual([{ dialogOpen: false, activeElementId: subject.host.id }]);
      expect(document.activeElement).toBe(subject.host);

      // JSDOM does not synthesize the native button activation click for Enter.
      browse.click();
      expect(subject.commandCalls("open_pdf_dialog")).toHaveLength(1);

      subject.nativeGates[0]!.resolve({ tag: "DIALOG_FAILED", reason: "PICKER_FAILED" });
      await vi.waitFor(() => expect(subject.api.nativeOpenPending).toBe(false));
      expect(subject.reportFailure).toHaveBeenCalledWith({ tag: "DIALOG_FAILED", reason: "PICKER_FAILED" });
      expect(document.activeElement).toBe(subject.host);
      await subject.openChooser();
    } finally {
      await subject.cleanup();
    }
  });

  it("requires the modeled browser click for Space and dispatches a separate pointer click", async () => {
    const subject = await createHarness();
    try {
      await subject.openChooser();
      const spaceBrowse = subject.browseButton();
      spaceBrowse.focus();
      const down = keyboard("keydown", { key: " ", code: "Space" });
      const up = keyboard("keyup", { key: " ", code: "Space" });
      spaceBrowse.dispatchEvent(down);
      spaceBrowse.dispatchEvent(up);
      expect(down.defaultPrevented).toBe(false);
      expect(up.defaultPrevented).toBe(false);
      expect(subject.commandCalls("open_pdf_dialog")).toHaveLength(0);

      // JSDOM has no native keyboard activation; this is the browser-produced Space click boundary.
      spaceBrowse.click();
      expect(subject.commandCalls("open_pdf_dialog")).toHaveLength(1);
      subject.nativeGates[0]!.resolve(CANCELLED);
      await vi.waitFor(() => expect(subject.api.nativeOpenPending).toBe(false));

      await subject.openChooser();
      const pointerBrowse = subject.browseButton();
      pointerBrowse.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      expect(subject.commandCalls("open_pdf_dialog")).toHaveLength(2);
      subject.nativeGates[1]!.resolve(CANCELLED);
      await vi.waitFor(() => expect(subject.api.nativeOpenPending).toBe(false));
    } finally {
      await subject.cleanup();
    }
  });

  const nativeCompositionCases = [
    { label: "isComposing Enter", options: { key: "Enter", isComposing: true } },
    { label: "legacy keyCode 229 Enter", options: { key: "Enter", keyCode: 229 } },
    { label: "Dead key", options: { key: "Dead" } },
    { label: "Process key", options: { key: "Process" } },
    { label: "AltGraph Enter", options: { key: "Enter", altGraph: true } },
  ] satisfies readonly { readonly label: string; readonly options: KeyOptions }[];
  const guardedTargets = nativeCompositionCases.flatMap((entry) => [
    { ...entry, target: "filter" as const },
    { ...entry, target: "button" as const },
  ]);

  it.each(guardedTargets)("does not dispatch $label from the $target", async ({ options, target }) => {
    const subject = await createHarness();
    try {
      await subject.openChooser();
      const destination = target === "filter" ? subject.input : subject.browseButton();
      destination.focus();
      const event = keyboard("keydown", options);
      expect(subject.api.isNativeCompositionEvent(event)).toBe(true);
      destination.dispatchEvent(event);
      expect(subject.commandCalls("open_pdf_dialog")).toHaveLength(0);
      expect(subject.dialog.hasAttribute("open")).toBe(true);
    } finally {
      await subject.cleanup();
    }
  });

  it("lets Escape and the dialog cancel event close without native dispatch and restore focus", async () => {
    const subject = await createHarness();
    try {
      await subject.openChooser();
      const escape = keyboard("keydown", { key: "Escape" });
      subject.input.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(true);
      expect(subject.dialog.hasAttribute("open")).toBe(false);
      expect(document.activeElement).toBe(subject.emptyOpen);
      expect(subject.commandCalls("open_pdf_dialog")).toHaveLength(0);

      await subject.openChooser();
      const cancel = new Event("cancel", { bubbles: false, cancelable: true });
      expect(subject.dialog.dispatchEvent(cancel)).toBe(false);
      expect(cancel.defaultPrevented).toBe(true);
      expect(subject.dialog.hasAttribute("open")).toBe(false);
      expect(document.activeElement).toBe(subject.emptyOpen);
      expect(subject.commandCalls("open_pdf_dialog")).toHaveLength(0);
    } finally {
      await subject.cleanup();
    }
  });

  it("falls back to the real empty-state target when the captured return target disconnects", async () => {
    const subject = await createHarness();
    try {
      const transient = document.createElement("button");
      transient.id = "transient-open-owner";
      document.querySelector("#app-shell")!.append(transient);
      transient.focus();
      await subject.openChooser();
      transient.remove();

      subject.input.dispatchEvent(keyboard("keydown", { key: "Escape" }));
      expect(subject.dialog.hasAttribute("open")).toBe(false);
      expect(document.activeElement).toBe(subject.emptyOpen);
    } finally {
      await subject.cleanup();
    }
  });

  it("releases and reopens after a rejected native invocation", async () => {
    const subject = await createHarness();
    try {
      await subject.openChooser();
      subject.browseButton().click();
      subject.nativeGates[0]!.reject(new Error("native boundary rejected"));
      await vi.waitFor(() => expect(subject.api.nativeOpenPending).toBe(false));
      expect(subject.reportFailure).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(subject.emptyOpen);
      await subject.openChooser();
      expect(subject.dialog.hasAttribute("open")).toBe(true);
    } finally {
      await subject.cleanup();
    }
  });

  it("rejects a late admitted result after disposal and never starts a second native dialog", async () => {
    const subject = await createHarness();
    try {
      await subject.openChooser();
      subject.browseButton().click();
      expect(subject.commandCalls("open_pdf_dialog")).toHaveLength(1);

      subject.api.shellOpen.dispose();
      expect(subject.api.nativeOpenPending).toBe(false);
      const requestId = "a".repeat(64);
      subject.nativeGates[0]!.resolve({ tag: "ADMITTED", requestId });
      await vi.waitFor(() => expect(subject.commandCalls("reject_open_request")).toHaveLength(1));
      expect(subject.commandCalls("reject_open_request")[0]?.[1]).toEqual({ requestId });
      expect(subject.reportFailure).not.toHaveBeenCalled();

      await subject.openChooser();
      subject.browseButton().click();
      expect(subject.commandCalls("open_pdf_dialog")).toHaveLength(1);
      expect(subject.commandCalls("reject_open_request")).toHaveLength(1);
    } finally {
      await subject.cleanup();
    }
  });
});
