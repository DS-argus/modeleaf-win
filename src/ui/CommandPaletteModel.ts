import { projectPaletteCommands } from "../application/commands/CommandCatalog";
import { filterCommandPalette, type PaletteEntry } from "../domain/actions/CommandPalette";
import { type ActionId, type ActionRuntimeContext } from "../domain/actions/ActionRegistry";
import { validateProductConfig, type ProductConfig } from "../domain/config/ConfigValidator";
const DEFAULT_CONFIG_RESULT = validateProductConfig({});
if (!DEFAULT_CONFIG_RESULT.ok) throw new Error("BUILT_IN_CONFIG_INVALID");
const DEFAULT_CONFIG = DEFAULT_CONFIG_RESULT.value;
const DEFAULT_RUNTIME_CONTEXT: ActionRuntimeContext = Object.freeze({ hasDocument: true, canOpenDocument: true, canCreateSession: true, canCreateWindow: true, tabCount: 1, paneCount: 1, modalOpen: false, updateAvailable: false, configExists: false, searchActive: false, canHistoryBack: true, canHistoryForward: true, linkCount: 1 });
const MAX_RECENT_ENTRIES = 15;
const MAX_QUERY_CODE_POINTS = 256;
const MAX_RAW_QUERY_CODE_UNITS = MAX_QUERY_CODE_POINTS * 2;
export interface RecentPaletteRecord { readonly recentId: string; readonly displayName: string }
export interface CommandPaletteCommandEntry { readonly kind: "command"; readonly id: ActionId; readonly shortcut: string; readonly label: string; readonly enabled: boolean; readonly disabledReason?: string }
export interface CommandPaletteRecentEntry extends RecentPaletteRecord { readonly kind: "recent" }
export type CommandPaletteEntry = CommandPaletteCommandEntry | CommandPaletteRecentEntry;
function exceedsCodePointCount(value: string, maximum: number): boolean { let count = 0; for (const _ of value) { count += 1; if (count > maximum) return true; } return false; }
export function buildCommandPaletteEntries(context: ActionRuntimeContext = DEFAULT_RUNTIME_CONTEXT, recents: readonly RecentPaletteRecord[] = [], query = "", config: ProductConfig = DEFAULT_CONFIG): readonly CommandPaletteEntry[] {
  if (query.length > MAX_RAW_QUERY_CODE_UNITS || exceedsCodePointCount(query, MAX_QUERY_CODE_POINTS)) return [];
  const commands: readonly CommandPaletteCommandEntry[] = projectPaletteCommands(context, config).map((command) => ({ kind: "command", id: command.id, shortcut: command.shortcuts.join(", "), label: command.title, enabled: command.enabled, ...(!command.enabled ? { disabledReason: command.disabledReason } : {}) }));
  const recentEntries: readonly CommandPaletteRecentEntry[] = recents.slice(0, MAX_RECENT_ENTRIES).map((recent) => ({ kind: "recent", recentId: recent.recentId, displayName: recent.displayName }));
  const source: PaletteEntry[] = [
    ...commands.map((entry) => ({ id: entry.id, title: entry.label, enabled: entry.enabled, ...(entry.disabledReason === undefined ? {} : { disabledReason: entry.disabledReason }), kind: "action" as const })),
    ...recentEntries.map((entry) => ({ id: entry.recentId, title: entry.displayName, enabled: true, kind: "recent" as const })),
  ];
  const commandById = new Map<string, CommandPaletteCommandEntry>(commands.map((entry) => [entry.id, entry]));
  const recentById = new Map<string, CommandPaletteRecentEntry>(recentEntries.map((entry) => [entry.recentId, entry]));
  return filterCommandPalette(source, query).map((match) => match.kind === "action" ? commandById.get(match.id)! : recentById.get(match.id)!);
}
type PaletteKeyboardEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "isComposing">;
function matchesLetter(event: PaletteKeyboardEvent, letter: string): boolean { return event.code === `Key${letter.toUpperCase()}` || event.key.toLowerCase() === letter.toLowerCase(); }
export function isPaletteClearShortcut(event: PaletteKeyboardEvent): boolean { return !event.isComposing && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && matchesLetter(event, "c"); }
export type CommandPaletteKeyAction = "close" | "submit" | "next" | "previous";
export function commandPaletteKeyAction(event: PaletteKeyboardEvent): CommandPaletteKeyAction | undefined {
  if (event.isComposing || event.altKey || event.metaKey) return undefined;
  if (event.key === "Escape" && !event.ctrlKey) return "close";
  if (event.key === "Enter" && !event.ctrlKey) return "submit";
  if (event.key === "ArrowDown" || (event.ctrlKey && matchesLetter(event, "j"))) return "next";
  if (event.key === "ArrowUp" || (event.ctrlKey && matchesLetter(event, "k"))) return "previous";
  return undefined;
}
export function moveCommandPaletteIndex(currentIndex: number, entryCount: number, action: "next" | "previous"): number {
  if (!Number.isSafeInteger(entryCount) || entryCount < 0) throw new RangeError("Palette entry count is invalid");
  if (entryCount === 0) return 0;
  const normalized = ((currentIndex % entryCount) + entryCount) % entryCount;
  return (normalized + (action === "next" ? 1 : entryCount - 1)) % entryCount;
}
