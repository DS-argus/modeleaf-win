import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  FIXTURE_NAMES,
  generateGoldenFixtures,
} from "../../tools/fixtures/generate-golden-pdfs.mjs";

interface OutlineNode {
  title: string;
  dest: unknown;
  items: OutlineNode[];
}

interface AnnotationRecord {
  subtype?: string;
  url?: string;
  dest?: unknown;
  rect?: number[];
  fieldValue?: unknown;
}
const standardFontDataUrl = `${join(
  process.cwd(),
  "node_modules",
  "pdfjs-dist",
  "standard_fonts",
).replaceAll("\\", "/")}/`;
const EXPECTED_SENTINELS: Record<string, unknown> = {
  "text-3-page.pdf": {},
  "fixture-S-text-10.pdf": { pattern: "s-magenta-lime-diagonal-v1" },
  "fixture-L-text-300.pdf": { pattern: "l-lime-magenta-columns-v1" },
  "fixture-F-raster-12.pdf": {
    pattern: "f-magenta-lime-frame-v1",
    raster_width: 850,
    raster_height: 1100,
    full_page: true,
    no_searchable_text: true,
  },
  "fixture-B-blank.pdf": { no_searchable_text: true },
  "image-only-2-page.pdf": { no_searchable_text: true, no_ocr: true },
  "malformed.pdf": { class: "malformed" },
  "locked.pdf": { class: "locked" },
  "empty.pdf": { class: "zero-pages" },
  "links.pdf": {
    allowed_url: "https://example.invalid/allowed",
    forbidden_url: "file:///C:/forbidden",
    goto_point: true,
    goto_no_point: true,
    unresolved: true,
    foreign: true,
    text_only_url: true,
  },
  "link-landing-3-page.pdf": {
    target: { page: 2, mode: "XYZ", x: 306, y: 40 },
    first_boundary: { page: 1, mode: "XYZ", x: 306, y: 780 },
    last_boundary: { page: 3, mode: "XYZ", x: 306, y: 12 },
    viewport_height_css: 600,
    page_3_visible_after_center: true,
    page_3_raster: "link-landing-page-3-raster-v1",
  },
  "link-duplicates.pdf": {
    exact_duplicates: 2,
    adjacent_same_target: true,
    wrapped_rectangles: true,
  },
  "outline.pdf": {
    wrapper: true,
    visible_depths: 2,
    deeper_hidden_child: true,
    duplicate_destinations: 2,
    invalid_row: true,
    edge_destination_y: 679,
    page_height: 676.3,
    edge_overshoot: 2.7,
  },
  "interactive.pdf": {
    widget: "sentinel-widget-value",
    note: "sentinel-note-contents",
    scripting_suppressed: true,
    media_suppressed: true,
  },
  "unicode-text.pdf": { nfc: "café", nfd: "café", rtl: "مرحبا" },
  "한글 공백 😀.pdf": { unicode_filename: true },
  "print-mixed-rotation-4.pdf": {
    identity: "print-mixed-rotation-4-v1",
    corner_markers:
      "tl-red-square-tr-green-tall-br-blue-wide-bl-orange-tall",
    orientation_markers: [
      "print-mixed-page-1-r0-source-top-arrow",
      "print-mixed-page-2-r90-source-top-arrow",
      "print-mixed-page-3-r180-source-top-arrow",
      "print-mixed-page-4-r270-source-top-arrow",
    ],
  },
};
const digest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function flattenOutline(
  nodes: OutlineNode[],
  depth = 0,
): Array<OutlineNode & { depth: number }> {
  return nodes.flatMap((node) => [
    { ...node, depth },
    ...flattenOutline(node.items ?? [], depth + 1),
  ]);
}

