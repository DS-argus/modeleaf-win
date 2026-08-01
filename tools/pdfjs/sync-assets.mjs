import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PDFJS_VERSION = "5.7.284";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(repositoryRoot, "node_modules/pdfjs-dist");
const destinationRoot = resolve(repositoryRoot, "public/assets", `pdfjs-${PDFJS_VERSION}`);
const assetPrefix = `./assets/pdfjs-${PDFJS_VERSION}/`;

const singleFiles = [
  ["worker", "build/pdf.worker.min.mjs"],
  ["core", "build/pdf.mjs"],
  ["viewer", "web/pdf_viewer.mjs"],
  ["viewerCss", "web/pdf_viewer.css"],
];
const runtimeDirectories = [
  ["cMaps", "cmaps"],
  ["standardFonts", "standard_fonts"],
  ["wasm", "wasm"],
  ["icc", "iccs"],
];

function assertInside(root, candidate) {
  const relativePath = relative(root, candidate);
  if (relativePath === "" || relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    throw new Error(`Asset path escapes approved root: ${candidate}`);
  }
}
async function assertNoSymlinkPath(path) {
  assertInside(sourceRoot, path);
  const components = relative(sourceRoot, path).split(sep);
  let current = sourceRoot;
  for (const component of components) {
    current = resolve(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`Symlinked PDF.js asset path is forbidden: ${current}`);
    }
  }
}


async function assertRegularFile(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Approved asset must be a regular non-symlink file: ${path}`);
  }
}

async function copyFile(kind, sourcePath, outputPath, records) {
  assertInside(sourceRoot, sourcePath);
  assertInside(destinationRoot, outputPath);
  await assertNoSymlinkPath(sourcePath);
  await assertRegularFile(sourcePath);
  const bytes = await readFile(sourcePath);
  if (bytes.byteLength === 0) throw new Error(`Approved asset is empty: ${sourcePath}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await cp(sourcePath, outputPath, { dereference: false, force: true });
  const outputRelativePath = relative(destinationRoot, outputPath).replaceAll("\\", "/");
  records.push({
    kind,
    path: `${assetPrefix}${outputRelativePath}`,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

async function copyDirectory(kind, sourceDirectory, records) {
  assertInside(sourceRoot, sourceDirectory);
  await assertNoSymlinkPath(sourceDirectory);
  const rootStat = await lstat(sourceDirectory);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Approved asset directory must be a real directory: ${sourceDirectory}`);
  }
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = resolve(sourceDirectory, entry.name);
    assertInside(sourceDirectory, sourcePath);
    if (entry.isSymbolicLink()) throw new Error(`Symlinked PDF.js asset is forbidden: ${sourcePath}`);
    if (entry.isDirectory()) {
      await copyDirectory(kind, sourcePath, records);
    } else if (entry.isFile()) {
      const outputPath = resolve(destinationRoot, relative(sourceRoot, sourcePath));
      await copyFile(kind, sourcePath, outputPath, records);
    } else {
      throw new Error(`Non-regular PDF.js asset is forbidden: ${sourcePath}`);
    }
  }
}

const sourceRootStat = await lstat(sourceRoot);
if (sourceRootStat.isSymbolicLink() || !sourceRootStat.isDirectory()) {
  throw new Error("pdfjs-dist package root must be a real directory");
}
const packageMetadataPath = resolve(sourceRoot, "package.json");
await assertRegularFile(packageMetadataPath);
const packageMetadata = JSON.parse(await readFile(packageMetadataPath, "utf8"));
if (packageMetadata.name !== "pdfjs-dist" || packageMetadata.version !== PDFJS_VERSION) {
  throw new Error(`Installed pdfjs-dist must be exactly ${PDFJS_VERSION}`);
}

await rm(destinationRoot, { recursive: true, force: true });
await mkdir(destinationRoot, { recursive: true });

const assets = [];
for (const [kind, path] of singleFiles) {
  const sourcePath = resolve(sourceRoot, path);
  const outputPath = resolve(destinationRoot, path);
  await copyFile(kind, sourcePath, outputPath, assets);
}
for (const [kind, directory] of runtimeDirectories) {
  await copyDirectory(kind, resolve(sourceRoot, directory), assets);
}

assets.sort((left, right) => left.path.localeCompare(right.path));
const manifestPath = resolve(destinationRoot, `pdfjs-assets-${PDFJS_VERSION}.json`);
await writeFile(manifestPath, `${JSON.stringify({ pdfjsVersion: PDFJS_VERSION, assets }, null, 2)}\n`, "utf8");
