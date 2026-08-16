import {
  DEFAULT_BINDINGS,
  formatShortcutKeys,
  isCommandEnabled,
  type CommandAvailabilityContext,
} from "../core/defaultBindings.windows";

export type HelpCategory = "Tabs" | "Pages" | "Scroll" | "View / Zoom" | "Search" | "Links" | "Theme" | "Application";

export interface HelpRow {
  readonly id: string;
  readonly category: HelpCategory;
  readonly shortcut: string;
  readonly label: string;
  readonly enabled: boolean;
}

export function helpCategoryForId(id: string): HelpCategory {
  if (id.startsWith("tab.")) return "Tabs";
  if (id.startsWith("page.") || id.startsWith("prompt.")) return "Pages";
  if (id.startsWith("scroll.")) return "Scroll";
  if (id.startsWith("view.")) return "View / Zoom";
  if (id.startsWith("search.")) return "Search";
  if (id.startsWith("linkHints.")) return "Links";
  if (id.startsWith("theme.")) return "Theme";
  return "Application";
}

export function buildHelpRows(context?: CommandAvailabilityContext): readonly HelpRow[] {
  return DEFAULT_BINDINGS
    .filter((binding) => binding.showInHelp)
    .map((binding) => ({
      id: binding.id,
      category: helpCategoryForId(binding.id),
      shortcut: formatShortcutKeys(binding.keys),
      label: binding.label,
      enabled: isCommandEnabled(binding, context),
    }));
}
