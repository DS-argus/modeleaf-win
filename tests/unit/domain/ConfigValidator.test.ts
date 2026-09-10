import { describe, expect, it } from "vitest";
import { BUILT_IN_CONFIG, validateProductConfig } from "../../../src/domain/config/ConfigValidator";

const codes = (value: unknown) => {
  const result = validateProductConfig(value);
  return result.ok ? [] : result.diagnostics.map(({ code }) => code);
};

describe("ConfigValidator", () => {
  it("applies a strict sparse overlay without mutating frozen built-ins", () => {
    const result = validateProductConfig({
      navigation: { smallScrollPoints: 1, largeScrollViewportFraction: 2, zoomFactor: 1.01 },
      input: { prefixTimeoutMilliseconds: 2000, prefix: "<C-A-b>" },
      keymap: { "document.open": ["<C-S-o>"] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.navigation).toEqual({ smallScrollPoints: 1, largeScrollViewportFraction: 2, zoomFactor: 1.01 });
    expect(result.value.input).toEqual({ prefixTimeoutMilliseconds: 2000, prefix: "<C-A-b>" });
    expect(result.value.keymap["document.open"]).toEqual(["<C-S-o>"]);
    expect(BUILT_IN_CONFIG.navigation.smallScrollPoints).toBe(32);
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it.each([
    [{ bad: {} }, "CONFIG_UNKNOWN_SECTION"],
    [{ navigation: { bad: 1 } }, "CONFIG_UNKNOWN_KEY"],
    [{ input: { bad: 1 } }, "CONFIG_UNKNOWN_KEY"],
    [{ navigation: [] }, "CONFIG_TYPE_INVALID"],
    [{ navigation: { smallScrollPoints: 0 } }, "CONFIG_RANGE_INVALID"],
    [{ navigation: { zoomFactor: Number.NaN } }, "CONFIG_TYPE_INVALID"],
    [{ keymap: { unknown: ["x"] } }, "CONFIG_ACTION_UNKNOWN"],
    [{ keymap: { "prompt.commit": ["x"] } }, "CONFIG_FIXED_BINDING"],
    [{ keymap: { "document.open": "x" } }, "CONFIG_TYPE_INVALID"],
    [{ keymap: { "document.open": ["<D-o>"] } }, "CONFIG_KEY_SEQUENCE_INVALID"],
  ])("reports %s", (value, code) => expect(codes(value)).toContain(code));

  it("rejects same-context canonical collisions but permits disjoint contexts", () => {
    expect(codes({ keymap: { "document.open": ["x"], "document.close": ["x"] } })).toContain("CONFIG_KEY_COLLISION");
    expect(codes({ keymap: { "history.back": ["x"], "search.cancel": ["x"] } })).not.toContain("CONFIG_KEY_COLLISION");
  });

  it("checks sparse overrides against retained defaults and honors explicit replacement", () => {
    expect(codes({ keymap: { "page.next": ["h"] } })).toContain("CONFIG_KEY_COLLISION");
    expect(codes({ keymap: { "page.next": ["h"], "scroll.left": [] } })).not.toContain("CONFIG_KEY_COLLISION");
  });
  it("returns a complete resolved default map and expands a concrete custom prefix", () => {
    const defaults = validateProductConfig({});
    expect(defaults.ok && defaults.value.keymap["document.open"]).toEqual(["<C-S-o>"]);
    expect(defaults.ok && defaults.value.keymap["config.reload"]).toEqual(["<C-b>r"]);
    const custom = validateProductConfig({ input: { prefix: "<C-x>" } });
    expect(custom.ok && custom.value.keymap["config.reload"]).toEqual(["<C-x>r"]);
  });
  it("rejects non-single/self prefix, duplicate sequences, unsafe exact prefixes, and prompt text capture", () => {
    expect(codes({ input: { prefix: "gg" } })).toContain("CONFIG_PREFIX_INVALID");
    expect(codes({ input: { prefix: "<prefix>" } })).toContain("CONFIG_PREFIX_INVALID");
    expect(codes({ keymap: { "history.back": ["x", "x"] } })).toContain("CONFIG_KEY_DUPLICATE");
    expect(codes({ keymap: { "history.back": ["q"], "history.forward": ["qq"] } })).toContain("CONFIG_KEY_PREFIX_UNSAFE");
    expect(codes({ keymap: { "document.open": ["o"] } })).toContain("CONFIG_PROMPT_UNSAFE");
  });
  it("is all-or-nothing and returns all diagnostics", () => {
    const result = validateProductConfig({ bad: {}, navigation: { smallScrollPoints: 0, nope: 1 }, input: "bad" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "CONFIG_UNKNOWN_SECTION",
      "CONFIG_UNKNOWN_KEY",
      "CONFIG_RANGE_INVALID",
      "CONFIG_TYPE_INVALID",
    ]);
    expect(result).not.toHaveProperty("value");
  });
});
