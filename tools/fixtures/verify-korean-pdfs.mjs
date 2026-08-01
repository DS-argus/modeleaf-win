import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = resolve(repositoryRoot, "fixtures/korean-pdfs.manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.fixtures) || manifest.fixtures.length !== 3) {
  throw new Error("Korean fixture manifest is invalid");
}

const results = [];
for (const fixture of manifest.fixtures) {
  if (typeof fixture.name !== "string" || fixture.name.includes("/") || fixture.name.includes("\\")) {
    throw new Error("Korean fixture name is invalid");
  }
  const bytes = await readFile(resolve(repositoryRoot, "test-pdf", fixture.name));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const byteLength = bytes.byteLength;
  if (byteLength !== fixture.byteLength || sha256 !== fixture.sha256) {
    throw new Error(`Korean fixture bytes do not match the manifest: ${fixture.name}`);
  }
  const loadingTask = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useWorkerFetch: false });
  const document = await loadingTask.promise;
  try {
    if (document.numPages !== fixture.pageCount) {
      throw new Error(`Korean fixture page count does not match the manifest: ${fixture.name}`);
    }
    results.push({ name: fixture.name, byteLength, pageCount: document.numPages, sha256 });
  } finally {
    await document.destroy();
  }
}

process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "passed", fixtures: results })}\n`);
