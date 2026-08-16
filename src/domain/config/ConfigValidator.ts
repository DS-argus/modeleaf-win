import {
  ACTION_IDS,
  FIXED_ACTION_IDS,
  getActionDescriptor,
  type ActionId,
  type InputContext,
} from "../actions/ActionRegistry";
import { DEFAULT_BINDINGS } from "../actions/DefaultBindings";
import { parseKeySequence } from "../input/KeyGrammar";

export interface ProductConfig {
  readonly keymap: Readonly<Partial<Record<ActionId, readonly string[]>>>;
  readonly navigation: Readonly<{ smallScrollPoints: number; largeScrollViewportFraction: number; zoomFactor: number }>;
  readonly input: Readonly<{ prefixTimeoutMilliseconds: number; prefix: string }>;
}

export type ConfigDiagnosticCode =
  | "CONFIG_ROOT_INVALID"
  | "CONFIG_UNKNOWN_SECTION"
  | "CONFIG_UNKNOWN_KEY"
  | "CONFIG_TYPE_INVALID"
  | "CONFIG_RANGE_INVALID"
  | "CONFIG_ACTION_UNKNOWN"
  | "CONFIG_FIXED_BINDING"
  | "CONFIG_KEY_SEQUENCE_INVALID"
  | "CONFIG_KEY_COLLISION"
  | "CONFIG_KEY_DUPLICATE"
  | "CONFIG_KEY_PREFIX_UNSAFE"
  | "CONFIG_PROMPT_UNSAFE"
  | "CONFIG_PREFIX_INVALID";

export interface ConfigDiagnostic {
  readonly code: ConfigDiagnosticCode;
  readonly path: string;
  readonly detail?: string;
}

export type ConfigValidationResult =
  | { readonly ok: true; readonly value: ProductConfig }
  | { readonly ok: false; readonly diagnostics: readonly ConfigDiagnostic[] };

export const BUILT_IN_CONFIG: ProductConfig = Object.freeze({
  keymap: DEFAULT_BINDINGS,
  navigation: Object.freeze({ smallScrollPoints: 32, largeScrollViewportFraction: 0.8, zoomFactor: 1.1 }),
  input: Object.freeze({ prefixTimeoutMilliseconds: 400, prefix: "<C-b>" }),
});

const ROOT_KEYS = new Set(["keymap", "navigation", "input"]);
const NAVIGATION_BOUNDS = Object.freeze({
  smallScrollPoints: [1, 512],
  largeScrollViewportFraction: [0.1, 2],
  zoomFactor: [1.01, 2],
} as const);
const INPUT_BOUNDS = Object.freeze({ prefixTimeoutMilliseconds: [100, 2000] } as const);

