import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../../src/ui/RecentChooserRenderer.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../src/styles/app.css", import.meta.url), "utf8");
const recentSource = readFileSync(new URL("../../src/domain/recent/RecentFiles.ts", import.meta.url), "utf8");

describe("Open chooser presentation", () => {
  it("presents glyph-free Browse and safe fitted text with full canonical tooltip", () => {
    expect(renderer).toContain('heading.className = "file-opener-recents-heading"');
    expect(renderer).toContain('heading.textContent = "Recent"');
    expect(renderer).toContain('button.className = `overlay-list-entry file-opener-entry file-opener-${row.kind}`');
    expect(renderer).toContain('button.setAttribute("aria-label", "Browse for a PDF")');
    expect(renderer).toContain("button.textContent = row.label");
    expect(renderer).toContain('label.className = "file-opener-recent-path"');
    expect(renderer).toContain("view.button.title = row.displayPath");
    expect(renderer).toContain('view.button.setAttribute("aria-label", displayPath)');
    expect(renderer).toContain("view.label.textContent = text");
    expect(renderer).not.toContain("innerHTML");
    expect(styles).not.toContain("file-opener-browse-glyph");
    const browse = styles.slice(styles.indexOf(".file-opener-browse {"), styles.indexOf("}", styles.indexOf(".file-opener-browse {")) + 1);
    expect(browse).not.toContain("border");
  });

  it("retains row nodes for selection and fits before owned vertical scrolling", () => {
    expect(renderer).toContain("if (structureChanged || diagnosticChanged)");
    expect(renderer).toContain("views.get(key)");
    expect(renderer).toContain("button.addEventListener");
    expect(renderer).toContain("new ResizeObserver");
    expect(renderer).toContain("requestAnimationFrame");
    expect(renderer).not.toContain('removeProperty("font-size")');
    expect(renderer).not.toMatch(/\.style\.fontSize\s*=/u);
    expect(renderer).not.toContain('setProperty("font-size"');
    expect(renderer).not.toContain("scrollIntoView");
    expect(renderer).toContain("list.scrollTop +=");
    expect(renderer).not.toContain("list.scrollLeft =");
    expect(renderer.indexOf("if (structureChanged || contentChanged")).toBeLessThan(renderer.lastIndexOf("keepSelectionVisible();"));
    expect(mainSource).toContain("fileOpenerRenderer.stop()");
    expect(mainSource).toContain('if (overlayOwner.active?.id === "recent") fileOpenerRenderer.requestFit()');
  });

  it("keeps filename-only matching, selection, footer and stable diagnostic announcement", () => {
    const filter = recentSource.slice(recentSource.indexOf("export function filterRecentFiles"), recentSource.indexOf("function fuzzyMatch"));
    expect(filter).toContain("Array.from(displayName.toLocaleLowerCase())");
    expect(filter).not.toContain("displayPath.toLocaleLowerCase");
    expect(mainSource).toContain('placeholder="Filter recent PDFs"');
    expect(renderer).toContain('setAttribute("aria-selected", String(current))');
    expect(renderer).toContain('setAttribute("aria-current", String(current))');
    expect(mainSource).toContain("Ctrl+j/k</kbd> move · <kbd>Ctrl+Shift+c</kbd> clear history · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close");
    expect(renderer).toContain('diagnostic.setAttribute("role", "status")');
    expect(renderer).toContain('diagnostic.setAttribute("aria-live", "polite")');
  });

  it("leaves opening authority on opaque recent IDs despite display aliases", () => {
    const dispatch = mainSource.slice(mainSource.indexOf("function dispatchFileOpenerEntry"), mainSource.indexOf("async function openFileOpener"));
    expect(dispatch).toContain("chooserRows(fileOpenerModel)[fileOpenerModel.activeIndex]");
    expect(dispatch).toContain("shellOpen.requestOpen()");
    expect(dispatch).toContain("openRecentDocument(invoke, row.recentId)");
    expect(dispatch).not.toContain("invoke, row.displayPath");
    expect(dispatch).not.toContain("fileOpenerAliases");
    expect(dispatch).toContain("shellOpen.admitOpen(outcome)");
    expect(mainSource).toContain("outcome.revision !== revision");
    expect(mainSource).toContain("fileOpenerModel.generation !== generation");
  });

  it("contains horizontal overflow at small windows while preserving focus/forced-color rules", () => {
    expect(styles).toContain(".file-opener-overlay { width: min(520px, calc(100vw - 32px))");
    const list = styles.slice(styles.indexOf(".file-opener-list {"), styles.indexOf("}", styles.indexOf(".file-opener-list {")) + 1);
    expect(list).toContain("overflow-x: hidden");
    expect(styles).toContain(".file-opener-list > li { min-width: 0; }");
    expect(styles).toContain("font-size: 13px");
    expect(styles).toContain("@media (max-width: 480px)");
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain('.file-opener-entry[aria-selected="true"] { color: HighlightText; background: Highlight;');
    expect(styles).toContain(".file-opener-entry, .file-opener-diagnostic, .file-opener-overlay input::placeholder { color: CanvasText; }");
    expect(styles).toContain(".file-opener-entry:not(:disabled):focus-visible, .file-opener-overlay input:focus-visible { outline: 3px solid Highlight;");
  });
});
