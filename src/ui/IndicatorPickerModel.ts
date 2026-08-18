import {
  INDICATOR_STYLES,
  validateIndicatorSettings,
  type IndicatorSettings,
  type IndicatorStyle,
} from "../domain/links/IndicatorSettings";

/**
 * Preview/commit/revert transaction for the link-destination indicator.
 *
 * Mirrors `ThemePickerModel` deliberately: a preview is local only, exactly one
 * durable-write intent exists per transaction, and revert restores the state
 * captured when the picker opened. `feature-spec.md` §12 makes the indicator
 * one of only three persisted fields, so an escaped preview would be a
 * persistence-contract violation rather than a cosmetic bug.
 */

export interface IndicatorTransaction {
  readonly baseline: IndicatorSettings;
  readonly preview: IndicatorSettings;
}

export interface IndicatorPickerRow {
  readonly style: IndicatorStyle;
  readonly displayName: string;
}

export interface IndicatorPickerOpenModel {
  readonly status: "open";
  readonly transaction: IndicatorTransaction;
  readonly activeIndex: number;
}

export interface IndicatorPickerClosedModel {
  readonly status: "closed";
}

export type IndicatorPickerModel = IndicatorPickerOpenModel | IndicatorPickerClosedModel;

export interface IndicatorPreviewEffect {
  readonly kind: "preview";
  readonly settings: IndicatorSettings;
}

export interface IndicatorCommitIntent {
  readonly kind: "commit";
  readonly settings: IndicatorSettings;
}

export interface IndicatorRevertEffect {
  readonly kind: "revert";
  readonly settings: IndicatorSettings;
}

const DISPLAY_NAMES: Readonly<Record<IndicatorStyle, string>> = Object.freeze({
  "pulse-ring": "Pulse ring",
  target: "Target",
  beacon: "Beacon",
  "static-ring": "Static ring",
  "diamond-pulse": "Diamond pulse",
});

export const INDICATOR_PICKER_ROWS: readonly IndicatorPickerRow[] = Object.freeze(
  INDICATOR_STYLES.map((style) => Object.freeze({ style, displayName: DISPLAY_NAMES[style] })),
);

export const CLOSED_INDICATOR_PICKER: IndicatorPickerClosedModel = Object.freeze({ status: "closed" });

export type IndicatorPickerKeyAction = "next" | "previous" | "commit" | "revert";

export function indicatorPickerKeyAction(key: string): IndicatorPickerKeyAction | undefined {
  if (key === "ArrowDown" || key === "ArrowRight") return "next";
  if (key === "ArrowUp" || key === "ArrowLeft") return "previous";
  if (key === "Enter") return "commit";
  if (key === "Escape") return "revert";
  return undefined;
}

export function indicatorPickerDialogKeyAction(event: KeyboardEvent): IndicatorPickerKeyAction | undefined {
  if (event.isComposing || event.altKey || event.metaKey || event.shiftKey) return undefined;
  const ctrlKey = event.ctrlKey ? event.key.toLowerCase() : "";
  const action = ctrlKey === "j"
    ? "next"
    : ctrlKey === "k"
      ? "previous"
      : event.ctrlKey
        ? undefined
        : indicatorPickerKeyAction(event.key);
  if (action === undefined) return undefined;
  event.preventDefault();
  event.stopPropagation();
  return action;
}

function styleIndex(style: IndicatorStyle): number {
  const index = INDICATOR_PICKER_ROWS.findIndex((row) => row.style === style);
  if (index < 0) throw new Error(`Missing picker row for indicator style: ${style}`);
  return index;
}

function openModel(transaction: IndicatorTransaction): IndicatorPickerOpenModel {
  return Object.freeze({
    status: "open",
    transaction: Object.freeze({
      baseline: Object.freeze({ ...transaction.baseline }),
      preview: Object.freeze({ ...transaction.preview }),
    }),
    activeIndex: styleIndex(transaction.preview.style),
  });
}

/**
 * Opens a transaction from the last durable settings.
 *
 * Invalid durable input is rejected rather than silently repaired, so a corrupt
 * state file cannot become the new baseline through the picker.
 */
export function openIndicatorPicker(baseline: IndicatorSettings): IndicatorPickerOpenModel {
  const validated = validateIndicatorSettings(baseline);
  if (!validated.ok) throw new RangeError(`Invalid indicator baseline: ${validated.error}`);
  return openModel({ baseline: validated.value, preview: validated.value });
}

/** Changes only the local preview; it never creates a persistence request. */
export function previewIndicatorPickerRow(
  model: IndicatorPickerOpenModel,
  index: number,
): { readonly model: IndicatorPickerOpenModel; readonly effect: IndicatorPreviewEffect } {
  const row = INDICATOR_PICKER_ROWS[index];
  if (row === undefined) throw new RangeError(`Indicator picker row is out of bounds: ${String(index)}`);
  const preview: IndicatorSettings = Object.freeze({ ...model.transaction.preview, style: row.style });
  const next = openModel({ baseline: model.transaction.baseline, preview });
  return Object.freeze({ model: next, effect: Object.freeze({ kind: "preview", settings: preview }) });
}

/** Emits the sole durable-write intent for an open transaction and closes it. */
export function commitIndicatorPicker(
  model: IndicatorPickerOpenModel,
): { readonly model: IndicatorPickerClosedModel; readonly intent: IndicatorCommitIntent } {
  return Object.freeze({
    model: CLOSED_INDICATOR_PICKER,
    intent: Object.freeze({ kind: "commit", settings: model.transaction.preview }),
  });
}

/** Closes synchronously and restores the settings captured on open. */
export function revertIndicatorPicker(
  model: IndicatorPickerOpenModel,
): { readonly model: IndicatorPickerClosedModel; readonly effect: IndicatorRevertEffect } {
  return Object.freeze({
    model: CLOSED_INDICATOR_PICKER,
    effect: Object.freeze({ kind: "revert", settings: model.transaction.baseline }),
  });
}

/** Reverts to authoritative durable state after a stale or failed native commit. */
export function revertIndicatorPickerToDurable(
  _model: IndicatorPickerOpenModel,
  durable: IndicatorSettings,
): { readonly model: IndicatorPickerClosedModel; readonly effect: IndicatorRevertEffect } {
  const validated = validateIndicatorSettings(durable);
  if (!validated.ok) throw new RangeError(`Invalid durable indicator settings: ${validated.error}`);
  return Object.freeze({
    model: CLOSED_INDICATOR_PICKER,
    effect: Object.freeze({ kind: "revert", settings: validated.value }),
  });
}
