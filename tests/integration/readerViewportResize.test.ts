// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync("src/main.ts", "utf8");
const start = source.indexOf("  let viewportFrameRequest:");
const end = source.indexOf("\n}\nworkspace =", start);
if (start < 0 || end <= start) throw new Error("Production reader viewport binding is missing");
const code = transpileModule(source.slice(start, end), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); vi.unstubAllGlobals(); });

function fixture() {
  let width = 0;
  let height = 0;
  let active = true;
  let observerCallback!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { observerCallback = callback; } observe() {} disconnect = disconnect; });
  const host = document.createElement("section");
  Object.defineProperties(host, { clientWidth: { get: () => width }, clientHeight: { get: () => height } });
  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++sequence, callback); return sequence; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const session = {
    navigationLandingInProgress: false,
    cancelWheelZoom: vi.fn(), invalidateViewportSynchronization: vi.fn(),
    renderCurrentView: vi.fn(async () => true), synchronizeViewport: vi.fn(async () => true),
    clearVisibleLinkAuthority: vi.fn(),
  };
  const reportFailure = vi.fn();
  const wheelDispose = vi.fn();
  const init = new Function("host", "session", "active", "rootKeyboard", "render", "reportPresentationFailure", "copyContextMenu", "disposeWheelInput", "queueMicrotask", code);
  const payload = init(host, session, () => active ? { session } : { session: undefined }, { syncContext: vi.fn() }, vi.fn(), reportFailure, { dispose: vi.fn() }, wheelDispose, () => undefined) as { disposeUi(): void };
  disposers.push(() => { payload.disposeUi(); vi.restoreAllMocks(); });
  return {
    host, session, disconnect, reportFailure, wheelDispose,
    resize(w: number, h: number) { width = w; height = h; observerCallback(); },
    deactivate() { active = false; },
    dispose: payload.disposeUi,
    flush() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); },
    frameCount: () => frames.size,
  };
}

describe("production reader viewport scheduling", () => {
  it("invalidates immediately on zero-to-nonzero geometry and coalesces rendering", async () => {
    const f = fixture();
    f.resize(800, 600);
    expect(f.session.cancelWheelZoom).toHaveBeenCalledOnce();
    expect(f.session.invalidateViewportSynchronization).toHaveBeenCalledOnce();
    expect(f.session.renderCurrentView).not.toHaveBeenCalled();
    f.resize(900, 700);
    f.resize(1000, 720);
    expect(f.session.invalidateViewportSynchronization).toHaveBeenCalledTimes(3);
    expect(f.frameCount()).toBe(1);
    f.flush();
    expect(f.session.renderCurrentView).toHaveBeenCalledOnce();
    await Promise.resolve();
    f.flush();
    expect(f.session.synchronizeViewport).toHaveBeenCalledWith(0, 720);
  });
  it("ignores unchanged geometry notifications", () => {
    const f = fixture(); f.resize(0, 0);
    expect(f.session.invalidateViewportSynchronization).not.toHaveBeenCalled();
    expect(f.frameCount()).toBe(0);
  });
  it("does not render a tab deactivated before its scheduled callback", () => {
    const f = fixture(); f.resize(800, 600); f.deactivate(); f.flush();
    expect(f.session.renderCurrentView).not.toHaveBeenCalled();
  });
  it("removes observer, resize listener and pending callbacks when disposed", () => {
    const f = fixture(); f.resize(800, 600); f.dispose();
    expect(f.disconnect).toHaveBeenCalledOnce();
    expect(f.wheelDispose).toHaveBeenCalledOnce();
    expect(f.frameCount()).toBe(0);
    f.session.invalidateViewportSynchronization.mockClear();
    window.dispatchEvent(new Event("resize"));
    f.flush();
    expect(f.session.invalidateViewportSynchronization).not.toHaveBeenCalled();
    expect(f.session.renderCurrentView).not.toHaveBeenCalled();
  });
});
