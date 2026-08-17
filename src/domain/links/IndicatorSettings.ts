export const INDICATOR_STYLES = Object.freeze([
  "pulse-ring", "target", "beacon", "static-ring", "diamond-pulse",
] as const);
export type IndicatorStyle = (typeof INDICATOR_STYLES)[number];

export const INDICATOR_COLORS = Object.freeze([
  "red", "amber", "cyan", "green", "purple", "accent", "auto-contrast", "high-contrast",
] as const);
export type IndicatorNamedColor = (typeof INDICATOR_COLORS)[number];
export type IndicatorColor = IndicatorNamedColor | `#${string}`;

export interface IndicatorSettings {
  readonly style: IndicatorStyle;
  readonly color: IndicatorColor;
  readonly size: number;
  readonly durationMilliseconds: number;
}

export type IndicatorSettingsError =
  | "INDICATOR_NOT_OBJECT"
  | "INDICATOR_STYLE_INVALID"
  | "INDICATOR_COLOR_INVALID"
  | "INDICATOR_SIZE_INVALID"
  | "INDICATOR_DURATION_INVALID";

export type IndicatorSettingsResult =
  | { readonly ok: true; readonly value: IndicatorSettings }
  | { readonly ok: false; readonly error: IndicatorSettingsError };

export const DEFAULT_INDICATOR_SETTINGS: IndicatorSettings = Object.freeze({
  style: "pulse-ring",
  color: "red",
  size: 28,
  durationMilliseconds: 1500,
});

export function validateIndicatorSettings(value: unknown): IndicatorSettingsResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "INDICATOR_NOT_OBJECT" };
  }
  const candidate = value as Record<string, unknown>;
  if (!INDICATOR_STYLES.includes(candidate.style as IndicatorStyle)) {
    return { ok: false, error: "INDICATOR_STYLE_INVALID" };
  }
  const color = normalizeIndicatorColor(candidate.color);
  if (color === undefined) return { ok: false, error: "INDICATOR_COLOR_INVALID" };
  if (!Number.isFinite(candidate.size) || (candidate.size as number) < 16 || (candidate.size as number) > 48) {
    return { ok: false, error: "INDICATOR_SIZE_INVALID" };
  }
  if (!Number.isFinite(candidate.durationMilliseconds) || !Number.isInteger(candidate.durationMilliseconds)
    || (candidate.durationMilliseconds as number) < 500 || (candidate.durationMilliseconds as number) > 3000) {
    return { ok: false, error: "INDICATOR_DURATION_INVALID" };
  }
  return {
    ok: true,
    value: Object.freeze({
      style: candidate.style as IndicatorStyle,
      color,
      size: candidate.size as number,
      durationMilliseconds: candidate.durationMilliseconds as number,
    }),
  };
}

export function normalizeIndicatorColor(value: unknown): IndicatorColor | undefined {
  if (typeof value !== "string") return undefined;
  if (INDICATOR_COLORS.includes(value as IndicatorNamedColor)) return value as IndicatorNamedColor;
  return /^#[0-9a-fA-F]{6}$/u.test(value) ? value.toLowerCase() as IndicatorColor : undefined;
}
export interface IndicatorSettingsTransaction {
  readonly baseline: IndicatorSettings;
  readonly preview: IndicatorSettings;
}

export type IndicatorSettingsTransactionResult =
  | { readonly ok: true; readonly transaction: IndicatorSettingsTransaction }
  | { readonly ok: false; readonly error: IndicatorSettingsError };

export interface IndicatorSettingsResolution {
  readonly value: IndicatorSettings;
  readonly persist: boolean;
}

export function openIndicatorSettingsTransaction(value: unknown): IndicatorSettingsTransactionResult {
  const validated = validateIndicatorSettings(value);
  return validated.ok
    ? { ok: true, transaction: freezeTransaction(validated.value, validated.value) }
    : validated;
}

export function previewIndicatorSettings(
  transaction: IndicatorSettingsTransaction,
  value: unknown,
): IndicatorSettingsTransactionResult {
  const validated = validateIndicatorSettings(value);
  return validated.ok
    ? { ok: true, transaction: freezeTransaction(transaction.baseline, validated.value) }
    : validated;
}

export function cancelIndicatorSettings(transaction: IndicatorSettingsTransaction): IndicatorSettingsResolution {
  return Object.freeze({ value: transaction.baseline, persist: false });
}

export function commitIndicatorSettings(transaction: IndicatorSettingsTransaction): IndicatorSettingsResolution {
  return Object.freeze({ value: transaction.preview, persist: true });
}

function freezeTransaction(baseline: IndicatorSettings, preview: IndicatorSettings): IndicatorSettingsTransaction {
  return Object.freeze({ baseline, preview });
}
