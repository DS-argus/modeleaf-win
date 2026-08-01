import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_SCHEMA_VERSION = "modeleaf.adversarial-pdfs.v1";
export const GENERATOR_VERSION = "1.0.0";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT_DIRECTORY = "fixtures/adversarial-generated";
const MANIFEST_PATH = "fixtures/adversarial-pdfs.manifest.json";
const PASSWORD = "modeleaf";
const PASSWORD_PADDING = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);
const FILE_ID = Buffer.from("4d4f44454c4541464144564552534152", "hex");

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function md5(bytes) { return createHash("md5").update(bytes).digest(); }
function ascii(value) { return Buffer.from(value, "ascii"); }
function passwordBytes(value) {
  const bytes = Buffer.from(value, "latin1");
  return Buffer.concat([bytes.subarray(0, 32), PASSWORD_PADDING]).subarray(0, 32);
}
function rc4(key, input) {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let index = 0; index < 256; index += 1) { j = (j + state[index] + key[index % key.length]) & 255; [state[index], state[j]] = [state[j], state[index]]; }
  const output = Buffer.alloc(input.length); let i = 0; j = 0;
  for (let index = 0; index < input.length; index += 1) { i = (i + 1) & 255; j = (j + state[i]) & 255; [state[i], state[j]] = [state[j], state[i]]; output[index] = input[index] ^ state[(state[i] + state[j]) & 255]; }
  return output;
}
function objectKey(fileKey, objectNumber) {
  return md5(Buffer.concat([fileKey, Buffer.from([objectNumber & 255, (objectNumber >>> 8) & 255, (objectNumber >>> 16) & 255, 0, 0])])).subarray(0, Math.min(fileKey.length + 5, 16));
}
function security(password) {
  const ownerKey = md5(passwordBytes(password)).subarray(0, 5);
  const owner = rc4(ownerKey, passwordBytes(password));
  const digest = md5(Buffer.concat([passwordBytes(password), owner, Buffer.from([0xfc, 0xff, 0xff, 0xff]), FILE_ID]));
  const fileKey = digest.subarray(0, 5);
  return { owner, user: rc4(fileKey, PASSWORD_PADDING), fileKey };
}
function stream(dictionary, contents) { return Buffer.concat([ascii(`${dictionary} /Length ${contents.length} >>\nstream\n`), contents, ascii("\nendstream")]); }
function pdf(objects, trailer) {
  const chunks = [ascii("%PDF-1.4\n%\x80\x81\x82\x83\n")]; const offsets = [0]; let offset = chunks[0].length;
  for (let index = 0; index < objects.length; index += 1) {
    const body = Buffer.isBuffer(objects[index]) ? objects[index] : ascii(objects[index]); const header = ascii(`${index + 1} 0 obj\n`); const footer = ascii("\nendobj\n");
    offsets.push(offset); chunks.push(header, body, footer); offset += header.length + body.length + footer.length;
  }
  const xref = offset; chunks.push(ascii(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`));
  for (let index = 1; index < offsets.length; index += 1) chunks.push(ascii(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`));
  chunks.push(ascii(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /ID [<${FILE_ID.toString("hex")}> <${FILE_ID.toString("hex")}>]${trailer} >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
function zeroPagePdf() {
  return pdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 0 /Kids [] >>"], "");
}
function onePagePdf(pageBody, objects = []) {
  return pdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 /Kids [3 0 R] >>", pageBody, ...objects], "");
}
function page(contents, resources = "", annotations = "", mediaBox = "[0 0 612 792]") {
  return `<< /Type /Page /Parent 2 0 R /MediaBox ${mediaBox}${resources ? ` /Resources ${resources}` : ""}${annotations ? ` /Annots ${annotations}` : ""} /Contents ${contents} >>`;
}
export function createAdversarialPdfs() {
  const encrypted = security(PASSWORD);
  const encryptedContents = rc4(objectKey(encrypted.fileKey, 3), ascii("BT\n/F1 18 Tf\n72 720 Td\n(Password protected fixture) Tj\nET\n"));
  const password = pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [4 0 R] >>",
    stream("<<", encryptedContents),
    page("3 0 R", "<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>"),
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${encrypted.owner.toString("hex")}> /U <${encrypted.user.toString("hex")}> /P -4 >>`,
  ], " /Encrypt 5 0 R");
  const malformed = Buffer.concat([ascii("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nxref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n")]);
  const empty = zeroPagePdf();
  const huge = onePagePdf(page("4 0 R", "", "", "[0 0 20000 20000]"), [stream("<<", ascii("q\nQ\n"))]);
  const image = Buffer.from([0x00]);
  const imageOnly = onePagePdf(page("4 0 R", "<< /XObject << /Im1 5 0 R >> >>"), [stream("<<", ascii("q\n612 0 0 792 0 0 cm\n/Im1 Do\nQ\n")), stream("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", image)]);
  const links = onePagePdf(page("4 0 R", "", "[5 0 R 6 0 R]"), [stream("<<", ascii("q\nQ\n")), "<< /Type /Annot /Subtype /Link /Rect [72 700 260 720] /Border [0 0 0] /A << /S /URI /URI (https://example.invalid/allowed) >> >>", "<< /Type /Annot /Subtype /Link /Rect [72 650 260 670] /Border [0 0 0] /A << /S /URI /URI (file:///C:/forbidden) >> >>"]);
  const slowContents = Buffer.concat([ascii("q\n"), Buffer.alloc(1024 * 1024, 0x20), ascii("\nQ\n")]);
  const slow = onePagePdf(page("4 0 R"), [stream("<<", slowContents)]);
  return new Map([
    ["password-user-modeleaf.pdf", { bytes: password, expectedClass: "password-user" }],
    ["malformed-truncated-xref.pdf", { bytes: malformed, expectedClass: "malformed-truncated-xref" }],
    ["empty-zero-pages.pdf", { bytes: empty, expectedClass: "empty-zero-pages" }],
    ["huge-page-canvas-limit.pdf", { bytes: huge, expectedClass: "huge-page-canvas-limit" }],
    ["no-text-image-only.pdf", { bytes: imageOnly, expectedClass: "no-text-image-only" }],
    ["links-allowed-and-forbidden.pdf", { bytes: links, expectedClass: "links-allowed-and-forbidden" }],
    ["slow-cancel-range.pdf", { bytes: slow, expectedClass: "slow-cancel-range" }],
  ]);
}
function checkedPath(value, root) {
  const target = resolve(ROOT, value); const rel = relative(root, target);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error(`unsafe fixture path: ${value}`);
  return target;
}
async function safeDirectory(directory) {
  const rel = relative(ROOT, directory);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("fixture path escapes repository");
  let current = ROOT;
  for (const part of rel.split(sep)) {
    if (!part) continue;
    current = resolve(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`symlinked fixture path: ${current}`); }
    catch (error) { if (error?.code === "ENOENT") await mkdir(current); else throw error; }
  }
}
async function atomicWrite(target, contents) {
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error(`symlinked fixture target: ${target}`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { flag: "wx" });
  try { await rename(temporary, target); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
export async function generateAdversarialPdfs({ outputDirectory = OUTPUT_DIRECTORY, manifestPath = MANIFEST_PATH } = {}) {
  const directory = checkedPath(outputDirectory, ROOT); const manifestTarget = checkedPath(manifestPath, ROOT);
  await safeDirectory(directory); await safeDirectory(dirname(manifestTarget));
  const fixtures = createAdversarialPdfs(); const generator = await readFile(fileURLToPath(import.meta.url));
  const outputs = [];
  for (const [name, fixture] of fixtures) { await atomicWrite(resolve(directory, name), fixture.bytes); outputs.push({ name, sha256: sha256(fixture.bytes), byteLength: fixture.bytes.length, expectedClass: fixture.expectedClass }); }
  const manifest = { schemaVersion: FIXTURE_SCHEMA_VERSION, generatorVersion: GENERATOR_VERSION, generatorSha256: sha256(generator), outputs };
  await atomicWrite(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateAdversarialPdfs();
