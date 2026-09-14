import { describe, expect, it } from "vitest";
import { ACTION_DESCRIPTORS, getActionRuntimeAvailability, type ActionRuntimeContext } from "../../../src/domain/actions/ActionRegistry";
import { BUILT_IN_CONFIG } from "../../../src/domain/config/ConfigValidator";
import { buildHelpRows } from "../../../src/ui/HelpModel";

const unavailableContext: ActionRuntimeContext = {
  hasDocument: false, canCreateSession: false, canOpenDocument: false, canCreateWindow: false,
  tabCount: 1, modalOpen: true, updateAvailable: false, configExists: false,
  searchActive: false, canHistoryBack: false, canHistoryForward: false,
};

describe("HelpModel", () => {
  it("projects the retained 49-action registry and groups its nine tab selection actions", () => {
    const rows = buildHelpRows();
    const selectionRows = rows.filter(({ label }) => label === "Select Tab 1–9");
    const visible = ACTION_DESCRIPTORS.filter(({ bindingConfiguration, id }) => bindingConfiguration === "configurable" && !/^(config|history|update)\./u.test(id));
    const rowIds: readonly string[] = rows.map(({ id }) => id);

    expect(ACTION_DESCRIPTORS).toHaveLength(49);
    expect(visible).toHaveLength(39);
    expect(selectionRows).toEqual([expect.objectContaining({ id: "tab.select.1", category: "Tabs", shortcut: "Ctrl+1 … Ctrl+9", enabled: true })]);
    expect(rows).toHaveLength(31);
    expect(rowIds).toEqual(visible.map(({ id }) => id).filter((id) => !/^tab\.select\.[2-9]$/u.test(id)));
    for (const retiredId of ["toc.toggle", "toc.scrollDown", "toc.scrollUp", "link.hint", "indicator.picker"]) expect(rowIds).not.toContain(retiredId);
    expect(rows).not.toContainEqual(expect.objectContaining({ id: "indicator.picker", enabled: true }));
    expect(rows).toContainEqual(expect.objectContaining({ category: "Pages", id: "page.first", shortcut: "g g", label: "First Page", enabled: true }));
  });
  it("spells uppercase bindings as explicit Shift shortcuts", () => {
    const rows = buildHelpRows();
    expect(rows.find(({ id }) => id === "page.last")?.shortcut).toBe("Shift+g");
    expect(rows.find(({ id }) => id === "theme.picker")?.shortcut).toBe("Shift+t");
    expect(rows.find(({ id }) => id === "page.next")?.shortcut).toBe("n");
  });
  it("keeps self-modal rows truthful without repeating the dialog reason", () => {
    const rows = buildHelpRows(unavailableContext, BUILT_IN_CONFIG, { modalOwner: "help" });
    expect(rows.find(({ id }) => id === "app.new")).toMatchObject({ enabled: false, disabledReason: "Window capacity unavailable" });
    expect(rows.find(({ label }) => label === "Select Tab 1–9")).toMatchObject({ enabled: false, disabledReason: "No document open" });
    expect(rows.find(({ id }) => id === "app.quit")).toMatchObject({ enabled: true });
  });
  it("derives grouped availability from all nine tab selection projections", () => {
    const rows = buildHelpRows({ ...unavailableContext, modalOpen: false });
    expect(rows.find(({ label }) => label === "Select Tab 1–9")).toMatchObject({ enabled: false, disabledReason: "No document open" });
    expect(getActionRuntimeAvailability("tab.select.1", { ...unavailableContext, modalOpen: false })).toMatchObject({ enabled: false, reason: "No document open" });
  });
});
