import { describe, expect, it } from "vitest";
import { KeySequenceEngine } from "../../src/core/KeySequenceEngine";
import { token } from "../../src/core/KeyToken";
import { ReaderState } from "../../src/core/ReaderState";
import { buildHelpRows } from "../../src/ui/HelpModel";

function applyResult(
  reader: ReaderState,
  result: ReturnType<KeySequenceEngine["handle"]>,
): void {
  for (const dispatch of result.dispatches) {
    reader.apply(dispatch.action);
  }
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

    applyResult(reader, engine.handle(token("G"), 2, context()));
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
    expect(shortcuts).toEqual(expect.arrayContaining(["Ctrl+O", "n", "p", "g g", "G", "?"]));
  });
});
