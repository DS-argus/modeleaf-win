import { describe, expect, it } from "vitest";
import { KeySequenceEngine } from "../../../src/core/KeySequenceEngine";
import { token } from "../../../src/core/KeyToken";

const documentContext = { hasDocument: true, pageCount: 120, documentGeneration: 1 };
const emptyContext = { hasDocument: false, pageCount: 0, documentGeneration: 0 };

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
