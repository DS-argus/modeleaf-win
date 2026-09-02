import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../src/styles/app.css", import.meta.url), "utf8");

describe("Open chooser presentation", () => {
  it("presents Browse as the distinct first choice and recents as path-free filenames", () => {
    const render = mainSource.slice(mainSource.indexOf("function renderFileOpener"), mainSource.indexOf("function closeFileOpener"));
    expect(render).toContain('if (row.kind === "recent" && index === 1)');
    expect(render).toContain('heading.textContent = "Recent"');
    expect(render).toContain('button.className = `overlay-list-entry file-opener-entry file-opener-${row.kind}`');
    expect(render).toContain('button.setAttribute("aria-label", "Browse for a PDF")');
    expect(render).toContain('glyph.className = "file-opener-browse-glyph"');
    expect(render).toContain("button.textContent = row.displayName");
    expect(render).not.toContain("path");
  });

  it("keeps the filter, selected state, truthful footer, and diagnostic announcement", () => {
    expect(mainSource).toContain('placeholder="Filter recent PDFs"');
    expect(mainSource).toContain('button.setAttribute("aria-selected", String(selected))');
    expect(mainSource).toContain('button.setAttribute("aria-current", selected ? "true" : "false")');
    expect(mainSource).toContain("Ctrl+J/K</kbd> move · <kbd>Ctrl+Shift+C</kbd> clear · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close");
    expect(mainSource).toContain('diagnostic[0].setAttribute("role", "status")');
    expect(mainSource).toContain('diagnostic[0].setAttribute("aria-live", "polite")');
  });
  it("leaves chooser dispatch on its existing native terminal paths", () => {
    const dispatch = mainSource.slice(mainSource.indexOf("function dispatchFileOpenerEntry"), mainSource.indexOf("async function openFileOpener"));
    expect(dispatch).toContain("chooserRows(fileOpenerModel)[fileOpenerModel.activeIndex]");
    expect(dispatch).toContain("shellOpen.requestOpen()");
    expect(dispatch).toContain("openRecentDocument(invoke, row.recentId)");
    expect(dispatch).toContain("shellOpen.admitOpen(outcome)");
  });

  it("contains the chooser at small windows, text scale, and forced colors", () => {
    expect(styles).toContain(".file-opener-overlay { width: min(520px, calc(100vw - 32px))");
    expect(styles).toContain(".file-opener-list { max-height: min(48vh, 360px); padding: 1px; overscroll-behavior: contain; }");
    expect(styles).toContain("@media (max-width: 480px)");
    expect(styles).toContain(".file-opener-footer { overflow-wrap: anywhere; }");
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain(".file-opener-entry[aria-selected=\"true\"] { color: HighlightText; background: Highlight;");
    expect(styles).toContain(".file-opener-entry, .file-opener-diagnostic, .file-opener-overlay input::placeholder { color: CanvasText; }");
    expect(styles.indexOf(".file-opener-entry, .file-opener-diagnostic")).toBeLessThan(styles.indexOf(".file-opener-entry[aria-selected=\"true\"] { color: HighlightText"));
    expect(styles).toContain("@media (min-resolution: 2dppx)");
    expect(styles).toContain(".file-opener-overlay { max-width: calc(100vw - 32px); }");
  });
});
