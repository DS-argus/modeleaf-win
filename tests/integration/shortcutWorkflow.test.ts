/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { KeySequenceEngine } from "../../src/core/KeySequenceEngine";
import { token } from "../../src/core/KeyToken";
import { ReaderState } from "../../src/core/ReaderState";
import { bindingById } from "../../src/core/defaultBindings.windows";
import { createKeyboardAdapter } from "../../src/platform/keyboardAdapter";
import { buildCommandPaletteEntries, type CommandPaletteCommandEntry } from "../../src/ui/CommandPaletteModel";
import { buildHelpRows } from "../../src/ui/HelpModel";

function applyResult(
  reader: ReaderState,
  result: ReturnType<KeySequenceEngine["handle"]>,
): void {
  for (const dispatch of result.dispatches) {
    reader.apply(dispatch.action);
  }
}

function keydown(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
}

describe("shortcut workflow", () => {
  it("navigates a document using only the frozen Phase 1 shortcuts", () => {
    const engine = new KeySequenceEngine();
    const reader = new ReaderState();
    reader.mountDocument(25);
    const context = () => ({
      hasDocument: reader.snapshot.hasDocument,
      pageCount: reader.snapshot.pageCount,
      documentGeneration: reader.snapshot.documentGeneration,
    });

    applyResult(reader, engine.handle(token("n"), 0, context()));
    applyResult(reader, engine.handle(token("n"), 1, context()));
    expect(reader.snapshot.page).toBe(3);

    applyResult(reader, engine.handle(token("G", { shift: true }), 2, context()));
    expect(reader.snapshot.page).toBe(25);

    engine.handle(token("g"), 3, context());
    applyResult(reader, engine.handle(token("g"), 4, context()));
    expect(reader.snapshot.page).toBe(1);

    engine.handle(token("g"), 5, context());
    for (const dispatch of engine.advance(805).dispatches) {
      reader.apply(dispatch.action);
    }
    engine.handle(token("1"), 806, context());
    engine.handle(token("7"), 807, context());
    applyResult(reader, engine.handle(token("Enter"), 808, context()));
    expect(reader.snapshot).toMatchObject({ page: 17, status: "Page 17 of 25 · Fit page · 0°" });
  });

  it("uses the same registry for behavior and visible help", () => {
    const shortcuts = buildHelpRows().map((row) => row.shortcut);
    expect(shortcuts).toEqual(expect.arrayContaining([
      "Ctrl+O", "Ctrl+N", "Ctrl+W", "Ctrl+1", "Ctrl+9", "Ctrl+Shift+P", ":", "Shift+N", "Shift+P", "n", "p", "g g", "Shift+G", "?",
    ]));
  });

  it("derives global theme and quit commands for help and the palette", () => {
    const unavailableContext = {
      hasDocument: false,
      canCreateSession: false,
      canOpenDocument: false,
      modalOpen: true,
    };
    const expected = [
      { id: "theme.open", shortcut: "Shift+T", label: "Choose theme", enabled: true },
      { id: "application.quit", shortcut: "Ctrl+Q", label: "Quit after owned cleanup", enabled: true },
    ];

    expect(bindingById("theme.open")).toMatchObject({
      keys: ["T"], action: { type: "theme.open" }, repeatable: false, contexts: ["global"],
    });
    expect(bindingById("application.quit")).toMatchObject({
      keys: ["Ctrl+Q"], action: { type: "application.quit" }, repeatable: false, contexts: ["global"],
    });
    expect(buildHelpRows(unavailableContext)
      .filter((row) => row.id === "theme.open" || row.id === "application.quit")
      .map(({ id, shortcut, label, enabled }) => ({ id, shortcut, label, enabled })))
      .toEqual(expected);
    expect(buildCommandPaletteEntries(unavailableContext)
      .filter((entry): entry is CommandPaletteCommandEntry => entry.kind === "command" && (entry.id === "theme.open" || entry.id === "application.quit"))
      .map(({ id, shortcut, label, enabled }) => ({ id, shortcut, label, enabled })))
      .toEqual(expected);
  });

  it("dispatches exact global theme and quit actions only once per key press", () => {
    const engine = new KeySequenceEngine();
    const context = { hasDocument: false, pageCount: 0, documentGeneration: 0 };

    expect(engine.handle(token("T", { shift: true }), 0, context)).toMatchObject({
      claimed: true, dispatches: [{ action: { type: "theme.open" }, source: "binding" }],
    });
    expect(engine.handle(token("q", { ctrl: true }), 1, context)).toMatchObject({
      claimed: true, dispatches: [{ action: { type: "application.quit" }, source: "binding" }],
    });
    expect(engine.handle(token("T", { shift: true, repeat: true }), 2, context)).toMatchObject({ claimed: false, dispatches: [] });
    expect(engine.handle(token("q", { ctrl: true, repeat: true }), 3, context)).toMatchObject({ claimed: false, dispatches: [] });
    expect(engine.handle(token("t"), 4, context)).toMatchObject({ claimed: false, dispatches: [] });
    expect(engine.handle(token("q"), 5, context)).toMatchObject({ claimed: false, dispatches: [] });
  });

  it("keeps theme and quit keys native for editable, IME, AltGr, and OS-owned input", () => {
    const target = document.createElement("button");
    const input = document.createElement("input");
    document.body.append(target, input);
    const dispatches: string[] = [];
    const adapter = createKeyboardAdapter({
      engine: new KeySequenceEngine(),
      getContext: () => ({ hasDocument: false, pageCount: 0, documentGeneration: 0 }),
      onDispatch: ({ action }) => dispatches.push(action.type),
    });
    target.addEventListener("keydown", adapter.handleKeyDown);
    input.addEventListener("keydown", adapter.handleKeyDown);

    const theme = keydown("T", { shiftKey: true });
    target.dispatchEvent(theme);
    const quit = keydown("q", { ctrlKey: true });
    target.dispatchEvent(quit);
    const repeatedQuit = keydown("q", { ctrlKey: true, repeat: true });
    target.dispatchEvent(repeatedQuit);
    const editableQuit = keydown("q", { ctrlKey: true });
    input.dispatchEvent(editableQuit);
    const composingQuit = keydown("q", { ctrlKey: true, isComposing: true });
    target.dispatchEvent(composingQuit);
    const altGraphTheme = keydown("T", { ctrlKey: true, altKey: true, shiftKey: true });
    target.dispatchEvent(altGraphTheme);
    const osQuit = keydown("q", { metaKey: true });
    target.dispatchEvent(osQuit);

    expect(dispatches).toEqual(["theme.open", "application.quit"]);
    expect(theme.defaultPrevented).toBe(true);
    expect(quit.defaultPrevented).toBe(true);
    for (const event of [repeatedQuit, editableQuit, composingQuit, altGraphTheme, osQuit]) {
      expect(event.defaultPrevented).toBe(false);
    }
    adapter.dispose();
    target.remove();
    input.remove();
  });
  it("keeps uppercase tab cycling distinct from page keys and opens the palette with colon", () => {
    const engine = new KeySequenceEngine();
    const context = { hasDocument: true, pageCount: 10, documentGeneration: 1 };

    expect(engine.handle(token("N", { shift: true }), 0, context).dispatches[0]?.action).toEqual({ type: "tab.next" });
    expect(engine.handle(token("P", { shift: true }), 1, context).dispatches[0]?.action).toEqual({ type: "tab.previous" });
    expect(engine.handle(token("n"), 2, context).dispatches[0]?.action).toEqual({ type: "page.next" });
    expect(engine.handle(token("p"), 3, context).dispatches[0]?.action).toEqual({ type: "page.previous" });
    expect(engine.handle(token("ArrowLeft"), 4, context).dispatches[0]?.action).toEqual({ type: "page.previous" });
    expect(engine.handle(token("ArrowRight"), 5, context).dispatches[0]?.action).toEqual({ type: "page.next" });
    expect(engine.handle(token("ArrowUp"), 6, context).dispatches[0]?.action).toEqual({ type: "scroll.byCssPixels", axis: "vertical", delta: -48 });
    expect(engine.handle(token("ArrowDown"), 7, context).dispatches[0]?.action).toEqual({ type: "scroll.byCssPixels", axis: "vertical", delta: 48 });
    expect(engine.handle(token(":", { shift: true }), 8, context).dispatches[0]?.action).toEqual({ type: "palette.toggle" });
  });
});
