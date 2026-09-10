import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../src/styles/app.css", import.meta.url), "utf8");
const recentSource = readFileSync(new URL("../../src/domain/recent/RecentFiles.ts", import.meta.url), "utf8");

describe("Open chooser presentation", () => {
  it("presents glyph-free Browse and recent display paths with safe text APIs", () => {
    const render = mainSource.slice(mainSource.indexOf("function renderFileOpener"), mainSource.indexOf("let clearingRecents"));
    const conditionalHeading = render.slice(
      render.indexOf('if (row.kind === "recent" && index === 1)'),
      render.indexOf('const item = document.createElement("li")'),
    );
    expect(conditionalHeading).toContain('heading.className = "file-opener-recents-heading"');
    expect(conditionalHeading).toContain('heading.textContent = "Recent"');
    expect(render).toContain('button.className = `overlay-list-entry file-opener-entry file-opener-${row.kind}`');
    expect(render).toContain('button.setAttribute("aria-label", "Browse for a PDF")');
    expect(render).toContain("button.textContent = row.label");
    expect(render).toContain('directory.className = "file-opener-recent-directory"');
    expect(render).toContain('filename.className = "file-opener-recent-filename"');
    expect(render).toContain("directory.textContent = separatorIndex < 0 ? \"\" : row.displayPath.slice(0, separatorIndex + 1)");
    expect(render).toContain("filename.textContent = row.displayName");
    expect(render).toContain('button.setAttribute("aria-label", row.displayPath)');
    expect(render).toContain("button.title = row.displayPath");
    expect(render).not.toContain("innerHTML");
    expect(render).not.toContain("file-opener-browse-glyph");
    expect(styles).not.toContain(".file-opener-browse-glyph");
    const browseRule = styles.slice(styles.indexOf(".file-opener-browse {"), styles.indexOf("}", styles.indexOf(".file-opener-browse {")) + 1);
    expect(browseRule).not.toContain("border");
    expect(styles).toContain(".file-opener-entry:not(:disabled):focus-visible { outline: 2px solid var(--theme-focus-indicator)");
    expect(styles).toContain(".file-opener-recents-heading { margin: 7px 0 1px; padding: 7px 9px 0; color: var(--theme-muted-text); border-top: 1px solid var(--theme-border);");
  });

  it("fits paths from a restored base font after visible layout and width changes", () => {
    const presentation = mainSource.slice(mainSource.indexOf("function renderFileOpener"), mainSource.indexOf("let clearingRecents"));
    expect(presentation).toContain("startFileOpenerPathFitting()");
    expect(presentation).toContain('new ResizeObserver(() => {');
    expect(presentation).toContain("requestAnimationFrame(() => {");
    expect(presentation).toContain("fileOpenerList.clientWidth <= 0");
    expect(presentation).toContain('button.style.removeProperty("font-size")');
    expect(presentation).toContain("fitRecentPath(button.title, filename.textContent ?? \"\", availableWidth, baseFontSize");
    expect(presentation).toContain("directory.textContent = result.directoryText");
    expect(presentation).toContain("filename.textContent = result.filenameText");
    expect(presentation).toContain("fileOpenerPathResizeObserver?.disconnect()");
    expect(mainSource).toContain('if (overlayOwner.active?.id === "recent") scheduleFileOpenerPathFit()');
    expect(mainSource).toContain("function closeFileOpener(): void {\n  stopFileOpenerPathFitting();");
    expect(styles).toContain(".file-opener-recent { display: flex; align-items: baseline; gap: 0; min-width: 0; white-space: nowrap; }");
    expect(styles).toContain(".file-opener-recent-directory, .file-opener-recent-filename { flex: 0 0 auto; }");
    expect(styles).not.toContain(".file-opener-recent { display: block; overflow: hidden; text-overflow: ellipsis");
  });

  it("keeps filename-only matching, selection, footer, and diagnostic announcement", () => {
    const filter = recentSource.slice(recentSource.indexOf("export function filterRecentFiles"), recentSource.indexOf("function fuzzyMatch"));
    expect(filter).toContain("Array.from(displayName.toLocaleLowerCase())");
    expect(filter).not.toContain("displayPath.toLocaleLowerCase");
    expect(mainSource).toContain('placeholder="Filter recent PDFs"');
    expect(mainSource).toContain('button.setAttribute("aria-selected", String(selected))');
    expect(mainSource).toContain('button.setAttribute("aria-current", selected ? "true" : "false")');
    expect(mainSource).toContain("Ctrl+J/K</kbd> move · <kbd>Ctrl+Shift+C</kbd> clear history · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close");
    expect(mainSource).toContain('diagnostic[0].setAttribute("role", "status")');
    expect(mainSource).toContain('diagnostic[0].setAttribute("aria-live", "polite")');
  });

  it("leaves chooser dispatch on native terminals with opaque recent ID authority", () => {
    const dispatch = mainSource.slice(mainSource.indexOf("function dispatchFileOpenerEntry"), mainSource.indexOf("async function openFileOpener"));
    expect(dispatch).toContain("chooserRows(fileOpenerModel)[fileOpenerModel.activeIndex]");
    expect(dispatch).toContain("shellOpen.requestOpen()");
    expect(dispatch).toContain("openRecentDocument(invoke, row.recentId)");
    expect(dispatch).not.toContain("openRecentDocument(invoke, row.displayPath)");
    expect(dispatch).not.toContain("invoke, row.displayPath");
    expect(dispatch).toContain("shellOpen.admitOpen(outcome)");
  });

  it("contains the chooser at small windows, text scale, and forced colors", () => {
    expect(styles).toContain(".file-opener-overlay { width: min(520px, calc(100vw - 32px))");
    expect(styles).toContain(".file-opener-list { grid-template-columns: minmax(0, 1fr); max-height: min(48vh, 360px); padding: 1px; overscroll-behavior: contain; }");
    expect(styles).toContain("@media (max-width: 480px)");
    expect(styles).toContain(".file-opener-footer { overflow-wrap: anywhere; }");
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain('.file-opener-entry[aria-selected="true"] { color: HighlightText; background: Highlight;');
    expect(styles).toContain(".file-opener-entry, .file-opener-diagnostic, .file-opener-overlay input::placeholder { color: CanvasText; }");
    expect(styles.indexOf(".file-opener-entry, .file-opener-diagnostic")).toBeLessThan(styles.indexOf('.file-opener-entry[aria-selected="true"] { color: HighlightText'));
    expect(styles).toContain(".file-opener-entry:not(:disabled):focus-visible, .file-opener-overlay input:focus-visible { outline: 3px solid Highlight;");
    expect(styles).toContain("@media (min-resolution: 2dppx)");
    expect(styles).toContain(".file-opener-recents-heading { border-color: CanvasText; }");
    expect(styles).toContain(".file-opener-recents-heading, .file-opener-footer, .file-opener-footer kbd { color: CanvasText; }");
    expect(styles).toContain(".file-opener-overlay { max-width: calc(100vw - 32px); }");
  });
});