async function inspectPdf(pdf: Uint8Array, password?: string) {
  const task = getDocument({
    data: pdf,
    password,
    isEvalSupported: false,
    useWorkerFetch: false,
    standardFontDataUrl,
  } as never);
  const document = await task.promise;
  const text: string[] = [];
  const annotations: AnnotationRecord[] = [];
  const pageAnnotations: AnnotationRecord[][] = [];
  const pageViews: number[][] = [];
  const pageRotations: number[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    pageViews.push([...page.view]);
    pageRotations.push(page.rotate);
    const content = await page.getTextContent();
    text.push(
      content.items.map((item) => ("str" in item ? item.str : "")).join(""),
    );
    const currentAnnotations = (await page.getAnnotations({
      intent: "display",
    })) as AnnotationRecord[];
    pageAnnotations.push(currentAnnotations);
    annotations.push(...currentAnnotations);
  }
  const outline = flattenOutline(
    ((await document.getOutline()) ?? []) as OutlineNode[],
  );
  const pages = document.numPages;
  await task.destroy();
  return {
    pages,
    text: text.join("\n"),
    pageText: text,
    annotations,
    pageAnnotations,
    outline,
    pageViews,
    pageRotations,
  };
}

function countAnnotations(annotations: AnnotationRecord[]) {
  return {
    links: annotations.filter(({ subtype }) => subtype === "Link").length,
    forms: annotations.filter(({ subtype }) => subtype === "Widget").length,
    media: annotations.filter(({ subtype }) => subtype === "Screen").length,
  };
}

