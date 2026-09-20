import { describe, expect, it } from "vitest";
import { ReaderState } from "../../../src/core/ReaderState";

describe("ReaderState", () => {
  it("rejects invalid document metadata", () => {
    const reader = new ReaderState();
    expect(() => reader.mountDocument(0)).toThrow(RangeError);
    expect(() => reader.mountDocument(Number.NaN)).toThrow(RangeError);
  });

  it("mounts page one in continuous fit and restores those defaults on close", () => {
    const reader = new ReaderState();
    reader.mountDocument(3);
    expect(reader.snapshot).toMatchObject({
      hasDocument: true,
      page: 1,
      pageCount: 3,
      zoomMode: "continuous-fit",
      customScale: 1.25,
      fitPageReference: 1,
      rotationQuarterTurns: 0,
      status: "Page 1 of 3 · 0°",
    });

    reader.apply({ type: "view.fitPage" });
    reader.apply({ type: "view.zoom", factor: 1.1 });
    reader.apply({ type: "view.rotate", quarterTurns: 1 });
    reader.closeDocument();
    expect(reader.snapshot).toMatchObject({
      hasDocument: false,
      page: 0,
      pageCount: 0,
      zoomMode: "continuous-fit",
      customScale: 1.25,
      fitPageReference: undefined,
      rotationQuarterTurns: 0,
      status: "No document open",
    });
  });

  it("keeps the Fit Page reference independent from current-page movement", () => {
    const reader = new ReaderState();
    reader.mountDocument(4);
    reader.apply({ type: "page.goTo", page: 3 });
    expect(reader.snapshot.fitPageReference).toBe(1);
    reader.apply({ type: "view.fitPage" });
    expect(reader.snapshot.fitPageReference).toBe(3);
    reader.apply({ type: "page.next" });
    expect(reader.snapshot.fitPageReference).toBe(3);
    reader.apply({ type: "view.fitWidth" });
    expect(reader.snapshot.fitPageReference).toBeUndefined();
    expect(() => reader.restoreView({ zoomMode: "fit-page", customScale: 1, rotationQuarterTurns: 0, fitPageReference: 0 })).toThrow(RangeError);
  });
  it("clamps page navigation at document bounds", () => {
    const reader = new ReaderState();
    reader.mountDocument(3);
    reader.apply({ type: "page.previous" });
    expect(reader.snapshot.page).toBe(1);
    reader.apply({ type: "page.last" });
    reader.apply({ type: "page.next" });
    expect(reader.snapshot).toMatchObject({
      page: 3,
      status: "Page 3 of 3 · 0°",
    });
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
    expect(reader.snapshot).toMatchObject({
      helpVisible: false,
      status: "Page 7 of 10 · 0°",
    });
  });

  it("accumulates scroll intent separately until the shell consumes it", () => {
    const reader = new ReaderState();
    reader.mountDocument(2);

    reader.apply({ type: "scroll.byCssPixels", axis: "horizontal", delta: -48 });
    reader.apply({ type: "scroll.byCssPixels", axis: "vertical", delta: 48 });
    reader.apply({ type: "scroll.byViewport", factor: 0.8 });

    expect(reader.snapshot).toMatchObject({
      page: 1,
      pendingScroll: {
        horizontalCssPixels: -48,
        verticalCssPixels: 48,
        viewportFactor: 0.8,
      },
    });
    expect(reader.consumePendingScroll()).toEqual({
      horizontalCssPixels: -48,
      verticalCssPixels: 48,
      viewportFactor: 0.8,
    });
    expect(reader.snapshot.pendingScroll).toEqual({
      horizontalCssPixels: 0,
      verticalCssPixels: 0,
      viewportFactor: 0,
    });
  });

  it("sets Actual Size exactly once from fit and custom modes", () => {
    const reader = new ReaderState();
    reader.mountDocument(10);
    reader.apply({ type: "view.fitPage" });
    reader.apply({ type: "view.actualSize" });
    expect(reader.snapshot).toMatchObject({
      zoomMode: "custom",
      customScale: 1,
      status: "Page 1 of 10 · Custom 100% · 0°",
    });

    reader.apply({ type: "view.zoom", factor: 1.1 });
    reader.apply({ type: "view.actualSize" });
    const actualSize = reader.snapshot;
    reader.apply({ type: "view.actualSize" });
    expect(reader.snapshot).toEqual(actualSize);
  });

  it("preserves custom scale through fit modes and normalizes rotation", () => {
    const reader = new ReaderState();
    reader.mountDocument(10);

    reader.apply({ type: "view.zoom", factor: 1.1 });
    reader.apply({ type: "view.fitWidth" });
    reader.apply({ type: "view.fitPage" });
    reader.apply({ type: "view.rotate", quarterTurns: -1 });
    reader.apply({ type: "view.rotate", quarterTurns: 1 });

    expect(reader.snapshot).toMatchObject({
      zoomMode: "fit-page",
      customScale: 1.375,
      rotationQuarterTurns: 0,
      fitPageReference: 1,
      status: "Page 1 of 10 · 0°",
    });
    reader.apply({ type: "view.zoom", factor: 1 / 1.1 });
    reader.apply({ type: "view.rotate", quarterTurns: -1 });
    expect(reader.snapshot).toMatchObject({
      zoomMode: "custom",
      customScale: 1.25,
      rotationQuarterTurns: 3,
      status: "Page 1 of 10 · Custom 125% · 270°",
    });
  });

  it("clamps custom zoom and restores a prior view after render failure", () => {
    const reader = new ReaderState();
    reader.mountDocument(2);
    for (let index = 0; index < 100; index += 1) {
      reader.apply({ type: "view.zoom", factor: 1.1 });
    }
    expect(reader.snapshot.customScale).toBe(4);

    for (let index = 0; index < 100; index += 1) {
      reader.apply({ type: "view.zoom", factor: 1 / 1.1 });
    }
    expect(reader.snapshot.customScale).toBe(0.25);

    reader.restoreView({ zoomMode: "fit-width", customScale: 1.25, fitPageReference: undefined, rotationQuarterTurns: -1 });
    expect(reader.snapshot).toMatchObject({
      zoomMode: "fit-width",
      customScale: 1.25,
      rotationQuarterTurns: 3,
      status: "Page 1 of 2 · 270°",
    });
  });

  it("does not change view actions without a document", () => {
    const reader = new ReaderState();
    const before = reader.snapshot;
    reader.apply({ type: "page.next" });
    reader.apply({ type: "view.actualSize" });
    expect(reader.snapshot).toEqual(before);
  });
});
