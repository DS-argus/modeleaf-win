import { describe, expect, it } from "vitest";
import { ACTION_DESCRIPTORS, getActionRuntimeAvailability, type ActionRuntimeContext } from "../../../src/domain/actions/ActionRegistry";
import { buildHelpRows } from "../../../src/ui/HelpModel";

const unavailableContext: ActionRuntimeContext = {
  hasDocument: false, canCreateSession: false, canOpenDocument: false, canCreateWindow: false,
  tabCount: 1, modalOpen: true, updateAvailable: false, configExists: false,
  searchActive: false, canHistoryBack: false, canHistoryForward: false, linkCount: 0,
};

describe("HelpModel", () => {
  it("derives every help row from the authoritative registry", () => {
    const rows = buildHelpRows();
    const visible = ACTION_DESCRIPTORS.filter(({ bindingConfiguration }) => bindingConfiguration === "configurable");
    expect(rows.map(({ id }) => id)).toEqual(visible.map(({ id }) => id));
    expect(rows).toContainEqual(expect.objectContaining({ category: "Pages", id: "page.first", shortcut: "g g", label: "First Page", enabled: true }));
  });
  it("spells uppercase bindings as explicit Shift shortcuts", () => {
    const rows = buildHelpRows();
    expect(rows.find(({ id }) => id === "page.last")?.shortcut).toBe("Shift+G");
    expect(rows.find(({ id }) => id === "theme.picker")?.shortcut).toBe("Shift+T");
    expect(rows.find(({ id }) => id === "page.next")?.shortcut).toBe("n");
  });
  it("uses exact registry availability and reasons", () => {
    const rows = buildHelpRows(unavailableContext);
    for (const row of rows) expect(row.enabled).toBe(getActionRuntimeAvailability(row.id, unavailableContext).enabled);
    expect(rows.find(({ id }) => id === "app.new")).toMatchObject({ enabled: false, disabledReason: "Close the current dialog" });
    expect(rows.find(({ id }) => id === "document.open")).toMatchObject({ enabled: false, disabledReason: "Close the current dialog" });
    expect(rows.find(({ id }) => id === "app.quit")).toMatchObject({ enabled: true });
  });
});
