import { DEFAULT_BINDINGS } from "../core/defaultBindings.windows";

export interface HelpRow {
  readonly id: string;
  readonly shortcut: string;
  readonly label: string;
}

export function buildHelpRows(): readonly HelpRow[] {
  return DEFAULT_BINDINGS
    .filter((binding) => binding.showInHelp)
    .map((binding) => ({
      id: binding.id,
      shortcut: binding.keys.join(" "),
      label: binding.label,
    }));
}
