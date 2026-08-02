import { describe, expect, it } from "vitest";
import { KeySequenceEngine } from "../../../src/core/KeySequenceEngine";
import { DEFAULT_BINDINGS, bindingById, isCommandEnabled, resolvePaletteBindingAction } from "../../../src/core/defaultBindings.windows";
import { token } from "../../../src/core/KeyToken";

const documentContext = {
  hasDocument: true,
  pageCount: 120,
  documentGeneration: 1,
  commandAvailability: { hasDocument: true, canCreateSession: true, canOpenDocument: true, modalOpen: false },
};
const emptyContext = {
  hasDocument: false,
  pageCount: 0,
  documentGeneration: 0,
  commandAvailability: { hasDocument: false, canCreateSession: true, canOpenDocument: true, modalOpen: false },
};

describe("KeySequenceEngine", () => {
  it("dispatches registered direct bindings and respects repeat policy", () => {
    const engine = new KeySequenceEngine();

    expect(engine.handle(token("O", { ctrl: true }), 0, emptyContext)).toMatchObject({
      claimed: true,
      dispatches: [{ action: { type: "document.open" } }],
    });
    expect(engine.handle(token("n", { repeat: true }), 1, documentContext)).toMatchObject({
      claimed: true,
      dispatches: [{ action: { type: "page.next" } }],
    });
    expect(engine.handle(token("?", { repeat: true }), 2, emptyContext)).toMatchObject({
      claimed: false,
      dispatches: [],
    });
  });
  it("dispatches Ctrl+N once only when tab creation is available", () => {
    const engine = new KeySequenceEngine();
    const available = {
      ...emptyContext,
      commandAvailability: { hasDocument: false, canCreateSession: true, canOpenDocument: true, modalOpen: false },
    };

    expect(engine.handle(token("n", { ctrl: true }), 0, available)).toMatchObject({
      claimed: true,
      dispatches: [{ action: { type: "tab.new" }, source: "binding" }],
    });
    expect(engine.handle(token("n", { ctrl: true, repeat: true }), 1, available)).toMatchObject({
      claimed: false,
      dispatches: [],
    });
    expect(engine.handle(token("n", { ctrl: true }), 2, {
      ...emptyContext,
      commandAvailability: { hasDocument: false, canCreateSession: false, canOpenDocument: false, modalOpen: false },
    })).toMatchObject({ claimed: false, dispatches: [] });
    expect(engine.handle(token("n", { ctrl: true }), 3, {
      ...emptyContext,
      commandAvailability: { hasDocument: false, canCreateSession: true, canOpenDocument: true, modalOpen: true },
    })).toMatchObject({ claimed: false, dispatches: [] });
  });
  it("dispatches the command palette only for Ctrl+Shift+P regardless of letter case", () => {
    const engine = new KeySequenceEngine();

    for (const key of ["P", "p"]) {
      expect(engine.handle(token(key, { ctrl: true, shift: true }), 0, emptyContext)).toMatchObject({
        claimed: true,
        dispatches: [{ action: { type: "palette.toggle" }, source: "binding" }],
      });
    }
    for (const modifiers of [{ ctrl: true }, { ctrl: true, shift: true, alt: true }]) {
      expect(engine.handle(token("p", modifiers), 1, emptyContext)).toMatchObject({
        claimed: false,
        dispatches: [],
      });
    }
  });

  it("matches real Shift shortcuts while preserving Caps-Lock and Ctrl normalization", () => {
    expect(new KeySequenceEngine().handle(token("G", { shift: true }), 0, documentContext)).toMatchObject({
      claimed: true,
      dispatches: [{ action: { type: "page.last" }, source: "binding" }],
    });
    expect(new KeySequenceEngine().handle(token("F", { shift: true }), 0, documentContext)).toMatchObject({
      claimed: true,
      dispatches: [{ action: { type: "view.fitPage" }, source: "binding" }],
    });
    expect(new KeySequenceEngine().handle(token("?", { shift: true }), 0, emptyContext)).toMatchObject({
      claimed: true,
      dispatches: [{ action: { type: "help.toggle" }, source: "binding" }],
    });
    expect(new KeySequenceEngine().handle(token("G"), 0, documentContext).state.kind).toBe("gPending");
    expect(new KeySequenceEngine().handle(token("O", { ctrl: true }), 0, emptyContext)).toMatchObject({
      dispatches: [{ action: { type: "document.open" }, source: "binding" }],
    });
    expect(new KeySequenceEngine().handle(token("P", { ctrl: true, shift: true }), 0, emptyContext)).toMatchObject({
      dispatches: [{ action: { type: "palette.toggle" }, source: "binding" }],
    });
  });

  it("only advertises page-prompt commands while the prompt is active", () => {
    const unavailable = { ...documentContext.commandAvailability, pagePromptActive: false };
    const available = { ...unavailable, pagePromptActive: true };

    for (const id of ["prompt.commit", "prompt.backspace"] as const) {
      expect(isCommandEnabled(bindingById(id), unavailable)).toBe(false);
      expect(isCommandEnabled(bindingById(id), available)).toBe(true);
    }
  });
  it("dispatches tab close, indexed activation, and Ctrl+9 last-tab actions", () => {
    const engine = new KeySequenceEngine();

    expect(engine.handle(token("w", { ctrl: true }), 0, emptyContext)).toMatchObject({
      claimed: true,
      dispatches: [{ action: { type: "tab.close" }, source: "binding" }],
    });
    for (const [key, index] of [["1", 0], ["2", 1], ["3", 2], ["9", -1]] as const) {
      expect(engine.handle(token(key, { ctrl: true }), index + 1, emptyContext)).toMatchObject({
        claimed: true,
        dispatches: [{ action: { type: "tab.activate", index }, source: "binding" }],
      });
    }
    expect(bindingById("tab.activate.last")).toMatchObject({
      keys: ["Ctrl+9"],
      label: "Activate last tab",
      action: { type: "tab.activate", index: -1 },
    });
  });

  it("only enables tab activation commands with an existing target", () => {
    const oneTab = { ...emptyContext.commandAvailability, tabCount: 1 };
    const eightTabs = { ...emptyContext.commandAvailability, tabCount: 8 };

    expect(isCommandEnabled(bindingById("tab.activate.1"), oneTab)).toBe(true);
    expect(isCommandEnabled(bindingById("tab.activate.2"), oneTab)).toBe(false);
    expect(isCommandEnabled(bindingById("tab.activate.last"), oneTab)).toBe(true);
    expect(isCommandEnabled(bindingById("tab.activate.last"), { ...oneTab, tabCount: 0 })).toBe(false);
    expect(isCommandEnabled(bindingById("tab.activate.8"), eightTabs)).toBe(true);
  });

  it("dispatches reader scrolling and view actions with CP2 values", () => {
    const engine = new KeySequenceEngine();

    expect(engine.handle(token("h"), 0, documentContext).dispatches).toEqual([
      { action: { type: "scroll.byCssPixels", axis: "horizontal", delta: -48 }, source: "binding" },
    ]);
    expect(engine.handle(token("j"), 1, documentContext).dispatches).toEqual([
      { action: { type: "scroll.byCssPixels", axis: "vertical", delta: 48 }, source: "binding" },
    ]);
    expect(engine.handle(token("k"), 2, documentContext).dispatches).toEqual([
      { action: { type: "scroll.byCssPixels", axis: "vertical", delta: -48 }, source: "binding" },
    ]);
    expect(engine.handle(token("l"), 3, documentContext).dispatches).toEqual([
      { action: { type: "scroll.byCssPixels", axis: "horizontal", delta: 48 }, source: "binding" },
    ]);
    expect(engine.handle(token("d"), 4, documentContext).dispatches).toEqual([
      { action: { type: "scroll.byViewport", factor: 0.8 }, source: "binding" },
    ]);
    expect(engine.handle(token("u"), 5, documentContext).dispatches).toEqual([
      { action: { type: "scroll.byViewport", factor: -0.8 }, source: "binding" },
    ]);
    expect(engine.handle(token("w"), 6, documentContext).dispatches).toEqual([
      { action: { type: "view.fitWidth" }, source: "binding" },
    ]);
    expect(engine.handle(token("F", { shift: true }), 7, documentContext).dispatches).toEqual([
      { action: { type: "view.fitPage" }, source: "binding" },
    ]);
    expect(engine.handle(token("="), 8, documentContext).dispatches).toEqual([
      { action: { type: "view.zoom", factor: 1.1 }, source: "binding" },
    ]);
    expect(engine.handle(token("-"), 9, documentContext).dispatches).toEqual([
      { action: { type: "view.zoom", factor: 1 / 1.1 }, source: "binding" },
    ]);
    expect(engine.handle(token("["), 10, documentContext).dispatches).toEqual([
      { action: { type: "view.rotate", quarterTurns: -1 }, source: "binding" },
    ]);
    expect(engine.handle(token("]"), 11, documentContext).dispatches).toEqual([
      { action: { type: "view.rotate", quarterTurns: 1 }, source: "binding" },
    ]);
    expect(engine.handle(token("/"), 12, documentContext).dispatches).toEqual([
      { action: { type: "search.open" }, source: "binding" },
    ]);
    expect(engine.handle(token("f"), 13, documentContext).dispatches).toEqual([
      { action: { type: "linkHints.toggle" }, source: "binding" },
    ]);
  });


  it("resolves palette scroll, zoom, and rotation commands to the keyboard payloads", () => {
    const engine = new KeySequenceEngine();
    const cases = [
      ["scroll.left", token("h")],
      ["scroll.viewportDown", token("d")],
      ["view.zoomOut", token("-")],
      ["view.rotateClockwise", token("]")],
    ] as const;

    for (const [id, key] of cases) {
      const palette = resolvePaletteBindingAction(bindingById(id));
      expect(palette).toMatchObject({ kind: "dispatch" });
      if (palette?.kind !== "dispatch") throw new Error("Missing palette action");
      expect(engine.handle(key, 0, documentContext).dispatches).toEqual([
        { action: palette.action, source: "binding" },
      ]);
    }
  });

  it("does not advertise palette commands without a canonical action", () => {
    for (const binding of DEFAULT_BINDINGS.filter((candidate) => candidate.showInPalette)) {
      expect(resolvePaletteBindingAction(binding)).toBeDefined();
    }
  });

  it("enters the page prompt from the canonical palette page-target command", () => {
    const engine = new KeySequenceEngine();
    expect(resolvePaletteBindingAction(bindingById("page.target"))).toEqual({ kind: "page.target" });
    expect(engine.enterPagePrompt(documentContext)).toMatchObject({
      claimed: true,
      dispatches: [{ action: { type: "prompt.open" }, source: "sequence" }],
      state: { kind: "pagePrompt", digits: "" },
    });
    expect(engine.enterPagePrompt(emptyContext)).toMatchObject({ claimed: false, dispatches: [] });
  });

  it("keeps non-repeatable view commands from dispatching on held keys", () => {
    const engine = new KeySequenceEngine();

    expect(engine.handle(token("w", { repeat: true }), 0, documentContext)).toMatchObject({
      claimed: false,
      dispatches: [],
    });
    expect(engine.handle(token("[", { repeat: true }), 1, documentContext)).toMatchObject({
      claimed: false,
      dispatches: [],
    });
    expect(engine.handle(token("j", { repeat: true }), 2, documentContext)).toMatchObject({
      claimed: true,
      dispatches: [{ action: { type: "scroll.byCssPixels", axis: "vertical", delta: 48 } }],
    });
  });

  it("keeps reader-only bindings native without a document", () => {
    const engine = new KeySequenceEngine();
    expect(engine.handle(token("n"), 0, emptyContext).claimed).toBe(false);
    expect(engine.handle(token("g"), 0, emptyContext).claimed).toBe(false);
  });

  it("resolves gg before the 800 ms deadline", () => {
    const engine = new KeySequenceEngine();
    expect(engine.handle(token("g"), 0, documentContext).state.kind).toBe("gPending");

    const result = engine.handle(token("g"), 799, documentContext);
    expect(result).toMatchObject({
      claimed: true,
      dispatches: [{ action: { type: "page.first" }, source: "sequence" }],
      state: { kind: "idle" },
    });
  });
  it("accepts page digits before the prefix timeout", () => {
    const engine = new KeySequenceEngine();
    engine.handle(token("g"), 0, documentContext);

    const digit = engine.handle(token("4"), 799, documentContext);
    expect(digit).toMatchObject({
      claimed: true,
      dispatches: [{ action: { type: "prompt.open" }, source: "sequence" }],
      state: { kind: "pagePrompt", digits: "4" },
    });
    expect(engine.handle(token("Enter"), 799, documentContext)).toMatchObject({
      dispatches: [{ action: { type: "page.goTo", page: 4 }, source: "prompt" }],
      state: { kind: "idle" },
    });
  });

  it("lets Escape cancel a pending prefix without an invalid-sequence error", () => {
    const engine = new KeySequenceEngine();
    engine.handle(token("g"), 0, documentContext);

    expect(engine.handle(token("Escape"), 100, documentContext)).toMatchObject({
      claimed: true,
      dispatches: [{ action: { type: "prompt.cancel" }, source: "sequence" }],
      state: { kind: "idle" },
    });
  });
  it("leaves repeated Escape native and cancels pending prefix state", () => {
    const engine = new KeySequenceEngine();
    engine.handle(token("g"), 0, documentContext);
    expect(engine.handle(token("Escape", { repeat: true }), 799, documentContext)).toMatchObject({
      claimed: false,
      dispatches: [],
      state: { kind: "idle" },
    });

    engine.handle(token("g"), 1000, documentContext);
    expect(engine.handle(token("Escape", { repeat: true }), 1801, documentContext)).toMatchObject({
      claimed: false,
      dispatches: [],
      state: { kind: "idle" },
    });
  });

  it("suppresses timeout prompt dispatch when native ownership or context changes late", () => {
    const engine = new KeySequenceEngine();
    engine.handle(token("g"), 0, documentContext);
    expect(engine.handle(token("s", { ctrl: true }), 801, documentContext)).toMatchObject({
      claimed: false,
      dispatches: [],
      state: { kind: "idle" },
    });

    engine.handle(token("g"), 1000, documentContext);
    expect(engine.handle(token("n"), 1801, emptyContext)).toMatchObject({
      claimed: false,
      dispatches: [],
      state: { kind: "idle" },
    });
  });

  it("does not allow held-key repeat to complete gg", () => {
    const engine = new KeySequenceEngine();
    engine.handle(token("g"), 0, documentContext);
    const result = engine.handle(token("g", { repeat: true }), 1, documentContext);
    expect(result).toMatchObject({
      claimed: true,
      error: "KEY_SEQUENCE_INVALID",
      state: { kind: "idle" },
    });
  });

  it("opens the page prompt at the deadline and accepts digits", () => {
    const engine = new KeySequenceEngine();
    engine.handle(token("g"), 0, documentContext);

    expect(engine.advance(799).state.kind).toBe("gPending");
    const timeout = engine.advance(800);
    expect(timeout).toMatchObject({
      dispatches: [{ action: { type: "prompt.open" }, source: "timeout" }],
      state: { kind: "pagePrompt", digits: "" },
    });

    engine.handle(token("1"), 801, documentContext);
    engine.handle(token("2"), 802, documentContext);
    const committed = engine.handle(token("Enter"), 803, documentContext);
    expect(committed).toMatchObject({
      claimed: true,
      dispatches: [{ action: { type: "page.goTo", page: 12 }, source: "prompt" }],
      state: { kind: "idle" },
    });
  });

  it("processes a digit arriving after the deadline without losing it", () => {
    const engine = new KeySequenceEngine();
    engine.handle(token("g"), 0, documentContext);
    const result = engine.handle(token("4"), 801, documentContext);
    expect(result).toMatchObject({
      claimed: true,
      dispatches: [{ action: { type: "prompt.open" }, source: "timeout" }],
      state: { kind: "pagePrompt", digits: "4" },
    });
  });

  it("keeps invalid page commits in the prompt with stable errors", () => {
    const engine = new KeySequenceEngine();
    engine.handle(token("g"), 0, documentContext);
    engine.advance(800);
    expect(engine.handle(token("Enter"), 801, documentContext).error).toBe("PAGE_TARGET_EMPTY");

    engine.handle(token("0"), 802, documentContext);
    expect(engine.handle(token("Enter"), 803, documentContext)).toMatchObject({
      error: "PAGE_TARGET_OUT_OF_RANGE",
      state: { kind: "pagePrompt", digits: "0" },
    });
  });

  it("caps page targets at nine digits and supports Backspace and Escape", () => {
    const engine = new KeySequenceEngine();
    engine.handle(token("g"), 0, documentContext);
    engine.advance(800);
    for (const digit of "123456789") {
      engine.handle(token(digit), 801, documentContext);
    }
    expect(engine.handle(token("0"), 802, documentContext).error).toBe("PAGE_TARGET_TOO_LONG");
    expect(engine.handle(token("Backspace"), 803, documentContext).state).toMatchObject({
      kind: "pagePrompt",
      digits: "12345678",
    });
    expect(engine.handle(token("Escape"), 804, documentContext).state.kind).toBe("idle");
  });

  it("consumes an invalid prefix continuation exactly once", () => {
    const engine = new KeySequenceEngine();
    engine.handle(token("g"), 0, documentContext);
    const result = engine.handle(token("n"), 100, documentContext);
    expect(result).toMatchObject({
      claimed: true,
      error: "KEY_SEQUENCE_INVALID",
      dispatches: [],
      state: { kind: "idle" },
    });
  });
  it("cancels pending state without claiming native Ctrl or context changes", () => {
    const engine = new KeySequenceEngine();
    engine.handle(token("g"), 0, documentContext);
    expect(engine.handle(token("s", { ctrl: true }), 100, documentContext)).toMatchObject({
      claimed: false,
      dispatches: [],
      state: { kind: "idle" },
    });

    engine.handle(token("g"), 200, documentContext);
    expect(engine.handle(token("n"), 201, emptyContext)).toMatchObject({
      claimed: false,
      dispatches: [],
      state: { kind: "idle" },
    });
  });
  it("cancels a prefix across same-size document replacement", () => {
    const engine = new KeySequenceEngine();
    engine.handle(token("g"), 0, documentContext);
    const replacement = { ...documentContext, documentGeneration: 2 };

    expect(engine.handle(token("1"), 100, replacement)).toMatchObject({
      claimed: false,
      dispatches: [],
      state: { kind: "idle" },
    });

    engine.handle(token("g"), 1000, replacement);
    const nextReplacement = { ...replacement, documentGeneration: 3 };
    expect(engine.handle(token("1"), 1801, nextReplacement)).toMatchObject({
      claimed: false,
      dispatches: [],
      state: { kind: "idle" },
    });
  });

  it("ignores stale timeout work after cancellation", () => {
    const engine = new KeySequenceEngine();
    engine.handle(token("g"), 0, documentContext);
    engine.cancelForNativeOwnership();
    expect(engine.advance(1000)).toMatchObject({
      claimed: false,
      dispatches: [],
      state: { kind: "idle" },
    });
  });
});
