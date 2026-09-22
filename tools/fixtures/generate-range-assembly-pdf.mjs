import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Public read-only fixture: one page with a 12MiB RGB stream, inducing a >4MiB logical PDF.js read. */
export function createRangeAssemblyPdf() {
  const content = Buffer.from("q 100 0 0 100 0 0 cm /Im1 Do Q\n");
  const pixels = Buffer.alloc(2048 * 2048 * 3, 32);
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Count 1 /Kids [3 0 R] >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im1 6 0 R >> >> /Contents 4 0 R >>"),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("endstream")]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width 2048 /Height 2048 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`),
      pixels, Buffer.from("\nendstream"),
    ]),
  ];
  const chunks = [Buffer.from("%PDF-1.7\n")], offsets = [];
  let size = chunks[0].length;
  objects.forEach((body, index) => {
    offsets.push(size);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    chunks.push(object); size += object.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(process.argv[2] ?? ".internal/evidence/issue147-native/fixtures/large-image.pdf");
  const bytes = createRangeAssemblyPdf();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
  console.log(JSON.stringify({ bytes: bytes.length, pages: 1, sha256: createHash("sha256").update(bytes).digest("hex") }));
}
