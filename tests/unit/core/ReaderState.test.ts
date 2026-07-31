import { describe, expect, it } from "vitest";
import { ReaderState } from "../../../src/core/ReaderState";

describe("ReaderState", () => {
  it("rejects invalid document metadata", () => {
    const reader = new ReaderState();
    expect(() => reader.mountDocument(0)).toThrow(RangeError);
    expect(() => reader.mountDocument(Number.NaN)).toThrow(RangeError);
  });

  it("clamps page navigation at document bounds", () => {
    const reader = new ReaderState();
    reader.mountDocument(3);
    reader.apply({ type: "page.previous" });
    expect(reader.snapshot.page).toBe(1);
    reader.apply({ type: "page.last" });
    reader.apply({ type: "page.next" });
    expect(reader.snapshot).toMatchObject({ page: 3, status: "Page 3 of 3" });
  });
  it("increments document generation for replacement and close", () => {
    const reader = new ReaderState();
    reader.mountDocument(10);
    expect(reader.snapshot.documentGeneration).toBe(1);
    reader.mountDocument(10);
    expect(reader.snapshot.documentGeneration).toBe(2);
    reader.closeDocument();
    expect(reader.snapshot.documentGeneration).toBe(3);
  });

  it("applies direct page targets and toggles generated help state", () => {
    const reader = new ReaderState();
    reader.mountDocument(10);
    reader.apply({ type: "page.goTo", page: 7 });
    reader.apply({ type: "help.toggle" });
    expect(reader.snapshot).toMatchObject({ page: 7, helpVisible: true });
    reader.apply({ type: "prompt.cancel" });
    expect(reader.snapshot).toMatchObject({ helpVisible: false, status: "Page 7 of 10" });
  });

  it("does not navigate without a document", () => {
    const reader = new ReaderState();
    reader.apply({ type: "page.next" });
    expect(reader.snapshot).toMatchObject({ hasDocument: false, page: 0 });
  });
});
