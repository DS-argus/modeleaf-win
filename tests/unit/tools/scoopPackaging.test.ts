import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_VERSION = "1.2.3";
const REPOSITORY_SLUG = "fixture-owner/modeleaf-fixture";
const ZIP_BASENAME = `modeleaf-${PACKAGE_VERSION}-windows-x64.zip`;
const packageScript = fileURLToPath(new URL("../../../tools/windows/package-scoop.ps1", import.meta.url));
const stagingPrefix = ".modeleaf-scoop-staging-";

type FixtureOptions = {
  packageVersion?: string;
  tauriVersion?: string;
  cargoVersion?: string;
  omitThirdPartyNotices?: boolean;
  executableBytes?: Buffer;
};

type Fixture = {
  base: string;
  repository: string;
  executable: string;
  output: string;
  commit: string;
  sourceInputs: string[];
  packagedSources: Map<string, string>;
};

type ScoopManifest = {
  version: string;
  description: string;
  homepage: string;
  license: string;
  architecture: { "64bit": { url: string; hash: string } };
  bin: string;
  shortcuts: string[][];
  notes: string[];
};

type PackageReceipt = {
  source: { commit: string; version: string };
  artifact: { basename: string; sha256: string; bytes: number };
  status: { signature: string; executableValidation: string; nativeAcceptance: string };
};

// These synthetic bytes exercise PE header validation only. They are test-only,
// never shipped, launched, signed, or represented as a runnable application.
function syntheticX64GuiPe(machine = 0x8664, subsystem = 2): Buffer {
  const bytes = Buffer.alloc(512);
  const peOffset = 0x80;
  const optionalHeaderOffset = peOffset + 24;
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(peOffset, 0x3c);
  bytes.write("PE\0\0", peOffset, "ascii");
  bytes.writeUInt16LE(machine, peOffset + 4);
  bytes.writeUInt16LE(1, peOffset + 6);
  bytes.writeUInt16LE(0xf0, peOffset + 20);
  bytes.writeUInt16LE(0x0022, peOffset + 22);
  bytes.writeUInt16LE(0x020b, optionalHeaderOffset);
  bytes.writeUInt16LE(subsystem, optionalHeaderOffset + 68);
  return bytes;
}

function malformedPeWithEscapingOffset(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0xfffffff0, 0x3c);
  return bytes;
}

