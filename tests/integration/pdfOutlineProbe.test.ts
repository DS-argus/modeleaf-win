import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { probePdfOutline, type PdfOutlineDocument, type PdfOutlineItem } from "../../src/pdf/PdfOutlineProbe";

const fixtureUrl = new URL("../../fixtures/pdf/outline.pdf", import.meta.url);

const outlineDocument = (outline: readonly PdfOutlineItem[] | null): PdfOutlineDocument => ({
  numPages: 1,
  getOutline: async () => outline,
  getPageIndex: async () => 0,
  getPage: async () => ({
    getViewport: () => ({ height: 200, viewBox: [10, 20, 110, 220], userUnit: 1 }),
  }),
});

describe("probePdfOutline", () => {
  it("classifies the frozen nested, duplicate, invalid, and edge destinations", async () => {
    const source = new Uint8Array(await readFile(fixtureUrl));
    const loadingTask = getDocument({
      data: source,
      disableFontFace: true,
      useSystemFonts: false,
    });
    try {
      const document = await loadingTask.promise;
      const rows = await probePdfOutline(document as unknown as PdfOutlineDocument);

      expect(rows.map((row) => row.title)).toEqual([
        "Modeleaf outline wrapper",
        "1 Root",
        "2 Interior",
        "3 Duplicate A",
        "4 Duplicate B",
        "5 Nested parent",
        "6 Hidden child",
        "7 Deeper hidden child",
        "8 Invalid row",
        "12 Edge destination",
      ]);
      expect(rows.map((row) => row.depth)).toEqual([0, 1, 1, 1, 1, 1, 2, 3, 2, 2]);
      expect(rows.map((row) => row.destinationStatus)).toEqual([
        "wrapper",
        "resolved",
        "resolved",
        "resolved",
        "duplicate",
        "resolved",
        "resolved",
        "resolved",
        "invalid",
        "edge-clamped",
      ]);
      expect(rows.at(-1)).toMatchObject({ pageNumber: 1, y: 679 });
      expect(rows.at(-1)?.clampedY).toBeCloseTo(676.3, 3);
    } finally {
      await loadingTask.destroy();
    }
  });

  it("treats null and empty outlines as stable empty results", async () => {
    await expect(probePdfOutline(outlineDocument(null))).resolves.toEqual([]);
    await expect(probePdfOutline(outlineDocument([]))).resolves.toEqual([]);
  });

  it("canonicalizes page references, decodes FitH/FitR Y slots, and rejects page overflow", async () => {
    const reference = { num: 4, gen: 0 };
    const documentBoundary: PdfOutlineDocument = {
      ...outlineDocument([]),
      getOutline: async () => [
        { title: "numeric", dest: [0, { name: "XYZ" }, 10, 30, null], items: [] },
        { title: "reference", dest: [reference, { name: "XYZ" }, 10, 30, null], items: [] },
        { title: "fit-height", dest: [0, { name: "FitH" }, 250], items: [] },
        { title: "fit-rectangle", dest: [0, { name: "FitR" }, 10, 30, 90, 10], items: [] },
        { title: "outside", dest: [1, { name: "XYZ" }, 10, 30, null], items: [] },
      ],
      getPageIndex: async (value) => value === reference ? 0 : 1,
    };

    const rows = await probePdfOutline(documentBoundary);
    expect(rows.map((row) => row.destinationStatus)).toEqual([
      "resolved", "duplicate", "edge-clamped", "edge-clamped", "invalid",
    ]);
    expect(rows[2]).toMatchObject({ y: 250, clampedY: 220 });
    expect(rows[3]).toMatchObject({ y: 10, clampedY: 20 });
  });

  it("rejects outline depth beyond the bounded limit", async () => {
    const root: { title: string; dest: null; items: PdfOutlineItem[] } = { title: "0", dest: null, items: [] };
    let parent = root;
    for (let depth = 1; depth <= 33; depth += 1) {
      const child = { title: String(depth), dest: null, items: [] as PdfOutlineItem[] };
      parent.items.push(child);
      parent = child;
    }
    await expect(probePdfOutline(outlineDocument([root]))).rejects.toThrow("OUTLINE_DEPTH_LIMIT");
  });
  it("fails closed on cyclic outline objects", async () => {
    const cyclic: { title: string; dest: null; items: PdfOutlineItem[] } = {
      title: "cycle",
      dest: null,
      items: [],
    };
    cyclic.items.push(cyclic);
    await expect(probePdfOutline(outlineDocument([cyclic]))).rejects.toThrow("OUTLINE_CYCLE");
  });
});
