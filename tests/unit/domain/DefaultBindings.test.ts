import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_IDS, FIXED_ACTION_IDS } from "../../../src/domain/actions/ActionRegistry";
import { DEFAULT_BINDINGS, defaultBindingCollisions } from "../../../src/domain/actions/DefaultBindings";

const snapshot = JSON.parse(readFileSync(join(process.cwd(), "tests/contract/snapshots/product-defaults.json"), "utf8")) as {
  readonly configurableKeyTemplates: Record<string, readonly string[]>;
  readonly fixedBindings: Record<string, readonly string[] | string>;
};

describe("DefaultBindings", () => {
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
