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
  if (id.startsWith("theme.") || id.startsWith("indicator.")) return "Theme";
  return "Application";
}
export function buildHelpRows(context: ActionRuntimeContext = DEFAULT_RUNTIME_CONTEXT, config: ProductConfig = DEFAULT_CONFIG, projectionOptions: CommandProjectionOptions = {}): readonly HelpRow[] {
  const commands = projectHelpCommands(context, config, projectionOptions);
  const tabSelectionCommands = commands.filter((command) => /^tab\.select\.[1-9]$/u.test(command.id));
  const tabSelectionRow = buildTabSelectionRow(tabSelectionCommands);

  return commands.flatMap((command) => {
    if (!/^tab\.select\.[1-9]$/u.test(command.id)) return [helpRow(command)];
    return command.id === "tab.select.1" && tabSelectionRow !== undefined ? [tabSelectionRow] : [];
  });
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
function buildTabSelectionRow(commands: readonly CommandProjection[]): HelpRow | undefined {
  const first = commands[0];
  if (first === undefined) return undefined;
  const enabled = commands.some((command) => command.enabled);
  const last = commands.at(-1) ?? first;
  const disabledReason = !enabled && commands.every((command) => command.disabledReason === first.disabledReason)
    ? first.disabledReason
    : undefined;
  return Object.freeze({
    id: first.id,
    category: "Tabs",
    shortcut: `${first.shortcuts.join(", ")} … ${last.shortcuts.join(", ")}`,
    label: "Select Tab 1–9",
    enabled,
    ...(disabledReason !== undefined ? { disabledReason } : {}),
  });
}