export function validateProductConfig(value: unknown): ConfigValidationResult {
  const diagnostics: ConfigDiagnostic[] = [];
  if (!isRecord(value)) return failure([{ code: "CONFIG_ROOT_INVALID", path: "$" }]);
  for (const key of Object.keys(value)) if (!ROOT_KEYS.has(key)) diagnostics.push({ code: "CONFIG_UNKNOWN_SECTION", path: key });

  const navigation = { ...BUILT_IN_CONFIG.navigation };
  if (value.navigation !== undefined) validateNumericSection(value.navigation, "navigation", NAVIGATION_BOUNDS, navigation, diagnostics);

  const input = { ...BUILT_IN_CONFIG.input };
  if (value.input !== undefined) {
    if (!isRecord(value.input)) diagnostics.push({ code: "CONFIG_TYPE_INVALID", path: "input" });
    else {
      for (const key of Object.keys(value.input)) {
        if (key !== "prefixTimeoutMilliseconds" && key !== "prefix") diagnostics.push({ code: "CONFIG_UNKNOWN_KEY", path: `input.${key}` });
      }
      const timeout = value.input.prefixTimeoutMilliseconds;
      if (timeout !== undefined) validateNumber(timeout, "input.prefixTimeoutMilliseconds", INPUT_BOUNDS.prefixTimeoutMilliseconds, diagnostics, (number) => { input.prefixTimeoutMilliseconds = number; });
      const prefix = value.input.prefix;
      if (prefix !== undefined) {
        if (typeof prefix !== "string") diagnostics.push({ code: "CONFIG_TYPE_INVALID", path: "input.prefix" });
        else {
          const parsed = parseKeySequence(prefix);
          if (!parsed.ok) diagnostics.push({ code: "CONFIG_KEY_SEQUENCE_INVALID", path: "input.prefix", detail: parsed.code });
          else if (parsed.tokens.length !== 1 || parsed.tokens[0]!.kind === "prefix") diagnostics.push({ code: "CONFIG_PREFIX_INVALID", path: "input.prefix" });
          else input.prefix = parsed.canonical;
        }
      }
    }
  }

  const keymap: Partial<Record<ActionId, readonly string[]>> = {};
  const canonicalBindings: { readonly id: ActionId; readonly sequence: string; readonly contexts: readonly InputContext[] }[] = [];
  if (value.keymap !== undefined) validateKeymap(value.keymap, keymap, canonicalBindings, diagnostics);
  const effectiveKeymap: Partial<Record<ActionId, readonly string[]>> = {};
  canonicalBindings.length = 0;
  for (const id of ACTION_IDS) {
    const descriptor = getActionDescriptor(id)!;
    const contexts = descriptor.availability.kind === "global"
      ? (["navigation", "pagePrompt", "searchPrompt", "searchResults"] as const)
      : descriptor.availability.contexts;
    const resolved: string[] = [];
    for (const sequence of keymap[id] ?? DEFAULT_BINDINGS[id]) {
      const parsed = parseKeySequence(sequence);
      if (!parsed.ok) continue;
      const expanded = parseKeySequence(parsed.canonical.replaceAll("<prefix>", input.prefix));
      if (expanded.ok) {
        resolved.push(expanded.canonical);
        canonicalBindings.push({ id, sequence: expanded.canonical, contexts });
      }
    }
    effectiveKeymap[id] = Object.freeze(resolved);
  }
  detectCollisions(canonicalBindings, diagnostics);
  detectUnsafePrefixes(canonicalBindings, diagnostics);
  detectPromptUnsafe(canonicalBindings, diagnostics);

  if (diagnostics.length > 0) return failure(diagnostics);
  return {
    ok: true,
    value: Object.freeze({
      keymap: Object.freeze(effectiveKeymap),
      navigation: Object.freeze(navigation),
      input: Object.freeze(input),
    }),
  };
}

function validateKeymap(
  value: unknown,
  output: Partial<Record<ActionId, readonly string[]>>,
  canonical: { id: ActionId; sequence: string; contexts: readonly InputContext[] }[],
  diagnostics: ConfigDiagnostic[],
): void {
  if (!isRecord(value)) { diagnostics.push({ code: "CONFIG_TYPE_INVALID", path: "keymap" }); return; }
  for (const [idValue, sequences] of Object.entries(value)) {
    const path = `keymap.${idValue}`;
    if (!ACTION_IDS.includes(idValue as ActionId)) { diagnostics.push({ code: "CONFIG_ACTION_UNKNOWN", path }); continue; }
    const id = idValue as ActionId;
    if (FIXED_ACTION_IDS.includes(id)) { diagnostics.push({ code: "CONFIG_FIXED_BINDING", path }); continue; }
    if (!Array.isArray(sequences) || !sequences.every((sequence) => typeof sequence === "string")) {
      diagnostics.push({ code: "CONFIG_TYPE_INVALID", path }); continue;
    }
    const normalized: string[] = [];
    for (let index = 0; index < sequences.length; index += 1) {
      const parsed = parseKeySequence(sequences[index]!);
      if (!parsed.ok) diagnostics.push({ code: "CONFIG_KEY_SEQUENCE_INVALID", path: `${path}[${index}]`, detail: parsed.code });
      else normalized.push(parsed.canonical);
    }
    output[id] = Object.freeze(normalized);
    const descriptor = getActionDescriptor(id)!;
    const contexts = descriptor.availability.kind === "global"
      ? (["navigation", "pagePrompt", "searchPrompt", "searchResults"] as const)
      : descriptor.availability.contexts;
    for (const sequence of normalized) canonical.push({ id, sequence, contexts });
  }
}

