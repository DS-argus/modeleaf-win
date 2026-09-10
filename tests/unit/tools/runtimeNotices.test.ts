import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { importCargoAboutReport, importRuntimeNotices, renderRuntimeNotices, replaceRuntimeNotices, verifyRuntimeNotices } from "../../../tools/legal/runtime-notices.mjs";

const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
const LOCK = Buffer.from(`version = 4\n\n[[package]]\nname = "fixture-lib"\nversion = "1.2.3"\nsource = "${REGISTRY}"\n`);
const TEXT = "MIT License\n\nCopyright (c) Test-only Fixture Author\n\nPermission is hereby granted for this synthetic test fixture.\n";
const PREFIX = "# Third-party notices\n\nExisting human-reviewed prefix.\n<!-- third-party-review\n{}\n-->\n";
const roots: string[] = [];
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function report(text = TEXT) {
  return { licenses: [{ id: "MIT", text, source_path: "C:\\Users\\private-user\\LICENSE", used_by: [{
    crate: { name: "fixture-lib", version: "1.2.3", source: REGISTRY as string | null, manifest_path: "C:\\private\\Cargo.toml" },
  }] }] };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "modeleaf-notices-"));
  roots.push(root);
  await mkdir(join(root, "tools/legal"), { recursive: true });
  await mkdir(join(root, "src-tauri"));
  await writeFile(join(root, "src-tauri/Cargo.lock"), LOCK);
  await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), PREFIX);
  const input = join(root, "report.json");
  await writeFile(input, JSON.stringify(report()));
  return { root, input, inventory: join(root, "tools/legal/runtime-license-inventory.json"), notices: join(root, "THIRD_PARTY_NOTICES.md") };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("native runtime notice inventory", () => {
  it("imports complete copyright text without private cargo metadata", () => {
    const input = report(TEXT.replaceAll("\n", "  \r\n"));
    input.licenses.push(structuredClone(input.licenses[0]!));
    const inventory = importCargoAboutReport(input, LOCK);
    expect(inventory.packageCount).toBe(1);
    expect(inventory.licenses).toHaveLength(1);
    expect(inventory.licenses[0].text).toBe(TEXT);
    expect(inventory.licenses[0].textSha256).toBe(sha256(TEXT));
    expect(JSON.stringify(inventory)).not.toMatch(/source_path|manifest_path|private-user|C:\\/u);
  });

  it("retains distinct copyright notices under the same license", () => {
    const input = report();
    input.licenses.push({ ...input.licenses[0]!, text: TEXT.replace("Fixture Author", "Another Fixture Author") });
    const rendered = renderRuntimeNotices(importCargoAboutReport(input, LOCK));
    expect(rendered).toContain("Copyright (c) Test-only Fixture Author");
    expect(rendered).toContain("Copyright (c) Test-only Another Fixture Author");
    expect(rendered).toContain("https://crates.io/api/v1/crates/fixture-lib/1.2.3/download");
    expect(rendered).toContain("MPL-2.0 covered components remain available in Source Code Form");
  });

  it("excludes the local product only, rather than inventing a registry source", () => {
    const input = report();
    input.licenses[0]!.used_by.push({ crate: { name: "modeleaf", version: "0.1.0", source: null, manifest_path: "private" } });
    expect(importCargoAboutReport(input, LOCK).packageCount).toBe(1);
    input.licenses[0]!.used_by[1]!.crate.source = REGISTRY;
    expect(() => importCargoAboutReport(input, LOCK)).toThrow(/absent from Cargo.lock/u);
  });

  it("rejects generic copyright placeholders and unreviewed source identities", () => {
    expect(() => importCargoAboutReport(report("MIT License\nCopyright (c) <year> <copyright holders>"), LOCK)).toThrow(/placeholders/u);
    const bsd = report("Copyright (c) <year> <owner>");
    bsd.licenses[0]!.id = "BSD-3-Clause";
    expect(() => importCargoAboutReport(bsd, LOCK)).toThrow(/placeholders/u);
    const input = report();
    input.licenses[0]!.used_by[0]!.crate.source = "git+https://example.invalid/source";
    expect(() => importCargoAboutReport(input, LOCK)).toThrow(/non-registry/u);
    input.licenses[0]!.used_by[0]!.crate.source = REGISTRY;
    input.licenses[0]!.used_by[0]!.crate.name = "../../unsafe";
    expect(() => importCargoAboutReport(input, LOCK)).toThrow(/Unsafe package/u);
  });

  it("rejects report versions that are not bound to the supplied lockfile", () => {
    const input = report();
    input.licenses[0]!.used_by[0]!.crate.version = "1.2.4";
    expect(() => importCargoAboutReport(input, LOCK)).toThrow(/absent from Cargo.lock/u);
  });

  it.each(["", "\0bad"])("rejects unusable license text %j", (text) => {
    expect(() => importCargoAboutReport(report(text), LOCK)).toThrow(/Invalid license/u);
  });

  it("detects text, count, and duplicate-group corruption", () => {
    const inventory = importCargoAboutReport(report(), LOCK);
    const altered = structuredClone(inventory);
    altered.licenses[0].text += "changed";
    expect(() => renderRuntimeNotices(altered)).toThrow(/hash mismatch/u);
    const counted = structuredClone(inventory);
    counted.packageCount++;
    expect(() => renderRuntimeNotices(counted)).toThrow(/count mismatch/u);
    inventory.licenses.push(structuredClone(inventory.licenses[0]));
    expect(() => renderRuntimeNotices(inventory)).toThrow(/Duplicate license/u);
  });

  it("preserves the existing prefix and verifies without modifying files", async () => {
    const f = await fixture();
    expect(importRuntimeNotices(f.root, f.input)).toEqual({ packages: 1, licenseTexts: 1 });
    const text = await readFile(f.notices, "utf8");
    expect(text.startsWith(PREFIX)).toBe(true);
    const before = await stat(f.notices);
    expect(verifyRuntimeNotices(f.root)).toEqual({ packages: 1, licenseTexts: 1 });
    expect((await stat(f.notices)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(f.notices, "utf8")).toBe(text);
    importRuntimeNotices(f.root, f.input);
    expect(await readFile(f.notices, "utf8")).toBe(text);
  });

  it("rejects stale locks and removed or altered notice sections", async () => {
    const f = await fixture();
    importRuntimeNotices(f.root, f.input);
    await writeFile(join(f.root, "src-tauri/Cargo.lock"), Buffer.concat([LOCK, Buffer.from("\n")]));
    expect(() => verifyRuntimeNotices(f.root)).toThrow(/stale for Cargo.lock/u);
    await writeFile(join(f.root, "src-tauri/Cargo.lock"), LOCK);
    const text = await readFile(f.notices, "utf8");
    await writeFile(f.notices, text.replace("Fixture Author", "Changed Author"));
    expect(() => verifyRuntimeNotices(f.root)).toThrow(/missing or modified/u);
    await writeFile(f.notices, PREFIX);
    expect(() => verifyRuntimeNotices(f.root)).toThrow(/missing or modified/u);
  });

  it("validates malformed markers before writing either output", async () => {
    const f = await fixture();
    importRuntimeNotices(f.root, f.input);
    const prior = await readFile(f.inventory);
    const bad = PREFIX + "<!-- runtime-license-notices:start -->\n";
    await writeFile(f.notices, bad);
    expect(() => importRuntimeNotices(f.root, f.input)).toThrow(/Malformed runtime notice markers/u);
    expect(await readFile(f.inventory)).toEqual(prior);
    expect(await readFile(f.notices, "utf8")).toBe(bad);
    expect(() => replaceRuntimeNotices("<!-- runtime-license-notices:end --><!-- runtime-license-notices:start -->", "new")).toThrow(/Malformed/u);
  });

  it("bounds input size and rejects unknown CLI arguments", async () => {
    const f = await fixture();
    await writeFile(f.input, " ".repeat(16 * 1024 * 1024 + 1));
    expect(() => importRuntimeNotices(f.root, f.input)).toThrow(/bounded regular file/u);
    const script = fileURLToPath(new URL("../../../tools/legal/runtime-notices.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, "--import", f.input, "--write", "--unknown"], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
    expect(await readFile(f.notices, "utf8")).toBe(PREFIX);
  });
  it("retains the required native copyright and source notices in the real inventory", async () => {
    verifyRuntimeNotices(process.cwd());
    const inventory = JSON.parse(await readFile("tools/legal/runtime-license-inventory.json", "utf8")) as {
      licenses: { id: string; text: string; packages: { name: string }[] }[];
    };
    const notice = (name: string, id: string) => inventory.licenses
      .filter((license) => license.id === id && license.packages.some((pkg) => pkg.name === name))
      .map((license) => license.text).join("\n");
    expect(notice("webview2-com", "MIT")).toContain("Copyright (c) 2021 Bill Avery");
    expect(notice("dpi", "MIT")).toContain("Copyright (c) 2018 Jorge Aparicio");
    expect(notice("alloc-stdlib", "BSD-3-Clause")).toContain("Copyright (c) 2016 Dropbox, Inc.");
    expect(notice("icu_normalizer", "Unicode-3.0")).toContain("Unicode, Inc.");
    expect(notice("cssparser", "MPL-2.0")).toContain("Distribution of Executable Form");
  });
});
