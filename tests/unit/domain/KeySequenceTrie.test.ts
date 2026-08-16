import { describe, expect, it } from "vitest";
import { ACTION_IDS, getActionDescriptor, type InputContext } from "../../../src/domain/actions/ActionRegistry";
import { DEFAULT_BINDINGS } from "../../../src/domain/actions/DefaultBindings";
import { KeySequenceEngine, KeySequenceTrie, type SequenceBinding } from "../../../src/domain/input/KeySequenceTrie";

const contexts = (id: (typeof ACTION_IDS)[number]): readonly InputContext[] => {
  const availability = getActionDescriptor(id)!.availability;
  return availability.kind === "global" ? ["navigation", "pagePrompt", "searchPrompt", "searchResults"] : availability.contexts;
};
const defaultTrie = () => new KeySequenceTrie(ACTION_IDS.flatMap((id): SequenceBinding[] =>
  DEFAULT_BINDINGS[id].map((sequence) => ({ sequence, actionId: id, contexts: contexts(id) }))));
const smallTrie = () => new KeySequenceTrie([
  { sequence: "g", actionId: "page.prompt", contexts: ["navigation"] },
  { sequence: "gg", actionId: "page.first", contexts: ["navigation"] },
]);

describe("KeySequenceTrie", () => {
  it("represents the complete frozen map including identical disjoint-context bindings", () => {
    expect(defaultTrie()).toBeInstanceOf(KeySequenceTrie);
    expect(() => new KeySequenceTrie([
      { sequence: "x", actionId: "page.next", contexts: ["navigation"] },
      { sequence: "x", actionId: "search.cancel", contexts: ["searchResults"] },
    ])).not.toThrow();
    expect(() => new KeySequenceTrie([
      { sequence: "x", actionId: "page.next", contexts: ["navigation"] },
      { sequence: "x", actionId: "page.last", contexts: ["navigation"] },
    ])).toThrow("Overlapping binding");
  });

  it("waits for ambiguous prefixes and dispatches exact longer matches", () => {
    const engine = new KeySequenceEngine(smallTrie());
    expect(engine.advance("g", "navigation", 100)).toMatchObject({ kind: "pending", sequence: "g", deadline: 500 });
    expect(engine.advance("g", "navigation", 499)).toEqual({ kind: "dispatch", dispatch: { actionId: "page.first" } });
  });

  it("uses injected 399/400 ms expiration and rejects stale epochs", () => {
    const engine = new KeySequenceEngine(smallTrie());
    const pending = engine.advance("g", "navigation", 0);
    expect(pending).toMatchObject({ kind: "pending", deadline: 400 });
    if (pending.kind !== "pending") return;
    expect(engine.expire("navigation", 399, pending.epoch).kind).toBe("pending");
    expect(engine.expire("navigation", 400, pending.epoch)).toEqual({ kind: "dispatch", dispatch: { actionId: "page.prompt", transitionedContext: "pagePrompt" } });
    expect(engine.expire("navigation", 401, pending.epoch)).toEqual({ kind: "invalid", reason: "stale-timeout" });
  });

  it("resolves 399/400/401ms arrivals without dropping the current token", () => {
    const before = new KeySequenceEngine(smallTrie()); before.advance("g", "navigation", 0);
    expect(before.advance("1", "navigation", 399)).toMatchObject({ kind: "dispatch", dispatch: { actionId: "page.prompt", replay: { token: "1" } } });
    const exact = new KeySequenceEngine(smallTrie()); exact.advance("g", "navigation", 0);
    expect(exact.advance("1", "navigation", 400)).toMatchObject({ kind: "dispatch", dispatch: { actionId: "page.prompt", replay: { token: "1" } } });
    const prefixOnly = new KeySequenceEngine(new KeySequenceTrie([
      { sequence: "<C-b>r", actionId: "config.reload", contexts: ["navigation"] },
      { sequence: "n", actionId: "page.next", contexts: ["navigation"] },
    ]));
    prefixOnly.advance("<C-b>", "navigation", 1);
    expect(prefixOnly.advance("n", "navigation", 401)).toEqual({ kind: "dispatch", dispatch: { actionId: "page.next" } });
  });
  it("replays only an unmodified decimal mismatch into the page prompt", () => {
    const engine = new KeySequenceEngine(smallTrie());
    engine.advance("g", "navigation", 0);
    expect(engine.advance("1", "navigation", 10)).toEqual({ kind: "dispatch", dispatch: {
      actionId: "page.prompt", transitionedContext: "pagePrompt",
      replay: { token: "1", tokenClass: "decimalDigit", targetContext: "pagePrompt" },
    } });
    engine.advance("g", "navigation", 20);
    expect(engine.advance("x", "navigation", 30)).toEqual({ kind: "invalid", reason: "invalid-sequence" });
    engine.advance("g", "navigation", 40);
    expect(engine.advance("<C-1>", "navigation", 50)).toEqual({ kind: "invalid", reason: "invalid-sequence" });
  });

  it("suppresses repeats for prefixes and non-repeatable actions", () => {
    const engine = new KeySequenceEngine(smallTrie());
    expect(engine.advance("g", "navigation", 0, true)).toEqual({ kind: "invalid", reason: "repeat-suppressed" });
    const leaf = new KeySequenceEngine(new KeySequenceTrie([{ sequence: "x", actionId: "document.close", contexts: ["navigation"] }]));
    expect(leaf.advance("x", "navigation", 0, true)).toEqual({ kind: "invalid", reason: "repeat-suppressed" });
  });

  it("invalidates pending work and validates timeout bounds", () => {
    const engine = new KeySequenceEngine(smallTrie());
    engine.advance("g", "navigation", 0);
    engine.reset();
    expect(engine.state()).toEqual({ kind: "idle" });
    expect(() => new KeySequenceEngine(smallTrie(), 99)).toThrow("PREFIX_TIMEOUT_INVALID");
  });
});