describe("golden PDF fixtures", () => {
  it("regenerates byte-for-byte and verifies every committed manifest contract", async () => {
    const first = await mkdtemp(join(tmpdir(), "modeleaf-golden-one-"));
    const second = await mkdtemp(join(tmpdir(), "modeleaf-golden-two-"));
    try {
      const options = { outputDirectory: "pdf", manifestPath: "manifest.json" };
      const one = await generateGoldenFixtures({
        rootDirectory: first,
        ...options,
      });
      const repeated = await generateGoldenFixtures({
        rootDirectory: first,
        ...options,
      });
      const two = await generateGoldenFixtures({
        rootDirectory: second,
        ...options,
      });
      expect(
        repeated,
        "same-target regeneration must be deterministic",
      ).toEqual(one);
      expect(two, "cross-directory generation must be deterministic").toEqual(
        one,
      );
      expect(
        one.files.map(({ name }) => name),
        "fixture set changed",
      ).toEqual(FIXTURE_NAMES);
      expect(new Set(one.files.map(({ name }) => name)).size).toBe(
        FIXTURE_NAMES.length,
      );
      expect(Object.keys(one.path_scenarios).sort()).toEqual([
        "junction_symlink_copies",
        "unc_transient_errors",
        "unicode",
        "windows_long_path",
      ]);

      const committedManifest = JSON.parse(
        await readFile(
          join(process.cwd(), "fixtures", "manifest.json"),
          "utf8",
        ),
      );
      expect(
        committedManifest,
        "committed manifest differs from regeneration",
      ).toEqual(one);
      const generator = await readFile(
        join(process.cwd(), "tools", "fixtures", "generate-golden-pdfs.mjs"),
      );
      expect(one.generator_sha256, "generator hash is stale").toBe(
        digest(generator),
      );
      expect(
        JSON.stringify(one),
        "manifest must not contain a password field",
      ).not.toMatch(/"[^"]*password[^"]*"\s*:/i);

      for (const file of one.files) {
        const firstBytes = await readFile(join(first, "pdf", file.name));
        const secondBytes = await readFile(join(second, "pdf", file.name));
        const committedBytes = await readFile(
          join(process.cwd(), "fixtures", "pdf", file.name),
        );
        expect(
          firstBytes.equals(secondBytes),
          `${file.name} changed between runs`,
        ).toBe(true);
        expect(
          firstBytes.equals(committedBytes),
          `${file.name} committed bytes are stale`,
        ).toBe(true);
        expect(digest(firstBytes), `${file.name} hash`).toBe(file.sha256);
        expect(firstBytes.length, `${file.name} byte count`).toBe(file.bytes);
        expect(file.license, `${file.name} license`).toBe("test-generated");
        expect(file.source, `${file.name} source`).toContain("v0.10.0");
        expect(
          file.sentinel,
          `${file.name} complete sentinel contract`,
        ).toEqual(EXPECTED_SENTINELS[file.name]);

        if (file.name === "malformed.pdf") {
          expect(firstBytes.subarray(0, 5).toString("ascii")).not.toBe("%PDF-");
          await expect(
            inspectPdf(new Uint8Array(firstBytes)),
          ).rejects.toThrow();
          continue;
        }
        expect(
          firstBytes.subarray(0, 5).toString("ascii"),
          `${file.name} signature`,
        ).toBe("%PDF-");
        if (file.name === "locked.pdf") {
          await expect(
            inspectPdf(new Uint8Array(firstBytes)),
          ).rejects.toMatchObject({ name: "PasswordException" });
          const unlocked = await inspectPdf(
            new Uint8Array(firstBytes),
            "modeleaf",
          );
          expect(unlocked.pages, "locked.pdf page count").toBe(file.pages);
          expect(countAnnotations(unlocked.annotations)).toEqual(
            file.expected_annotations,
          );
          expect(unlocked.outline).toHaveLength(
            file.expected_outline.row_count,
          );
          continue;
        }

        const parsed = await inspectPdf(new Uint8Array(firstBytes));
        expect(parsed.pages, `${file.name} page count`).toBe(file.pages);
        for (const expected of file.expected_text) {
          expect(
            parsed.text,
            `${file.name} expected text ${expected}`,
          ).toContain(expected);
        }
        const sentinel: { no_searchable_text?: boolean; pattern?: string } =
          file.sentinel;
        if (sentinel.no_searchable_text) {
          expect(
            parsed.text.trim(),
            `${file.name} must not contain extractable text`,
          ).toBe("");
        }
        if (file.name === "image-only-2-page.pdf") {
          const raw = firstBytes.toString("latin1");
          expect(raw.match(/\/Subtype \/Image/g) ?? []).toHaveLength(2);
          expect(file.sentinel).toMatchObject({
            no_searchable_text: true,
            no_ocr: true,
          });
        }
        if (sentinel.pattern) {
          const raw = firstBytes.toString("latin1");
          expect(raw, `${file.name} visible sentinel name`).toContain(
            `% ${sentinel.pattern}`,
          );
          expect(raw, `${file.name} visible sentinel bounds`).toContain(
            "48 568 192 128 re f",
          );
          if (file.name === "fixture-F-raster-12.pdf") {
            expect(raw.match(/\/Subtype \/Image/g) ?? []).toHaveLength(
              file.pages,
            );
            expect(raw).toContain("/Width 850 /Height 1100");
            expect(raw).toContain("q 612 0 0 792 0 0 cm");
            expect(firstBytes.length).toBeGreaterThan(32 * 1024 * 1024);
            expect(file.sentinel).toMatchObject({
              raster_width: 850,
              raster_height: 1100,
              full_page: true,
            });
          }
        }
        expect(
          countAnnotations(parsed.annotations),
          `${file.name} annotation contract`,
        ).toEqual(file.expected_annotations);
        expect(parsed.outline, `${file.name} outline row count`).toHaveLength(
          file.expected_outline.row_count,
        );
        expect(
          parsed.outline.map(({ title }) => title),
          `${file.name} outline rows`,
        ).toEqual(file.expected_outline.rows);
      }

      const links = await inspectPdf(
        new Uint8Array(await readFile(join(first, "pdf", "links.pdf"))),
      );
      expect(
        links.annotations.filter(({ subtype }) => subtype === "Link"),
      ).toHaveLength(6);
      expect(
        links.annotations.some(({ url }) => url?.includes("text-only-url")),
      ).toBe(false);
      const internalDestinations = links.annotations.flatMap(({ dest }) =>
        Array.isArray(dest) ? [dest] : [],
      );
      expect(internalDestinations).toHaveLength(2);
      expect(
        internalDestinations.some(
          (dest) =>
            (dest[1] as { name?: string })?.name === "XYZ" &&
            dest[2] === 42 &&
            dest[3] === 600,
        ),
      ).toBe(true);
      expect(
        internalDestinations.some(
          (dest) => (dest[1] as { name?: string })?.name === "Fit",
        ),
      ).toBe(true);
      expect(
        links.annotations.some(({ dest }) => dest === "unresolved-destination"),
      ).toBe(true);
      const linksRaw = (
        await readFile(join(first, "pdf", "links.pdf"))
      ).toString("latin1");
      for (const sentinel of [
        "https://example.invalid/allowed",
        "file:///C:/forbidden",
        "/GoTo",
        "/GoToR",
        "unresolved-destination",
        "text-only-url",
      ]) {
        expect(linksRaw, `links sentinel ${sentinel}`).toContain(sentinel);
      }

      const linkLandingBytes = await readFile(
        join(first, "pdf", "link-landing-3-page.pdf"),
      );
      const linkLanding = await inspectPdf(
        new Uint8Array(linkLandingBytes),
      );
      expect(linkLanding.pageViews).toEqual([
        [0, 0, 612, 792],
        [0, 0, 612, 792],
        [0, 0, 612, 792],
      ]);
      expect(linkLanding.pageText).toHaveLength(3);
      expect(linkLanding.pageText[0]).toContain("Link landing source page one");
      expect(linkLanding.pageText[1]).toContain("Link landing target page two");
      expect(linkLanding.pageText[2]).toContain("Link landing visible page three");
      expect(
        linkLanding.pageAnnotations.map((page) =>
          page.filter(({ subtype }) => subtype === "Link").length,
        ),
      ).toEqual([3, 0, 0]);
      const landingLinks = linkLanding.pageAnnotations[0]!.filter(
        ({ subtype }) => subtype === "Link",
      );
      expect(landingLinks.map(({ rect }) => rect)).toEqual([
        [48, 690, 270, 714],
        [48, 650, 270, 674],
        [48, 610, 270, 634],
      ]);
      expect(landingLinks.map(({ dest }) => dest)).toEqual([
        [{ num: 9, gen: 0 }, { name: "XYZ" }, 306, 40, null],
        [{ num: 4, gen: 0 }, { name: "XYZ" }, 306, 780, null],
        [{ num: 11, gen: 0 }, { name: "XYZ" }, 306, 12, null],
      ]);
      const linkLandingRaw = linkLandingBytes.toString("latin1");
      expect(linkLandingRaw).toContain("% link-landing-page-3-raster-v1");
      expect(linkLandingRaw).toContain("48 650 192 48 re f");

      const printMixedBytes = await readFile(
        join(first, "pdf", "print-mixed-rotation-4.pdf"),
      );
      const printMixed = await inspectPdf(new Uint8Array(printMixedBytes));
      const printMixedPageViews = [
        [0, 0, 612, 792],
        [0, 0, 792, 612],
        [0, 0, 400, 600],
        [0, 0, 600, 400],
      ];
      const printMixedRotations = [0, 90, 180, 270];
      const printMixedText = [
        "Print mixed rotation page 1 612x792 rotate 0",
        "Print mixed rotation page 2 792x612 rotate 90",
        "Print mixed rotation page 3 400x600 rotate 180",
        "Print mixed rotation page 4 600x400 rotate 270",
      ];
      const printMixedOrientationMarkers = [
        "print-mixed-page-1-r0-source-top-arrow",
        "print-mixed-page-2-r90-source-top-arrow",
        "print-mixed-page-3-r180-source-top-arrow",
        "print-mixed-page-4-r270-source-top-arrow",
      ];
      expect(printMixed.pageViews).toEqual(printMixedPageViews);
      expect(printMixed.pageRotations).toEqual(printMixedRotations);
      expect(printMixed.pageText).toEqual(printMixedText);
      const printMixedMetadata = one.files.find(
        ({ name }) => name === "print-mixed-rotation-4.pdf",
      );
      if (printMixedMetadata === undefined || !("page_sizes" in printMixedMetadata) || !("rotations" in printMixedMetadata)) {
        throw new Error("Mixed print fixture metadata is incomplete");
      }
      expect(printMixedMetadata?.page_sizes).toEqual(
        printMixedPageViews.map(([, , width, height]) => [width, height]),
      );
      expect(printMixedMetadata?.rotations).toEqual(printMixedRotations);
      const printMixedRaw = printMixedBytes.toString("latin1");
      expect(
        printMixedRaw.match(/% print-mixed-rotation-4-v1/g) ?? [],
      ).toHaveLength(4);
      expect(
        Array.from(
          printMixedRaw.matchAll(
            /% (print-mixed-page-\d-r\d+-source-top-arrow)/g,
          ),
          (match) => match[1],
        ),
      ).toEqual(printMixedOrientationMarkers);
      expect(
        printMixedRaw.match(
          /% tl-red-square-tr-green-tall-br-blue-wide-bl-orange-tall/g,
        ) ?? [],
      ).toHaveLength(4);

      const duplicates = await inspectPdf(
        new Uint8Array(
          await readFile(join(first, "pdf", "link-duplicates.pdf")),
        ),
      );
      const duplicateLinks = duplicates.annotations.filter(
        ({ url }) => url === "https://example.invalid/duplicate",
      );
      expect(duplicateLinks).toHaveLength(3);
      expect(duplicateLinks[0]?.rect).toEqual(duplicateLinks[1]?.rect);
      expect(duplicateLinks[2]?.rect).not.toEqual(duplicateLinks[0]?.rect);
      const wrappedLinks = duplicates.annotations.filter(
        ({ url }) => url === "https://example.invalid/wrapped",
      );
      expect(wrappedLinks).toHaveLength(2);
      expect(wrappedLinks[0]?.rect).not.toEqual(wrappedLinks[1]?.rect);

      const outline = await inspectPdf(
        new Uint8Array(await readFile(join(first, "pdf", "outline.pdf"))),
      );
      expect(outline.outline).toHaveLength(10);
      expect(outline.outline.filter(({ depth }) => depth === 0)).toHaveLength(
        1,
      );
      expect(
        outline.outline.find(({ title }) => title === "7 Deeper hidden child")
          ?.depth,
      ).toBe(3);
      expect(
        outline.outline.find(({ title }) => title === "8 Invalid row")?.dest,
      ).toBeNull();
      expect(
        outline.outline.find(({ title }) => title === "3 Duplicate A")?.dest,
      ).toEqual(
        outline.outline.find(({ title }) => title === "4 Duplicate B")?.dest,
      );
      expect(
        outline.outline.find(({ title }) => title === "12 Edge destination")
          ?.dest,
      ).toEqual([{ num: 4, gen: 0 }, { name: "XYZ" }, 42, 679, null]);
      expect(outline.pageViews[0]).toEqual([0, 0, 612, 676.3]);
      const outlineHeight = outline.pageViews[0]?.[3] ?? Number.NaN;
      expect(679).toBeGreaterThan(outlineHeight);
      expect(679 - outlineHeight).toBeCloseTo(2.7, 5);
      expect(679 - outlineHeight).toBeLessThanOrEqual(8);
      expect(
        one.files.find(({ name }) => name === "outline.pdf")?.sentinel,
      ).toMatchObject({
        page_height: 676.3,
        edge_destination_y: 679,
        edge_overshoot: 2.7,
      });

      const interactiveRaw = (
        await readFile(join(first, "pdf", "interactive.pdf"))
      ).toString("latin1");
      for (const sentinel of [
        "/Widget",
        "sentinel-widget-value",
        "/Text",
        "sentinel-note-contents",
        "/JavaScript",
        "/Screen",
      ]) {
        expect(interactiveRaw, `interactive sentinel ${sentinel}`).toContain(
          sentinel,
        );
      }
      const lockedRaw = (
        await readFile(join(first, "pdf", "locked.pdf"))
      ).toString("latin1");
      expect(
        lockedRaw,
        "locked fixture must use PDF standard encryption",
      ).toContain("/Filter /Standard");

      await expect(
        generateGoldenFixtures({
          rootDirectory: first,
          outputDirectory: "../escape",
          manifestPath: "manifest.json",
        }),
      ).rejects.toThrow(/unsafe fixture path/);
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });
});
