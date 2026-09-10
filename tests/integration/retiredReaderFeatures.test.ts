// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ACTION_IDS } from "../../src/domain/actions/ActionRegistry";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const main = source("src/main.ts");
const compositionStart = main.indexOf("function isNativeCompositionEvent(");
if (compositionStart < 0) throw new Error("Production composition guard is missing");
const compositionBody = main.slice(main.indexOf("{", compositionStart) + 1, main.indexOf("\n}", compositionStart));
const isNativeCompositionEvent = new Function("event", compositionBody);
const editableStart = main.indexOf("function isEditableTarget(");
if (editableStart < 0) throw new Error("Production editable-target guard is missing");
const editableBody = main.slice(main.indexOf("{", editableStart) + 1, main.indexOf("\n}", editableStart));
const isEditableTarget = new Function("target", editableBody);

describe("Retired reader features", () => {
  it("removes TOC and keyboard hints without removing ordinary link targets", () => {
    for (const id of ["toc.toggle", "toc.scrollDown", "toc.scrollUp", "link.hint"]) expect(ACTION_IDS).not.toContain(id);
    expect(ACTION_IDS).toContain("indicator.picker");
    for (const path of [
      "src/domain/outlines/OutlineModel.ts", "src/domain/outlines/OutlineSelector.ts",
      "src/pdf/PdfOutlineAdapter.ts", "src/pdf/PdfOutlineProbe.ts",
      "src/ui/reader/TocController.ts", "src/ui/reader/TocWidgetModel.ts", "src/ui/reader/TocWidgetView.ts",
      "src/domain/links/LinkHints.ts",
    ]) expect(existsSync(resolve(process.cwd(), path))).toBe(false);
    for (const text of [main, source("src/styles/app.css"), source("src/pdf/PdfContentController.ts")]) {
      for (const retired of ["toc-widget", "pdf-link-hint", "handleHintKey", "toggleHints", "hintsVisible"]) expect(text).not.toContain(retired);
    }
    expect(source("src/pdf/PdfContentController.ts")).toContain("pdf-link-overlay");
    expect(main).toContain('invoke<number>("open_external_link"');
  });

  const marker = 'window.addEventListener("keydown", (event) => {\n  const session = active().session;';
  const start = main.indexOf(marker);
  const end = main.indexOf('}, { capture: true });', start);
  if (start < 0 || end < 0) throw new Error("Production indicator dismissal listener is missing");
  const body = main.slice(start + 'window.addEventListener("keydown", (event) => {'.length, end);
  const dismiss = new Function("event", "active", "isNativeCompositionEvent", "render", "overlayOwner", "isEditableTarget", body);

  it("consumes plain Escape only when a destination indicator is visible", () => {
    const session = { linkIndicatorVisible: true, dismissLinkIndicator: vi.fn() };
    const render = vi.fn();
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    dismiss(event, () => ({ session }), isNativeCompositionEvent, render, { active: undefined }, isEditableTarget);
    expect(session.dismissLinkIndicator).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(render).toHaveBeenCalledOnce();
    session.linkIndicatorVisible = false;
    const absent = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    dismiss(absent, () => ({ session }), isNativeCompositionEvent, render, { active: undefined }, isEditableTarget);
    expect(absent.defaultPrevented).toBe(false);
    expect(session.dismissLinkIndicator).toHaveBeenCalledTimes(1);
  });

  it.each([
    { key: "f" }, { key: "t" }, { key: "J" }, { key: "K" },
    { key: "Escape", ctrlKey: true }, { key: "Escape", altKey: true },
    { key: "Escape", metaKey: true }, { key: "Escape", shiftKey: true },
    { key: "Escape", isComposing: true }, { key: "Escape", keyCode: 229 },
  ])("does not steal unrelated or composition input: %j", (init) => {
    const session = { linkIndicatorVisible: true, dismissLinkIndicator: vi.fn() };
    const event = new KeyboardEvent("keydown", { ...init, cancelable: true });
    dismiss(event, () => ({ session }), isNativeCompositionEvent, vi.fn(), { active: undefined }, isEditableTarget);
    expect(event.defaultPrevented).toBe(false);
    expect(session.dismissLinkIndicator).not.toHaveBeenCalled();
  });

  it.each([
    { overlay: true, tag: "input" },
    { overlay: true, tag: "button" },
    { overlay: false, tag: "input" },
  ])("preserves dialog/editable Escape after late indicator publication: %j", ({ overlay, tag }) => {
    const session = { linkIndicatorVisible: false, dismissLinkIndicator: vi.fn() };
    const render = vi.fn();
    const owner = { active: overlay ? { id: "search" } : undefined };
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    const target = document.createElement(tag);
    dialog.append(target);
    document.body.append(dialog);
    let previouslyPrevented: boolean | undefined;
    const onDialog = vi.fn((event: KeyboardEvent) => {
      previouslyPrevented = event.defaultPrevented;
      event.preventDefault();
    });
    dialog.addEventListener("keydown", onDialog);
    const capture = (event: KeyboardEvent) => dismiss(event, () => ({ session }), isNativeCompositionEvent, render, owner, isEditableTarget);
    window.addEventListener("keydown", capture, true);
    try {
      target.focus();
      expect(document.activeElement).toBe(target);
      session.linkIndicatorVisible = true;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(onDialog).toHaveBeenCalledOnce();
      expect(previouslyPrevented).toBe(false);
      expect(session.dismissLinkIndicator).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", capture, true);
      dialog.remove();
    }
  });
});
