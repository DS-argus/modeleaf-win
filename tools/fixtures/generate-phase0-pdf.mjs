import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_SCHEMA_VERSION = "modeleaf.phase0.fixture.v1";
export const GENERATOR_VERSION = "1.0.0";
export const PAGE_COUNT = 100;
export const IMAGE_WIDTH = 256;
export const IMAGE_HEIGHT = 256;
const SEED = 0x4d4f4445;
const A4 = [595, 842];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function xorshift32(state) {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

function ascii(value) {
  return Buffer.from(value, "ascii");
}

function pdfLiteral(value) {
  return value.replace(/[\\()]/g, "\\$&");
}

function imageBytes(page) {
  const bytes = Buffer.alloc(IMAGE_WIDTH * IMAGE_HEIGHT * 3);
  let state = (SEED ^ Math.imul(page, 0x9e3779b9)) >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state = xorshift32(state);
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function stream(dictionary, contents) {
  return Buffer.concat([ascii(`${dictionary} /Length ${contents.length} >>\nstream\n`), contents, ascii("\nendstream")]);
}

/** Returns a valid, byte-stable PDF 1.7 fixture. */
export function createPhase0Pdf() {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = add("");
  const infoId = add("<< /Title (Modeleaf Phase 0 deterministic fixture) /Creator (Modeleaf) /Producer (Modeleaf Phase 0 fixture generator) /CreationDate (D:20000101000000Z) /ModDate (D:20000101000000Z) >>");
  const pageIds = [];

  for (let page = 1; page <= PAGE_COUNT; page += 1) {
    const pageId = add("");
    const content = ascii(`BT\n/F1 18 Tf\n72 770 Td\n(Modeleaf Phase 0 page ${page} of ${PAGE_COUNT}) Tj\nET\nq\n256 0 0 256 72 420 cm\n/Im${page} Do\nQ\n`);
    const contentId = add(stream("<<", content));
    const imageId = add(stream(`<< /Type /XObject /Subtype /Image /Width ${IMAGE_WIDTH} /Height ${IMAGE_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8`, imageBytes(page)));
    const annotationIds = [];
    if (page % 10 === 0) {
      annotationIds.push(add(`<< /Type /Annot /Subtype /Link /Rect [72 390 220 410] /Border [0 0 0] /A << /S /GoTo /D [${pageId} 0 R /Fit] >> >>`));
      annotationIds.push(add(`<< /Type /Annot /Subtype /Link /Rect [72 360 360 380] /Border [0 0 0] /A << /S /URI /URI (https://example.invalid/modeleaf/${page}) >> >>`));
    }
    objects[pageId - 1] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4[0]} ${A4[1]}] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> /XObject << /Im${page} ${imageId} 0 R >> >> /Contents ${contentId} 0 R${annotationIds.length ? ` /Annots [${annotationIds.map((id) => `${id} 0 R`).join(" ")}]` : ""} >>`;
    pageIds.push(pageId);
  }
  objects[pagesId - 1] = `<< /Type /Pages /Count ${PAGE_COUNT} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;

  // Padding raises the raw-RGB fixture above 19 MiB without changing page content.
  const padding = Buffer.alloc(320 * 1024, 0x50);
  add(stream("<< /Type /Metadata /Subtype /XML", padding));

  const chunks = [ascii("%PDF-1.7\n%\x80\x81\x82\x83\n")];
  const offsets = [0];
  let offset = chunks[0].length;
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(offset);
    const object = Buffer.isBuffer(objects[index]) ? objects[index] : ascii(objects[index]);
    const header = ascii(`${index + 1} 0 obj\n`);
    const footer = ascii("\nendobj\n");
    chunks.push(header, object, footer);
    offset += header.length + object.length + footer.length;
  }
  const xrefOffset = offset;
  chunks.push(ascii(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
  for (let index = 1; index < offsets.length; index += 1) chunks.push(ascii(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`));
  chunks.push(ascii(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R /ID [<4d4f44454c4541465048304649585455> <4d4f44454c4541465048304649585455>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

export async function generatePhase0Pdf({
  outputPath = "fixtures/phase0-100p-20m.pdf",
  manifestPath = "fixtures/phase0-100p-20m.manifest.json",
} = {}) {
  const pdf = createPhase0Pdf();
  if (pdf.length < 19 * 1024 * 1024 || pdf.length > 21 * 1024 * 1024) throw new Error(`fixture size ${pdf.length} is outside 19-21 MiB`);
  const generator = await readFile(fileURLToPath(import.meta.url));
  const manifest = {
    schema: FIXTURE_SCHEMA_VERSION,
    toolVersion: GENERATOR_VERSION,
    generatorSha256: sha256(generator),
    outputSha256: sha256(pdf),
    byteLength: pdf.length,
    pageCount: PAGE_COUNT,
    textAssertions: Array.from({ length: PAGE_COUNT }, (_, index) => `Modeleaf Phase 0 page ${index + 1} of ${PAGE_COUNT}`),
    annotationAssertions: { everyTenthPage: true, gotoCount: 10, uriCount: 10, uriPrefix: "https://example.invalid/modeleaf/" },
  };
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await mkdir(dirname(resolve(manifestPath)), { recursive: true });
  await writeFile(outputPath, pdf);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [outputPath, manifestPath] = process.argv.slice(2);
  generatePhase0Pdf({ outputPath, manifestPath }).then((manifest) => process.stdout.write(`${JSON.stringify(manifest)}\n`));
}
