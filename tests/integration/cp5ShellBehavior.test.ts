import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../src/styles/app.css", import.meta.url), "utf8");
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
    expect(tauriConfig.app.windows[0]?.additionalBrowserArgs).toBe("--force-renderer-accessibility");
  });
});
