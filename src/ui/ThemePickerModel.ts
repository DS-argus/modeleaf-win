import { THEMES, isThemeId, type ThemeId } from "../domain/theme/Theme";

export interface ThemeTransaction {
  readonly baselineId: ThemeId;
  readonly baselineRevision: number;
  readonly previewId: ThemeId;
}

export interface ThemePickerRow {
  readonly id: ThemeId;
  readonly displayName: string;
}

export interface ThemePickerOpenModel {
  readonly status: "open";
  readonly transaction: ThemeTransaction;
  readonly activeIndex: number;
}

export interface ThemePickerClosedModel {
  readonly status: "closed";
}

export type ThemePickerModel = ThemePickerOpenModel | ThemePickerClosedModel;

export interface ThemePreviewEffect {
  readonly kind: "preview";
  readonly themeId: ThemeId;
}

export interface ThemeCommitIntent {
  readonly kind: "commit";
  readonly themeId: ThemeId;
  readonly baseRevision: number;
}

export interface ThemeRevertEffect {
  readonly kind: "revert";
  readonly themeId: ThemeId;
}

export const THEME_PICKER_ROWS: readonly ThemePickerRow[] = Object.freeze(THEMES.map((theme) => Object.freeze({
  id: theme.id,
  displayName: theme.displayName,
})));

export const CLOSED_THEME_PICKER: ThemePickerClosedModel = Object.freeze({ status: "closed" });

export type ThemePickerKeyAction = "next" | "previous" | "commit" | "revert";
export const THEME_PICKER_FOOTER = Object.freeze([
  Object.freeze({ key: "j/k", action: "move" }),
  Object.freeze({ key: "Enter", action: "apply" }),
  Object.freeze({ key: "Esc", action: "cancel" }),
] as const);

export function themePickerKeyAction(key: string): ThemePickerKeyAction | undefined {
  if (key === "ArrowDown" || key === "ArrowRight" || key === "j" || key === "J") return "next";
  if (key === "ArrowUp" || key === "ArrowLeft" || key === "k" || key === "K") return "previous";
  if (key === "Enter") return "commit";
  if (key === "Escape") return "revert";
  return undefined;
}

export function themePickerDialogKeyAction(event: KeyboardEvent): ThemePickerKeyAction | undefined {
  if (event.isComposing || event.altKey || event.metaKey || event.shiftKey) return undefined;
  const ctrlKey = event.ctrlKey ? event.key.toLowerCase() : "";
  const action = ctrlKey === "j"
    ? "next"
    : ctrlKey === "k"
      ? "previous"
      : event.ctrlKey
        ? undefined
        : themePickerKeyAction(event.key);
  if (!action) return undefined;
  event.preventDefault();
  event.stopPropagation();
  return action;
}
function assertThemeId(value: string): asserts value is ThemeId {
  if (!isThemeId(value)) throw new RangeError(`Unknown theme id: ${value}`);
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Theme revision must be a non-negative safe integer");
}

function rowIndex(id: ThemeId): number {
  const index = THEME_PICKER_ROWS.findIndex((row) => row.id === id);
  if (index < 0) throw new Error(`Missing picker row for theme: ${id}`);
  return index;
}

function openModel(transaction: ThemeTransaction): ThemePickerOpenModel {
  return Object.freeze({
    status: "open",
    transaction: Object.freeze(transaction),
    activeIndex: rowIndex(transaction.previewId),
  });
}

/** Opens a new transaction from the last durable theme state. */
export function openThemePicker(baselineId: string, baselineRevision: number): ThemePickerOpenModel {
  assertThemeId(baselineId);
  assertRevision(baselineRevision);
  return openModel({ baselineId, baselineRevision, previewId: baselineId });
}

/** Changes only the local preview; it never creates a persistence request. */
export function previewThemePickerRow(
  model: ThemePickerOpenModel,
  index: number,
): { readonly model: ThemePickerOpenModel; readonly effect: ThemePreviewEffect } {
  if (!Number.isSafeInteger(index) || index < 0 || index >= THEME_PICKER_ROWS.length) {
    throw new RangeError(`Theme picker row is out of bounds: ${index}`);
  }
  const row = THEME_PICKER_ROWS[index];
  if (row === undefined) throw new RangeError(`Theme picker row is out of bounds: ${index}`);
  const next = openModel({ ...model.transaction, previewId: row.id });
  return Object.freeze({ model: next, effect: Object.freeze({ kind: "preview", themeId: row.id }) });
}

/** Emits the sole durable-write intent for an open transaction and closes it. */
export function commitThemePicker(
  model: ThemePickerOpenModel,
): { readonly model: ThemePickerClosedModel; readonly intent: ThemeCommitIntent } {
  const { previewId, baselineRevision } = model.transaction;
  return Object.freeze({
    model: CLOSED_THEME_PICKER,
    intent: Object.freeze({ kind: "commit", themeId: previewId, baseRevision: baselineRevision }),
  });
}

/** Closes a picker synchronously and restores the theme captured on open. */
export function revertThemePicker(
  model: ThemePickerOpenModel,
): { readonly model: ThemePickerClosedModel; readonly effect: ThemeRevertEffect } {
  return Object.freeze({
    model: CLOSED_THEME_PICKER,
    effect: Object.freeze({ kind: "revert", themeId: model.transaction.baselineId }),
  });
}

/** Reverts a preview after a stale or failed native commit to its authoritative state. */
export function revertThemePickerToDurable(
  _model: ThemePickerOpenModel,
  durableId: string,
  durableRevision: number,
): { readonly model: ThemePickerClosedModel; readonly effect: ThemeRevertEffect } {
  assertThemeId(durableId);
  assertRevision(durableRevision);
  return Object.freeze({
    model: CLOSED_THEME_PICKER,
    effect: Object.freeze({ kind: "revert", themeId: durableId }),
  });
}
