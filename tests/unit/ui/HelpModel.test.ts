import { describe, expect, it } from "vitest";
import {
  DEFAULT_BINDINGS,
  isCommandEnabled,
  type CommandAvailabilityContext,
} from "../../../src/core/defaultBindings.windows";
import { buildHelpRows } from "../../../src/ui/HelpModel";

const unavailableContext: CommandAvailabilityContext = {
  hasDocument: false,
  canCreateSession: false,
  canOpenDocument: false,
  modalOpen: true,
};

describe("HelpModel", () => {
  it("derives every help row from the canonical registry", () => {
    const rows = buildHelpRows();
    const visibleBindings = DEFAULT_BINDINGS.filter((binding) => binding.showInHelp);
    expect(rows).toHaveLength(visibleBindings.length);
    expect(rows.map((row) => row.id)).toEqual(visibleBindings.map((binding) => binding.id));
    expect(rows).toContainEqual({
      category: "Pages",
      id: "page.first",
      shortcut: "g g",
      label: "First page",
      enabled: true,
    });
  });

  it("spells uppercase bindings as explicit Shift shortcuts", () => {
    const rows = buildHelpRows();
    expect(rows.find((row) => row.id === "page.last")?.shortcut).toBe("Shift+G");
    expect(rows.find((row) => row.id === "theme.open")?.shortcut).toBe("Shift+T");
    expect(rows.find((row) => row.id === "page.next")?.shortcut).toBe("n");
  });

  it("uses keyboard dispatch availability for every help row", () => {
    const rows = buildHelpRows(unavailableContext);
    const visibleBindings = DEFAULT_BINDINGS.filter((binding) => binding.showInHelp);

    expect(rows.map((row) => row.enabled)).toEqual(
      visibleBindings.map((binding) => isCommandEnabled(binding, unavailableContext)),
    );
    expect(rows.find((row) => row.id === "tab.new")?.enabled).toBe(false);
    expect(rows.find((row) => row.id === "document.open")?.enabled).toBe(false);
  });
});
