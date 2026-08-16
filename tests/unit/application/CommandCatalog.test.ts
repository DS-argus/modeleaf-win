import { describe, expect, it } from "vitest";
import { ACTION_DESCRIPTORS, type ActionRuntimeContext } from "../../../src/domain/actions/ActionRegistry";
import { validateProductConfig } from "../../../src/domain/config/ConfigValidator";
import { projectHelpCommands, projectMenuCommands, projectPaletteCommands } from "../../../src/application/commands/CommandCatalog";

const configResult = validateProductConfig({});
if (!configResult.ok) throw new Error("built-in config invalid");
const config = configResult.value;
const state = (overrides: Partial<ActionRuntimeContext> = {}): ActionRuntimeContext => ({
  hasDocument: true, canOpenDocument: true, canCreateSession: true, canCreateWindow: true,
  tabCount: 2, paneCount: 1, modalOpen: false, updateAvailable: false, configExists: false,
  searchActive: false, canHistoryBack: false, canHistoryForward: false, linkCount: 0, ...overrides,
});

describe("CommandCatalog", () => {
  it("projects palette and help in authoritative registry order", () => {
    const expected = ACTION_DESCRIPTORS.filter(({ bindingConfiguration }) => bindingConfiguration === "configurable").map(({ id }) => id);
    expect(projectPaletteCommands(state(), config).map(({ id }) => id)).toEqual(expected);
    expect(projectHelpCommands(state(), config).map(({ id }) => id)).toEqual(expected);
  });
  it("uses exact runtime disabled reasons with no document", () => {
    const rows = projectPaletteCommands(state({ hasDocument: false, tabCount: 1 }), config);
    expect(rows.find(({ id }) => id === "document.open")).toMatchObject({ enabled: true });
    expect(rows.find(({ id }) => id === "document.print")).toMatchObject({ enabled: false, disabledReason: "No document open" });
    expect(rows.find(({ id }) => id === "app.new")).toMatchObject({ enabled: true });
    expect(rows.find(({ id }) => id === "tab.next")).toMatchObject({ enabled: false, disabledReason: "No document open" });
  });
  it("shares metadata and shortcuts across menu palette and help", () => {
    const projections = [projectMenuCommands(state(), config), projectPaletteCommands(state(), config), projectHelpCommands(state(), config)];
    const openRows = projections.map((rows) => rows.find(({ id }) => id === "document.open"));
    expect(openRows).toEqual([openRows[0], openRows[0], openRows[0]]);
    expect(openRows[0]?.shortcuts).toEqual(["Ctrl+O"]);
  });
  it("preserves modal, capacity, config and update reasons", () => {
    const modal = projectPaletteCommands(state({ modalOpen: true }), config);
    expect(modal.find(({ id }) => id === "document.open")?.disabledReason).toBe("Close the current dialog");
    const bounded = projectPaletteCommands(state({ canOpenDocument: false, canCreateSession: false, configExists: true }), config);
    expect(bounded.find(({ id }) => id === "document.open")?.disabledReason).toBe("Document capacity unavailable");
    expect(bounded.find(({ id }) => id === "config.writeDefault")?.disabledReason).toBe("Config already exists");
    expect(bounded.find(({ id }) => id === "update.show")?.disabledReason).toBe("No update available");
  });
  it("marks future-workstream actions non-executable with an exact reason", () => {
    const rows = projectPaletteCommands(state({ implementedActionIds: new Set(["document.open"] as const) }), config);
    expect(rows.find(({ id }) => id === "document.open")).toMatchObject({ enabled: true });
    expect(rows.find(({ id }) => id === "pane.splitRight")).toMatchObject({ enabled: false, disabledReason: "Not available in this workstream" });
  });
});
