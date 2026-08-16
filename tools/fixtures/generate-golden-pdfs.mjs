import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdversarialPdfs } from "./generate-adversarial-pdfs.mjs";

export const SCHEMA_VERSION = 1;
export const GENERATOR_VERSION = "1";
export const FIXTURE_NAMES = [
  "text-3-page.pdf",
  "fixture-S-text-10.pdf",
  "fixture-L-text-300.pdf",
  "fixture-F-raster-12.pdf",
  "fixture-B-blank.pdf",
  "image-only-2-page.pdf",
  "malformed.pdf",
  "locked.pdf",
  "empty.pdf",
  "links.pdf",
  "link-duplicates.pdf",
  "outline.pdf",
  "interactive.pdf",
  "unicode-text.pdf",
  "한글 공백 😀.pdf",
];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = "fixtures/pdf";
const MANIFEST = "fixtures/manifest.json";
const ID = "4d4f44454c454146474f4c44454e3031";
const A4 = "[0 0 612 792]";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ascii = (value) => Buffer.from(value, "ascii");
const literal = (value) => value.replace(/[\\()]/g, "\\$&");
const stream = (dictionary, contents) =>
  Buffer.concat([
    ascii(`${dictionary} /Length ${contents.length} >>\nstream\n`),
    contents,
    ascii("\nendstream"),
  ]);

