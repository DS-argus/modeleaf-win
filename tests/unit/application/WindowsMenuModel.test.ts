import { describe, expect, it } from "vitest";
import { projectHelpCommands, projectMenuCommands, projectPaletteCommands } from "../../../src/application/commands/CommandCatalog";
import { buildWindowsMenuModel } from "../../../src/application/commands/WindowsMenuModel";
import { validateProductConfig } from "../../../src/domain/config/ConfigValidator";
import type { ActionRuntimeContext } from "../../../src/domain/actions/ActionRegistry";

const configResult = validateProductConfig({});
if (!configResult.ok) throw new Error("built-in config invalid");
const config = configResult.value;
const state = (overrides: Partial<ActionRuntimeContext> = {}): ActionRuntimeContext => ({
  hasDocument: false, canOpenDocument: true, canCreateSession: true, canCreateWindow: true,
  tabCount: 1, modalOpen: false, updateAvailable: false, configExists: false,
  searchActive: false, canHistoryBack: false, canHistoryForward: false, ...overrides,
});

const navigationIds = [
  "scroll.left", "scroll.down", "scroll.up", "scroll.right", "scroll.largeDown", "scroll.largeUp",
  "page.next", "page.previous", "page.first", "page.last", "page.prompt",
];
const settingsIds = ["theme.picker"];

describe("WindowsMenuModel", () => {
  it("applies the menu-only exclusions without changing the retained groups", () => {
    const projected = projectMenuCommands(state(), config);
    const menu = buildWindowsMenuModel(state(), config);

    expect(menu.map(({ label }) => label)).toEqual(["File", "Document", "Tabs", "Search", "View", "Settings"]);
    expect(menu.find(({ id }) => id === "settings")?.commands.map(({ id }) => id)).toEqual(["theme.picker"]);
    for (const section of menu) {
      const expected = projected.filter((command) =>
        command.category === section.id && (section.id !== "settings" || command.id === "theme.picker"));
      expect(section.commands).toEqual(expected);
    }

    const ids = menu.flatMap(({ commands }) => commands.map(({ id }) => id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("palette.open");
    expect(ids).not.toContain("prompt.commit");
  });

  it("keeps page navigation and theme entries on the shared projections", () => {
    for (const commands of [
      projectMenuCommands(state(), config),
      projectPaletteCommands(state(), config),
      projectHelpCommands(state(), config),
    ]) {
      expect(commands.filter(({ category }) => category === "navigation").map(({ id }) => id)).toEqual(navigationIds);
      expect(commands.filter(({ category }) => category === "settings").map(({ id }) => id)).toEqual(settingsIds);
    }
  });

  it("keeps empty-window globals available and document commands disabled with their exact reason", () => {
    const commands = buildWindowsMenuModel(state(), config).flatMap(({ commands }) => commands);
    const globalIds = new Set(["document.open", "app.new", "app.quit", "help.show", "theme.picker"]);

    for (const id of globalIds) {
      expect(commands.find((command) => command.id === id)).toMatchObject({ enabled: true });
    }
    const documentCommands = commands.filter(({ id }) => !globalIds.has(id));
    expect(documentCommands.length).toBeGreaterThan(0);
    for (const command of documentCommands) {
      expect(command).toMatchObject({ enabled: false, disabledReason: "No document open" });
    }
  });

  it("enables retained document commands when their runtime requirements are met", () => {
    const commands = buildWindowsMenuModel(state({
      hasDocument: true,
      tabCount: 9,
      searchActive: true,
      canHistoryBack: true,
      canHistoryForward: true,
    }), config).flatMap(({ commands }) => commands);

    expect(commands.filter(({ enabled }) => !enabled)).toEqual([]);
  });
});