function git(repository: string, args: string[]): string {
  return execFileSync("git", ["-c", `core.hooksPath=${join(repository, ".disabled-test-hooks")}`, "-c", "commit.gpgsign=false", ...args], { cwd: repository, encoding: "utf8", windowsHide: true }).trim();
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "modeleaf-scoop-packaging-"));
  const repository = join(base, "repository");
  const executable = join(base, "candidate.exe");
  const output = join(base, "output");
  const packageVersion = options.packageVersion ?? PACKAGE_VERSION;
  const tauriVersion = options.tauriVersion ?? packageVersion;
  const cargoVersion = options.cargoVersion ?? packageVersion;
  await mkdir(repository, { recursive: true });

  const repositoryFiles = new Map<string, string | Buffer>();
  repositoryFiles.set("package.json", `${JSON.stringify({
    name: "modeleaf-win",
    version: packageVersion,
    license: "MIT",
    private: true,
  }, null, 2)}\n`);
  repositoryFiles.set("src-tauri/tauri.conf.json", `${JSON.stringify({
    productName: "Modeleaf",
    version: tauriVersion,
  }, null, 2)}\n`);
  repositoryFiles.set("src-tauri/Cargo.toml", [
    "[package]",
    'name = "modeleaf"',
    `version = "${cargoVersion}"`,
    'description = "Keyboard-first read-only PDF viewer for Windows"',
    'license = "MIT"',
    'edition = "2021"',
    "",
    "[dependencies]",
    "",
  ].join("\n"));
  repositoryFiles.set("LICENSE", "MIT License\n\nPermission is hereby granted for this disposable test fixture.\n");
  if (!options.omitThirdPartyNotices) {
    repositoryFiles.set("THIRD_PARTY_NOTICES.md", "# Third-party notices\n\nFixture notices.\n");
  }
  repositoryFiles.set("public/assets/pdfjs-6.2.108/cmaps/LICENSE", "CMap fixture license\n");
  repositoryFiles.set("public/assets/pdfjs-6.2.108/iccs/LICENSE", "ICC fixture license\n");
  repositoryFiles.set("public/assets/pdfjs-6.2.108/standard_fonts/LICENSE_FOXIT", "Foxit fixture license\n");
  repositoryFiles.set("public/assets/pdfjs-6.2.108/standard_fonts/LICENSE_LIBERATION", "Liberation fixture license\n");
  repositoryFiles.set("public/assets/pdfjs-6.2.108/wasm/LICENSE_JBIG2", "JBIG2 fixture license\n");
  repositoryFiles.set("public/assets/pdfjs-6.2.108/wasm/LICENSE_PDFJS_JBIG2", "PDF.js JBIG2 fixture license\n");
  repositoryFiles.set("public/assets/pdfjs-6.2.108/wasm/LICENSE_OPENJPEG", "OpenJPEG fixture license\n");
  repositoryFiles.set("public/assets/pdfjs-6.2.108/wasm/LICENSE_PDFJS_OPENJPEG", "PDF.js OpenJPEG fixture license\n");
  repositoryFiles.set("public/assets/pdfjs-6.2.108/wasm/LICENSE_PDFJS_QCMS", "PDF.js QCMS fixture license\n");
  repositoryFiles.set("public/assets/pdfjs-6.2.108/wasm/LICENSE_QCMS", "QCMS fixture license\n");

  // Decoys make an accidental whole-tree package observable without using real
  // credentials, user documents, build products, or test state.
  repositoryFiles.set("src/private-source.txt", "must not be packaged\n");
  repositoryFiles.set("build/machine-path.txt", "C:\\Users\\fixture\\must-not-leak\n");
  repositoryFiles.set("user-library/private.pdf", Buffer.from("test-only user PDF decoy"));
  repositoryFiles.set("test-state/session.json", '{"testOnlySecret":"must-not-leak"}\n');

  const sourceInputs: string[] = [];
  for (const [relativePath, contents] of repositoryFiles) {
    const target = join(repository, ...relativePath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
    sourceInputs.push(target);
  }
  await writeFile(executable, options.executableBytes ?? syntheticX64GuiPe());
  sourceInputs.push(executable);

  git(repository, ["init", "--quiet"]);
  git(repository, ["add", "--all", "--force"]);
  git(repository, [
    "-c", "user.name=Modeleaf Packaging Test",
    "-c", "user.email=modeleaf-packaging@example.invalid",
    "commit", "--quiet", "-m", "Create disposable packaging fixture",
  ]);
  const commit = git(repository, ["rev-parse", "HEAD"]);

  const packagedSources = new Map<string, string>([
    ["modeleaf.exe", executable],
    ["LICENSE", join(repository, "LICENSE")],
    ["THIRD_PARTY_NOTICES.md", join(repository, "THIRD_PARTY_NOTICES.md")],
    ["licenses/pdfjs/cmaps/LICENSE", join(repository, "public", "assets", "pdfjs-6.2.108", "cmaps", "LICENSE")],
    ["licenses/pdfjs/iccs/LICENSE", join(repository, "public", "assets", "pdfjs-6.2.108", "iccs", "LICENSE")],
    ["licenses/pdfjs/standard_fonts/LICENSE_FOXIT", join(repository, "public", "assets", "pdfjs-6.2.108", "standard_fonts", "LICENSE_FOXIT")],
    ["licenses/pdfjs/standard_fonts/LICENSE_LIBERATION", join(repository, "public", "assets", "pdfjs-6.2.108", "standard_fonts", "LICENSE_LIBERATION")],
    ["licenses/pdfjs/wasm/LICENSE_JBIG2", join(repository, "public", "assets", "pdfjs-6.2.108", "wasm", "LICENSE_JBIG2")],
    ["licenses/pdfjs/wasm/LICENSE_PDFJS_JBIG2", join(repository, "public", "assets", "pdfjs-6.2.108", "wasm", "LICENSE_PDFJS_JBIG2")],
    ["licenses/pdfjs/wasm/LICENSE_OPENJPEG", join(repository, "public/assets/pdfjs-6.2.108/wasm/LICENSE_OPENJPEG")],
    ["licenses/pdfjs/wasm/LICENSE_PDFJS_OPENJPEG", join(repository, "public/assets/pdfjs-6.2.108/wasm/LICENSE_PDFJS_OPENJPEG")],
    ["licenses/pdfjs/wasm/LICENSE_PDFJS_QCMS", join(repository, "public/assets/pdfjs-6.2.108/wasm/LICENSE_PDFJS_QCMS")],
    ["licenses/pdfjs/wasm/LICENSE_QCMS", join(repository, "public/assets/pdfjs-6.2.108/wasm/LICENSE_QCMS")],
  ]);

  return { base, repository, executable, output, commit, sourceInputs, packagedSources };
}