/** Build a classic-xref PDF with fixed IDs and metadata. */
function pdf(objects, trailer = "") {
  const chunks = [ascii("%PDF-1.7\n%\x80\x81\x82\x83\n")];
  const offsets = [0];
  let offset = chunks[0].length;
  for (let index = 0; index < objects.length; index += 1) {
    const body = Buffer.isBuffer(objects[index])
      ? objects[index]
      : ascii(objects[index]);
    const head = ascii(`${index + 1} 0 obj\n`);
    const tail = ascii("\nendobj\n");
    offsets.push(offset);
    chunks.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  }
  const xref = offset;
  chunks.push(ascii(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
  for (let index = 1; index < offsets.length; index += 1)
    chunks.push(
      ascii(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`),
    );
  chunks.push(
    ascii(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 3 0 R /ID [<${ID}> <${ID}>]${trailer} >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}
function document(
  pageSpecs,
  extra = [],
  catalog = "<< /Type /Catalog /Pages 2 0 R >>",
) {
  const objects = [
    catalog,
    "",
    "<< /Title (Modeleaf deterministic golden fixtures) /Creator (Modeleaf) /Producer (Modeleaf) /CreationDate (D:20000101000000Z) /ModDate (D:20000101000000Z) >>",
  ];
  const pages = [];
  for (const spec of pageSpecs) {
    const page = objects.length + 1;
    objects.push("");
    const content = objects.length + 1;
    objects.push(stream("<<", ascii(spec.content ?? "q\nQ\n")));
    const annotations =
      spec.annots?.map((annotation) => {
        objects.push(annotation);
        return objects.length;
      }) ?? [];
    const resources = spec.resources ?? "<< >>";
    objects[page - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox ${spec.mediaBox ?? A4} /Resources ${resources} /Contents ${content} 0 R${annotations.length ? ` /Annots [${annotations.map((id) => `${id} 0 R`).join(" ")}]` : ""} >>`;
    pages.push(page);
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((id) => `${id} 0 R`).join(" ")}] >>`;
  for (const item of extra) objects.push(item);
  return pdf(objects);
}
const font =
  "<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>";
const SENTINEL_COLORS = {
  "s-magenta-lime-diagonal-v1": [
    "1 0 1",
    "0 0 0",
    "0 1 0",
    "1 1 1",
    "0 0 0",
    "0 1 0",
    "1 1 1",
    "1 0 1",
  ],
  "l-lime-magenta-columns-v1": [
    "0 1 0",
    "0 1 0",
    "0 0 0",
    "1 0 1",
    "1 1 1",
    "0 0 0",
    "1 0 1",
    "1 1 1",
  ],
  "f-magenta-lime-frame-v1": [
    "0 0 0",
    "1 0 1",
    "0 0 0",
    "0 1 0",
    "1 1 1",
    "0 1 0",
    "1 1 1",
    "1 0 1",
  ],
};
function sentinelCommands(pattern) {
  if (!pattern) return "";
  const colors = SENTINEL_COLORS[pattern];
  if (!colors) throw new Error(`unknown performance sentinel: ${pattern}`);
  const commands = [`% ${pattern}`, "0 0 0 rg", "48 568 192 128 re f"];
  for (let index = 0; index < colors.length; index += 1) {
    const column = index % 4;
    const row = Math.floor(index / 4);
    commands.push(
      `${colors[index]} rg`,
      `${52 + column * 48} ${572 + row * 64} 40 56 re f`,
    );
  }
  return `${commands.join("\n")}\n`;
}
function textPages(count, prefix, sentinel = "") {
  return document(
    Array.from({ length: count }, (_, index) => ({
      resources: font,
      content: `BT /F1 14 Tf 48 720 Td (${literal(`${prefix} page ${index + 1} copyable needle`)}) Tj ET\n${index === 0 ? sentinelCommands(sentinel) : ""}`,
    })),
  );
}
function imageBytes(page) {
  const pixels = Buffer.alloc(256 * 256 * 3);
  let state = (0x4d4f4445 ^ Math.imul(page, 0x9e3779b9)) >>> 0;
  for (let index = 0; index < pixels.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[index] = state & 0xff;
  }
  return pixels;
}
function imagePages(count, sentinel = "") {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Title (Modeleaf deterministic raster fixture) /Creator (Modeleaf) /CreationDate (D:20000101000000Z) >>",
  ];
  const pageIds = [];
  for (let page = 1; page <= count; page += 1) {
    const pageId = objects.length + 1;
    objects.push("");
    const contentId = objects.length + 1;
    objects.push(
      stream(
        "<<",
        ascii(
          `q 512 0 0 512 50 140 cm /Im${page} Do Q\n${page === 1 ? sentinelCommands(sentinel) : ""}`,
        ),
      ),
    );
    const imageId = objects.length + 1;
    objects.push(
      stream(
        "<< /Type /XObject /Subtype /Image /Width 256 /Height 256 /ColorSpace /DeviceRGB /BitsPerComponent 8",
        imageBytes(page),
      ),
    );
    objects[pageId - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox ${A4} /Resources << /XObject << /Im${page} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    pageIds.push(pageId);
  }
  objects[1] = `<< /Type /Pages /Count ${count} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  return pdf(objects);
}
function linksPdf(duplicates = false) {
  const annotations = duplicates
    ? [
        "<< /Type /Annot /Subtype /Link /Rect [48 700 148 720] /A << /S /URI /URI (https://example.invalid/duplicate) >> >>",
        "<< /Type /Annot /Subtype /Link /Rect [48 700 148 720] /A << /S /URI /URI (https://example.invalid/duplicate) >> >>",
        "<< /Type /Annot /Subtype /Link /Rect [150 700 250 720] /A << /S /URI /URI (https://example.invalid/duplicate) >> >>",
        "<< /Type /Annot /Subtype /Link /Rect [48 660 148 680] /A << /S /URI /URI (https://example.invalid/wrapped) >> >>",
        "<< /Type /Annot /Subtype /Link /Rect [48 638 148 658] /A << /S /URI /URI (https://example.invalid/wrapped) >> >>",
      ]
    : [
        "<< /Type /Annot /Subtype /Link /Rect [48 700 170 720] /A << /S /URI /URI (https://example.invalid/allowed) >> >>",
        "<< /Type /Annot /Subtype /Link /Rect [48 670 170 690] /A << /S /URI /URI (file:///C:/forbidden) >> >>",
        "<< /Type /Annot /Subtype /Link /Rect [48 640 170 660] /A << /S /GoTo /D [12 0 R /XYZ 42 600 null] >> >>",
        "<< /Type /Annot /Subtype /Link /Rect [48 610 170 630] /A << /S /GoTo /D [12 0 R /Fit] >> >>",
        "<< /Type /Annot /Subtype /Link /Rect [48 580 170 600] /A << /S /GoTo /D (unresolved-destination) >> >>",
        "<< /Type /Annot /Subtype /Link /Rect [48 550 170 570] /A << /S /GoToR /F (foreign.pdf) /D [0 /Fit] >> >>",
      ];
  return document([
    {
      resources: font,
      content:
        "BT /F1 12 Tf 48 740 Td (https://example.invalid/text-only-url) Tj ET\n",
      annots: annotations,
    },
    { resources: font, content: "q Q\n" },
  ]);
}
function outlinePdf() {
  const pages = [
    {
      resources: font,
      content: "BT /F1 14 Tf 48 720 Td (outline page one) Tj ET",
    },
    {
      resources: font,
      content: "BT /F1 14 Tf 48 720 Td (outline page two) Tj ET",
    },
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R /PageMode /UseOutlines >>",
    "",
    "<< /Title (Modeleaf outline) /Creator (Modeleaf) /CreationDate (D:20000101000000Z) >>",
  ];
  const pageIds = [];
  for (const p of pages) {
    const id = objects.length + 1;
    objects.push("");
    const content = objects.length + 1;
    objects.push(stream("<<", ascii(p.content)));
    objects[id - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox ${A4} /Resources ${p.resources} /Contents ${content} 0 R >>`;
    pageIds.push(id);
  }
  objects[1] = `<< /Type /Pages /Count 2 /Kids [${pageIds[0]} 0 R ${pageIds[1]} 0 R] >>`;
  objects.push("<< /Type /Outlines /First 9 0 R /Last 9 0 R /Count 1 >>");
  objects.push(
    "<< /Title (Modeleaf outline wrapper) /Parent 8 0 R /First 10 0 R /Last 14 0 R /Count 5 >>",
  );
  objects.push(
    `<< /Title (1 Root) /Parent 9 0 R /Next 11 0 R /Dest [${pageIds[0]} 0 R /XYZ 42 640 null] >>`,
  );
  objects.push(
    `<< /Title (2 Interior) /Parent 9 0 R /Prev 10 0 R /Next 12 0 R /Dest [${pageIds[0]} 0 R /XYZ 42 600 null] >>`,
  );
  objects.push(
    `<< /Title (3 Duplicate A) /Parent 9 0 R /Prev 11 0 R /Next 13 0 R /Dest [${pageIds[1]} 0 R /XYZ 42 400 null] >>`,
  );
  objects.push(
    `<< /Title (4 Duplicate B) /Parent 9 0 R /Prev 12 0 R /Next 14 0 R /Dest [${pageIds[1]} 0 R /XYZ 42 400 null] >>`,
  );
  objects.push(
    `<< /Title (5 Nested parent) /Parent 9 0 R /Prev 13 0 R /First 15 0 R /Last 17 0 R /Count -3 /Dest [${pageIds[1]} 0 R /XYZ 42 510 null] >>`,
  );
  objects.push(
    `<< /Title (6 Hidden child) /Parent 14 0 R /Next 16 0 R /First 18 0 R /Last 18 0 R /Count -1 /Dest [${pageIds[1]} 0 R /XYZ 42 500 null] >>`,
  );
  objects.push(
    "<< /Title (8 Invalid row) /Parent 14 0 R /Prev 15 0 R /Next 17 0 R >>",
  );
  objects.push(
    `<< /Title (12 Edge destination) /Parent 14 0 R /Prev 16 0 R /Dest [${pageIds[0]} 0 R /XYZ 42 679 null] >>`,
  );
  objects.push(
    `<< /Title (7 Deeper hidden child) /Parent 15 0 R /Dest [${pageIds[1]} 0 R /XYZ 42 480 null] >>`,
  );
  return pdf(objects);
}
function interactivePdf() {
  const annots = [
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (suppressed-field) /V (sentinel-widget-value) /Rect [48 700 220 724] >>",
    "<< /Type /Annot /Subtype /Text /Contents (sentinel-note-contents) /Rect [48 660 70 682] >>",
    '<< /Type /Annot /Subtype /Link /Rect [48 620 220 642] /A << /S /JavaScript /JS (app.alert\\(\\"suppressed\\"\\)) >> >>',
    "<< /Type /Annot /Subtype /Screen /Rect [48 580 220 602] /A << /S /Rendition /OP 0 >> >>",
  ];
  return document(
    [
      {
        resources: font,
        content:
          "BT /F1 14 Tf 48 740 Td (interactive suppression sentinels) Tj ET",
        annots,
      },
    ],
    [],
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [6 0 R] >> /Names << /JavaScript << /Names [(suppressed-script) 8 0 R] >> >> >>",
  );
}
function unicodePdf() {
  const source = "한글 café café ابحرم"; // PDF content uses visual RTL order so PDF.js extracts logical text.
  const characters = [...source];
  const encoded = characters
    .map((_, index) => (index + 1).toString(16).padStart(4, "0"))
    .join("")
    .toUpperCase();
  const mappings = characters.map((character, index) => {
    const unicode = Buffer.from(character, "utf16le")
      .swap16()
      .toString("hex")
      .toUpperCase();
    return `<${(index + 1).toString(16).padStart(4, "0").toUpperCase()}> <${unicode}>`;
  });
  const toUnicode = ascii(
    `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /ModeleafUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0001> <FFFF>\nendcodespacerange\n${mappings.length} beginbfchar\n${mappings.join("\n")}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`,
  );
  const content = ascii(
    `BT /F1 14 Tf 48 720 Td (unicode-text-sentinel copyable needle) Tj ET\nBT /FU 14 Tf 48 680 Td <${encoded}> Tj ET\n`,
  );
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [4 0 R] >>",
    "<< /Title (Modeleaf Unicode fixture) /Creator (Modeleaf) /CreationDate (D:20000101000000Z) >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox ${A4} /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> /FU 6 0 R >> >> /Contents 5 0 R >>`,
    stream("<<", content),
    "<< /Type /Font /Subtype /Type0 /BaseFont /ModeleafUnicode /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 9 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ModeleafUnicode /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 /CIDToGIDMap /Identity >>",
    "<< /Type /FontDescriptor /FontName /ModeleafUnicode /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>",
    stream("<<", toUnicode),
  ];
  return pdf(objects);
}
export function createGoldenFixtures() {
  const locked = createAdversarialPdfs().get(
    "password-user-modeleaf.pdf",
  ).bytes;
  return new Map([
    ["text-3-page.pdf", { bytes: textPages(3, "Modeleaf text") }],
    [
      "fixture-S-text-10.pdf",
      {
        bytes: textPages(
          10,
          "PDFReader performance fixture S",
          "s-magenta-lime-diagonal-v1",
        ),
      },
    ],
    [
      "fixture-L-text-300.pdf",
      {
        bytes: textPages(
          300,
          "PDFReader performance fixture L",
          "l-lime-magenta-columns-v1",
        ),
      },
    ],
    [
      "fixture-F-raster-12.pdf",
      { bytes: imagePages(12, "f-magenta-lime-frame-v1") },
    ],
    ["fixture-B-blank.pdf", { bytes: document([{ content: "q\nQ\n" }]) }],
    ["image-only-2-page.pdf", { bytes: imagePages(2) }],
    [
      "malformed.pdf",
      { bytes: ascii("this is deliberately malformed; not a PDF\n") },
    ],
    ["locked.pdf", { bytes: locked, locked: true }],
    [
      "empty.pdf",
      {
        bytes: pdf([
          "<< /Type /Catalog /Pages 2 0 R >>",
          "<< /Type /Pages /Count 0 /Kids [] >>",
          "<< /Title (Modeleaf empty) >>",
        ]),
      },
    ],
    ["links.pdf", { bytes: linksPdf() }],
    ["link-duplicates.pdf", { bytes: linksPdf(true) }],
    ["outline.pdf", { bytes: outlinePdf() }],
    ["interactive.pdf", { bytes: interactivePdf() }],
    ["unicode-text.pdf", { bytes: unicodePdf() }],
    ["한글 공백 😀.pdf", { bytes: textPages(1, "Unicode filename") }],
  ]);
}
function expected(name) {
  const base = {
    expected_text: [],
    expected_annotations: { links: 0, forms: 0, media: 0 },
    expected_outline: { row_count: 0, rows: [] },
    sentinel: {},
  };
  if (name === "malformed.pdf")
    return { ...base, pages: 0, sentinel: { class: "malformed" } };
  if (name === "locked.pdf")
    return { ...base, pages: 1, sentinel: { class: "locked" } };
  if (name === "empty.pdf")
    return { ...base, pages: 0, sentinel: { class: "zero-pages" } };
  const pages = name.includes("300")
    ? 300
    : name.includes("10")
      ? 10
      : name.includes("raster-12")
        ? 12
        : name === "text-3-page.pdf"
          ? 3
          : name === "image-only-2-page.pdf"
            ? 2
            : 1;
  if (name === "text-3-page.pdf")
    return {
      ...base,
      pages: 3,
      expected_text: [
        "Modeleaf text page 1 copyable needle",
        "Modeleaf text page 3 copyable needle",
      ],
    };
  if (name === "fixture-S-text-10.pdf")
    return {
      ...base,
      pages: 10,
      expected_text: [
        "PDFReader performance fixture S page 1 copyable needle",
        "PDFReader performance fixture S page 10 copyable needle",
      ],
      sentinel: { pattern: "s-magenta-lime-diagonal-v1" },
    };
  if (name === "fixture-L-text-300.pdf")
    return {
      ...base,
      pages: 300,
      expected_text: [
        "PDFReader performance fixture L page 1 copyable needle",
        "PDFReader performance fixture L page 300 copyable needle",
      ],
      sentinel: { pattern: "l-lime-magenta-columns-v1" },
    };
  if (name === "links.pdf")
    return {
      ...base,
      pages: 2,
      expected_text: ["https://example.invalid/text-only-url"],
      expected_annotations: { links: 6, forms: 0, media: 0 },
      sentinel: {
        allowed_url: "https://example.invalid/allowed",
        forbidden_url: "file:///C:/forbidden",
        goto_point: true,
        goto_no_point: true,
        unresolved: true,
        foreign: true,
        text_only_url: true,
      },
    };
  if (name === "link-duplicates.pdf")
    return {
      ...base,
      pages: 2,
      expected_annotations: { links: 5, forms: 0, media: 0 },
      sentinel: {
        exact_duplicates: 2,
        adjacent_same_target: true,
        wrapped_rectangles: true,
      },
    };
  if (name === "outline.pdf")
    return {
      ...base,
      pages: 2,
      expected_outline: {
        row_count: 10,
        rows: [
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
        ],
      },
      sentinel: {
        wrapper: true,
        visible_depths: 2,
        deeper_hidden_child: true,
        duplicate_destinations: 2,
        invalid_row: true,
        edge_destination_y: 679,
      },
    };
  if (name === "interactive.pdf")
    return {
      ...base,
      pages,
      expected_annotations: { links: 1, forms: 1, media: 1 },
      sentinel: {
        widget: "sentinel-widget-value",
        note: "sentinel-note-contents",
        scripting_suppressed: true,
        media_suppressed: true,
      },
    };
  if (name === "fixture-F-raster-12.pdf")
    return {
      ...base,
      pages,
      sentinel: {
        pattern: "f-magenta-lime-frame-v1",
        no_searchable_text: true,
      },
    };
  if (name === "fixture-B-blank.pdf" || name === "image-only-2-page.pdf")
    return { ...base, pages, sentinel: { no_searchable_text: true } };
  if (name === "unicode-text.pdf")
    return {
      ...base,
      pages: 1,
      expected_text: ["unicode-text-sentinel", "한글", "café", "café", "مرحبا"],
      sentinel: { nfc: "café", nfd: "café", rtl: "مرحبا" },
    };
  if (name === "한글 공백 😀.pdf")
    return {
      ...base,
      pages: 1,
      expected_text: ["Unicode filename page 1 copyable needle"],
      sentinel: { unicode_filename: true },
    };
  throw new Error(`missing fixture contract: ${name}`);
}
function checkedPath(value, root = ROOT) {
  const target = resolve(root, value);
  const rel = relative(root, target);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  )
    throw new Error(`unsafe fixture path: ${value}`);
  return target;
}
async function safeDirectory(directory, root = ROOT) {
  const rel = relative(root, directory);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("fixture path escapes repository");
  let current = root;
  for (const part of rel.split(sep)) {
    if (!part) continue;
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`symlinked fixture path: ${current}`);
    } catch (error) {
      if (error?.code === "ENOENT") await mkdir(current);
      else throw error;
    }
  }
}
async function atomicWrite(target, contents) {
  try {
    if ((await lstat(target)).isSymbolicLink())
      throw new Error(`symlinked fixture target: ${target}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { flag: "wx" });
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
export async function generateGoldenFixtures({
  outputDirectory = OUT,
  manifestPath = MANIFEST,
  rootDirectory = ROOT,
} = {}) {
  const directory = checkedPath(outputDirectory, rootDirectory);
  const manifestTarget = checkedPath(manifestPath, rootDirectory);
  await safeDirectory(directory, rootDirectory);
  await safeDirectory(dirname(manifestTarget), rootDirectory);
  const fixtures = createGoldenFixtures();
  const generatorSha256 = sha256(
    await readFile(fileURLToPath(import.meta.url)),
  );
  const files = [];
  for (const [name, fixture] of fixtures) {
    await atomicWrite(resolve(directory, name), fixture.bytes);
    files.push({
      name,
      sha256: sha256(fixture.bytes),
      bytes: fixture.bytes.length,
      ...expected(name),
      license: "test-generated",
      source: "Modeleaf v0.10.0 golden fixture contract",
    });
  }
  const manifest = {
    schema_version: SCHEMA_VERSION,
    generator_version: GENERATOR_VERSION,
    generator_sha256: generatorSha256,
    files,
    path_scenarios: {
      unicode: {
        source: "한글 공백 😀.pdf",
        recipe: "copy under a Unicode directory with spaces",
      },
      windows_long_path: {
        source: "text-3-page.pdf",
        recipe: "copy below a path longer than 260 characters",
      },
      unc_transient_errors: {
        source: "text-3-page.pdf",
        recipe:
          "serve/copy through UNC and inject sharing or transient I/O errors",
      },
      junction_symlink_copies: {
        source: "text-3-page.pdf",
        recipe:
          "copy through a junction or symlink; fixture bytes must remain unchanged",
      },
    },
  };
  await atomicWrite(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  generateGoldenFixtures().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
