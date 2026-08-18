import { describe, expect, it } from "vitest";
import {
  projectConfigDiagnostics,
  retainsPreviousConfig,
  summarizeConfigReload,
  type ConfigReloadOutcome,
} from "../../../src/ui/ConfigDiagnosticsModel";
import { validateProductConfig, type ConfigDiagnostic } from "../../../src/domain/config/ConfigValidator";

const rejected = (diagnostics: readonly ConfigDiagnostic[]): ConfigReloadOutcome =>
  ({ kind: "rejected", rows: projectConfigDiagnostics(diagnostics) });

describe("config diagnostics projection", () => {
  it("gives every validator code an actionable message", () => {
    const codes: ConfigDiagnostic["code"][] = [
      "CONFIG_ROOT_INVALID", "CONFIG_UNKNOWN_SECTION", "CONFIG_UNKNOWN_KEY", "CONFIG_TYPE_INVALID",
      "CONFIG_RANGE_INVALID", "CONFIG_ACTION_UNKNOWN", "CONFIG_FIXED_BINDING",
      "CONFIG_KEY_SEQUENCE_INVALID", "CONFIG_KEY_COLLISION", "CONFIG_KEY_DUPLICATE",
      "CONFIG_KEY_PREFIX_UNSAFE", "CONFIG_PROMPT_UNSAFE", "CONFIG_PREFIX_INVALID",
    ];
    for (const code of codes) {
      const [row] = projectConfigDiagnostics([{ code, path: "keymap.page.next" }]);
      expect(row?.message.length, `${code} has no message`).toBeGreaterThan(0);
      expect(row?.message).not.toBe("Configuration value was rejected.");
    }
  });

  it("preserves the failing path so the user can find the line", () => {
    const [row] = projectConfigDiagnostics([{ code: "CONFIG_KEY_COLLISION", path: "keymap.history.back" }]);
    expect(row?.path).toBe("keymap.history.back");
  });

  it("flags a D-modifier sequence as a migration rather than a generic parse error", () => {
    // Silently rewriting D to Ctrl would shadow Ctrl+O and the history keys.
    const [row] = projectConfigDiagnostics([
      { code: "CONFIG_KEY_SEQUENCE_INVALID", path: "keymap.document.open", detail: "unsupported_modifier:D" },
    ]);
    expect(row?.migration).toBe(true);
  });

  it("does not flag an ordinary parse failure as a migration", () => {
    const [row] = projectConfigDiagnostics([
      { code: "CONFIG_KEY_SEQUENCE_INVALID", path: "keymap.page.next", detail: "empty_token" },
    ]);
    expect(row?.migration).toBe(false);
  });

  it("projects real validator output end to end", () => {
    // A genuine collision from the real validator, not a hand-built diagnostic.
    const result = validateProductConfig({ keymap: { "page.next": ["h"] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const rows = projectConfigDiagnostics(result.diagnostics);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.message.length > 0)).toBe(true);
  });
});

describe("config reload outcome reporting", () => {
  it("reports success only when the config was actually applied", () => {
    const result = validateProductConfig({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(summarizeConfigReload({ kind: "applied", config: result.value })).toContain("reloaded");
  });

  it("states plainly that previous settings are kept on rejection", () => {
    const summary = summarizeConfigReload(rejected([{ code: "CONFIG_KEY_COLLISION", path: "keymap.x" }]));
    expect(summary).toContain("Previous settings kept");
    expect(summary).not.toMatch(/reloaded|applied|success/iu);
  });

  it("counts migration problems separately so they are visible", () => {
    const summary = summarizeConfigReload(rejected([
      { code: "CONFIG_KEY_SEQUENCE_INVALID", path: "keymap.document.open", detail: "unsupported_modifier:D" },
      { code: "CONFIG_KEY_COLLISION", path: "keymap.page.next" },
    ]));
    expect(summary).toContain("2 problems");
    expect(summary).toContain("1 need migration");
  });

  it("uses singular wording for exactly one problem", () => {
    expect(summarizeConfigReload(rejected([{ code: "CONFIG_TYPE_INVALID", path: "navigation.zoomFactor" }])))
      .toMatch(/1 problem\./u);
  });

  it("never reports an unreadable file as success", () => {
    const summary = summarizeConfigReload({ kind: "unavailable", rows: [] });
    expect(summary).toContain("could not be read");
    expect(summary).toContain("Previous settings kept");
  });

  it("keeps the previous config live for every non-applied outcome", () => {
    // The running app must never degrade to defaults because of a bad edit.
    expect(retainsPreviousConfig({ kind: "rejected", rows: [] })).toBe(true);
    expect(retainsPreviousConfig({ kind: "unavailable", rows: [] })).toBe(true);
    expect(retainsPreviousConfig({ kind: "unchanged" })).toBe(true);
    const result = validateProductConfig({});
    if (result.ok) expect(retainsPreviousConfig({ kind: "applied", config: result.value })).toBe(false);
  });
});
