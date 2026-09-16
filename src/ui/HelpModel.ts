import { projectHelpCommands, type CommandProjection, type CommandProjectionOptions } from "../application/commands/CommandCatalog";
import { type ActionId, type ActionRuntimeContext } from "../domain/actions/ActionRegistry";
import { validateProductConfig, type ProductConfig } from "../domain/config/ConfigValidator";

export type HelpCategory = "Tabs" | "Pages" | "Scroll" | "View / Zoom" | "Search" | "Theme" | "Application";
export interface HelpRow { readonly id: ActionId; readonly category: HelpCategory; readonly shortcut: string; readonly label: string; readonly enabled: boolean; readonly disabledReason?: string }
const DEFAULT_CONFIG_RESULT = validateProductConfig({});
if (!DEFAULT_CONFIG_RESULT.ok) throw new Error("BUILT_IN_CONFIG_INVALID");
const DEFAULT_CONFIG = DEFAULT_CONFIG_RESULT.value;
const DEFAULT_RUNTIME_CONTEXT: ActionRuntimeContext = Object.freeze({ hasDocument: true, canOpenDocument: true, canCreateSession: true, canCreateWindow: true, tabCount: 1, modalOpen: false, updateAvailable: false, configExists: false, searchActive: false, canHistoryBack: true, canHistoryForward: true });

export function helpCategoryForId(id: ActionId): HelpCategory {
  if (id.startsWith("tab.")) return "Tabs";
  if (id.startsWith("page.") || id.startsWith("prompt.")) return "Pages";
  if (id.startsWith("scroll.")) return "Scroll";
  if (id.startsWith("view.")) return "View / Zoom";
  if (id.startsWith("search.")) return "Search";
  if (id.startsWith("theme.")) return "Theme";
  return "Application";
}
export function buildHelpRows(context: ActionRuntimeContext = DEFAULT_RUNTIME_CONTEXT, config: ProductConfig = DEFAULT_CONFIG, projectionOptions: CommandProjectionOptions = {}): readonly HelpRow[] {
  return projectHelpCommands(context, config, projectionOptions).map(helpRow);
}

function helpRow(command: CommandProjection): HelpRow {
  return Object.freeze({
    id: command.id,
    category: helpCategoryForId(command.id),
    shortcut: command.shortcuts.join(", "),
    label: command.title,
    enabled: command.enabled,
    ...(!command.enabled && command.disabledReason !== undefined ? { disabledReason: command.disabledReason } : {}),
  });
}
