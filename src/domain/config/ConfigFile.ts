import { parse } from "smol-toml";
import defaultConfigToml from "./default-config.toml?raw";
import { validateProductConfig, type ConfigValidationResult } from "./ConfigValidator";

export interface ConfigTomlDiagnostic {
  readonly code: "CONFIG_TOML_INVALID";
  readonly path: "$";
  readonly line: number;
  readonly column: number;
}
export type ConfigTomlResult = ConfigValidationResult | { readonly ok: false; readonly diagnostics: readonly [ConfigTomlDiagnostic] };

export function parseAndValidateConfigToml(source: string): ConfigTomlResult {
  let parsed: unknown;
  try { parsed = parse(source); }
  catch (error) {
    const location = parserLocation(error);
    const diagnostic: ConfigTomlDiagnostic = Object.freeze({ code: "CONFIG_TOML_INVALID", path: "$", ...location });
    return { ok: false, diagnostics: Object.freeze([diagnostic]) as readonly [ConfigTomlDiagnostic] };
  }
  return validateProductConfig(projectTomlNames(parsed));
}

export const CANONICAL_DEFAULT_CONFIG_TOML: string = defaultConfigToml;

function parserLocation(error: unknown): { readonly line: number; readonly column: number } {
  if (typeof error !== "object" || error === null) return { line: 1, column: 1 };
  const value = error as Record<string, unknown>;
  const line = boundedCoordinate(value.line);
  const column = boundedCoordinate(value.column);
  return { line, column };
}
function boundedCoordinate(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1;
}
function projectTomlNames(value: unknown): unknown {
  if (!record(value)) return value;
  const output: Record<string, unknown> = { ...value };
  if (record(value.navigation)) {
    output.navigation = rename(value.navigation, {
      small_scroll_points: "smallScrollPoints",
      large_scroll_viewport_fraction: "largeScrollViewportFraction",
      zoom_factor: "zoomFactor",
    });
  }
  if (record(value.input)) output.input = rename(value.input, { prefix_timeout_ms: "prefixTimeoutMilliseconds" });
  if (record(value.keymap)) output.keymap = { ...value.keymap };
  return output;
}
function rename(value: Record<string, unknown>, names: Readonly<Record<string, string>>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) output[names[key] ?? key] = item;
  return output;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
