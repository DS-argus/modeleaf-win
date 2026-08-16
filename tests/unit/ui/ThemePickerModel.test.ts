import { describe, expect, it } from "vitest";
import {
  CLOSED_THEME_PICKER,
  THEME_PICKER_ROWS,
  commitThemePicker,
  openThemePicker,
  previewThemePickerRow,
  revertThemePicker,
  revertThemePickerToDurable,
} from "../../../src/ui/ThemePickerModel";

describe("ThemePickerModel", () => {
  it("has exactly six unique rows in the frozen built-in order", () => {
    expect(THEME_PICKER_ROWS.map((row) => row.id)).toMatchInlineSnapshot(`
      [
        "tokyo-night",
        "gruvbox-dark",
        "solarized-dark",
        "dracula",
        "everforest",
        "catppuccin-latte",
      ]
    `);
    expect(THEME_PICKER_ROWS.map((row) => row.displayName)).toEqual([
      "Tokyo Night", "Gruvbox Dark", "Solarized Dark", "Dracula", "Everforest", "Catppuccin Latte",
    ]);
    expect(new Set(THEME_PICKER_ROWS.map((row) => row.id)).size).toBe(6);
    expect(Object.isFrozen(THEME_PICKER_ROWS)).toBe(true);
  });

  it("snapshots durable id and revision when opening", () => {
    expect(openThemePicker("tokyo-night", 17)).toEqual({
      status: "open",
      activeIndex: 0,
      transaction: { baselineId: "tokyo-night", baselineRevision: 17, previewId: "tokyo-night" },
    });
    expect(openThemePicker("dracula", 18).activeIndex).toBe(3);
  });

  it("previews a bounded row without emitting a durable-write intent", () => {
    const opened = openThemePicker("tokyo-night", 17);
    const preview = previewThemePickerRow(opened, 3);

    expect(preview).toEqual({
      model: {
        status: "open",
        activeIndex: 3,
        transaction: { baselineId: "tokyo-night", baselineRevision: 17, previewId: "dracula" },
      },
      effect: { kind: "preview", themeId: "dracula" },
    });
    expect(preview).not.toHaveProperty("intent");
    expect(opened.transaction.previewId).toBe("tokyo-night");
  });

  it("emits one revision-checked commit intent on Enter and closes the transaction", () => {
    const preview = previewThemePickerRow(openThemePicker("tokyo-night", 17), 3);
    const commit = commitThemePicker(preview.model);

    expect(commit).toEqual({
      model: CLOSED_THEME_PICKER,
      intent: { kind: "commit", themeId: "dracula", baseRevision: 17 },
    });
  });

  it("reverts the opening baseline on Escape or overlay replacement", () => {
    const preview = previewThemePickerRow(openThemePicker("tokyo-night", 17), 3);

    expect(revertThemePicker(preview.model)).toEqual({
      model: CLOSED_THEME_PICKER,
      effect: { kind: "revert", themeId: "tokyo-night" },
    });
  });

  it("reverts a stale or failed commit to the authoritative durable theme", () => {
    const preview = previewThemePickerRow(openThemePicker("tokyo-night", 17), 3);

    expect(revertThemePickerToDurable(preview.model, "everforest", 18)).toEqual({
      model: CLOSED_THEME_PICKER,
      effect: { kind: "revert", themeId: "everforest" },
    });
  });

  it("rejects unknown IDs, invalid revisions, and out-of-range row indices", () => {
    expect(() => openThemePicker("not-a-theme", 0)).toThrow(RangeError);
    expect(() => openThemePicker("dracula", -1)).toThrow(RangeError);
    expect(() => previewThemePickerRow(openThemePicker("dracula", 0), -1)).toThrow(RangeError);
    expect(() => previewThemePickerRow(openThemePicker("dracula", 0), THEME_PICKER_ROWS.length)).toThrow(RangeError);
    expect(() => revertThemePickerToDurable(openThemePicker("dracula", 0), "not-a-theme", 0)).toThrow(RangeError);
  });
});
