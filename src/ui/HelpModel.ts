import { projectHelpCommands } from "../application/commands/CommandCatalog";
import { type ActionId, type ActionRuntimeContext } from "../domain/actions/ActionRegistry";
import { validateProductConfig, type ProductConfig } from "../domain/config/ConfigValidator";

export type HelpCategory = "Tabs" | "Pages" | "Scroll" | "View / Zoom" | "Search" | "Links" | "Theme" | "Application";
export interface HelpRow { readonly id: ActionId; readonly category: HelpCategory; readonly shortcut: string; readonly label: string; readonly enabled: boolean; readonly disabledReason?: string }
const DEFAULT_CONFIG_RESULT = validateProductConfig({});
if (!DEFAULT_CONFIG_RESULT.ok) throw new Error("BUILT_IN_CONFIG_INVALID");
const DEFAULT_CONFIG = DEFAULT_CONFIG_RESULT.value;
const DEFAULT_RUNTIME_CONTEXT: ActionRuntimeContext = Object.freeze({ hasDocument: true, canOpenDocument: true, canCreateSession: true, canCreateWindow: true, tabCount: 1, paneCount: 1, modalOpen: false, updateAvailable: false, configExists: false, searchActive: false, canHistoryBack: true, canHistoryForward: true, linkCount: 1 });

export function helpCategoryForId(id: ActionId): HelpCategory {
  if (id.startsWith("tab.")) return "Tabs";
  if (id.startsWith("page.") || id.startsWith("prompt.") || id.startsWith("toc.")) return "Pages";
  if (id.startsWith("scroll.")) return "Scroll";
  if (id.startsWith("view.")) return "View / Zoom";
  if (id.startsWith("search.")) return "Search";
  if (id.startsWith("link.")) return "Links";
  if (id.startsWith("theme.") || id.startsWith("indicator.")) return "Theme";
  return "Application";
}
export function buildHelpRows(context: ActionRuntimeContext = DEFAULT_RUNTIME_CONTEXT, config: ProductConfig = DEFAULT_CONFIG): readonly HelpRow[] {
  return projectHelpCommands(context, config).map((command) => Object.freeze({
    id: command.id,
    category: helpCategoryForId(command.id),
    shortcut: command.shortcuts.join(", "),
    label: command.title,
    enabled: command.enabled,
    ...(!command.enabled ? { disabledReason: command.disabledReason } : {}),
  }));
}
