import { describe, expect, it } from "vitest";
import { ACTION_IDS, FIXED_ACTION_IDS } from "../../../src/domain/actions/ActionRegistry";
import { validateProductConfig } from "../../../src/domain/config/ConfigValidator";
import { CANONICAL_DEFAULT_CONFIG_TOML, parseAndValidateConfigToml } from "../../../src/domain/config/ConfigFile";

describe("ConfigFile", () => {
  it("round-trips the deterministic canonical Windows defaults", () => {
    const result = parseAndValidateConfigToml(CANONICAL_DEFAULT_CONFIG_TOML);
    expect(result).toEqual(validateProductConfig({}));
    expect(CANONICAL_DEFAULT_CONFIG_TOML.endsWith("\n")).toBe(true);
    for (const id of ACTION_IDS) expect(CANONICAL_DEFAULT_CONFIG_TOML.includes(JSON.stringify(id))).toBe(!FIXED_ACTION_IDS.includes(id));
  });

  it("maps frozen snake-case TOML keys before strict product validation", () => {
    expect(parseAndValidateConfigToml("[navigation]\nsmall_scroll_points=64\n[input]\nprefix_timeout_ms=500\n")).toMatchObject({
      ok: true,
      value: { navigation: { smallScrollPoints: 64 }, input: { prefixTimeoutMilliseconds: 500 } },
    });
  });

  it("returns one redacted diagnostic for malformed TOML", () => {
    expect(parseAndValidateConfigToml("[keymap\nsecret = 'do not echo'")).toEqual({
      ok: false,
      diagnostics: [{ code: "CONFIG_TOML_INVALID", path: "$", line: 1, column: 2 }],
    });
  });

  it("preserves unknown names for strict schema diagnostics", () => {
    expect(parseAndValidateConfigToml("[future]\nsecret=1\n")).toEqual({
      ok: false,
      diagnostics: [{ code: "CONFIG_UNKNOWN_SECTION", path: "future" }],
    });
  });
});
