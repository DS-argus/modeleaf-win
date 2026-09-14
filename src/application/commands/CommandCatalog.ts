import {
  ACTION_DESCRIPTORS,
  getActionRuntimeAvailability,
  type ActionDescriptor,
  type ActionId,
  type ActionRuntimeContext,
} from "../../domain/actions/ActionRegistry";
import type { ProductConfig } from "../../domain/config/ConfigValidator";
import { parseKeySequence, type CanonicalKeyToken } from "../../domain/input/KeyGrammar";

export type CommandSurface = "menu" | "palette" | "help";
export type CommandCategory = "application" | "tabs" | "navigation" | "search" | "view" | "document" | "settings";

export interface CommandProjectionOptions {
  readonly modalOwner?: "help" | "palette";
}

export interface CommandProjection {
  readonly id: ActionId;
  readonly title: string;
  readonly category: CommandCategory;
  readonly shortcuts: readonly string[];
  readonly enabled: boolean;
  readonly disabledReason?: string;
}

const CATEGORY_BY_PREFIX: readonly [string, CommandCategory][] = Object.freeze([
  ["app.", "application"], ["tab.", "tabs"], ["search.", "search"],
  ["view.", "view"], ["config.", "settings"], ["theme.", "settings"], ["update.", "settings"],
  ["document.", "document"], ["scroll.", "navigation"], ["page.", "navigation"],
  ["history.", "navigation"], ["palette.", "application"], ["help.", "application"],
]);

export function projectCommands(
  surface: CommandSurface,
  state: ActionRuntimeContext,
  config: ProductConfig,
  options: CommandProjectionOptions = {},
): readonly CommandProjection[] {
  return Object.freeze(ACTION_DESCRIPTORS
    .filter((descriptor) => visibleOnSurface(descriptor, surface))
    .map((descriptor) => projectCommand(descriptor, surface, state, config, options)));
}

export const projectMenuCommands = (state: ActionRuntimeContext, config: ProductConfig): readonly CommandProjection[] =>
  projectCommands("menu", state, config);
export const projectPaletteCommands = (state: ActionRuntimeContext, config: ProductConfig, options: CommandProjectionOptions = {}): readonly CommandProjection[] =>
  projectCommands("palette", state, config, options);
export const projectHelpCommands = (state: ActionRuntimeContext, config: ProductConfig, options: CommandProjectionOptions = {}): readonly CommandProjection[] =>
  projectCommands("help", state, config, options);

function visibleOnSurface(descriptor: ActionDescriptor, surface: CommandSurface): boolean {
  if (descriptor.bindingConfiguration === "fixed") return false;
  if (/^(config|history|update)\./u.test(descriptor.id)) return false;
  if (surface === "menu") return descriptor.id !== "palette.open";
  return true;
}
function projectCommand(descriptor: ActionDescriptor, surface: CommandSurface, state: ActionRuntimeContext, config: ProductConfig, options: CommandProjectionOptions): CommandProjection {
  const availability = getActionRuntimeAvailability(
    descriptor.id,
    options.modalOwner === surface && state.modalOpen ? { ...state, modalOpen: false } : state,
  );
  return Object.freeze({
    id: descriptor.id,
    title: descriptor.displayName,
    category: categoryFor(descriptor.id),
    shortcuts: Object.freeze((config.keymap[descriptor.id] ?? []).map(formatShortcut)),
    enabled: availability.enabled,
    ...(!availability.enabled ? { disabledReason: availability.reason } : {}),
  });
}
function categoryFor(id: ActionId): CommandCategory {
  return CATEGORY_BY_PREFIX.find(([prefix]) => id.startsWith(prefix))?.[1] ?? "application";
}
function formatShortcut(sequence: string): string {
  const parsed = parseKeySequence(sequence);
  if (!parsed.ok) throw new Error(`INVALID_EFFECTIVE_BINDING:${sequence}`);
  return parsed.tokens.map(formatToken).join(" ");
}
function formatToken(token: CanonicalKeyToken): string {
  if (token.modifiers.length === 0) {
    if (/^[A-Z]$/u.test(token.key)) return `Shift+${token.key.toLowerCase()}`;
    return displayKey(token.key);
  }
  const modifiers = token.modifiers.map((modifier) => ({ C: "Ctrl", A: "Alt", S: "Shift" })[modifier]);
  return [...modifiers, displayKey(token.key)].join("+");
}
function displayKey(key: string): string {
  return ({ Esc: "Esc", Enter: "Enter", BS: "Backspace", Del: "Delete", Left: "Left", Right: "Right", Up: "Up", Down: "Down", Space: "Space", Minus: "-", LT: "<", GT: ">" } as Readonly<Record<string, string>>)[key] ?? key;
}
