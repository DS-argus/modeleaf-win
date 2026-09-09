import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../src/styles/app.css", import.meta.url), "utf8");

describe("Open chooser presentation", () => {
  it("presents glyph-free Browse as the distinct first choice and recents as path-free filenames", () => {
    const render = mainSource.slice(mainSource.indexOf("function renderFileOpener"), mainSource.indexOf("function closeFileOpener"));
    const conditionalHeading = render.slice(
      render.indexOf('if (row.kind === "recent" && index === 1)'),
      render.indexOf('const item = document.createElement("li")'),
    );
    expect(conditionalHeading).toContain('heading.className = "file-opener-recents-heading"');
    expect(conditionalHeading).toContain('heading.textContent = "Recent"');
    expect(render).toContain('button.className = `overlay-list-entry file-opener-entry file-opener-${row.kind}`');
    expect(render).toContain('button.setAttribute("aria-label", "Browse for a PDF")');
    expect(render).toContain("button.textContent = row.label");
    expect(render).toContain("button.textContent = row.displayName");
    expect(render).not.toContain("file-opener-browse-glyph");
    expect(render).not.toContain("path");
    expect(styles).not.toContain(".file-opener-browse-glyph");
    expect(styles).toContain(".file-opener-recents-heading { margin: 7px 0 1px; padding: 7px 9px 0; color: var(--theme-muted-text); border-top: 1px solid var(--theme-border);");
  });

  it("keeps the filter, selected state, truthful footer, and diagnostic announcement", () => {
    expect(mainSource).toContain('placeholder="Filter recent PDFs"');
    expect(mainSource).toContain('button.setAttribute("aria-selected", String(selected))');
    expect(mainSource).toContain('button.setAttribute("aria-current", selected ? "true" : "false")');
    expect(mainSource).toContain("Ctrl+J/K</kbd> move · <kbd>Ctrl+Shift+C</kbd> clear history · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close");
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
    expect(styles).toContain(".file-opener-recents-heading { border-color: CanvasText; }");
    expect(styles).toContain(".file-opener-recents-heading, .file-opener-footer, .file-opener-footer kbd { color: CanvasText; }");
    expect(styles).toContain(".file-opener-overlay { max-width: calc(100vw - 32px); }");
  });
});
