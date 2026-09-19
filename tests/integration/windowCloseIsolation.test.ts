import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const source = readFileSync(`${process.cwd()}/src/main.ts`, "utf8");
const fragment = source.slice(source.indexOf("let quitRequest:"), source.indexOf("function dispatchActionId("));
const code = ts.transpile(fragment, { target: ts.ScriptTarget.ES2022 });
afterEach(() => vi.unstubAllGlobals());

type Target = { kind: string; label?: string };
type Registration = { id: number; event: string; target: Target; handler: number };
function eventBridge() {
  let sequence = 0;
  const callbacks = new Map<number, (event: unknown) => void>();
  const registrations = new Map<number, Registration>();
  const metadata = { currentWindow: { label: "" } };
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {
      metadata,
      transformCallback: (callback: (event: unknown) => void) => { const id = ++sequence; callbacks.set(id, callback); return id; },
      invoke: async (command: string, args: Registration & { eventId: number }) => {
        if (command === "plugin:event|listen") {
          const id = ++sequence;
          registrations.set(id, { ...args, id });
          return id;
        }
        if (command === "plugin:event|unlisten") { registrations.delete(args.eventId); return; }
        throw new Error(`Unexpected event bridge command: ${command}`);
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
  });
  return {
    metadata, registrations,
    // Mirrors Tauri's match_any_or_filter semantics: Any listeners receive targeted events too.
    emit: (event: string, label?: string, payload: unknown = {}) => {
      for (const row of [...registrations.values()]) {
        if (row.event === event && (label === undefined || row.target.kind === "Any" || row.target.label === label)) {
          callbacks.get(row.handler)!({ event, id: row.id, payload });
        }
      }
    },
  };
}
function renderer(
  label: string,
  pendingClose: Map<string, number>,
  bridge: ReturnType<typeof eventBridge>,
  password: {
    readonly owner?: {
      readonly cancelPasswordOpening: () => void;
      readonly close: () => Promise<void> | void;
    };
    readonly prompt?: { readonly dismiss: () => void };
  } = {},
) {
  bridge.metadata.currentWindow.label = label;
  const menuDispose = vi.fn();
  const openDispose = vi.fn();
  const keyboardDispose = vi.fn();
  const invoke = vi.fn(async (command: string, args?: { requestId?: number }) => {
    if (command === "close_current_window" && pendingClose.get(label) !== args?.requestId) throw new Error("WINDOW_CLOSE_STALE");
  });
  const noop = () => undefined;
  const protectedOpenSession = password.owner;
  const passwordPrompt = password.prompt ?? { dismiss: noop };
  const dependencies = {
    protectedOpenSession, passwordPrompt,
    listen, getCurrentWindow, invoke, overlayOwner: {},
    closeThemePicker: noop, closePalette: noop, closeFileOpener: noop, releaseOverlay: noop,
    cancelPagePromptOwnership: noop, themeUnlisten: undefined, recentSnapshotUnlisten: undefined,
    shellOpen: { dispose: openDispose }, workspace: { snapshot: { tabs: [] }, close: noop },
    removedTabTeardown: { retryParked: noop, dispose: noop }, disposeSearchPrompt: noop,
    rootKeyboard: { dispose: keyboardDispose }, applicationMenuOwner: { dispose: menuDispose },
    disposeDprChange: noop, resources: { assertEmpty: noop },
  };
  const api = new Function(...Object.keys(dependencies), `let shellDisposing = false; ${code}; return { pending: () => quitRequest, disposing: () => shellDisposing };`)(...Object.values(dependencies)) as {
    pending(): Promise<void> | undefined; disposing(): boolean;
  };
  return { ...api, invoke, menuDispose, openDispose, keyboardDispose };
}

