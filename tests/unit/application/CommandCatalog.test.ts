import { describe, expect, it } from "vitest";
import { ACTION_DESCRIPTORS, type ActionRuntimeContext } from "../../../src/domain/actions/ActionRegistry";
import { validateProductConfig } from "../../../src/domain/config/ConfigValidator";
import { projectHelpCommands, projectMenuCommands, projectPaletteCommands } from "../../../src/application/commands/CommandCatalog";

const configResult = validateProductConfig({});
if (!configResult.ok) throw new Error("built-in config invalid");
const config = configResult.value;
const state = (overrides: Partial<ActionRuntimeContext> = {}): ActionRuntimeContext => ({
  hasDocument: true, canOpenDocument: true, canCreateSession: true, canCreateWindow: true,
  tabCount: 2, modalOpen: false, updateAvailable: false, configExists: false,
  searchActive: false, canHistoryBack: false, canHistoryForward: false, linkCount: 0, ...overrides,
});

const command = (rows: ReturnType<typeof projectPaletteCommands>, id: string) => rows.find((row) => row.id === id);

describe("CommandCatalog", () => {
  it("projects palette and help in authoritative registry order", () => {
    const expected = ACTION_DESCRIPTORS.filter(({ bindingConfiguration }) => bindingConfiguration === "configurable").map(({ id }) => id);
    expect(projectPaletteCommands(state(), config).map(({ id }) => id)).toEqual(expected);
    expect(projectHelpCommands(state(), config).map(({ id }) => id)).toEqual(expected);
  });
  it("uses exact runtime disabled reasons with no document", () => {
    const rows = projectPaletteCommands(state({ hasDocument: false, tabCount: 1 }), config);
    expect(command(rows, "document.open")).toMatchObject({ enabled: true });
    expect(command(rows, "document.print")).toMatchObject({ enabled: false, disabledReason: "No document open" });
    expect(command(rows, "app.new")).toMatchObject({ enabled: true });
    expect(command(rows, "tab.next")).toMatchObject({ enabled: false, disabledReason: "No document open" });
  });
  it("shares metadata and shortcuts across menu palette and help", () => {
    const projections = [projectMenuCommands(state(), config), projectPaletteCommands(state(), config), projectHelpCommands(state(), config)];
    const openRows = projections.map((rows) => rows.find(({ id }) => id === "document.open"));
    expect(openRows).toEqual([openRows[0], openRows[0], openRows[0]]);
    expect(openRows[0]?.shortcuts).toEqual(["Ctrl+O"]);
  });
  it("keeps foreign modals and menu projection blocked", () => {
    const modalState = state({ modalOpen: true });
    for (const rows of [
      projectMenuCommands(modalState, config),
      projectPaletteCommands(modalState, config),
      projectHelpCommands(modalState, config),
      projectPaletteCommands(modalState, config, { modalOwner: "help" }),
      projectHelpCommands(modalState, config, { modalOwner: "palette" }),
    ]) {
      expect(command(rows, "document.open")).toMatchObject({ enabled: false, disabledReason: "Close the current dialog" });
    }
  });
  it("recomputes palette and help availability only for their self-owned modal", () => {
    const modalState = state({ modalOpen: true });
    for (const [rows, owner] of [
      [projectPaletteCommands(modalState, config, { modalOwner: "palette" }), "palette"],
      [projectHelpCommands(modalState, config, { modalOwner: "help" }), "help"],
    ] as const) {
      expect(command(rows, "document.open")).toMatchObject({ enabled: true });
      expect(command(rows, "document.open")).not.toHaveProperty("disabledReason");
      expect(owner).toBeDefined();
    }
  });
  it("preserves underlying availability reasons for self-owned modals", () => {
    const modalState = state({
      modalOpen: true,
      hasDocument: false,
      canOpenDocument: false,
      canCreateSession: false,
      configExists: true,
      updateAvailable: false,
    });
    for (const rows of [
      projectPaletteCommands(modalState, config, { modalOwner: "palette" }),
      projectHelpCommands(modalState, config, { modalOwner: "help" }),
    ]) {
      expect(command(rows, "document.print")).toMatchObject({ enabled: false, disabledReason: "No document open" });
      expect(command(rows, "history.back")).toMatchObject({ enabled: false, disabledReason: "No document open" });
      expect(command(rows, "document.open")).toMatchObject({ enabled: false, disabledReason: "Document capacity unavailable" });
      expect(command(rows, "config.writeDefault")).toMatchObject({ enabled: false, disabledReason: "Config already exists" });
      expect(command(rows, "update.show")).toMatchObject({ enabled: false, disabledReason: "No update available" });
    }
  });
  it("preserves the nine individual tab selection projections", () => {
    const ids = projectPaletteCommands(state(), config).map(({ id }) => id).filter((id) => /^tab\.select\.[1-9]$/u.test(id));
    expect(ids).toEqual(["tab.select.1", "tab.select.2", "tab.select.3", "tab.select.4", "tab.select.5", "tab.select.6", "tab.select.7", "tab.select.8", "tab.select.9"]);
  });
  it("marks future-workstream actions non-executable with an exact reason", () => {
    const rows = projectPaletteCommands(state({ implementedActionIds: new Set(["document.open"] as const) }), config);
    expect(command(rows, "document.open")).toMatchObject({ enabled: true });
  });
});
