import { describe, expect, it } from "vitest";
import {
  readOutlineTree,
  resolveOutlineDestination,
  type PdfOutlineAdapterDocument,
  type PdfOutlineAdapterItem,
} from "../../../src/pdf/PdfOutlineAdapter";
import { normalizeOutline } from "../../../src/domain/outlines/OutlineModel";

const LETTER = { width: 612, height: 792 } as const;

function documentWith(
  outline: readonly PdfOutlineAdapterItem[] | null,
  overrides: Partial<PdfOutlineAdapterDocument> = {},
  viewBox: readonly number[] | undefined = [0, 0, LETTER.width, LETTER.height],
): PdfOutlineAdapterDocument {
  return {
    numPages: 3,
    getOutline: async () => outline,
    getPageIndex: async () => 0,
    getPage: async () => ({
      getViewport: () => ({
        width: LETTER.width,
        height: LETTER.height,
        ...(viewBox === undefined ? {} : { viewBox }),
      }),
    }),
    ...overrides,
  };
}

const xyz = (x: number | null, y: number | null) => [0, { name: "XYZ" }, x, y, null];

describe("PdfOutlineAdapter destination policy", () => {
  it("resolves an unspecified sentinel coordinate to the media-box center", async () => {
    // feature-spec.md §8: "지정되지 않은 sentinel coordinate는 중앙으로".
    // A fully unspecified XYZ destination is the common real-world case.
    const resolved = await resolveOutlineDestination(documentWith([]), xyz(null, null));
    expect(resolved).toMatchObject({ pageIndex: 0, x: LETTER.width / 2, y: LETTER.height / 2 });
  });

  it("centers only the unspecified axis and keeps the specified one", async () => {
    await expect(resolveOutlineDestination(documentWith([]), xyz(100, null)))
      .resolves.toMatchObject({ x: 100, y: LETTER.height / 2 });
    await expect(resolveOutlineDestination(documentWith([]), xyz(null, 700)))
      .resolves.toMatchObject({ x: LETTER.width / 2, y: 700 });
  });

  it("centers Fit and FitB, which name no point at all", async () => {
    await expect(resolveOutlineDestination(documentWith([]), [0, { name: "Fit" }]))
      .resolves.toMatchObject({ x: LETTER.width / 2, y: LETTER.height / 2 });
    await expect(resolveOutlineDestination(documentWith([]), [0, { name: "FitB" }]))
      .resolves.toMatchObject({ x: LETTER.width / 2, y: LETTER.height / 2 });
  });

  it("takes the y slot from FitH and the x slot from FitV, centering the other axis", async () => {
    await expect(resolveOutlineDestination(documentWith([]), [0, { name: "FitH" }, 500]))
      .resolves.toMatchObject({ x: LETTER.width / 2, y: 500 });
    await expect(resolveOutlineDestination(documentWith([]), [0, { name: "FitV" }, 200]))
      .resolves.toMatchObject({ x: 200, y: LETTER.height / 2 });
  });

  it("lands FitR on the rectangle top-left corner", async () => {
    await expect(resolveOutlineDestination(documentWith([]), [0, { name: "FitR" }, 10, 30, 90, 700]))
      .resolves.toMatchObject({ x: 10, y: 700 });
  });

  it("clamps a coordinate outside the box by at most eight points", async () => {
    // Exactly at tolerance on both ends clamps onto the boundary.
    await expect(resolveOutlineDestination(documentWith([]), xyz(-8, LETTER.height + 8)))
      .resolves.toMatchObject({ x: 0, y: LETTER.height });
    // Just inside tolerance still clamps.
    await expect(resolveOutlineDestination(documentWith([]), xyz(-7.5, 100)))
      .resolves.toMatchObject({ x: 0 });
  });

  it("rejects a coordinate beyond the eight-point tolerance", async () => {
    // Just past tolerance is invalid, not clamped: landing would be wrong.
    await expect(resolveOutlineDestination(documentWith([]), xyz(-8.5, 100))).resolves.toBeUndefined();
    await expect(resolveOutlineDestination(documentWith([]), xyz(100, LETTER.height + 8.5))).resolves.toBeUndefined();
  });

  it("rejects non-finite coordinates rather than treating them as unspecified", async () => {
    // NaN is corrupt data. Centering it would invent a destination.
    await expect(resolveOutlineDestination(documentWith([]), xyz(Number.NaN, 100))).resolves.toBeUndefined();
    await expect(resolveOutlineDestination(documentWith([]), xyz(100, Number.POSITIVE_INFINITY))).resolves.toBeUndefined();
  });

  it("rejects a destination on a foreign page", async () => {
    const foreign = documentWith([], { getPageIndex: async () => 99 });
    await expect(resolveOutlineDestination(foreign, [{ num: 9, gen: 0 }, { name: "XYZ" }, 10, 10, null]))
      .resolves.toBeUndefined();
  });

  it("resolves against a translated media box in box-relative coordinates", async () => {
    // A non-zero viewBox origin must not shift the landing point.
    const translated = documentWith([], {}, [20, 40, 632, 832]);
    await expect(resolveOutlineDestination(translated, xyz(null, null)))
      .resolves.toMatchObject({ x: 306, y: 396, pageWidth: 612, pageHeight: 792 });
    await expect(resolveOutlineDestination(translated, xyz(20, 40)))
      .resolves.toMatchObject({ x: 0, y: 0 });
  });

  it("fails closed on a degenerate media box", async () => {
    const degenerate = documentWith([], {}, [0, 0, 0, 0]);
    await expect(resolveOutlineDestination(degenerate, xyz(0, 0))).resolves.toBeUndefined();
  });

  it("fails closed when the page cannot be loaded", async () => {
    const broken = documentWith([], { getPage: async () => { throw new Error("page gone"); } });
    await expect(resolveOutlineDestination(broken, xyz(10, 10))).resolves.toBeUndefined();
  });

  it("rejects a structurally invalid destination array", async () => {
    await expect(resolveOutlineDestination(documentWith([]), [0, { name: "Nonsense" }, 1])).resolves.toBeUndefined();
    await expect(resolveOutlineDestination(documentWith([]), "unresolvable-name")).resolves.toBeUndefined();
  });
});

