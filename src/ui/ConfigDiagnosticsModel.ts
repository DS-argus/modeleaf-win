import type { ConfigDiagnostic, ProductConfig } from "../domain/config/ConfigValidator";

/**
 * Projects config reload outcomes into an actionable diagnostics surface.
 *
 * `feature-spec.md` §11 requires two behaviors this model encodes. A reload
 * that fails must keep the previously valid configuration live rather than
 * degrading to defaults, and a `D` modifier must produce an actionable
 * migration error instead of being silently rewritten to Ctrl, because that
 * silent rewrite would collide with the Windows Open and History bindings.
 */

export interface ConfigDiagnosticRow {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly migration: boolean;
}

export type ConfigReloadOutcome =
  | { readonly kind: "applied"; readonly config: ProductConfig }
  | { readonly kind: "unchanged" }
  | { readonly kind: "rejected"; readonly rows: readonly ConfigDiagnosticRow[] }
  | { readonly kind: "unavailable"; readonly rows: readonly ConfigDiagnosticRow[] };

const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  CONFIG_ROOT_INVALID: "The configuration file must contain a table at its root.",
  CONFIG_UNKNOWN_SECTION: "Unknown section. Valid sections are keymap, navigation, and input.",
  CONFIG_UNKNOWN_KEY: "Unknown key for this section.",
  CONFIG_TYPE_INVALID: "Value has the wrong type.",
  CONFIG_RANGE_INVALID: "Value is outside the permitted range.",
  CONFIG_ACTION_UNKNOWN: "Unknown action id.",
  CONFIG_FIXED_BINDING: "This action's binding is fixed and cannot be reassigned.",
  CONFIG_KEY_SEQUENCE_INVALID: "Key sequence could not be parsed.",
  CONFIG_KEY_COLLISION: "Two actions share this key sequence in the same context.",
  CONFIG_KEY_DUPLICATE: "The same key sequence is listed twice for this action.",
  CONFIG_KEY_PREFIX_UNSAFE: "This sequence is a prefix of another binding in the same context.",
  CONFIG_PROMPT_UNSAFE: "This binding would capture text while a prompt is open.",
  CONFIG_PREFIX_INVALID: "The prefix must be exactly one non-prefix key.",
});

/**
 * A `D` modifier is the macOS Command key. Converting it to Ctrl silently would
 * shadow explicit user bindings, so it is surfaced for the user
 * to resolve.
 */
function isMigration(diagnostic: ConfigDiagnostic): boolean {
  return diagnostic.code === "CONFIG_KEY_SEQUENCE_INVALID"
    && diagnostic.detail !== undefined
    && /unsupported[_-]?modifier|\bD\b/iu.test(diagnostic.detail);
}

export function projectConfigDiagnostics(
  diagnostics: readonly ConfigDiagnostic[],
): readonly ConfigDiagnosticRow[] {
  return Object.freeze(diagnostics.map((diagnostic) => Object.freeze({
    code: diagnostic.code,
    path: diagnostic.path,
    message: MESSAGES[diagnostic.code] ?? "Configuration value was rejected.",
    migration: isMigration(diagnostic),
  })));
}

/** Human summary for the status line; never claims success for a failed reload. */
export function summarizeConfigReload(outcome: ConfigReloadOutcome): string {
  switch (outcome.kind) {
    case "applied":
      return "Configuration reloaded.";
    case "unchanged":
      return "Configuration is unchanged.";
    case "rejected": {
      const migrations = outcome.rows.filter((row) => row.migration).length;
      const suffix = migrations > 0 ? ` (${String(migrations)} need migration)` : "";
      return `Configuration rejected: ${String(outcome.rows.length)} problem${outcome.rows.length === 1 ? "" : "s"}${suffix}. Previous settings kept.`;
    }
    case "unavailable":
      return "Configuration could not be read. Previous settings kept.";
  }
}

/**
 * True when the reload must leave the live configuration untouched.
 *
 * The previous valid config stays authoritative for every non-applied outcome,
 * so a broken edit can never degrade the running app to defaults.
 */
export function retainsPreviousConfig(outcome: ConfigReloadOutcome): boolean {
  return outcome.kind !== "applied";
}
