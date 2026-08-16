import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const assetRoot = resolve(root, "public/assets/pdfjs-6.2.108");
const errors = [];
const fail = (message) => errors.push(message);

function text(path) {
  try { return readFileSync(path, "utf8"); }
  catch (error) { fail(`${relative(root, path)}: ${error.message}`); return ""; }
}
function json(path) {
  try { return JSON.parse(text(path)); }
  catch (error) { fail(`${relative(root, path)}: invalid JSON: ${error.message}`); return null; }
}
function required(record, label, fields) {
  if (!record || typeof record !== "object") { fail(`${label}: review entry is not an object`); return false; }
  let valid = true;
  for (const field of fields) {
    if (typeof record[field] !== "string" || record[field].trim() === "") {
      fail(`${label}: missing ${field}`); valid = false;
    }
  }
  return valid;
}
function reviewData() {
  const match = /<!-- third-party-review\n([\s\S]*?)\n-->/u.exec(text(resolve(root, "THIRD_PARTY_NOTICES.md")));
  if (!match) { fail("THIRD_PARTY_NOTICES.md: missing third-party-review JSON block"); return null; }
  try {
    const review = JSON.parse(match[1]);
    if (!Array.isArray(review.dependencies) || !Array.isArray(review.assets) || !Array.isArray(review.themes)) throw new Error("dependencies, assets, and themes must be arrays");
    return review;
  } catch (error) { fail(`THIRD_PARTY_NOTICES.md: invalid review JSON: ${error.message}`); return null; }
}
function cargoPackages(lock) {
  const packages = new Map();
  for (const block of lock.split("[[package]]").slice(1)) {
    const name = /^name = "([^"]+)"/mu.exec(block)?.[1];
    const version = /^version = "([^"]+)"/mu.exec(block)?.[1];
    const source = /^source = "([^"]+)"/mu.exec(block)?.[1] ?? "workspace";
    if (!name || !version) continue;
    packages.set(name, [...(packages.get(name) ?? []), { version, source }]);
  }
  return packages;
}
function cargoManifestDependencies(manifest) {
  const names = [];
  for (const section of ["build-dependencies", "dependencies"]) {
    const match = new RegExp(`^\\[${section}\\]\\r?\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "mu").exec(manifest);
    if (!match) { fail(`src-tauri/Cargo.toml: missing [${section}]`); continue; }
    for (const line of match[1].split("\n")) {
      const name = /^([A-Za-z0-9_-]+)\s*=/u.exec(line)?.[1];
      if (name) names.push(name);
    }
  }
  return names.sort();
}
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

function verifyDependencies(review) {
  const lock = json(resolve(root, "package-lock.json"));
  const cargoLock = text(resolve(root, "src-tauri/Cargo.lock"));
  const cargoManifest = text(resolve(root, "src-tauri/Cargo.toml"));
  if (!lock || !cargoLock || !cargoManifest) return;
  const expected = [];
  for (const name of Object.keys(lock.packages?.[""]?.dependencies ?? {}).sort()) {
    const packageEntry = lock.packages?.[`node_modules/${name}`];
    if (!packageEntry?.version || !packageEntry.resolved || !packageEntry.license) {
      fail(`package-lock.json: direct production dependency ${name} lacks version, source, or license metadata`); continue;
    }
    expected.push({ ecosystem: "npm", name, version: packageEntry.version, source: packageEntry.resolved, license: packageEntry.license });
  }
  const packages = cargoPackages(cargoLock);
  for (const name of cargoManifestDependencies(cargoManifest)) {
    const matches = packages.get(name);
    if (!matches || matches.length !== 1) { fail(`src-tauri/Cargo.lock: direct production dependency ${name} must resolve exactly once`); continue; }
    expected.push({ ecosystem: "cargo", name, ...matches[0] });
  }
  const expectedKeys = new Set();
  for (const item of expected) {
    const key = `${item.ecosystem}:${item.name}`;
    expectedKeys.add(key);
    const record = review.dependencies.find((candidate) => candidate.ecosystem === item.ecosystem && candidate.name === item.name);
    if (!required(record, key, ["ecosystem", "name", "version", "license", "source", "requiredNotice"])) continue;
    for (const field of item.ecosystem === "npm" ? ["version", "license", "source"] : ["version", "source"]) {
      if (record[field] !== item[field]) fail(`${key}: reviewed ${field} is stale (expected ${item[field]})`);
    }
  }
  for (const record of review.dependencies) {
    if (!required(record, "dependency review", ["ecosystem", "name", "version", "license", "source", "requiredNotice"])) continue;
    if (!expectedKeys.has(`${record.ecosystem}:${record.name}`)) fail(`${record.ecosystem}:${record.name}: stale or unreviewed dependency entry`);
  }
}

function verifyAssets(review) {
  const manifest = json(resolve(assetRoot, "pdfjs-assets-6.2.108.json"));
  const lock = json(resolve(root, "package-lock.json"));
  if (!manifest || !lock) return;
  const pdfjs = lock.packages?.["node_modules/pdfjs-dist"];
  if (!pdfjs?.version || manifest.pdfjsVersion !== pdfjs.version) fail("PDF.js asset manifest version does not match locked pdfjs-dist");
  const covered = new Set();
  for (const asset of manifest.assets ?? []) {
    if (typeof asset.path !== "string" || typeof asset.sha256 !== "string" || !Number.isInteger(asset.byteLength)) { fail("PDF.js asset manifest contains incomplete metadata"); continue; }
    const path = asset.path.replace(/^\.\/assets\/pdfjs-6\.2\.108\//u, "");
    const absolute = resolve(assetRoot, path);
    if (!absolute.startsWith(`${assetRoot}${sep}`)) { fail(`PDF.js asset path escapes root: ${asset.path}`); continue; }
    if (!existsSync(absolute) || !statSync(absolute).isFile()) { fail(`missing copied PDF.js asset: ${asset.path}`); continue; }
    if (statSync(absolute).size !== asset.byteLength || sha256(absolute) !== asset.sha256) fail(`copied PDF.js asset differs from reviewed manifest: ${asset.path}`);
    const matches = review.assets.filter((record) => typeof record.prefix === "string" && path.startsWith(record.prefix));
    if (matches.length !== 1) fail(`PDF.js asset ${asset.path} must have exactly one review entry`);
    else covered.add(matches[0].prefix);
  }
  for (const record of review.assets) {
    if (!required(record, "asset review", ["name", "version", "license", "source", "requiredNotice", "prefix"])) continue;
    if (record.name !== "pdfjs-dist" || record.version !== manifest.pdfjsVersion || record.source !== pdfjs?.resolved) fail(`asset review ${record.prefix}: stale name, version, or source`);
    if (!covered.has(record.prefix)) fail(`asset review ${record.prefix}: stale or does not cover a copied asset`);
  }
}

function verifyThemes(review) {
  const source = text(resolve(root, "src/core/Theme.ts"));
  const ids = [...source.matchAll(/theme\("([a-z0-9-]+)"/gu)].map((match) => match[1]);
  const revision = "d809e2e4d6aa5f257c91ff38b2cd4503e17405f0";
  const seen = new Set();
  for (const id of ids) {
    const record = review.themes.find((candidate) => candidate.id === id);
    if (!required(record, `theme:${id}`, ["id", "revision", "license", "source", "requiredNotice"])) continue;
    if (record.revision !== revision || !record.source.includes(revision)) fail(`theme:${id}: stale upstream revision or source`);
    seen.add(id);
  }
  if (ids.length !== 6 || new Set(ids).size !== 6) fail("src/core/Theme.ts must define exactly six unique copied themes");
  for (const record of review.themes) {
    if (!required(record, "theme review", ["id", "revision", "license", "source", "requiredNotice"])) continue;
    if (!seen.has(record.id)) fail(`theme:${record.id}: stale or unreviewed attribution`);
  }
}

const review = reviewData();
if (review) { verifyDependencies(review); verifyAssets(review); verifyThemes(review); }
if (errors.length) {
  for (const error of errors.sort()) console.error(`third-party verification failed: ${error}`);
  process.exitCode = 1;
} else console.log("third-party verification passed");
