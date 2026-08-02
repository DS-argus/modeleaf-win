import { describe, expect, it } from "vitest";
import { DEFAULT_BINDINGS } from "../../../src/core/defaultBindings.windows";
import { buildHelpRows } from "../../../src/ui/HelpModel";

describe("HelpModel", () => {
  it("derives every help row from the binding registry", () => {
    const rows = buildHelpRows();
    const visibleBindings = DEFAULT_BINDINGS.filter((binding) => binding.showInHelp);
    expect(rows).toHaveLength(visibleBindings.length);
    expect(rows.map((row) => row.id)).toEqual(visibleBindings.map((binding) => binding.id));
    expect(rows).toContainEqual({
      id: "page.first",
      shortcut: "g g",
      label: "First page",
    });
    expect(rows).toEqual(expect.arrayContaining([
      { id: "search.open", shortcut: "/", label: "Search text" },
      { id: "linkHints.toggle", shortcut: "f", label: "Open link hint" },
    ]));
    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining([
      "prompt.commit",
      "prompt.cancel",
      "prompt.backspace",
    ]));
  });
});
