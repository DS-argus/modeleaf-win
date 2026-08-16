import { describe, expect, it } from "vitest";
import { buildWindowsMenuModel } from "../../../src/application/commands/WindowsMenuModel";
import { validateProductConfig } from "../../../src/domain/config/ConfigValidator";
import type { ActionRuntimeContext } from "../../../src/domain/actions/ActionRegistry";
const configResult = validateProductConfig({});
if (!configResult.ok) throw new Error("built-in config invalid");
const state: ActionRuntimeContext = { hasDocument: false, canOpenDocument: true, canCreateSession: true, canCreateWindow: true, tabCount: 1, paneCount: 1, modalOpen: false, updateAvailable: false, configExists: false, searchActive: false, canHistoryBack: false, canHistoryForward: false, linkCount: 0 };
describe("WindowsMenuModel", () => {
  it("groups one registry projection in stable Windows menu order", () => {
    const menu = buildWindowsMenuModel(state, configResult.value);
    expect(menu.map(({ label }) => label)).toEqual(["File", "Document", "Tabs", "Navigate", "Search", "View", "Panes", "Settings"]);
    const ids = menu.flatMap(({ commands }) => commands.map(({ id }) => id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("palette.open");
    expect(ids).not.toContain("prompt.commit");
  });
  it("preserves exact no-document disabled reasons", () => {
    const menu = buildWindowsMenuModel(state, configResult.value);
    const print = menu.flatMap(({ commands }) => commands).find(({ id }) => id === "document.print");
    expect(print).toMatchObject({ enabled: false, disabledReason: "No document open" });
  });
});
