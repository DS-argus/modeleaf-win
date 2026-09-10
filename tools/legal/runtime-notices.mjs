import { parse as parseToml } from "smol-toml";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const START = "<!-- runtime-license-notices:start -->";
const END = "<!-- runtime-license-notices:end -->";
const INVENTORY = "tools/legal/runtime-license-inventory.json";
const GENERATOR = "cargo-about 0.9.2";
const TARGET = "x86_64-pc-windows-msvc";
const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
const MAX_BYTES = 16 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/u;
const NAME = /^[A-Za-z0-9_-]+$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u;
const IDS = new Set(["Apache-2.0", "MIT", "BSD-3-Clause", "BSD-2-Clause", "ISC", "Unicode-3.0", "Zlib", "MPL-2.0"]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packageKey = (pkg) => `${pkg.name}@${pkg.version}`;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function fields(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw new Error(`${label}: unexpected fields`);
  }
}
function packageIdentity(pkg) {
  fields(pkg, ["name", "version"], "Package");
  if (typeof pkg.name !== "string" || !NAME.test(pkg.name) || typeof pkg.version !== "string" || !VERSION.test(pkg.version)) {
    throw new Error("Unsafe package identity");
  }
}
function licenseText(id, text) {
  if (!IDS.has(id) || typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > MAX_BYTES
    || text.includes("\0") || text.includes(START) || text.includes(END)) throw new Error("Invalid license text or identifier");
  if (/<year>|<owner>|<copyright holders>/iu.test(text)) throw new Error("Generic copyright placeholders are not redistribution notices");
}
function readBounded(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Notice input is not a bounded regular file");
  const bytes = readFileSync(path);
  if (bytes.length > MAX_BYTES) throw new Error("Notice input exceeds size bound");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function validateInventory(inventory) {
  fields(inventory, ["schemaVersion", "generator", "target", "cargoLockSha256", "packageCount", "licenses"], "Inventory");
  if (inventory.schemaVersion !== 1 || inventory.generator !== GENERATOR || inventory.target !== TARGET
    || !HASH.test(inventory.cargoLockSha256) || !Number.isSafeInteger(inventory.packageCount) || inventory.packageCount < 1
    || !Array.isArray(inventory.licenses) || !inventory.licenses.length) throw new Error("Invalid inventory metadata");
  const allPackages = new Set();
  const groups = new Set();
  for (const license of inventory.licenses) {
    fields(license, ["id", "text", "textSha256", "packages"], "License");
    licenseText(license.id, license.text);
    if (!HASH.test(license.textSha256) || sha256(license.text) !== license.textSha256) throw new Error("License text hash mismatch");
    const key = `${license.id}:${license.textSha256}`;
    if (groups.has(key)) throw new Error("Duplicate license group");
    groups.add(key);
    if (!Array.isArray(license.packages) || !license.packages.length) throw new Error("License has no packages");
    const seen = new Set();
    for (const pkg of license.packages) {
      packageIdentity(pkg);
      const identity = packageKey(pkg);
      if (seen.has(identity)) throw new Error("Duplicate package in license group");
      seen.add(identity); allPackages.add(identity);
    }
  }
  if (allPackages.size !== inventory.packageCount) throw new Error("Inventory package count mismatch");
}

function verifyLockedPackages(inventory, cargoLockBytes) {
  const lock = parseToml(new TextDecoder("utf-8", { fatal: true }).decode(cargoLockBytes));
  const packages = new Set((lock.package ?? []).filter((pkg) => pkg.source === REGISTRY).map(packageKey));
  for (const license of inventory.licenses) {
    for (const pkg of license.packages) {
      if (!packages.has(packageKey(pkg))) throw new Error("Notice package is absent from Cargo.lock");
    }
  }
}
export function importCargoAboutReport(report, cargoLockBytes) {
  if (!report || !Array.isArray(report.licenses) || !report.licenses.length) throw new Error("Missing cargo-about license report");
  const groups = new Map();
  for (const record of report.licenses) {
    if (!Array.isArray(record.used_by)) throw new Error("Missing license users");
    const packages = [];
    for (const entry of record.used_by) {
      const crate = entry?.crate;
      if (!crate) throw new Error("Missing crate metadata");
      if (crate.name === "modeleaf" && crate.source === null) continue;
      if (crate.source !== REGISTRY) throw new Error("Unreviewed non-registry source");
      const pkg = { name: crate.name, version: crate.version };
      packageIdentity(pkg); packages.push(pkg);
    }
    if (!packages.length) continue;
    licenseText(record.id, record.text);
    // Git stores the notice document with LF; retain wording and all copyright
    // text while normalizing line endings and trailing layout whitespace.
    const text = record.text.replaceAll("\r\n", "\n").replace(/[ \t]+$/gmu, "");
    const textSha256 = sha256(text);
    const key = `${record.id}:${textSha256}`;
    const group = groups.get(key) ?? { id: record.id, text, textSha256, packages: new Map() };
    for (const pkg of packages) group.packages.set(packageKey(pkg), pkg);
    groups.set(key, group);
  }
  const licenses = [...groups.values()].map((group) => ({
    ...group, packages: [...group.packages.values()].sort((a, b) => compare(packageKey(a), packageKey(b))),
  })).sort((a, b) => compare(`${a.id}:${a.textSha256}`, `${b.id}:${b.textSha256}`));
  const inventory = {
    schemaVersion: 1, generator: GENERATOR, target: TARGET, cargoLockSha256: sha256(cargoLockBytes),
    packageCount: new Set(licenses.flatMap((license) => license.packages.map(packageKey))).size, licenses,
  };
  validateInventory(inventory);
  verifyLockedPackages(inventory, cargoLockBytes);
  return inventory;
}

export function renderRuntimeNotices(inventory) {
  validateInventory(inventory);
  const lines = [START, "## Native runtime dependency licenses", "",
    `Inventory: ${inventory.generator}; ${inventory.target}; ${inventory.packageCount} resolved packages.`,
    `Cargo.lock SHA-256: \`${inventory.cargoLockSha256}\`.`, "",
    "These dependencies retain their own terms; the product MIT license does not replace them.",
    "Unmodified source archives are available from the versioned links below. In particular, MPL-2.0 covered components remain available in Source Code Form under MPL-2.0 through those links; their source rights are not restricted by the product license.", ""];
  for (const [index, license] of inventory.licenses.entries()) {
    lines.push(`### ${license.id} — notice ${index + 1}`, "");
    for (const pkg of license.packages) {
      lines.push(`- \`${packageKey(pkg)}\` — [source archive](https://crates.io/api/v1/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}/download)`);
    }
    const fence = "`".repeat(Math.max(3, ...[...license.text.matchAll(/`+/gu)].map((match) => match[0].length + 1)));
    lines.push("", fence + "text", license.text.endsWith("\n") ? license.text.slice(0, -1) : license.text, fence, "");
  }
  lines.push(END);
  return lines.join("\n");
}

export function replaceRuntimeNotices(document, section) {
  const starts = document.split(START).length - 1;
  const ends = document.split(END).length - 1;
  if (!starts && !ends) return `${document}${document.endsWith("\n") ? "" : "\n"}\n${section}\n`;
  const start = document.indexOf(START);
  const end = document.indexOf(END);
  if (starts !== 1 || ends !== 1 || end < start) throw new Error("Malformed runtime notice markers");
  return document.slice(0, start) + section + document.slice(end + END.length);
}

export function verifyRuntimeNotices(root) {
  const inventory = JSON.parse(readBounded(resolve(root, INVENTORY)));
  validateInventory(inventory);
  if (sha256(readFileSync(resolve(root, "src-tauri/Cargo.lock"))) !== inventory.cargoLockSha256) {
    throw new Error("Native notice inventory is stale for Cargo.lock; regenerate and review it");
  }
  verifyLockedPackages(inventory, readFileSync(resolve(root, "src-tauri/Cargo.lock")));
  const document = readBounded(resolve(root, "THIRD_PARTY_NOTICES.md"));
  const rendered = renderRuntimeNotices(inventory);
  if (replaceRuntimeNotices(document, rendered) !== document) throw new Error("Native runtime notice section is missing or modified");
  return { packages: inventory.packageCount, licenseTexts: inventory.licenses.length };
}

export function importRuntimeNotices(root, reportPath) {
  const inventory = importCargoAboutReport(JSON.parse(readBounded(reportPath)), readFileSync(resolve(root, "src-tauri/Cargo.lock")));
  const noticePath = resolve(root, "THIRD_PARTY_NOTICES.md");
  const document = replaceRuntimeNotices(readBounded(noticePath), renderRuntimeNotices(inventory));
  // All validation, including marker checks, precedes either write. A write
  // failure propagates; verification will reject any partially written pair.
  writeFileSync(resolve(root, INVENTORY), JSON.stringify(inventory, null, 2) + "\n");
  writeFileSync(noticePath, document);
  return verifyRuntimeNotices(root);
}

const ownPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === ownPath) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || args[0] !== "--import" || args[2] !== "--write") throw new Error("Usage: runtime-notices.mjs --import <cargo-about-json> --write");
    const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
    console.log(JSON.stringify(importRuntimeNotices(root, args[1])));
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
