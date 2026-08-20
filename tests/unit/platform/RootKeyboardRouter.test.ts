import { describe, expect, it } from "vitest";
import { validateProductConfig } from "../../../src/domain/config/ConfigValidator";
import { createRootKeyboardRouter, type RootKeyboardContext, type RootKeyboardEvent } from "../../../src/platform/RootKeyboardRouter";

const validated = validateProductConfig({});
if (!validated.ok) throw new Error("built-in config invalid");
const config = validated.value;
const runtime = { hasDocument: true, canOpenDocument: true, canCreateSession: true, canCreateWindow: true, tabCount: 1, modalOpen: false, updateAvailable: false, configExists: false, searchActive: false, canHistoryBack: false, canHistoryForward: false, linkCount: 0 };
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
  const router = createRootKeyboardRouter({
    config,
    getContext: () => context,
    onDispatch: (id, dispatch) => {
      dispatched.push(id);
      if (dispatch.transitionedContext !== undefined) context = { ...context, inputContext: dispatch.transitionedContext };
    },
    onDisabled: (id, reason) => disabled.push(`${id}:${reason}`),
    now: () => clock,
    setTimer: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, due: clock + delay }); return id; },
    clearTimer: (id) => { timers.delete(id); },
  });
  return { router, dispatched, disabled, setContext: (value: RootKeyboardContext) => { context = value; }, setClock: (time: number) => { clock = time; }, advance: (time: number) => { clock = time; for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.callback(); } }, context: () => context };
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
  it("settles a delayed g timeout before routing the current prompt key", () => {
    let clock = 0;
    let context: RootKeyboardContext = { windowId: "window-a", routeRevision: "route-a", generation: 1, inputContext: "navigation", runtime };
    const dispatched: string[] = [];
    const accepted: string[] = [];
    const router = createRootKeyboardRouter({
      config,
      getContext: () => context,
      onDispatch: (id, dispatch) => {
        dispatched.push(id);
        if (dispatch.transitionedContext !== undefined) context = { ...context, inputContext: dispatch.transitionedContext };
      },
      onUnboundToken: (token) => { accepted.push(token); return token === "7"; },
      now: () => clock,
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    router.handleKeyDown(keyboard("g").event);
    clock = 400;
    const digit = keyboard("7");
    expect(router.handleKeyDown(digit.event)).toBe(true);
    expect(digit.prevented()).toBe(true);
    expect(dispatched).toEqual(["page.prompt"]);
    expect(accepted).toEqual(["7"]);
    router.dispose();
  });
  it("routes a non-decimal lifecycle key after delayed prefix settlement", () => {
    const h = harness();
    h.router.handleKeyDown(keyboard("g").event);
    h.setClock(400);
    const escape = keyboard("Escape");
    expect(h.router.handleKeyDown(escape.event)).toBe(true);
    expect(h.dispatched).toEqual(["page.prompt", "prompt.cancel"]);
  });
  it("routes page, tab, and edge bindings with browser shift semantics", () => {
    const h = harness({ runtime: { ...runtime, tabCount: 3 } });
    for (const event of [keyboard("n"), keyboard("p"), keyboard("N", { shiftKey: true }), keyboard("P", { shiftKey: true }), keyboard("G", { shiftKey: true }), keyboard("g"), keyboard("g")]) {
      expect(h.router.handleKeyDown(event.event)).toBe(true);
      expect(event.prevented()).toBe(true);
    }
    expect(h.dispatched).toEqual(["page.next", "page.previous", "tab.next", "tab.previous", "page.last", "page.first"]);
  });
  it("settles a pre-timeout g mismatch and replays the decimal into its newly owned prompt", () => {
    let clock = 0;
    let context: RootKeyboardContext = { windowId: "window-a", routeRevision: "route-a", generation: 1, inputContext: "navigation", runtime };
    const dispatched: string[] = [];
    const replayed: string[] = [];
    const router = createRootKeyboardRouter({
      config,
      getContext: () => context,
      onDispatch: (id, dispatch) => {
        dispatched.push(id);
        if (dispatch.replay !== undefined) replayed.push(dispatch.replay.token);
        if (dispatch.transitionedContext !== undefined) context = { ...context, inputContext: dispatch.transitionedContext };
      },
      now: () => clock,
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    router.handleKeyDown(keyboard("g").event);
    clock = 399;
    const digit = keyboard("7");
    expect(router.handleKeyDown(digit.event)).toBe(true);
    expect(digit.prevented()).toBe(true);
    expect(dispatched).toEqual(["page.prompt"]);
    expect(replayed).toEqual(["7"]);
    router.dispose();
  });
  it("allows held adjacent-page movement but suppresses held edge, tab, and prefix commands", () => {
    const repeatable = harness({ runtime: { ...runtime, tabCount: 3 } });
    for (const value of [keyboard("n", { repeat: true }), keyboard("p", { repeat: true })]) {
      expect(repeatable.router.handleKeyDown(value.event)).toBe(true);
      expect(value.prevented()).toBe(true);
    }
    expect(repeatable.dispatched).toEqual(["page.next", "page.previous"]);

    for (const value of [keyboard("G", { shiftKey: true, repeat: true }), keyboard("N", { shiftKey: true, repeat: true }), keyboard("P", { shiftKey: true, repeat: true }), keyboard("g", { repeat: true })]) {
      const suppressed = harness({ runtime: { ...runtime, tabCount: 3 } });
      expect(suppressed.router.handleKeyDown(value.event)).toBe(true);
      expect(value.prevented()).toBe(true);
      expect(suppressed.dispatched).toEqual([]);
    }
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
    const router = createRootKeyboardRouter({ config, getContext: () => ({ windowId: "window-a", routeRevision: "route-a", generation: 1, inputContext: "pagePrompt", runtime }), onDispatch: () => undefined, onUnboundToken: (value) => { accepted.push(value); return value === "7" || value === "<BS>"; } });
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
  it("dispatches each enabled default Alt-arrow history action exactly once", () => {
    const h = harness({ runtime: { ...runtime, canHistoryBack: true, canHistoryForward: true } });
    const back = keyboard("ArrowLeft", { altKey: true }); const forward = keyboard("ArrowRight", { altKey: true });
    expect(h.router.handleKeyDown(back.event)).toBe(true); expect(h.router.handleKeyDown(forward.event)).toBe(true);
    expect(back.prevented()).toBe(true); expect(forward.prevented()).toBe(true);
    expect(h.dispatched).toEqual(["history.back", "history.forward"]);
  });
  it("consumes physical Alt arrows outside plain enabled navigation without WebView escape", () => {
    for (const inputContext of ["pagePrompt", "searchPrompt", "searchResults"] as const) {
      const h = harness({ inputContext, runtime: { ...runtime, canHistoryBack: true } }); const event = keyboard("ArrowLeft", { altKey: true });
      expect(h.router.handleKeyDown(event.event)).toBe(true); expect(event.prevented()).toBe(true); expect(h.dispatched).toEqual([]);
    }
    const modal = harness({ runtime: { ...runtime, modalOpen: true, canHistoryBack: true } }); const event = keyboard("ArrowLeft", { altKey: true }); modal.router.handleKeyDown(event.event);
    expect(event.prevented()).toBe(true); expect(modal.dispatched).toEqual([]); expect(modal.disabled).toEqual(["history.back:Close the current dialog"]);
  });
  it("consumes repeats and unavailable Alt arrows without duplicate traversal", () => {
    const h = harness({ runtime: { ...runtime, canHistoryBack: true } }); const first = keyboard("ArrowLeft", { altKey: true }); const repeat = keyboard("ArrowLeft", { altKey: true, repeat: true });
    h.router.handleKeyDown(first.event); h.router.handleKeyDown(repeat.event);
    expect(first.prevented()).toBe(true); expect(repeat.prevented()).toBe(true); expect(h.dispatched).toEqual(["history.back"]);
    const disabled = harness(); const unavailable = keyboard("ArrowLeft", { altKey: true }); disabled.router.handleKeyDown(unavailable.event);
    expect(unavailable.prevented()).toBe(true); expect(disabled.dispatched).toEqual([]); expect(disabled.disabled).toEqual(["history.back:No back history"]);
  });
  it("keeps remapped history navigation-only while reserving physical Alt arrows", () => {
    const custom = validateProductConfig({ keymap: { "history.back": ["x"] } });
    if (!custom.ok) throw new Error("custom config invalid");
    let context: RootKeyboardContext = { windowId: "window-a", routeRevision: "route-a", generation: 1, inputContext: "navigation", runtime: { ...runtime, canHistoryBack: true } };
    const dispatched: string[] = [];
    const router = createRootKeyboardRouter({ config: custom.value, getContext: () => context, onDispatch: (id) => dispatched.push(id) });
    const physical = keyboard("ArrowLeft", { altKey: true }); router.handleKeyDown(physical.event);
    const remapped = keyboard("x"); router.handleKeyDown(remapped.event); context = { ...context, inputContext: "searchResults" };
    const outsideNavigation = keyboard("x"); router.handleKeyDown(outsideNavigation.event);
    expect(physical.prevented()).toBe(true); expect(remapped.prevented()).toBe(true); expect(outsideNavigation.prevented()).toBe(false); expect(dispatched).toEqual(["history.back"]); router.dispose();
  });
  it("leaves AltGraph-owned arrows native", () => {
    const h = harness({ runtime: { ...runtime, canHistoryBack: true } });
    const event = keyboard("ArrowLeft", { altKey: true, altGraph: true });
    h.router.handleKeyDown(event.event);
    expect(event.prevented()).toBe(false); expect(h.dispatched).toEqual([]);
  });
  it.each([{ isComposing: true }, { keyCode: 229 }])("consumes physical Alt arrows during IME ownership without dispatch: %o", (overrides) => {
    const h = harness({ runtime: { ...runtime, canHistoryBack: true } });
    const event = keyboard("ArrowLeft", { altKey: true, ...overrides });
    h.router.handleKeyDown(event.event);
    expect(event.prevented()).toBe(true); expect(h.dispatched).toEqual([]);
  });
});