describe("production window-close event isolation", () => {
  it("cancels password opening before dismissing the prompt during window close", async () => {
    const bridge = eventBridge();
    const pending = new Map([["main", 7]]);
    const order: string[] = [];
    const protectedOpenSession = {
      cancelPasswordOpening: vi.fn(() => { order.push("cancel"); }),
      close: vi.fn(async () => { order.push("close"); }),
    };
    const passwordPrompt = { dismiss: vi.fn(() => { order.push("dismiss"); }) };
    const main = renderer("main", pending, bridge, { owner: protectedOpenSession, prompt: passwordPrompt });
    main.openDispose.mockImplementation(() => { order.push("openDispose"); });
    await vi.waitFor(() => expect(main.invoke).toHaveBeenCalledWith("window_close_ready"));

    bridge.emit("window-close-requested", "main", { requestId: 7 });
    await main.pending();
    expect(protectedOpenSession.cancelPasswordOpening).toHaveBeenCalledOnce();
    expect(passwordPrompt.dismiss).toHaveBeenCalledOnce();
    expect(protectedOpenSession.close).toHaveBeenCalledOnce();
    expect(order).toEqual(["cancel", "dismiss", "close", "openDispose"]);
  });
  it.each(["main", "reader-secondary"])("closing %s leaves the other renderer operational", async (closingLabel) => {
    const bridge = eventBridge();
    const pending = new Map([[closingLabel, 7]]);
    const main = renderer("main", pending, bridge);
    const secondary = renderer("reader-secondary", pending, bridge);
    await vi.waitFor(() => expect(secondary.invoke).toHaveBeenCalledWith("window_close_ready"));
    expect([...bridge.registrations.values()].filter((row) => row.event === "window-close-requested").map((row) => row.target)).toEqual([
      { kind: "Window", label: "main" }, { kind: "Window", label: "reader-secondary" },
    ]);
    bridge.emit("window-close-requested", closingLabel, { requestId: 7 });
    const closing = closingLabel === "main" ? main : secondary;
    const survivor = closingLabel === "main" ? secondary : main;
    await closing.pending();
    expect(closing.menuDispose).toHaveBeenCalledOnce();
    expect(closing.openDispose).toHaveBeenCalledOnce();
    expect(closing.invoke).toHaveBeenCalledWith("close_current_window", { requestId: 7, rendererDrained: true });
    expect(survivor.disposing()).toBe(false);
    expect(survivor.pending()).toBeUndefined();
    expect(survivor.menuDispose).not.toHaveBeenCalled();
    expect(survivor.openDispose).not.toHaveBeenCalled();
    expect(survivor.keyboardDispose).not.toHaveBeenCalled();
    expect(survivor.invoke.mock.calls.some(([command]) => command === "close_current_window")).toBe(false);
    const survivorLabel = closingLabel === "main" ? "reader-secondary" : "main";
    pending.set(survivorLabel, 8);
    bridge.emit("window-close-requested", survivorLabel, { requestId: 8 });
    await survivor.pending();
    expect(survivor.invoke).toHaveBeenCalledWith("close_current_window", { requestId: 8, rendererDrained: true });
  });

  it("retains intentional application-wide quit delivery", async () => {
    const bridge = eventBridge();
    const pending = new Map<string, number>();
    const windows = [renderer("main", pending, bridge), renderer("reader-secondary", pending, bridge)];
    await vi.waitFor(() => expect(windows[1]!.invoke).toHaveBeenCalledWith("renderer_ready"));
    expect([...bridge.registrations.values()].filter((row) => row.event === "quit-requested").map((row) => row.target)).toEqual([{ kind: "Any" }, { kind: "Any" }]);
    bridge.emit("quit-requested");
    await Promise.all(windows.map((window) => window.pending()));
    for (const window of windows) {
      expect(window.menuDispose).toHaveBeenCalledOnce();
      expect(window.invoke).toHaveBeenCalledWith("finish_quit", { rendererDrained: true });
    }
  });

  it("ignores malformed close request identifiers without disposing services", async () => {
    const bridge = eventBridge();
    const main = renderer("main", new Map(), bridge);
    await vi.waitFor(() => expect(main.invoke).toHaveBeenCalledWith("window_close_ready"));
    for (const requestId of [undefined, "7", 1.5, Number.MAX_SAFE_INTEGER + 1]) bridge.emit("window-close-requested", "main", { requestId });
    expect(main.disposing()).toBe(false);
    expect(main.menuDispose).not.toHaveBeenCalled();
    expect(main.openDispose).not.toHaveBeenCalled();
  });
});
