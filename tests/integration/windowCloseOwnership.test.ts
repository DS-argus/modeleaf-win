// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScriptTarget, transpileModule } from "typescript";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const main = readFileSync("src/main.ts", "utf8");
const eventStart = main.indexOf('void ', main.indexOf('return quitRequest;'));
const eventEnd = main.indexOf('void listen("quit-requested"', eventStart);
if (eventStart < 0 || eventEnd <= eventStart || !main.slice(eventStart, eventEnd).includes('"window-close-requested"')) {
  throw new Error("Production window-close subscription was not found");
}
const registration = transpileModule(main.slice(eventStart, eventEnd), {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

type NativeEvent = { event: string; id: number; payload: { requestId: number } };
type Registration = { event: string; target: { kind: string; label?: string }; handler: number };
function nativeEvents() {
  let nextId = 0;
  const callbacks = new Map<number, (event: NativeEvent) => void>();
  const listeners = new Map<number, Registration>();
  const metadata = { currentWindow: { label: "main" } };
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      metadata,
      transformCallback: (callback: (event: NativeEvent) => void) => {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      },
      invoke: async (command: string, args: Registration & { eventId?: number }) => {
        if (command === "plugin:event|listen") {
          const id = ++nextId;
          listeners.set(id, args);
          return id;
        }
        if (command === "plugin:event|unlisten") {
          listeners.delete(args.eventId!);
          return;
        }
        throw new Error(`Unexpected native event command: ${command}`);
      },
    },
  });
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    configurable: true,
    value: { unregisterListener: (_event: string, id: number) => listeners.delete(id) },
  });
  return {
    metadata,
    listeners,
    // Models Tauri 2.11.5 listener.rs match_any_or_filter: Any subscriptions
    // receive even label-targeted emissions. The production Tauri JS API runs above.
    emitTo: (label: string, requestId: number) => {
      for (const [id, listener] of listeners) {
        if (listener.target.kind === "Any" || listener.target.label === label) {
          callbacks.get(listener.handler)!({ event: listener.event, id, payload: { requestId } });
        }
      }
    },
  };
}
async function subscribe(label: string, bus: ReturnType<typeof nativeEvents>, disposed = false) {
  bus.metadata.currentWindow.label = label;
  const quit = vi.fn();
  const invoke = vi.fn(async (command: string) => {
    if (command !== "window_close_ready") throw new Error(`Unexpected lifecycle command: ${command}`);
  });
  const run = new Function("listen", "getCurrentWindow", "requestApplicationQuit", "invoke", "shellDisposing",
    `let windowCloseUnlisten; ${registration}; return { unlisten: () => windowCloseUnlisten?.() };`);
  const result = run(listen, getCurrentWindow, quit, invoke, disposed) as { unlisten: () => Promise<void> | undefined };
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  return { quit, invoke, ...result };
}

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  Reflect.deleteProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__");
});

describe("production current-window close subscription", () => {
  it("does not tear down another window when native close targets its owner", async () => {
    const bus = nativeEvents();
    const a = await subscribe("main", bus);
    const b = await subscribe("reader-b", bus);
    expect(a.invoke).toHaveBeenCalledExactlyOnceWith("window_close_ready");
    expect(b.invoke).toHaveBeenCalledExactlyOnceWith("window_close_ready");

    bus.emitTo("main", 7);
    expect(a.quit).toHaveBeenCalledExactlyOnceWith(false, true, 7);
    expect(b.quit).not.toHaveBeenCalled();
    await a.unlisten();

    bus.emitTo("reader-b", 8);
    expect(b.quit).toHaveBeenCalledExactlyOnceWith(false, true, 8);
    expect(a.quit).toHaveBeenCalledTimes(1);
    await b.unlisten();
    expect(bus.listeners.size).toBe(0);
  });

  it("unsubscribes a disposed renderer before advertising native close readiness", async () => {
    const bus = nativeEvents();
    const gone = await subscribe("reader-gone", bus, true);
    expect(gone.invoke).not.toHaveBeenCalled();
    expect(bus.listeners.size).toBe(0);
    bus.emitTo("reader-gone", 9);
    expect(gone.quit).not.toHaveBeenCalled();
  });
});
