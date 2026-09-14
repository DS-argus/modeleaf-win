import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../src/styles/app.css", import.meta.url), "utf8");
const nativeMainSource = readFileSync(new URL("../../src-tauri/src/main.rs", import.meta.url), "utf8");
const tauriConfig = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { app: { windows: Array<{ additionalBrowserArgs?: string }> } };

describe("CP5 shell integration", () => {
  it("loads and commits native theme state with camelCase payloads", () => {
    expect(mainSource).toContain('invoke("read_theme_state")');
    expect(mainSource).toContain('invoke("commit_theme_state", { themeId: intent.themeId, baseRevision: intent.baseRevision })');
    expect(mainSource).toContain('revertThemePickerToDurable(picker, durableTheme.themeId, durableTheme.revision)');
    expect(mainSource).toContain('error: "theme-save-failed"');
  });
  it("routes quit through native admission, complete renderer cleanup, and native finish", () => {
    const quitHandler = mainSource.slice(mainSource.indexOf("function requestApplicationQuit"), mainSource.indexOf("function dispatch", mainSource.indexOf("function requestApplicationQuit")));
    expect(mainSource).toContain('type === "application.quit"');
    expect(quitHandler).toContain('invoke("begin_quit")');
    expect(quitHandler).toContain("Promise.allSettled");
    expect(quitHandler).toContain("payload.session.close()");
    expect(quitHandler).toContain("resources.assertEmpty()");
    expect(quitHandler).toContain('invoke("finish_quit", { rendererDrained })');
    expect(quitHandler.indexOf("payload.session.close()")).toBeLessThan(quitHandler.indexOf('invoke("finish_quit", { rendererDrained })'));
    expect(mainSource).toContain('listen("quit-requested"');
  });

  it("provides forced-color, reduced-motion, and responsive zoom CSS hooks", () => {
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("@media (min-resolution: 2dppx), (min-width: 1600px)");
    expect(styles).toContain("var(--theme-background)");
    expect(styles).toContain(".theme-option[aria-checked=\"true\"]");
    expect(tauriConfig.app.windows[0]?.additionalBrowserArgs).toBe("--force-renderer-accessibility --disable-features=HideCursorWhileTyping");
  });
  it("ships release builds without a console and keeps internal chrome out of the renderer", () => {
    expect(nativeMainSource).toContain('#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]');
    expect(mainSource).not.toContain('id="theme-button"');
    expect(mainSource).not.toContain("Windows foundation");
    expect(mainSource).not.toContain("Keyboard-first PDF reading for Windows");
    // The hint is now the accessible click target rather than inert text, so
    // one affordance carries both the shortcut and the action.
    expect(mainSource).toContain('<span>Open PDF</span><kbd id="empty-reader-shortcut"></kbd>');
    expect(mainSource).toContain('empty-reader-action');
    expect(styles).toContain("place-content: center");
  });

  it("keeps PDF.js raw TextLayer geometry aligned at quarter turns", () => {
    expect(styles).toContain('.textLayer[data-main-rotation="90"] { transform: rotate(90deg) translateY(-100%); }');
    expect(styles).toContain('.textLayer[data-main-rotation="180"] { transform: rotate(180deg) translate(-100%, -100%); }');
    expect(styles).toContain('.textLayer[data-main-rotation="270"] { transform: rotate(270deg) translateX(-100%); }');
  });
  it("keeps palette geometry stable across short and ordinary viewports", () => {
    expect(styles).toContain("max-height: min(58vh, 540px)");
    expect(styles).not.toContain("height: clamp(220px, 40vh, 420px)");
  });
  it("keeps command palette entries command-only and claims navigation across the dialog", () => {
    expect(mainSource).toContain(".filter((entry): entry is CommandPaletteCommandEntry => entry.kind === \"command\")");
    expect(mainSource).toContain("openRecentDocument(invoke, row.recentId)");
    expect(mainSource).toContain("listRecentDocuments(invoke)");
    expect(mainSource).toContain("chooserRows(fileOpenerModel)");
    expect(mainSource).toContain("fileOpenerModel = updateChooserQuery(fileOpenerModel, fileOpenerInput.value)");
    expect(mainSource).toContain('paletteDialog.addEventListener("keydown"');
    expect(mainSource).toContain("}, { capture: true });");
  });
});
