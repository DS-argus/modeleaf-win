// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AccessibilityController, focusRestoreTarget,
  readerAccessibilityName,
  tabAccessibilitySemantics,
  visualPageAccessibilityName,
} from "../../src/ui/AccessibilityController";
import { bindSearchPrompt } from "../../src/ui/SearchPromptController";
import { THEME_PICKER_ROWS, commitThemePicker, openThemePicker, previewThemePickerRow, revertThemePicker, themePickerDialogKeyAction } from "../../src/ui/ThemePickerModel";

const mainSource = readFileSync(join(process.cwd(), "src/main.ts"), "utf8");
const styles = readFileSync(join(process.cwd(), "src/styles/app.css"), "utf8");

describe("CP5 theme accessibility contract", () => {
  it("keeps all seven theme choices keyboard-addressable and makes preview reversible", () => {
    const opened = openThemePicker("tokyo-night", 4);
    const preview = previewThemePickerRow(opened, 6);
    expect(THEME_PICKER_ROWS).toHaveLength(7);
    expect(preview.effect).toEqual({ kind: "preview", themeId: "catppuccin-latte" });
    expect(commitThemePicker(preview.model).intent).toEqual({ kind: "commit", themeId: "catppuccin-latte", baseRevision: 4 });
    expect(revertThemePicker(preview.model).effect).toEqual({ kind: "revert", themeId: "tokyo-night" });
  });

  it("handles arrows, bare and Ctrl+J/K, Enter, and Escape from focused dialog controls", () => {
    const dialog = document.createElement("dialog");
    const option = document.createElement("button");
    const apply = document.createElement("button");
    dialog.append(option, apply);
    const actions: string[] = [];
    dialog.addEventListener("keydown", (event) => {
      const action = themePickerDialogKeyAction(event);
      if (action) actions.push(action);
    });
    const press = (target: HTMLElement, key: string, ctrlKey = false, repeat = false): void => {
      const event = new KeyboardEvent("keydown", { key, ctrlKey, repeat, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    };
    press(option, "j", true);
    press(apply, "k", true);
    press(option, "j");
    press(apply, "k");
    press(option, "j", false, true);
    press(apply, "k", false, true);
    press(option, "ArrowDown");
    press(option, "ArrowRight");
    press(apply, "ArrowUp");
    press(apply, "ArrowLeft");
    press(apply, "Enter");
    press(option, "Escape");
    expect(actions).toEqual(["next", "previous", "next", "previous", "next", "previous", "next", "next", "previous", "previous", "commit", "revert"]);
  });

  it("ignores composing and modified theme navigation keys", () => {
    const ignored = [
      new KeyboardEvent("keydown", { key: "j", isComposing: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "j", altKey: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "j", metaKey: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "j", shiftKey: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "x", ctrlKey: true, cancelable: true }),
    ];
    for (const event of ignored) {
      expect(themePickerDialogKeyAction(event)).toBeUndefined();
      expect(event.defaultPrevented).toBe(false);
    }
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
  it("keeps regular tabs equal-sized and accessible while narrow strips scroll", () => {
    const projection = mainSource.slice(
      mainSource.indexOf("tabStrip.replaceChildren"),
      mainSource.indexOf("function cancelPagePromptOwnership"),
    );
    expect(projection).toContain('button.setAttribute("aria-label", semantics.ariaLabel)');
    expect(projection).toContain("button.title = tab.payload.session.snapshot.title");
    expect(projection).toContain('close.setAttribute("aria-label", "Close tab")');
    expect(styles).toContain(".tab-strip { display: flex; flex-wrap: nowrap; min-width: 0; min-height: 34px;");
    expect(styles).toContain("overflow-x: auto; overflow-y: hidden;");
    expect(styles).toContain(".workspace-tab-item { display: flex; flex: 0 0 184px; width: 184px; min-width: 184px; height: 26px; }");
    expect(styles).toContain(".workspace-tab { flex: 1 1 auto; min-width: 0;");
    expect(styles).toContain("overflow: hidden; text-overflow: ellipsis; white-space: nowrap;");
    expect(styles).toContain(".workspace-tab-close { flex: 0 0 auto;");
    expect(styles).not.toContain(".workspace-tab { max-width: 220px");
    expect(styles).toContain(".workspace-tab:focus-visible, .workspace-tab-close:focus-visible { outline: 2px solid var(--theme-accent); outline-offset: -2px; }");
    expect(styles).toContain(".workspace-tab:focus-visible, .workspace-tab-close:focus-visible, .theme-option:focus-visible, #theme-button:focus-visible { outline-color: var(--theme-focus-indicator); }");
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain(".theme-option, .workspace-tab, .workspace-tab-close, #theme-button { forced-color-adjust: auto; border: 1px solid CanvasText; }");
    expect(styles).toContain(".workspace-tab:focus-visible, .workspace-tab-close:focus-visible, .theme-option:focus-visible, #theme-button:focus-visible { outline: 3px solid Highlight; outline-offset: 2px; }");
  });
});
describe("search prompt production binding", () => {
  it("keeps the search prompt semantic and compact above the status bar", () => {
    expect(mainSource).toContain('<dialog id="search-dialog" class="search-prompt" aria-labelledby="search-title">');
    expect(mainSource).toContain('<form id="search-form" autocomplete="off">');
    expect(mainSource).toContain('<label id="search-title" class="visually-hidden" for="search-input">Search PDF text</label>');
    expect(mainSource).toContain('<input id="search-input" type="search"');
    expect(mainSource).toContain('<span class="search-prefix" aria-hidden="true">/</span>');
    expect(styles).toContain("inset: auto auto 44px 50%");
    expect(styles).toContain("width: min(480px, calc(100vw - 32px))");
    expect(styles).toContain("#search-dialog::backdrop { background: transparent; }");
    expect(styles).toContain("overflow-wrap: anywhere;");
    expect(styles).toContain("@media (max-width: 480px)");
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain("#search-dialog { color: CanvasText");
    expect(styles).toContain("white-space: normal;");
  });
  it("centers search line boxes without offsets and preserves the narrow footer row", () => {
    const formRule = styles.match(/#search-dialog form \{([^}]+)\}/)?.[1];
    expect(formRule).toContain("align-items: center;");
    expect(formRule).toContain("grid-template-columns: auto minmax(0, 1fr) auto;");
    const narrowRules = styles.slice(styles.indexOf("@media (max-width: 480px)"), styles.indexOf("@media (forced-colors: active)"));
    expect(narrowRules).toContain("grid-template-columns: auto minmax(0, 1fr);");
    expect(narrowRules).toContain(".search-footer { grid-column: 1 / -1;");
    const searchRules = styles.slice(styles.indexOf("#search-dialog {"), styles.indexOf(".mac-overlay {"));
    expect(searchRules).not.toMatch(/translateY|\btop:|margin-top:|appearance:/);
    expect(mainSource).not.toContain('class="search-prompt mac-overlay"');
  });
  it("uses system colors for search key labels and opaque overlay panels in forced colors", () => {
    const forcedRules = styles.slice(styles.indexOf("@media (forced-colors: active)"), styles.indexOf("@media (min-resolution:"));
    expect(forcedRules).toContain(".search-footer, .search-footer kbd { color: CanvasText; }");
    expect(forcedRules).toContain(".mac-overlay { color: CanvasText; background: Canvas;");
    expect(forcedRules).toContain("#search-dialog input:focus-visible { outline: 2px solid Highlight;");
  });
  it("cancels the prompt on Escape without clearing active search or moving the reader", () => {
    const dialog = document.createElement("dialog");
    const form = document.createElement("form");
    const input = document.createElement("input");
    form.append(input);
    dialog.append(form);
    document.body.append(dialog);
    const startSearch = vi.fn(() => ({ kind: "search" as const }));
    const render = vi.fn();
    const close = vi.fn(() => dialog.removeAttribute("open"));
    const dispose = bindSearchPrompt(
      { dialog, form, input },
      () => ({ startSearch }),
      close,
      render,
    );

    dialog.setAttribute("open", "");
    input.value = "retained query";
    input.focus();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(startSearch).not.toHaveBeenCalled();
    expect(input.value).toBe("retained query");
    expect(dialog.open).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();

    dispose();
  });
});
