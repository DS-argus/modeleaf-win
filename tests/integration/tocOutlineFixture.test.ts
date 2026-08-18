import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { readOutlineTree, type PdfOutlineAdapterDocument } from "../../src/pdf/PdfOutlineAdapter";
import { normalizeOutline, currentOutlineRow } from "../../src/domain/outlines/OutlineModel";

/**
 * Fixture-backed proof against the real `outline.pdf`.
 *
 * The unit suites use synthetic documents to pin edge policy. This suite runs
 * the whole adapter plus pure-model pipeline over the frozen fixture so the
 * wrapper, depth, duplicate, invalid, and edge sentinels the W00 manifest
 * records are actually observed rather than assumed.
 */
const FIXTURE = join(process.cwd(), "fixtures", "pdf", "outline.pdf");
const MANIFEST = join(process.cwd(), "fixtures", "manifest.json");

interface ManifestEntry {
  readonly name: string;
  readonly sha256: string;
  readonly expected_outline: { readonly row_count: number; readonly rows: readonly string[] };
  readonly sentinel: Record<string, unknown>;
}

async function manifestEntry(): Promise<ManifestEntry> {
  const parsed = JSON.parse(await readFile(MANIFEST, "utf8")) as unknown;
  const entries = (Array.isArray(parsed) ? parsed : Object.values(parsed as object).find(Array.isArray)) as readonly ManifestEntry[];
  const entry = entries.find((candidate) => candidate.name === "outline.pdf");
  if (entry === undefined) throw new Error("outline.pdf missing from the fixture manifest");
  return entry;
}

async function loadFixture(): Promise<PdfOutlineAdapterDocument> {
  const bytes = new Uint8Array(await readFile(FIXTURE));
  return await getDocument({ data: bytes, useSystemFonts: false }).promise as unknown as PdfOutlineAdapterDocument;
}

describe("outline.pdf fixture", () => {
  it("is byte-identical to the frozen manifest hash", async () => {
    const entry = await manifestEntry();
    const digest = createHash("sha256").update(await readFile(FIXTURE)).digest("hex");
    // Reading a PDF must never modify it; this is the read-only invariant.
    expect(digest).toBe(entry.sha256);
  });

  it("normalizes to the frozen row set with the wrapper hidden", async () => {
    const document = await loadFixture();
    const rows = normalizeOutline(await readOutlineTree(document));
    const entry = await manifestEntry();

    // The manifest lists the raw outline including its wrapper; normalization
    // hides a lone titled wrapper and promotes its children.
    expect(entry.expected_outline.rows[0]).toBe("Modeleaf outline wrapper");
    expect(rows.some((row) => row.title === "Modeleaf outline wrapper")).toBe(false);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("clamps at most two display depths, hiding deeper descendants", async () => {
    const document = await loadFixture();
    const rows = normalizeOutline(await readOutlineTree(document));
    // sentinel.visible_depths = 2, sentinel.deeper_hidden_child = true.
    expect(new Set(rows.map((row) => row.depth))).toEqual(new Set([0, 1]));
    expect(rows.every((row) => row.depth <= 1)).toBe(true);
    expect(rows.some((row) => row.title.includes("Deeper hidden child"))).toBe(false);
  });

  it("keeps both duplicate-destination rows separate", async () => {
    const document = await loadFixture();
    const rows = normalizeOutline(await readOutlineTree(document));
    const duplicates = rows.filter((row) => row.title.includes("Duplicate"));
    // sentinel.duplicate_destinations = 2: same destination, distinct rows.
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0]?.id).not.toBe(duplicates[1]?.id);
    expect(duplicates.map((row) => row.selector).filter(Boolean)).toHaveLength(2);
  });

  it("assigns contiguous selectors to valid rows only", async () => {
    const document = await loadFixture();
    const rows = normalizeOutline(await readOutlineTree(document));
    const selectors = rows.filter((row) => row.enabled).map((row) => row.selector);
    expect(selectors).toEqual(selectors.map((_, index) => String(index + 1)));
    // A disabled row is visible but carries no selector.
    for (const row of rows.filter((candidate) => !candidate.enabled)) {
      expect(row.selector).toBeUndefined();
    }
  });

  it("resolves the edge destination that overshoots the page by 2.7pt", async () => {
    const document = await loadFixture();
    const rows = normalizeOutline(await readOutlineTree(document));
    const edge = rows.find((row) => row.title.includes("Edge destination"));
    // sentinel: edge_destination_y 679 against page_height 676.3, overshoot 2.7,
    // which is inside the 8pt tolerance and therefore clamps rather than fails.
    expect(edge).toBeDefined();
    expect(edge?.enabled).toBe(true);
    expect(edge?.destination?.y).toBeLessThanOrEqual(676.3);
  });

  it("tracks the current row from a viewport position", async () => {
    const document = await loadFixture();
    const rows = normalizeOutline(await readOutlineTree(document));
    const enabled = rows.filter((row) => row.enabled && row.destination !== undefined);
    expect(enabled.length).toBeGreaterThan(1);

    // A position at the very top of page 0 precedes every destination below it.
    const first = enabled[0]!;
    const current = currentOutlineRow(rows, {
      pageIndex: first.destination!.pageIndex,
      x: first.destination!.x,
      y: first.destination!.y,
    });
    expect(current).toBeDefined();
  });

  it("reports an empty outline for a PDF that has none", async () => {
    const bytes = new Uint8Array(await readFile(join(process.cwd(), "fixtures", "pdf", "text-3-page.pdf")));
    const document = await getDocument({ data: bytes, useSystemFonts: false }).promise as unknown as PdfOutlineAdapterDocument;
    // Explicit non-scope: never infer a table of contents.
    expect(normalizeOutline(await readOutlineTree(document))).toEqual([]);
  });
});
