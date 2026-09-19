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
  it("projects the retained 43-action registry with only previous and next tab actions", () => {
    const rows = buildHelpRows();
    const visible = ACTION_DESCRIPTORS.filter(({ bindingConfiguration, id }) => bindingConfiguration === "configurable" && !/^(config|history|update)\./u.test(id));
    const rowIds: readonly string[] = rows.map(({ id }) => id);

    expect(ACTION_DESCRIPTORS).toHaveLength(43);
    expect(visible).toHaveLength(33);
    expect(rows).toHaveLength(33);
    expect(rowIds).toEqual(visible.map(({ id }) => id));
    expect(rows).toContainEqual(expect.objectContaining({ id: "tab.previous", category: "Tabs", shortcut: "Shift+p", enabled: false }));
    expect(rows).toContainEqual(expect.objectContaining({ id: "tab.next", category: "Tabs", shortcut: "Shift+n", enabled: false }));
    expect(rowIds.some((id) => id.startsWith("tab.select."))).toBe(false);
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
    expect(rows.find(({ id }) => id === "tab.next")).toMatchObject({ enabled: false, disabledReason: "No document open" });
    expect(rows.find(({ id }) => id === "app.quit")).toMatchObject({ enabled: true });
  });
  it("keeps previous and next availability truthful for one and multiple tabs", () => {
    const single = { ...unavailableContext, hasDocument: true, modalOpen: false, tabCount: 1 };
    const multiple = { ...single, tabCount: 2 };
    for (const id of ["tab.previous", "tab.next"] as const) {
      expect(getActionRuntimeAvailability(id, single)).toMatchObject({ enabled: false, reason: "Only one tab open" });
      expect(getActionRuntimeAvailability(id, multiple)).toEqual({ enabled: true });
    }
  });
});
