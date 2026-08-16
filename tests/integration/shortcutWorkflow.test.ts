/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { validateProductConfig } from "../../src/domain/config/ConfigValidator";
import type { ActionRuntimeContext } from "../../src/domain/actions/ActionRegistry";
import { createRootKeyboardRouter, type RootKeyboardEvent } from "../../src/platform/RootKeyboardRouter";
import { buildCommandPaletteEntries, type CommandPaletteCommandEntry } from "../../src/ui/CommandPaletteModel";
import { buildHelpRows } from "../../src/ui/HelpModel";
const configResult = validateProductConfig({});
if (!configResult.ok) throw new Error("built-in config invalid");
const runtime: ActionRuntimeContext = { hasDocument: true, canCreateSession: true, canOpenDocument: true, canCreateWindow: true, tabCount: 2, paneCount: 1, modalOpen: false, updateAvailable: false, configExists: false, searchActive: false, canHistoryBack: false, canHistoryForward: false, linkCount: 1 };
function key(keyValue: string, init: Partial<RootKeyboardEvent> = {}) { let prevented = false; return { event: { key: keyValue, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, preventDefault: () => { prevented = true; }, ...init } satisfies RootKeyboardEvent, prevented: () => prevented }; }
describe("shortcut workflow", () => {
  it("routes reader actions through the W03 root registry", () => {
    const actions: string[] = [];
    const router = createRootKeyboardRouter({ config: configResult.value, getContext: () => ({ windowId: "window-a", routeRevision: "route-a", generation: 1, inputContext: "navigation", runtime }), onDispatch: (id) => actions.push(id) });
    for (const event of [key("n"), key("G"), key("g"), key("g")]) router.handleKeyDown(event.event);
    expect(actions).toEqual(["page.next", "page.last", "page.first"]);
    router.dispose();
  });
  it("uses the same registry metadata for visible help and palette", () => {
    const help = buildHelpRows(runtime);
    const palette = buildCommandPaletteEntries(runtime).filter((entry): entry is CommandPaletteCommandEntry => entry.kind === "command");
    const helpById = new Map(help.map((entry) => [entry.id, entry]));
    expect(palette).toHaveLength(12);
    for (const entry of palette) expect(entry).toMatchObject({ label: helpById.get(entry.id)?.label, shortcut: helpById.get(entry.id)?.shortcut });
    expect(help.map(({ shortcut }) => shortcut)).toEqual(expect.arrayContaining(["Ctrl+O", "Alt+F4", ":, Ctrl+Shift+P", "Shift+N", "g g", "Shift+G"]));
  });
  it("projects exact no-document current-window and theme behavior", () => {
    const empty = { ...runtime, hasDocument: false, modalOpen: true, linkCount: 0 };
    const select = (rows: readonly { id: string; shortcut: string; label: string; enabled: boolean }[]) => rows.filter(({ id }) => id === "app.quit" || id === "theme.picker").map(({ id, shortcut, label, enabled }) => ({ id, shortcut, label, enabled }));
    expect(select(buildHelpRows(empty))).toEqual([{ id: "app.quit", shortcut: "Alt+F4", label: "Close Window", enabled: true }, { id: "theme.picker", shortcut: "Shift+T", label: "Theme picker", enabled: false }]);
  });
});
