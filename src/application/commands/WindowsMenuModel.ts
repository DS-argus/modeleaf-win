import { projectMenuCommands, type CommandCategory, type CommandProjection } from "./CommandCatalog";
import type { ActionRuntimeContext } from "../../domain/actions/ActionRegistry";
import type { ProductConfig } from "../../domain/config/ConfigValidator";

export interface WindowsMenuSection { readonly id: CommandCategory; readonly label: string; readonly commands: readonly CommandProjection[] }
const MENU_ORDER: readonly { readonly id: CommandCategory; readonly label: string }[] = Object.freeze([
  { id: "application", label: "File" }, { id: "tabs", label: "Tabs" },
  { id: "search", label: "Search" }, { id: "view", label: "View" }, { id: "settings", label: "Settings" },
]);
export function buildWindowsMenuModel(state: ActionRuntimeContext, config: ProductConfig): readonly WindowsMenuSection[] {
  const commands = projectMenuCommands(state, config);
  return Object.freeze(MENU_ORDER.map(({ id, label }) => Object.freeze({
    id, label, commands: Object.freeze(commands.filter((command) =>
      (command.category === id || (id === "application" && command.category === "document")) &&
      (id !== "settings" || command.id === "theme.picker"))),
  })).filter(({ commands: rows }) => rows.length > 0));
}