function detectCollisions(
  bindings: readonly { id: ActionId; sequence: string; contexts: readonly InputContext[] }[],
  diagnostics: ConfigDiagnostic[],
): void {
  for (let left = 0; left < bindings.length; left += 1) for (let right = left + 1; right < bindings.length; right += 1) {
    const a = bindings[left]!;
    const b = bindings[right]!;
    if (a.sequence === b.sequence && a.contexts.some((context) => b.contexts.includes(context))) {
      diagnostics.push({
        code: a.id === b.id ? "CONFIG_KEY_DUPLICATE" : "CONFIG_KEY_COLLISION",
        path: `keymap.${b.id}`,
        detail: `${a.id}:${a.sequence}`,
      });
    }
  }
}
function detectUnsafePrefixes(
  bindings: readonly { id: ActionId; sequence: string; contexts: readonly InputContext[] }[],
  diagnostics: ConfigDiagnostic[],
): void {
  for (const shorter of bindings) for (const longer of bindings) {
    if (shorter === longer || shorter.sequence === longer.sequence || !longer.sequence.startsWith(shorter.sequence)) continue;
    if (!shorter.contexts.some((context) => longer.contexts.includes(context))) continue;
    if (shorter.id !== "page.prompt") diagnostics.push({
      code: "CONFIG_KEY_PREFIX_UNSAFE",
      path: `keymap.${shorter.id}`,
      detail: `${shorter.sequence}:${longer.id}`,
    });
  }
}

function detectPromptUnsafe(
  bindings: readonly { id: ActionId; sequence: string; contexts: readonly InputContext[] }[],
  diagnostics: ConfigDiagnostic[],
): void {
  for (const binding of bindings) {
    if (!binding.contexts.some((context) => context === "pagePrompt" || context === "searchPrompt")) continue;
    const descriptor = getActionDescriptor(binding.id)!;
    const parsed = parseKeySequence(binding.sequence);
    if (!parsed.ok || parsed.tokens.length === 0) continue;
    if (parsed.tokens.length > 1) {
      diagnostics.push({ code: "CONFIG_PROMPT_UNSAFE", path: `keymap.${binding.id}`, detail: "multipleTokens" });
      continue;
    }
    const token = parsed.tokens[0]!;
    const lifecycle = descriptor.bindingConfiguration === "fixed" && (token.key === "Enter" || token.key === "Esc");
    if (!lifecycle && ((token.printable && !token.modifiers.includes("C")) || token.key === "Enter" || token.key === "Esc")) {
      diagnostics.push({ code: "CONFIG_PROMPT_UNSAFE", path: `keymap.${binding.id}`, detail: token.canonical });
    }
  }
}

function validateNumericSection<T extends Record<string, number>>(
  value: unknown,
  section: string,
  bounds: Readonly<Record<keyof T, readonly [number, number]>>,
  output: T,
  diagnostics: ConfigDiagnostic[],
): void {
  if (!isRecord(value)) { diagnostics.push({ code: "CONFIG_TYPE_INVALID", path: section }); return; }
  for (const key of Object.keys(value)) if (!(key in bounds)) diagnostics.push({ code: "CONFIG_UNKNOWN_KEY", path: `${section}.${key}` });
  for (const key of Object.keys(bounds) as (keyof T)[]) {
    if (value[key as string] !== undefined) validateNumber(value[key as string], `${section}.${String(key)}`, bounds[key], diagnostics, (number) => { output[key] = number as T[keyof T]; });
  }
}

function validateNumber(value: unknown, path: string, bounds: readonly [number, number], diagnostics: ConfigDiagnostic[], adopt: (value: number) => void): void {
  if (typeof value !== "number" || !Number.isFinite(value)) diagnostics.push({ code: "CONFIG_TYPE_INVALID", path });
  else if (value < bounds[0] || value > bounds[1]) diagnostics.push({ code: "CONFIG_RANGE_INVALID", path });
  else adopt(value);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function failure(diagnostics: readonly ConfigDiagnostic[]): ConfigValidationResult {
  return { ok: false, diagnostics: Object.freeze(diagnostics.map((diagnostic): ConfigDiagnostic => Object.freeze({ ...diagnostic }))) };
}
