import { classifyPdfFailure, presentPdfFailure } from "../../src/core/PdfFailureDiagnostic";
import { createPdfFailureReporter } from "../../src/platform/PdfFailureDiagnostics";
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { openFailureAccessibilityError, openFailurePhase, openFailureStatus } from "../../src/domain/navigation/OpenFailureIdentifier";
import { nativeOpenError } from "../../src/domain/navigation/OpenError";
import { decodeRecentStateChanged, listRecentDocuments, openRecentDocument } from "../../src/platform/tauri-commands";
import {
  adoptChooserSnapshot,
  chooserRows,
  createOpenChooser,
  retainChooserFailure,
  selectChooserIndex,
  type OpenChooserModel,
} from "../../src/ui/OpenChooserModel";

const mainSource = readFileSync(`${process.cwd()}/src/main.ts`, "utf8");
const RECENT_STATE_UNAVAILABLE = "Recent documents are unavailable because application state could not be read.";
const RECENT_OPEN_FAILED = "The recent PDF could not be opened.";
const entry = {
  recentId: `recent-${"1".padStart(32, "0")}`,
  displayName: "retained.pdf",
  displayPath: "C:\\Documents\\retained.pdf",
};

function productionSlice(start: string, end: string): string {
  const startIndex = mainSource.indexOf(start);
  const endIndex = mainSource.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Missing production fragment: ${start}`);
  return mainSource.slice(startIndex, endIndex);
}

function evaluate<T>(fragment: string, dependencies: Record<string, unknown>, result: string): T {
  const names = Object.keys(dependencies);
  const code = ts.transpile(fragment, { target: ts.ScriptTarget.ES2022 });
  return new Function(...names, `${code}\nreturn ${result};`)(...Object.values(dependencies)) as T;
}

type RecentEventHandler = (event: { readonly payload: unknown }) => void;
type RecentLifecycleHarness = {
  readonly initialRecentsReady: Promise<void>;
  readonly openFileOpener: () => Promise<void>;
  readonly getModel: () => OpenChooserModel;
};

function createRecentLifecycleHarness(
  listen: (event: string, handler: RecentEventHandler) => Promise<() => void>,
  invoke: (command: string) => Promise<unknown>,
) {
  const overlayOwner: { active?: { readonly id: string } } = {};
  const renderFileOpener = vi.fn();
  const politeAnnouncements = document.createElement("div");
  const accessibility = { flush: vi.fn() };
  const fileOpenerInput = document.createElement("input");
  fileOpenerInput.value = "stale query";
  const claimOverlay = vi.fn((id: string) => { overlayOwner.active = { id }; });
  let activeStatus = "Page 4 of 12.";
  const setStatus = vi.fn((status: string) => { activeStatus = status; });
  const reportOpenInvokeFailure = vi.fn();
  const fragment = productionSlice("const RECENT_STATE_UNAVAILABLE", "function paletteEntries")
    + productionSlice("async function openFileOpener", "let quitRequest");
  const api = evaluate<RecentLifecycleHarness>(fragment, {
    fileOpenerModel: createOpenChooser({ tag: "READY", snapshot: { revision: "0", entries: [] } }, 7),
    listen,
    decodeRecentStateChanged,
    adoptChooserSnapshot,
    retainChooserFailure,
    createOpenChooser,
    overlayOwner,
    renderFileOpener,
    politeAnnouncements,
    accessibility,
    listRecentDocuments,
    invoke,
    nativeOpenPending: false,
    passwordModalOpen: () => false,
    fileOpenerInput,
    claimOverlay,
    active: () => ({ session: { reader: { setStatus } } }),
    reportOpenInvokeFailure,
    shellOpen: { ready: Promise.resolve() },
  }, "({ initialRecentsReady, openFileOpener, getModel: () => fileOpenerModel })");
  return {
    ...api,
    overlayOwner,
    renderFileOpener,
    politeAnnouncements,
    fileOpenerInput,
    claimOverlay,
    reportOpenInvokeFailure,
    setStatus,
    getActiveStatus: () => activeStatus,
  };
}

type OpenFailureHarness = {
  readonly dispatchFileOpenerEntry: () => void;
  readonly reportOpenInvokeFailure: (error?: unknown, fallbackStatus?: string) => void;
  readonly getModel: () => OpenChooserModel;
  readonly isNativeOpenPending: () => boolean;
};

function createOpenFailureHarness(rejection: unknown) {
  let activeStatus = "Page 4 of 12.";
  const setStatus = vi.fn((status: string) => { activeStatus = status; });
  const session = { reader: { setStatus }, get snapshot() { return { closed: false, status: activeStatus, reader: { documentGeneration: 1 } }; } };
  const accessibility = { announce: vi.fn() };
  const render = vi.fn();
  const renderFileOpener = vi.fn();
  const invoke = vi.fn(async () => { throw rejection; });
  const model = selectChooserIndex(createOpenChooser({
    tag: "READY",
    snapshot: { revision: "0", entries: [entry] },
  }, 9), 1);
  const fragment = productionSlice("const OPEN_FAILURE_STATUS", "const RECENT_STORAGE_FAILED")
    + productionSlice("function dispatchFileOpenerEntry", "async function openFileOpener");
  const api = evaluate<OpenFailureHarness>(fragment, {
    nativeOpenError,
    classifyPdfFailure, presentPdfFailure, createPdfFailureReporter,
    active: () => ({ session }),
    accessibility,
    render,
    openFailureAccessibilityError,
    openFailurePhase,
    openFailureStatus,
    nativeOpenPending: false,
    passwordModalOpen: () => false,
    fileOpenerModel: model,
    chooserRows,
    closeFileOpener: vi.fn(),
    shellOpen: { requestOpen: vi.fn(), admitOpen: vi.fn() },
    openRecentDocument,
    invoke,
    adoptChooserSnapshot,
    retainChooserFailure,
    renderFileOpener,
    RECENT_STATE_UNAVAILABLE,
  }, "({ dispatchFileOpenerEntry, reportOpenInvokeFailure, getModel: () => fileOpenerModel, isNativeOpenPending: () => nativeOpenPending })");
  return {
    ...api,
    accessibility,
    invoke,
    render,
    renderFileOpener,
    setStatus,
    getActiveStatus: () => activeStatus,
  };
}

describe("recent failure reporting", () => {
  it("retains a valid revision-zero snapshot and active PDF status after a malformed broadcast", async () => {
    const handler = { current: undefined as RecentEventHandler | undefined };
    const listen = vi.fn(async (_event: string, callback: RecentEventHandler) => {
      handler.current = callback;
      return () => undefined;
    });
    const invoke = vi.fn(async () => ({ tag: "READY", revision: "0", entries: [entry] }));
    const harness = createRecentLifecycleHarness(listen, invoke);

    await harness.initialRecentsReady;
    harness.overlayOwner.active = { id: "recent" };
    handler.current?.({ payload: { tag: "READY", revision: "1", entries: "malformed" } });

    expect(harness.getModel()).toMatchObject({
      prepared: { tag: "READY", snapshot: { revision: "0", entries: [entry] } },
      diagnostic: RECENT_STATE_UNAVAILABLE,
    });
    expect(chooserRows(harness.getModel())).toHaveLength(2);
    expect(harness.renderFileOpener).toHaveBeenCalledOnce();
    expect(harness.getActiveStatus()).toBe("Page 4 of 12.");
    expect(harness.setStatus).not.toHaveBeenCalled();
    expect(harness.reportOpenInvokeFailure).not.toHaveBeenCalled();
    expect(harness.politeAnnouncements.textContent).toBe(RECENT_STATE_UNAVAILABLE);
  });

  it("waits for native open-request readiness before exposing recent selections", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const source = productionSlice("async function openFileOpener", "let quitRequest");
    const overlayOwner: { active?: { readonly id: string } } = {};
    const claimOverlay = vi.fn((id: string) => { overlayOwner.active = { id }; });
    const open = evaluate<() => Promise<void>>(source, {
      nativeOpenPending: false,
      passwordModalOpen: () => false,
      overlayOwner,
      initialRecentsReady: Promise.resolve(),
      shellOpen: { ready },
      fileOpenerModel: createOpenChooser({ tag: "READY", snapshot: { revision: "0", entries: [entry] } }),
      recentStateHealth: "READY",
      RECENT_STATE_UNAVAILABLE,
      createOpenChooser,
      fileOpenerInput: document.createElement("input"),
      claimOverlay,
      renderFileOpener: vi.fn(),
      active: () => ({ session: { reader: { setStatus: vi.fn() } } }),
    }, "openFileOpener");
    const opening = open();
    await Promise.resolve();
    expect(claimOverlay).not.toHaveBeenCalled();
    release();
    await opening;
    expect(claimOverlay).toHaveBeenCalledWith("recent");
  });
  it("keeps a readable snapshot and unavailable diagnostic when the chooser opens after listener registration fails", async () => {
    const listen = vi.fn(async () => { throw new Error("listener unavailable"); });
    const invoke = vi.fn(async () => ({ tag: "READY", revision: "0", entries: [entry] }));
    const harness = createRecentLifecycleHarness(listen, invoke);

    await harness.initialRecentsReady;
    await harness.openFileOpener();

    expect(harness.getModel()).toMatchObject({
      generation: 8,
      prepared: { tag: "READY", snapshot: { revision: "0", entries: [entry] } },
      diagnostic: RECENT_STATE_UNAVAILABLE,
    });
    expect(chooserRows(harness.getModel())).toHaveLength(2);
    expect(harness.claimOverlay).toHaveBeenCalledWith("recent");
    expect(harness.renderFileOpener).toHaveBeenCalledOnce();
    expect(harness.fileOpenerInput.value).toBe("");
    expect(harness.getActiveStatus()).toBe("Page 4 of 12.");
    expect(harness.setStatus).not.toHaveBeenCalled();
    expect(harness.reportOpenInvokeFailure).not.toHaveBeenCalled();
    expect(harness.politeAnnouncements.textContent).toBe(RECENT_STATE_UNAVAILABLE);
  });

  it("disables recent rows when neither subscription nor an initial snapshot is available", async () => {
    const listen = vi.fn(async () => { throw new Error("listener unavailable"); });
    const invoke = vi.fn(async () => { throw new Error("state unavailable"); });
    const harness = createRecentLifecycleHarness(listen, invoke);

    await harness.initialRecentsReady;

    expect(harness.getModel().prepared).toEqual({ tag: "STATE_UNAVAILABLE", reason: RECENT_STATE_UNAVAILABLE });
    expect(chooserRows(harness.getModel())).toEqual([{ kind: "browse", label: "Browse..." }]);
    expect(harness.getActiveStatus()).toBe("Page 4 of 12.");
    expect(harness.politeAnnouncements.textContent).toBe(RECENT_STATE_UNAVAILABLE);
  });

  it("preserves the recent-specific status and releases pending state on an untyped invoke rejection", async () => {
    const harness = createOpenFailureHarness(new Error("bridge unavailable"));

    harness.dispatchFileOpenerEntry();
    expect(harness.isNativeOpenPending()).toBe(true);
    await vi.waitFor(() => expect(harness.isNativeOpenPending()).toBe(false));

    expect(harness.invoke).toHaveBeenCalledWith("open_recent", { recentId: entry.recentId });
    expect(harness.getModel().diagnostic).toBe(RECENT_OPEN_FAILED);
    expect(chooserRows(harness.getModel())).toHaveLength(2);
    expect(harness.getActiveStatus().split(" (diagnostic ")[0]).toBe(`${RECENT_OPEN_FAILED} [PDF_OPEN_REQUEST]`);
    expect(harness.setStatus).not.toHaveBeenCalledWith("The PDF could not be opened.");
    expect(harness.accessibility.announce).toHaveBeenCalledWith({ kind: "error", error: "open-unknown" });
    expect(harness.renderFileOpener).toHaveBeenCalledOnce();
  });

  it.each([
    ["SESSION_CAPACITY", "This PDF exceeds reader resource limits."],
    ["MISSING_FILE", "This PDF no longer exists."],
    ["PDF_INVALID", "Could not read this PDF."],
    ["untrusted error text", "Could not open PDF. [OPEN_UNKNOWN]"],
  ])("preserves the known picker rejection reason %s without exposing unknown text", (reason, expected) => {
    const harness = createOpenFailureHarness(new Error("unused"));
    harness.reportOpenInvokeFailure({ tag: "SELECTION_REJECTED", reason });
    expect(harness.getActiveStatus()).toBe(`${expected} [PDF_OPEN_REQUEST]`);
  });
  it("still applies a precise known native classification and the generic default elsewhere", async () => {
    const harness = createOpenFailureHarness({ tag: "MISSING_FILE" });

    harness.dispatchFileOpenerEntry();
    await vi.waitFor(() => expect(harness.isNativeOpenPending()).toBe(false));

    expect(harness.getActiveStatus().split(" (diagnostic ")[0]).toBe("This PDF no longer exists. [PDF_OPEN_REQUEST]");
    expect(harness.accessibility.announce).toHaveBeenLastCalledWith({ kind: "error", error: "document-invalid" });

    harness.reportOpenInvokeFailure(new Error("unclassified"));
    expect(harness.getActiveStatus()).toBe("Could not open PDF. [OPEN_UNKNOWN] [PDF_OPEN_REQUEST]");
    expect(harness.setStatus).toHaveBeenLastCalledWith("Could not open PDF. [OPEN_UNKNOWN] [PDF_OPEN_REQUEST]");
  });
});
