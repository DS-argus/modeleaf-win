import { validateIndicatorSettings, type IndicatorSettings } from "../domain/links/IndicatorSettings";
import { parseAndValidateConfigToml, type ConfigTomlResult } from "../domain/config/ConfigFile";

export type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type ConfigLoadOutcome =
  | { readonly tag: "MISSING" }
  | { readonly tag: "LOADED"; readonly config: ConfigTomlResult }
  | { readonly tag: "TOO_LARGE" | "INVALID_UTF8" | "STORAGE_FAILED" };
export type ConfigWriteOutcome = { readonly tag: "CREATED" | "ALREADY_EXISTS" | "TOO_LARGE" | "LOCK_TIMEOUT" | "STORAGE_FAILED" };
export type ConfigResetOutcome = { readonly tag: "REPLACED" | "UNCHANGED" | "MISSING" | "TOO_LARGE" | "LOCK_TIMEOUT" | "STORAGE_FAILED" };

const READ_TAGS = new Set(["MISSING", "LOADED", "TOO_LARGE", "INVALID_UTF8", "STORAGE_FAILED"]);
const WRITE_TAGS = new Set(["CREATED", "ALREADY_EXISTS", "TOO_LARGE", "LOCK_TIMEOUT", "STORAGE_FAILED"]);
const RESET_TAGS = new Set(["REPLACED", "UNCHANGED", "MISSING", "TOO_LARGE", "LOCK_TIMEOUT", "STORAGE_FAILED"]);

export async function readIndicatorState(invoke: NativeInvoke): Promise<IndicatorSettings | undefined> {
  const value = await invoke<unknown>("read_indicator_state");
  if (value === null) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw contractError();
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !["style", "color", "size", "duration_ms"].includes(key))) throw contractError();
  const validated = validateIndicatorSettings({ style: source.style, color: source.color, size: source.size, durationMilliseconds: source.duration_ms });
  if (!validated.ok) throw contractError();
  return validated.value;
}
export async function commitIndicatorState(invoke: NativeInvoke, value: IndicatorSettings): Promise<void> {
  const validated = validateIndicatorSettings(value);
  if (!validated.ok) throw contractError();
  const result = await invoke<unknown>("commit_indicator_state", { value: { style: validated.value.style, color: validated.value.color, size: validated.value.size, duration_ms: validated.value.durationMilliseconds } });
  if (result !== null) throw contractError();
}
export async function readProductConfig(invoke: NativeInvoke): Promise<ConfigLoadOutcome> {
  const value = await invoke<unknown>("read_config");
  const object = tagged(value, READ_TAGS);
  if (object.tag === "LOADED") {
    if (typeof object.text !== "string") throw contractError();
    return Object.freeze({ tag: "LOADED", config: parseAndValidateConfigToml(object.text) });
  }
  if ("text" in object) throw contractError();
  return Object.freeze({ tag: object.tag as Exclude<ConfigLoadOutcome["tag"], "LOADED"> });
}
export async function writeDefaultProductConfig(invoke: NativeInvoke): Promise<ConfigWriteOutcome> {
  return decodeSimple(await invoke<unknown>("write_default_config"), WRITE_TAGS) as ConfigWriteOutcome;
}
export async function resetProductConfig(invoke: NativeInvoke): Promise<ConfigResetOutcome> {
  return decodeSimple(await invoke<unknown>("reset_config"), RESET_TAGS) as ConfigResetOutcome;
}
function decodeSimple(value: unknown, tags: ReadonlySet<string>): Readonly<{ tag: string }> {
  const object = tagged(value, tags);
  if (Object.keys(object).length !== 1) throw contractError();
  return Object.freeze({ tag: object.tag });
}
function tagged(value: unknown, tags: ReadonlySet<string>): Record<string, unknown> & { tag: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw contractError();
  const object = value as Record<string, unknown>;
  if (typeof object.tag !== "string" || !tags.has(object.tag)) throw contractError();
  return object as Record<string, unknown> & { tag: string };
}
function contractError(): Error { return new Error("NATIVE_CONTRACT_INVALID"); }