function runPackager(fixture: Fixture, repositorySlug = REPOSITORY_SLUG, useDefaultRepositoryRoot = false): SpawnSyncReturns<string> {
  return spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", useDefaultRepositoryRoot ? join(fixture.repository, "tools/windows/package-scoop.ps1") : packageScript,
    "-ExecutablePath", fixture.executable,
    "-OutputDirectory", fixture.output,
    ...(useDefaultRepositoryRoot ? [] : ["-RepositoryRoot", fixture.repository]),
    "-RepositorySlug", repositorySlug,
  ], {
    cwd: fixture.base,
    encoding: "utf8",
    windowsHide: true,
  });
}

function commandOutput(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function requireSuccess(result: SpawnSyncReturns<string>): void {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`PowerShell packaging failed with status ${String(result.status)}:\n${commandOutput(result)}`);
  }
}

function requireFailure(result: SpawnSyncReturns<string>): string {
  if (result.error) throw result.error;
  expect(result.status, commandOutput(result)).not.toBe(0);
  return commandOutput(result);
}

async function inspectAndExtractZip(fixture: Fixture, zipPath: string): Promise<{ entries: string[]; extracted: string }> {
  const helper = join(fixture.base, "inspect-zip.ps1");
  const extracted = join(fixture.base, "extracted");
  await writeFile(helper, [
    "#Requires -Version 5.1",
    "param([string]$ZipPath, [string]$Destination)",
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)",
    "try {",
    "    foreach ($entry in $archive.Entries) { [Console]::Out.WriteLine($entry.FullName) }",
    "} finally {",
    "    $archive.Dispose()",
    "}",
    "[System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $Destination)",
    "",
  ].join("\n"));

  const result = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", helper,
    "-ZipPath", zipPath,
    "-Destination", extracted,
  ], { encoding: "utf8", windowsHide: true });
  requireSuccess(result);
  const entries = (result.stdout ?? "")
    .split(/\r?\n/u)
    .map((entry) => entry.trim().replaceAll("\\", "/"))
    .filter((entry) => entry.length > 0 && !entry.endsWith("/"))
    .sort();
  return { entries, extracted };
}

async function inputSnapshot(paths: string[]): Promise<Map<string, Buffer>> {
  return new Map(await Promise.all(paths.map(async (path) => [path, await readFile(path)] as const)));
}

