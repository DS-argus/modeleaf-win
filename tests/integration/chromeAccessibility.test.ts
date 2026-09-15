// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEMES } from "../../src/domain/theme/Theme";
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
    expect(projection).toContain('item.dataset.selected = String(selected)');
    expect(projection).toContain('button.setAttribute("aria-label", semantics.ariaLabel)');
    expect(projection).toContain("button.title = tab.payload.session.snapshot.title");
    expect(projection).toContain('close.setAttribute("aria-label", "Close tab")');
    expect(projection).toContain("event.stopPropagation(); closeTab(tab.id)");
    expect(styles).toContain(".tab-strip { display: flex; flex-wrap: nowrap; min-width: 0; min-height: 34px;");
    expect(styles).toContain("overflow-x: auto; overflow-y: hidden;");
    expect(styles).toContain(".workspace-tab-item { display: flex; align-items: center; box-sizing: border-box; flex: 0 0 184px; width: 184px; min-width: 184px; height: 26px; color: var(--theme-muted-text); background: var(--theme-active-tab); border: 1px solid transparent; }");
    expect(styles).toContain(".workspace-tab-item:hover { color: var(--theme-foreground); background: var(--theme-border); }");
    expect(styles).toContain('.workspace-tab-item[data-selected="true"] { color: var(--theme-foreground); border-color: color-mix(in srgb, var(--theme-accent) 72%, var(--theme-border)); font-weight: 650; }');
    expect(styles).toContain(".workspace-tab, .workspace-tab-close { border: 0; color: inherit; background: transparent; }");
    expect(styles).toContain(".workspace-tab { display: flex; align-items: center; align-self: stretch; flex: 1 1 auto; min-width: 0;");
    expect(styles).toContain("overflow: hidden; text-overflow: ellipsis; white-space: nowrap;");
    expect(styles).toContain(".workspace-tab-close { display: grid; place-items: center; align-self: stretch; flex: 0 0 auto;");
    expect(styles).toContain(".workspace-tab-item:hover .workspace-tab-close, .workspace-tab-close:focus-visible { opacity: 1; }");
    expect(styles).toContain("line-height: 1; opacity: 0.75;");
    expect(styles).not.toContain(".workspace-tab { max-width: 220px");
    expect(styles).toContain(".workspace-tab:focus-visible, .workspace-tab-close:focus-visible { outline: 2px solid var(--theme-accent); outline-offset: -2px; }");
    expect(styles).toContain(".workspace-tab:focus-visible, .workspace-tab-close:focus-visible, .theme-option:focus-visible, #theme-button:focus-visible { outline-color: var(--theme-focus-indicator); }");
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain('.workspace-tab-item:hover, .workspace-tab-item[data-selected="true"] { color: HighlightText; background: Highlight; }');
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
  it("limits transparency and contrast corrections to real overlay panels", () => {
    const panelRule = styles.match(/\.prompt, #search-dialog, \.mac-overlay \{([^}]+)\}/)?.[1];
    expect(panelRule).toContain("--overlay-panel-alpha: 85%;");
    expect(panelRule).toContain("--overlay-contrast: white;");
    expect(panelRule).toContain("--overlay-text: color-mix(in srgb, var(--theme-foreground) 40%, var(--overlay-contrast));");
    expect(panelRule).toContain("--overlay-muted: color-mix(in srgb, var(--theme-foreground) 70%, var(--overlay-contrast));");
    expect(panelRule).not.toMatch(/\bopacity:|\bfilter:/);
    expect(styles).toContain('[data-theme="catppuccin-latte"] :is(.prompt, #search-dialog, .mac-overlay) { --overlay-contrast: black; }');
    expect(styles).toContain("background: color-mix(in srgb, var(--theme-inactive-tab) var(--overlay-panel-alpha), transparent);");
    expect(styles).toContain("background: color-mix(in srgb, var(--theme-active-tab) var(--overlay-panel-alpha), transparent);");
    expect(styles).toContain("#search-dialog input::placeholder { color: var(--overlay-muted); opacity: 1; }");
    expect(styles).toContain(".list-overlay input::placeholder { color: var(--overlay-muted); opacity: 1; }");
    expect(styles).toContain("dialog::backdrop { background: rgb(7 8 14 / 44%); }");
    expect(styles).toContain("backdrop-filter: blur(18px) saturate(120%);");
  });
  it("separates themed footer descriptions from readable Windows key labels", () => {
    expect(styles).toContain("--overlay-secondary-accent: color-mix(in srgb, var(--theme-accent) 60%, var(--overlay-contrast));");
    for (const selector of [".search-footer", ".overlay-footer"]) {
      const rule = styles.slice(styles.indexOf(`${selector} {`)).split("}")[0];
      expect(rule).toContain("color: var(--overlay-secondary-accent);");
      expect(styles).toContain(`${selector} kbd { padding: 0; color: var(--overlay-text);`);
    }
    expect(mainSource).toContain("Ctrl+j/k</kbd> move");
    expect(mainSource).toContain("Ctrl+Shift+c</kbd> clear history");
  });
  it("gives help descriptions and palette shortcuts distinct themed roles without fading disabled rows", () => {
    expect(styles).toContain(".help-group dt { color: var(--overlay-secondary-accent); }");
    expect(styles).toContain(".help-group dd { margin: 0; color: var(--overlay-text);");
    expect(styles).toContain(".command-palette-entry-shortcut { color: var(--overlay-secondary-accent);");
    expect(styles).toContain('.command-palette-entry:is([aria-selected="true"], :hover, :focus-visible) .command-palette-entry-shortcut { color: var(--overlay-accent); }');
    expect(styles).toContain(".command-palette-entry-reason { grid-column: 1 / -1; color: var(--overlay-text);");
    expect(styles).not.toContain('.command-palette-entry[aria-disabled="true"] { opacity:');
    expect(styles).toContain("#command-palette-dialog[open] { display: flex; flex-direction: column; }");
    expect(styles).toContain("#command-palette-dialog form { display: flex; flex-direction: column; min-height: 0; }");
    expect(styles).toContain("#command-palette-dialog input { flex-shrink: 0; }");
    expect(styles).toContain(".command-palette-list { min-height: 0;");
    expect(styles).not.toContain("command-palette-section-title");
    const heading = styles.slice(styles.indexOf(".help-group h2 {")).split("}")[0];
    expect(heading).toContain("border-bottom: 1px solid");
    expect(heading).toContain("font-weight: 650;");
  });
  it("keeps composed overlay text above 4.5 and focus above 3 across all theme backing extremes", () => {
    const weight = (name: string): number => {
      const declaration = styles.match(new RegExp(`--overlay-${name}: ([^;]+);`))?.[1];
      const value = Number(declaration?.match(/(\d+)%/)?.[1]) / 100;
      expect(Number.isFinite(value)).toBe(true);
      return value;
    };
    const rgb = (hex: string): number[] => hex.slice(1).match(/../g)!.map((channel) => parseInt(channel, 16));
    const mix = (front: number[], back: number[], alpha: number): number[] => front.map((v, i) => v * alpha + back[i]! * (1 - alpha));
    const luminance = (color: number[]): number => color.reduce((sum, channel, i) => {
      const value = channel / 255;
      return sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]!;
    }, 0);
    const contrast = (a: number[], b: number[]): number => {
      const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (values[0]! + 0.05) / (values[1]! + 0.05);
    };
    for (const theme of THEMES) {
      const palette = theme.palette;
      const end = theme.id === "catppuccin-latte" ? [0, 0, 0] : [255, 255, 255];
      const text = mix(rgb(palette.foreground), end, weight("text"));
      const muted = mix(rgb(palette.foreground), end, weight("muted"));
      const accent = mix(rgb(palette.accent), end, weight("accent"));
      const focus = mix(rgb(palette["focus-indicator"]), end, weight("focus"));
      const footer = mix(rgb(palette.accent), end, weight("secondary-accent"));
      for (const back of [[0, 0, 0], [255, 255, 255]]) {
        const prompt = mix(rgb(palette["inactive-tab"]), back, weight("panel-alpha"));
        const panel = mix(rgb(palette["active-tab"]), mix([7, 8, 14], back, 0.44), weight("panel-alpha"));
        const selected = mix(rgb(palette.accent), panel, 0.28);
        const themeSelected = mix(rgb(palette.accent), panel, 0.18);
        const help = mix(rgb(palette["inactive-tab"]), panel, 0.62);
        for (const bg of [prompt, panel, help, rgb(palette["inactive-tab"])]) {
          expect(contrast(text, bg), `${theme.id} text`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(muted, bg), `${theme.id} muted/placeholder`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(focus, bg), `${theme.id} focus`).toBeGreaterThanOrEqual(3);
        }
        for (const bg of [prompt, panel]) {
          expect(contrast(footer, bg), `${theme.id} footer description`).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(footer, help), `${theme.id} help description`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(accent, mix(rgb(palette.accent), panel, 0.19)), `${theme.id} selected palette shortcut`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(text, selected), `${theme.id} selected row/shortcut`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(accent, themeSelected), `${theme.id} selected theme`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(accent, help), `${theme.id} help heading`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(focus, selected), `${theme.id} selected focus`).toBeGreaterThanOrEqual(3);
      }
    }
  });
  it("uses system colors for search key labels and opaque overlay panels in forced colors", () => {
    const forcedRules = styles.slice(styles.indexOf("@media (forced-colors: active)"), styles.indexOf("@media (min-resolution:"));
    expect(forcedRules).toContain(".search-footer, .search-footer kbd { color: CanvasText; }");
    expect(forcedRules).toContain(".mac-overlay { color: CanvasText; background: Canvas;");
    expect(forcedRules).toContain('.mac-overlay :is(.overlay-list-entry[aria-selected="true"], .theme-option[aria-checked="true"]) { color: HighlightText; background: Highlight; box-shadow: none; }');
    expect(forcedRules).toContain("--overlay-muted: CanvasText;");
    expect(forcedRules).toContain("--overlay-secondary-accent: CanvasText;");
    expect(forcedRules).toContain("--overlay-focus: Highlight;");
    expect(forcedRules).toContain('.command-palette-entry[aria-selected="true"] :is(.command-palette-entry-shortcut, .command-palette-entry-reason) { color: HighlightText; }');
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
