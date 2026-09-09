import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_IDS, FIXED_ACTION_IDS, INPUT_CONTEXTS, getActionDescriptor } from "../../../src/domain/actions/ActionRegistry";
import { DEFAULT_BINDINGS, defaultBindingCollisions } from "../../../src/domain/actions/DefaultBindings";
import { KeySequenceTrie } from "../../../src/domain/input/KeySequenceTrie";

const snapshot = JSON.parse(readFileSync(join(process.cwd(), "tests/contract/snapshots/product-defaults.json"), "utf8")) as {
  readonly configurableKeyTemplates: Record<string, readonly string[]>;
  readonly fixedBindings: Record<string, readonly string[] | string>;
};

describe("DefaultBindings", () => {
  it("uses Ctrl+Shift+O as the only default document.open binding", () => {
    expect(DEFAULT_BINDINGS["document.open"]).toEqual(["<C-S-o>"]);
    expect(DEFAULT_BINDINGS["document.open"]).not.toContain("<C-o>");
  });

  it("routes the default document.open chord through every global input context", () => {
    expect(getActionDescriptor("document.open")?.availability).toEqual({ kind: "global" });
    const trie = new KeySequenceTrie([{
      sequence: DEFAULT_BINDINGS["document.open"][0]!,
      actionId: "document.open",
      contexts: INPUT_CONTEXTS,
    }]);
    const open = trie.child(trie.start(), "<C-S-o>");
    expect(open).toBeDefined();
    for (const context of INPUT_CONTEXTS) {
      expect(trie.binding(open, context)?.actionId).toBe("document.open");
    }
    expect(trie.child(trie.start(), "<C-o>")).toBeUndefined();
  });

  it("matches every configurable and fixed W00 binding exactly", () => {
    const expected = Object.fromEntries(ACTION_IDS.map((id) => [id,
      id in snapshot.configurableKeyTemplates
        ? snapshot.configurableKeyTemplates[id]
        : snapshot.fixedBindings[id],
    ]));
    expect(DEFAULT_BINDINGS).toEqual(expected);
    expect(Object.keys(DEFAULT_BINDINGS)).toEqual(ACTION_IDS);
  });

  it("has exactly four non-configurable fixed binding IDs", () => {
    expect(FIXED_ACTION_IDS).toEqual(["prompt.commit", "prompt.cancel", "search.next", "search.previous"]);
  });

  it("has no canonical sequence collision in any shared input context", () => {
    expect(defaultBindingCollisions()).toEqual([]);
  });

  it("freezes the registry and every binding sequence", () => {
    expect(Object.isFrozen(DEFAULT_BINDINGS)).toBe(true);
    expect(Object.values(DEFAULT_BINDINGS).every(Object.isFrozen)).toBe(true);
  });
});