describe("PdfOutlineAdapter tree reading", () => {
  it("returns an empty tree for a PDF with no embedded outline", async () => {
    // Explicit non-scope: never infer or generate an outline.
    await expect(readOutlineTree(documentWith(null))).resolves.toEqual([]);
    await expect(readOutlineTree(documentWith([]))).resolves.toEqual([]);
  });

  it("preserves titles, nesting, and resolved destinations", async () => {
    const tree = await readOutlineTree(documentWith([
      { title: "Chapter", dest: xyz(10, 700), items: [{ title: "Section", dest: xyz(10, 600), items: [] }] },
    ]));
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ title: "Chapter", destination: { pageIndex: 0, y: 700 } });
    expect(tree[0]?.children?.[0]).toMatchObject({ title: "Section", destination: { y: 600 } });
  });

  it("keeps a node whose destination is invalid, without a destination", async () => {
    // The row must stay visible but disabled, so the node survives normalization.
    const tree = await readOutlineTree(documentWith([{ title: "Broken", dest: xyz(-40, 10), items: [] }]));
    expect(tree[0]).toMatchObject({ title: "Broken" });
    expect(tree[0]?.destination).toBeUndefined();
  });

  it("allows the same child object under two parents without reporting a cycle", async () => {
    // Sibling reuse is legal in PDF outlines; only a self-referential path is a cycle.
    const shared: PdfOutlineAdapterItem = { title: "Shared", dest: xyz(10, 500), items: [] };
    const tree = await readOutlineTree(documentWith([
      { title: "A", dest: xyz(10, 700), items: [shared] },
      { title: "B", dest: xyz(10, 600), items: [shared] },
    ]));
    expect(tree).toHaveLength(2);
    expect(tree[0]?.children?.[0]).toMatchObject({ title: "Shared" });
    expect(tree[1]?.children?.[0]).toMatchObject({ title: "Shared" });
  });

  it("fails closed on a genuine cycle", async () => {
    const cyclic: { title: string; dest: null; items: PdfOutlineAdapterItem[] } = { title: "loop", dest: null, items: [] };
    cyclic.items.push(cyclic);
    await expect(readOutlineTree(documentWith([cyclic]))).rejects.toThrow("OUTLINE_CYCLE");
  });

  it("fails closed beyond the bounded depth", async () => {
    const root: { title: string; dest: null; items: PdfOutlineAdapterItem[] } = { title: "0", dest: null, items: [] };
    let parent = root;
    for (let depth = 1; depth <= 40; depth += 1) {
      const child = { title: String(depth), dest: null, items: [] as PdfOutlineAdapterItem[] };
      parent.items.push(child);
      parent = child;
    }
    await expect(readOutlineTree(documentWith([root]))).rejects.toThrow("OUTLINE_DEPTH_LIMIT");
  });

  it("reports an unavailable outline distinctly from an absent one", async () => {
    const broken = documentWith(null, { getOutline: async () => { throw new Error("boom"); } });
    await expect(readOutlineTree(broken)).rejects.toThrow("PDF_OUTLINE_UNAVAILABLE");
  });
});

describe("PdfOutlineAdapter composed with the pure model", () => {
  it("produces enabled centered rows for sentinel destinations end to end", async () => {
    // The whole point of the center rule: a sentinel row is usable, not disabled.
    const tree = await readOutlineTree(documentWith([
      { title: "Sentinel", dest: xyz(null, null), items: [] },
      { title: "Precise", dest: xyz(10, 700), items: [] },
      { title: "Broken", dest: xyz(0, 5000), items: [] },
    ]));
    const rows = normalizeOutline(tree);

    expect(rows.map((row) => ({ title: row.title, enabled: row.enabled, selector: row.selector }))).toEqual([
      { title: "Sentinel", enabled: true, selector: "1" },
      { title: "Precise", enabled: true, selector: "2" },
      { title: "Broken", enabled: false, selector: undefined },
    ]);
    expect(rows[0]?.destination).toMatchObject({ x: LETTER.width / 2, y: LETTER.height / 2 });
  });

  it("hides a single wrapper and still assigns contiguous selectors", async () => {
    const tree = await readOutlineTree(documentWith([
      { title: "Wrapper", dest: null, items: [
        { title: "One", dest: xyz(10, 700), items: [] },
        { title: "Two", dest: xyz(10, 600), items: [] },
      ] },
    ]));
    const rows = normalizeOutline(tree);
    expect(rows.map((row) => row.title)).toEqual(["One", "Two"]);
    expect(rows.map((row) => row.selector)).toEqual(["1", "2"]);
  });
});
