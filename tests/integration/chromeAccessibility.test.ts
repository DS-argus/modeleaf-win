// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  AccessibilityController, focusRestoreTarget,
  readerAccessibilityName,
  tabAccessibilitySemantics,
  visualPageAccessibilityName,
} from "../../src/ui/AccessibilityController";
import { THEME_PICKER_ROWS, commitThemePicker, openThemePicker, previewThemePickerRow, revertThemePicker } from "../../src/ui/ThemePickerModel";


describe("CP5 theme accessibility contract", () => {
  it("keeps all six theme choices keyboard-addressable and makes preview reversible", () => {
    const opened = openThemePicker("tokyo-night", 4);
    const preview = previewThemePickerRow(opened, 5);
    expect(THEME_PICKER_ROWS).toHaveLength(6);
    expect(preview.effect).toEqual({ kind: "preview", themeId: "catppuccin-latte" });
    expect(commitThemePicker(preview.model).intent).toEqual({ kind: "commit", themeId: "catppuccin-latte", baseRevision: 4 });
    expect(revertThemePicker(preview.model).effect).toEqual({ kind: "revert", themeId: "tokyo-night" });
  });

  it("uses atomic polite and assertive live regions without document data", () => {
    const polite = document.createElement("div");
    const assertive = document.createElement("div");
    const controller = new AccessibilityController({ target: { polite, assertive } });
    controller.announce({ kind: "theme", themeId: "dracula" });
    controller.announce({ kind: "error", error: "theme-save-failed" });
    expect([polite.getAttribute("aria-live"), polite.getAttribute("aria-atomic"), polite.textContent]).toEqual([
      "polite", "true", "Theme changed to Dracula.",
    ]);
    expect([assertive.getAttribute("aria-live"), assertive.getAttribute("aria-atomic"), assertive.textContent]).toEqual([
      "assertive", "true", "The theme could not be saved.",
    ]);
  });
});
function focusableNames(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), [tabindex='0']",
  ))
    .filter((element) => element.tabIndex >= 0)
    .map((element) => element.getAttribute("aria-label") ?? element.textContent ?? "");
}

function chromeHarness(): HTMLElement {
  const app = document.createElement("section");
  app.setAttribute("role", "application");
  app.setAttribute("aria-label", "Modeleaf");

  const tabList = document.createElement("div");
  tabList.setAttribute("role", "tablist");
  tabList.setAttribute("aria-label", "Open documents");
  for (const input of [
    { basename: "Guide.pdf", ordinal: 1, total: 2, active: true },
    { basename: "Notes.pdf", ordinal: 2, total: 2, active: false },
  ] as const) {
    const tab = document.createElement("button");
    const semantics = tabAccessibilitySemantics(input);
    tab.setAttribute("role", semantics.role);
    tab.setAttribute("aria-label", semantics.ariaLabel);
    tab.setAttribute("aria-selected", semantics.ariaSelected);
    tab.setAttribute("aria-setsize", String(semantics.ariaSetSize));
    tab.setAttribute("aria-posinset", String(semantics.ariaPosInSet));
    tab.tabIndex = semantics.tabIndex;
    tabList.append(tab);
  }

  const reader = document.createElement("main");
  reader.tabIndex = 0;
  reader.setAttribute("aria-label", readerAccessibilityName("Guide.pdf", 12));
  const page = document.createElement("canvas");
  page.setAttribute("role", "img");
  page.setAttribute("aria-label", visualPageAccessibilityName(3, 12));
  page.tabIndex = -1;
  reader.append(page);

  const status = document.createElement("footer");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.tabIndex = -1;

  app.append(tabList, reader, status);
  return app;
}

describe("chrome accessibility contract", () => {
  it("defines application, tab, reader, visual-page, and status semantics", () => {
    const app = chromeHarness();
    const tabs = app.querySelectorAll<HTMLElement>("[role='tab']");

    expect(app.getAttribute("role")).toBe("application");
    expect(app.getAttribute("aria-label")).toBe("Modeleaf");
    expect(app.querySelector("[role='tablist']")?.getAttribute("aria-label")).toBe("Open documents");
    expect(Array.from(tabs).map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Guide.pdf, tab 1 of 2",
      "Notes.pdf, tab 2 of 2",
    ]);
    expect(Array.from(tabs).map((tab) => tab.tabIndex)).toEqual([0, -1]);
    expect(Array.from(tabs).map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(app.querySelector("main")?.getAttribute("aria-label")).toBe("Guide.pdf reader, 12 pages");
    expect(app.querySelector("canvas")?.getAttribute("aria-label")).toBe("PDF page 3 of 12");
    expect(app.querySelector<HTMLElement>("[role='status']")?.tabIndex).toBe(-1);
  });

  it("defines normal and modal focus order plus deterministic overlay restoration", () => {
    const app = chromeHarness();
    document.body.append(app);
    const reader = app.querySelector<HTMLElement>("main")!;
    const activeTab = app.querySelector<HTMLElement>("[role='tab'][aria-selected='true']")!;
    const overlay = document.createElement("dialog");
    overlay.setAttribute("aria-modal", "true");
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Password");
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    const open = document.createElement("button");
    open.textContent = "Open";
    overlay.append(input, cancel, open);
    app.append(overlay);

    expect(focusableNames(app).slice(0, 3)).toEqual([
      "Guide.pdf, tab 1 of 2",
      "Guide.pdf reader, 12 pages",
      "Password",
    ]);
    expect(focusableNames(overlay)).toEqual(["Password", "Cancel", "Open"]);
    expect(focusRestoreTarget(cancel, activeTab, reader)).toBe(cancel);
    cancel.remove();
    expect(focusRestoreTarget(cancel, activeTab, reader)).toBe(activeTab);
  });
});