async function stagingNames(base: string): Promise<string[]> {
  return (await readdir(base, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(stagingPrefix))
    .map((entry) => entry.name)
    .sort();
}

const windowsSuite = describe.skipIf(process.platform !== "win32");

windowsSuite("Windows Scoop package preparation", () => {
  it("creates only the curated ZIP and truthful manifest, checksums, and receipt without changing sources", async () => {
    const fixture = await createFixture();
    try {
      const unrelatedLicense = join(fixture.repository, "public/assets/pdfjs-6.2.108/wasm/LICENSE_LOCAL_PRIVATE");
      await writeFile(unrelatedLicense, "Untracked test-only private decoy; never include in an artifact.\n");
      fixture.sourceInputs.push(unrelatedLicense);
      const beforeStatus = git(fixture.repository, ["status", "--short"]);
      expect(beforeStatus).toContain("LICENSE_LOCAL_PRIVATE");
      const before = await inputSnapshot(fixture.sourceInputs);
      const result = runPackager(fixture);
      requireSuccess(result);

      expect((await readdir(fixture.output)).sort()).toEqual([
        "SHA256SUMS",
        "modeleaf.json",
        "package-receipt.json",
        ZIP_BASENAME,
      ].sort());

      const zipPath = join(fixture.output, ZIP_BASENAME);
      const zipBytes = await readFile(zipPath);
      const zipSha256 = createHash("sha256").update(zipBytes).digest("hex");
      const { entries, extracted } = await inspectAndExtractZip(fixture, zipPath);
      expect(entries).toEqual([...fixture.packagedSources.keys()].sort());
      for (const [entry, source] of fixture.packagedSources) {
        expect(await readFile(join(extracted, ...entry.split("/")))).toEqual(await readFile(source));
      }

      const manifest = JSON.parse(await readFile(join(fixture.output, "modeleaf.json"), "utf8")) as ScoopManifest;
      expect(manifest).toEqual({
        version: PACKAGE_VERSION,
        description: "Keyboard-first read-only PDF viewer for Windows",
        homepage: `https://github.com/${REPOSITORY_SLUG}`,
        license: "MIT",
        architecture: {
          "64bit": {
            url: `https://github.com/${REPOSITORY_SLUG}/releases/download/v${PACKAGE_VERSION}/${ZIP_BASENAME}`,
            hash: zipSha256,
          },
        },
        bin: "modeleaf.exe",
        shortcuts: [["modeleaf.exe", "Modeleaf"]],
        notes: [
          "Requires Windows 11 x64.",
          "Requires the Microsoft Edge WebView2 Runtime to be installed.",
        ],
      });
      expect(manifest.notes.join(" ")).not.toMatch(/auto-install|file association|user data|available now/iu);

      const checksumText = await readFile(join(fixture.output, "SHA256SUMS"), "utf8");
      expect(checksumText.replaceAll("\r\n", "\n")).toBe(`${zipSha256}  ${ZIP_BASENAME}\n`);
      const receiptText = await readFile(join(fixture.output, "package-receipt.json"), "utf8");
      const receipt = JSON.parse(receiptText) as PackageReceipt;
      expect(receipt).toEqual({
        source: { commit: fixture.commit, version: PACKAGE_VERSION },
        artifact: { basename: ZIP_BASENAME, sha256: zipSha256, bytes: zipBytes.length },
        status: {
          signature: "not-verified",
          executableValidation: "header-only",
          nativeAcceptance: "not-verified",
        },
      });
      expect(receiptText).not.toContain(fixture.repository);
      expect(receiptText).not.toContain(fixture.executable);

      for (const [path, bytes] of before) {
        expect(await readFile(path)).toEqual(bytes);
      }
      expect(git(fixture.repository, ["status", "--short"])).toBe(beforeStatus);
      expect(await stagingNames(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  it("resolves the repository root when the optional argument is omitted", async () => {
    const fixture = await createFixture();
    try {
      const copiedScript = join(fixture.repository, "tools/windows/package-scoop.ps1");
      await mkdir(dirname(copiedScript), { recursive: true });
      await writeFile(copiedScript, await readFile(packageScript));
      requireSuccess(runPackager(fixture, REPOSITORY_SLUG, true));
      const receipt = JSON.parse(await readFile(join(fixture.output, "package-receipt.json"), "utf8")) as PackageReceipt;
      expect(receipt.source).toEqual({ commit: fixture.commit, version: PACKAGE_VERSION });
      expect(await stagingNames(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });
  it.each([
    { metadata: "Tauri", options: { tauriVersion: "1.2.4" } satisfies FixtureOptions },
    { metadata: "Cargo", options: { cargoVersion: "1.2.4" } satisfies FixtureOptions },
  ])("rejects a $metadata version that differs from package.json", async ({ options }) => {
    const fixture = await createFixture(options);
    try {
      expect(requireFailure(runPackager(fixture))).toMatch(/version mismatch/iu);
      expect(existsSync(fixture.output)).toBe(false);
      expect(await stagingNames(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  it.each([
    {
      caseName: "out-of-bounds PE header",
      executableBytes: malformedPeWithEscapingOffset(),
      expectedError: /out-of-bounds PE header offset/iu,
    },
    {
      caseName: "x86 PE architecture",
      executableBytes: syntheticX64GuiPe(0x014c),
      expectedError: /architecture must be x64/iu,
    },
    {
      caseName: "console PE subsystem",
      executableBytes: syntheticX64GuiPe(0x8664, 3),
      expectedError: /subsystem must be Windows GUI/iu,
    },
  ])("rejects $caseName", async ({ executableBytes, expectedError }) => {
    const fixture = await createFixture({ executableBytes });
    try {
      expect(requireFailure(runPackager(fixture))).toMatch(expectedError);
      expect(existsSync(fixture.output)).toBe(false);
      expect(await stagingNames(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  it("rejects a missing required third-party notice", async () => {
    const fixture = await createFixture({ omitThirdPartyNotices: true });
    try {
      expect(requireFailure(runPackager(fixture))).toMatch(/THIRD_PARTY_NOTICES\.md is missing/iu);
      expect(existsSync(fixture.output)).toBe(false);
      expect(await stagingNames(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  it("rejects a missing pinned WebAssembly license", async () => {
    const fixture = await createFixture();
    try {
      await rm(join(fixture.repository, "public/assets/pdfjs-6.2.108/wasm/LICENSE_QCMS"));
      expect(requireFailure(runPackager(fixture))).toMatch(/LICENSE_QCMS.*missing/iu);
      expect(existsSync(fixture.output)).toBe(false);
      expect(await stagingNames(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });
  it("refuses an existing output directory without changing its contents", async () => {
    const fixture = await createFixture();
    try {
      const sentinel = join(fixture.output, "keep.txt");
      await mkdir(fixture.output);
      await writeFile(sentinel, "existing output must survive\n");
      expect(requireFailure(runPackager(fixture))).toMatch(/OutputDirectory already exists/iu);
      expect(await readFile(sentinel, "utf8")).toBe("existing output must survive\n");
      expect(await readdir(fixture.output)).toEqual(["keep.txt"]);
      expect(await stagingNames(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  it.each([
    {
      caseName: "repository slug path injection",
      options: {} satisfies FixtureOptions,
      slug: "owner/repository/../../escape",
      expectedError: /safe GitHub owner\/repository slug/iu,
    },
    {
      caseName: "version path injection",
      options: {
        packageVersion: "1.2.3/../../escape",
        tauriVersion: "1.2.3/../../escape",
        cargoVersion: "1.2.3/../../escape",
      } satisfies FixtureOptions,
      slug: REPOSITORY_SLUG,
      expectedError: /safe semantic version/iu,
    },
  ])("rejects $caseName", async ({ options, slug, expectedError }) => {
    const fixture = await createFixture(options);
    try {
      expect(requireFailure(runPackager(fixture, slug))).toMatch(expectedError);
      expect(existsSync(fixture.output)).toBe(false);
      expect(await stagingNames(fixture.base)).toEqual([]);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  it("removes only its owned staging directory after a packaging failure", async () => {
    const fixture = await createFixture({ executableBytes: malformedPeWithEscapingOffset() });
    const neighborName = `${stagingPrefix}do-not-delete`;
    const neighbor = join(fixture.base, neighborName);
    try {
      await mkdir(neighbor);
      await writeFile(join(neighbor, "sentinel.txt"), "user-owned neighbor\n");
      expect(requireFailure(runPackager(fixture))).toMatch(/out-of-bounds PE header offset/iu);
      expect(await stagingNames(fixture.base)).toEqual([neighborName]);
      expect(await readFile(join(neighbor, "sentinel.txt"), "utf8")).toBe("user-owned neighbor\n");
      expect(existsSync(fixture.output)).toBe(false);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });
});
