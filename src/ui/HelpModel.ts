import {
  DEFAULT_BINDINGS,
  isCommandEnabled,
  type CommandAvailabilityContext,
} from "../core/defaultBindings.windows";

export interface HelpRow {
  readonly id: string;
  readonly shortcut: string;
  readonly label: string;
  readonly enabled: boolean;
}

export function buildHelpRows(context?: CommandAvailabilityContext): readonly HelpRow[] {
  return DEFAULT_BINDINGS
    .filter((binding) => binding.showInHelp)
    .map((binding) => ({
      id: binding.id,
      shortcut: binding.keys.join(" "),
      label: binding.label,
      enabled: isCommandEnabled(binding, context),
    }));
}
