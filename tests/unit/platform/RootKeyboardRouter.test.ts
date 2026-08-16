import { describe, expect, it } from "vitest";
import { validateProductConfig } from "../../../src/domain/config/ConfigValidator";
import { createRootKeyboardRouter, type RootKeyboardContext, type RootKeyboardEvent } from "../../../src/platform/RootKeyboardRouter";

const validated = validateProductConfig({});
if (!validated.ok) throw new Error("built-in config invalid");
const config = validated.value;
const runtime = { hasDocument: true, canOpenDocument: true, canCreateSession: true, canCreateWindow: true, tabCount: 1, paneCount: 1, modalOpen: false, updateAvailable: false, configExists: false, searchActive: false, canHistoryBack: false, canHistoryForward: false, linkCount: 0 };
function keyboard(key: string, overrides: Partial<RootKeyboardEvent> = {}) {
  let prevented = false;
  const event: RootKeyboardEvent = { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, preventDefault: () => { prevented = true; }, ...overrides };
  return { event, prevented: () => prevented };
}
function harness(overrides: Partial<RootKeyboardContext> = {}) {
  let clock = 0;
  let context: RootKeyboardContext = { windowId: "window-a", routeRevision: "route-a", generation: 1, inputContext: "navigation", runtime, ...overrides };
  const dispatched: string[] = []; const disabled: string[] = [];
  const timers = new Map<number, { callback: () => void; due: number }>(); let nextTimer = 1;
  const router = createRootKeyboardRouter({ config, getContext: () => context, onDispatch: (id) => dispatched.push(id), onDisabled: (id, reason) => disabled.push(`${id}:${reason}`), now: () => clock, setTimer: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, due: clock + delay }); return id; }, clearTimer: (id) => { timers.delete(id); } });
  return { router, dispatched, disabled, setContext: (value: RootKeyboardContext) => { context = value; }, advance: (time: number) => { clock = time; for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.callback(); } }, context: () => context };
}

describe("RootKeyboardRouter", () => {
  it("prevents only handled bindings", () => {
    const h = harness(); const open = keyboard("o", { ctrlKey: true }); h.router.handleKeyDown(open.event);
    expect(open.prevented()).toBe(true); expect(h.dispatched).toEqual(["document.open"]);
    const unknown = keyboard("q"); h.router.handleKeyDown(unknown.event); expect(unknown.prevented()).toBe(false);
  });
  it.each([{ isComposing: true }, { keyCode: 229 }, { altGraph: true }, { key: "Dead" }, { ctrlKey: true, altKey: true, altGraph: true }])("leaves IME/dead/AltGraph input native-owned: %o", (overrides) => {
    const h = harness(); const value = keyboard("x", overrides); h.router.handleKeyDown(value.event);
    expect(value.prevented()).toBe(false); expect(h.dispatched).toEqual([]);
  });
  it("routes browser-produced colon and question-mark literals", () => {
    const h = harness();
    const palette = keyboard(":", { shiftKey: true }); h.router.handleKeyDown(palette.event);
    const help = keyboard("?", { shiftKey: true }); h.router.handleKeyDown(help.event);
    expect(palette.prevented()).toBe(true); expect(help.prevented()).toBe(true);
    expect(h.dispatched).toEqual(["palette.open", "help.show"]);
  });
  it("distinguishes configured Ctrl Alt from AltGraph", () => {
    const custom = validateProductConfig({ keymap: { "document.open": ["<C-A-o>"] } });
    if (!custom.ok) throw new Error("custom config invalid");
    const dispatched: string[] = [];
    const router = createRootKeyboardRouter({ config: custom.value, getContext: () => ({ windowId: "window-a", routeRevision: "route-a", generation: 1, inputContext: "navigation", runtime }), onDispatch: (id) => dispatched.push(id) });
    const chord = keyboard("o", { ctrlKey: true, altKey: true }); router.handleKeyDown(chord.event);
    const altGraph = keyboard("o", { ctrlKey: true, altKey: true, altGraph: true }); router.handleKeyDown(altGraph.event);
    expect(dispatched).toEqual(["document.open"]); expect(chord.prevented()).toBe(true); expect(altGraph.prevented()).toBe(false);
    router.dispose();
  });
  it("routes real Alt chords before browser accelerators", () => {
    const h = harness(); const close = keyboard("F4", { altKey: true }); h.router.handleKeyDown(close.event);
    expect(close.prevented()).toBe(true); expect(h.dispatched).toEqual(["app.quit"]);
    const back = keyboard("ArrowLeft", { altKey: true }); h.router.handleKeyDown(back.event);
    expect(back.prevented()).toBe(true); expect(h.disabled).toContain("history.back:No back history");
  });
  it("expires an exact-prefix binding at 400ms, not 399ms", () => {
    const h = harness(); const g = keyboard("g"); h.router.handleKeyDown(g.event); expect(g.prevented()).toBe(true);
    h.advance(399); expect(h.dispatched).toEqual([]); h.advance(400); expect(h.dispatched).toEqual(["page.prompt"]);
  });
  it("cancels pending input when the active route changes at the same generation", () => {
    const h = harness(); h.router.handleKeyDown(keyboard("g").event);
    h.setContext({ ...h.context(), routeRevision: "route-b" }); h.advance(400);
    expect(h.dispatched).toEqual([]);
  });
  it("cancels pending input when window generation changes", () => {
    const h = harness(); h.router.handleKeyDown(keyboard("g").event);
    h.setContext({ ...h.context(), windowId: "window-b", generation: 2 }); h.advance(400);
    expect(h.dispatched).toEqual([]);
  });
  it("consumes unavailable modal bindings without dispatch", () => {
    const h = harness({ runtime: { ...runtime, modalOpen: true } }); const open = keyboard("o", { ctrlKey: true }); h.router.handleKeyDown(open.event);
    expect(open.prevented()).toBe(true); expect(h.dispatched).toEqual([]); expect(h.disabled).toEqual(["document.open:Close the current dialog"]);
  });
  it("claims unbound decimal and backspace input only for page-prompt ownership", () => {
    const accepted: string[] = [];
    const router = createRootKeyboardRouter({
      config,
      getContext: () => ({ windowId: "window-a", routeRevision: "route-a", generation: 1, inputContext: "pagePrompt", runtime }),
      onDispatch: () => undefined,
      onUnboundToken: (value) => { accepted.push(value); return value === "7" || value === "<BS>"; },
    });
    const digit = keyboard("7"); router.handleKeyDown(digit.event);
    const backspace = keyboard("Backspace"); router.handleKeyDown(backspace.event);
    expect(digit.prevented()).toBe(true); expect(backspace.prevented()).toBe(true);
    expect(accepted).toEqual(["7", "<BS>"]);
    router.dispose();
  });
  it("suppresses repeated non-repeatable bindings", () => {
    const h = harness(); const help = keyboard("?", { repeat: true }); h.router.handleKeyDown(help.event);
    expect(h.dispatched).toEqual([]);
  });
});
