import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateScoopRelease } from "../../../tools/releases/prepare-scoop-release.mjs";

const VERSION = "1.2.3";
const TAG = `v${VERSION}`;
const REPOSITORY = "fixture-owner/modeleaf-fixture";
const SOURCE_COMMIT = "a".repeat(40);
const OTHER_SOURCE_COMMIT = "b".repeat(40);
const ZIP_BASENAME = `modeleaf-${VERSION}-windows-x64.zip`;
const ASSET_BASENAMES = [ZIP_BASENAME, "modeleaf.json", "SHA256SUMS", "package-receipt.json"];
const releaseScript = fileURLToPath(new URL("../../../tools/releases/prepare-scoop-release.mjs", import.meta.url));

// This is a disposable, test-only empty-ZIP byte sequence. No test executes it,
// launches it, signs it, publishes it, or represents it as a real application.
const SYNTHETIC_ZIP_BYTES = Buffer.from([
  0x50, 0x4b, 0x05, 0x06,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00,
]);
const ZIP_SHA256 = createHash("sha256").update(SYNTHETIC_ZIP_BYTES).digest("hex");
const OTHER_SHA256 = "f".repeat(64) === ZIP_SHA256 ? "e".repeat(64) : "f".repeat(64);

const MANIFEST_NOTES = [
  "Requires Windows 11 x64.",
  "Requires the Microsoft Edge WebView2 Runtime to be installed.",
];

type ManifestFixture = {
  version: string;
  description: string;
  homepage: string;
  license: string;
  architecture: { "64bit": { url: string; hash: string } };
  bin: string;
  shortcuts: string[][];
  notes: string[];
  [key: string]: unknown;
};

type ReceiptFixture = {
  source: { commit: string; version: string };
  artifact: { basename: string; sha256: string; bytes: number };
  status: { signature: string; executableValidation: string; nativeAcceptance: string };
};

type Fixture = {
  base: string;
  artifacts: string;
  notesFile: string;
};

type ValidatorOptions = {
  artifacts: string;
  repository: string;
  tag: string;
  sourceCommit: string;
  zipSha256: string;
};

const cleanupRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanupRoots].map((path) => rm(path, { recursive: true, force: true })));
  cleanupRoots.clear();
});

function manifestFixture(): ManifestFixture {
  return {
    version: VERSION,
    description: "Keyboard-first read-only PDF viewer for Windows",
    homepage: `https://github.com/${REPOSITORY}`,
    license: "MIT",
    architecture: {
      "64bit": {
        url: `https://github.com/${REPOSITORY}/releases/download/${TAG}/${ZIP_BASENAME}`,
        hash: ZIP_SHA256,
      },
    },
    bin: "modeleaf.exe",
    shortcuts: [["modeleaf.exe", "Modeleaf"]],
    notes: [...MANIFEST_NOTES],
  };
}

function receiptFixture(): ReceiptFixture {
  return {
    source: { commit: SOURCE_COMMIT, version: VERSION },
    artifact: {
      basename: ZIP_BASENAME,
      sha256: ZIP_SHA256,
      bytes: SYNTHETIC_ZIP_BYTES.length,
    },
    status: {
      signature: "not-verified",
      executableValidation: "header-only",
      nativeAcceptance: "not-verified",
    },
  };
}

async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "modeleaf-scoop-release-"));
  cleanupRoots.add(base);
  const artifacts = join(base, "artifacts");
  await mkdir(artifacts);
  await Promise.all([
    writeFile(join(artifacts, ZIP_BASENAME), SYNTHETIC_ZIP_BYTES),
    writeFile(join(artifacts, "modeleaf.json"), `${JSON.stringify(manifestFixture(), null, 2)}\n`),
    writeFile(join(artifacts, "SHA256SUMS"), `${ZIP_SHA256}  ${ZIP_BASENAME}\n`),
    writeFile(join(artifacts, "package-receipt.json"), `${JSON.stringify(receiptFixture(), null, 2)}\n`),
  ]);
  return { base, artifacts, notesFile: join(base, "release-notes.md") };
}

function validatorOptions(fixture: Fixture, overrides: Partial<ValidatorOptions> = {}): ValidatorOptions {
  return {
    artifacts: fixture.artifacts,
    repository: REPOSITORY,
    tag: TAG,
    sourceCommit: SOURCE_COMMIT,
    zipSha256: ZIP_SHA256,
    ...overrides,
  };
}

async function updateManifest(fixture: Fixture, update: (manifest: ManifestFixture) => void): Promise<void> {
  const path = join(fixture.artifacts, "modeleaf.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as ManifestFixture;
  update(manifest);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function updateReceipt(fixture: Fixture, update: (receipt: ReceiptFixture) => void): Promise<void> {
  const path = join(fixture.artifacts, "package-receipt.json");
  const receipt = JSON.parse(await readFile(path, "utf8")) as ReceiptFixture;
  update(receipt);
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

async function artifactSnapshot(artifacts: string): Promise<Map<string, Buffer>> {
  const names = (await readdir(artifacts)).sort();
  return new Map(await Promise.all(names.map(async (name) => [name, await readFile(join(artifacts, name))] as const)));
}

function cliArguments(
  fixture: Fixture,
  overrides: Partial<ValidatorOptions & { notesFile: string }> = {},
): string[] {
  const options = { ...validatorOptions(fixture), notesFile: fixture.notesFile, ...overrides };
  return [
    "--artifacts", options.artifacts,
    "--repository", options.repository,
    "--tag", options.tag,
    "--source-commit", options.sourceCommit,
    "--zip-sha256", options.zipSha256,
    "--notes-file", options.notesFile,
  ];
}

function runCli(fixture: Fixture, overrides: Partial<ValidatorOptions & { notesFile: string }> = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [releaseScript, ...cliArguments(fixture, overrides)], {
    cwd: fixture.base,
    encoding: "utf8",
    windowsHide: true,
  });
}

function commandOutput(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function requireCliSuccess(result: SpawnSyncReturns<string>): void {
  if (result.error) throw result.error;
  expect(result.status, commandOutput(result)).toBe(0);
}

function requireCliFailure(result: SpawnSyncReturns<string>): string {
  if (result.error) throw result.error;
  expect(result.status, commandOutput(result)).not.toBe(0);
  expect(result.stdout).toBe("");
  return result.stderr ?? "";
}

describe("Scoop release validation and notes", () => {
  it("validates the exact four-file contract and returns truthful initial-release notes", async () => {
    const fixture = await createFixture();
    const result = await validateScoopRelease(validatorOptions(fixture));

    expect(result).toEqual({
      version: VERSION,
      sourceCommit: SOURCE_COMMIT,
      zipSha256: ZIP_SHA256,
      assetBasenames: ASSET_BASENAMES,
      releaseNotes: expect.any(String),
    });
    expect(result.releaseNotes).toContain("initial experimental Modeleaf release for Windows 11 x64");
    expect(result.releaseNotes).toContain("owner accepted basic app use");
    expect(result.releaseNotes).toMatch(/native behavior.*DPI scaling.*Narrator accessibility.*clean-machine installation.*signature checks are unverified/isu);
    expect(result.releaseNotes).toContain("Live configuration changes are not yet applied completely.");
    expect(result.releaseNotes).toContain("Full-document printing is incomplete.");
    expect(result.releaseNotes).toContain("Update retrieval is incomplete.");
    expect(result.releaseNotes).toMatch(/table of contents \(TOC\).*keyboard link hints.*link-destination indicators.*retired/isu);
    expect(result.releaseNotes).toContain("Prerequisite: Install the Microsoft Edge WebView2 Runtime");
    expect(result.releaseNotes).toContain(
      `scoop install https://github.com/${REPOSITORY}/releases/download/${TAG}/modeleaf.json`,
    );
    expect(result.releaseNotes).toContain("does not create or imply an automatic Scoop bucket or update channel");
    expect(result.releaseNotes).not.toMatch(/\bis signed\b|\bsigned release\b|fully certified/iu);
  });

  it("rejects a source receipt that differs from the approved source commit", async () => {
    const fixture = await createFixture();
    await expect(validateScoopRelease(validatorOptions(fixture, {
      sourceCommit: OTHER_SOURCE_COMMIT,
    }))).rejects.toThrow(/source commit does not match/iu);
  });

  it("rejects a tag whose version differs from the four release inputs", async () => {
    const fixture = await createFixture();
    await expect(validateScoopRelease(validatorOptions(fixture, {
      tag: "v1.2.4",
    }))).rejects.toThrow(/tag-derived four-file contract/iu);
  });

  it("rejects unsafe repository and tag syntax before reading artifacts", async () => {
    const fixture = await createFixture();
    await expect(validateScoopRelease(validatorOptions(fixture, {
      repository: "fixture-owner/../other",
    }))).rejects.toThrow(/safe GitHub/iu);
    await expect(validateScoopRelease(validatorOptions(fixture, {
      tag: "v01.2.3",
    }))).rejects.toThrow(/safe semantic version/iu);
  });

  it("rejects an approved ZIP digest that differs from the metadata", async () => {
    const fixture = await createFixture();
    await expect(validateScoopRelease(validatorOptions(fixture, {
      zipSha256: OTHER_SHA256,
    }))).rejects.toThrow(/manifest ZIP hash.*approved/iu);
  });

  it("rejects a manifest ZIP hash mismatch", async () => {
    const fixture = await createFixture();
    await updateManifest(fixture, (manifest) => {
      manifest.architecture["64bit"].hash = OTHER_SHA256;
    });
    await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(/manifest ZIP hash.*approved/iu);
  });

  it("rejects a package receipt ZIP hash mismatch", async () => {
    const fixture = await createFixture();
    await updateReceipt(fixture, (receipt) => {
      receipt.artifact.sha256 = OTHER_SHA256;
    });
    await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(/receipt ZIP hash.*approved/iu);
  });

  it("rejects streamed ZIP bytes that differ from the approved digest", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.artifacts, ZIP_BASENAME), Buffer.from([...SYNTHETIC_ZIP_BYTES, 0x01]));
    await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(/streamed release ZIP hash/iu);
  });

  it("rejects a package receipt byte-count mismatch", async () => {
    const fixture = await createFixture();
    await updateReceipt(fixture, (receipt) => {
      receipt.artifact.bytes += 1;
    });
    await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(/byte count.*package receipt/iu);
  });

  it("rejects an arbitrary package receipt artifact path", async () => {
    const fixture = await createFixture();
    await updateReceipt(fixture, (receipt) => {
      receipt.artifact.basename = "../unreviewed.zip";
    });
    await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(/artifact basename/iu);
  });

  it.each([
    {
      name: "digest",
      checksum: `${OTHER_SHA256}  ${ZIP_BASENAME}\n`,
      expected: /SHA256SUMS digest.*approved/iu,
    },
    {
      name: "filename",
      checksum: `${ZIP_SHA256}  modeleaf-${VERSION}-other.zip\n`,
      expected: /SHA256SUMS filename/iu,
    },
    {
      name: "line shape",
      checksum: `${ZIP_SHA256} *${ZIP_BASENAME}\n`,
      expected: /canonical checksum line/iu,
    },
  ])("rejects a checksum $name mismatch", async ({ checksum, expected }) => {
    const fixture = await createFixture();
    await writeFile(join(fixture.artifacts, "SHA256SUMS"), checksum);
    await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(expected);
  });

  it("rejects a manifest URL targeting another release", async () => {
    const fixture = await createFixture();
    await updateManifest(fixture, (manifest) => {
      manifest.architecture["64bit"].url = `https://github.com/${REPOSITORY}/releases/download/v9.9.9/${ZIP_BASENAME}`;
    });
    await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(/manifest release URL/iu);
  });

  it("rejects an architecture target in addition to 64bit", async () => {
    const fixture = await createFixture();
    await updateManifest(fixture, (manifest) => {
      (manifest.architecture as unknown as Record<string, unknown>)["32bit"] = {
        url: "https://example.invalid/unsafe.zip",
        hash: ZIP_SHA256,
      };
    });
    await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(/architecture.*unsupported field/iu);
  });

  it.each(["installer", "pre_install", "persist", "env_add_path", "env_set"])(
    "rejects the unsupported manifest hook %s",
    async (hook) => {
      const fixture = await createFixture();
      await updateManifest(fixture, (manifest) => {
        manifest[hook] = hook === "persist" ? ["config"] : "arbitrary executable content";
      });
      await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(/unsupported field/iu);
    },
  );

  it("rejects shortcut tampering", async () => {
    const fixture = await createFixture();
    await updateManifest(fixture, (manifest) => {
      manifest.shortcuts = [["cmd.exe", "Modeleaf"]];
    });
    await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(/shortcut/iu);
  });

  it("rejects arbitrary executable prerequisite notes", async () => {
    const fixture = await createFixture();
    await updateManifest(fixture, (manifest) => {
      manifest.notes.push("Run powershell.exe with arbitrary arguments.");
    });
    await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(/prerequisite notes/iu);
  });

  it.each([
    { field: "signature" as const, value: "verified", expected: /signature status as not-verified/iu },
    { field: "nativeAcceptance" as const, value: "verified", expected: /native acceptance status as not-verified/iu },
  ])("rejects fabricated receipt status for $field", async ({ field, value, expected }) => {
    const fixture = await createFixture();
    await updateReceipt(fixture, (receipt) => {
      receipt.status[field] = value;
    });
    await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(expected);
  });

  it("rejects a missing required input", async () => {
    const fixture = await createFixture();
    await rm(join(fixture.artifacts, "SHA256SUMS"));
    await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(/exactly four input files/iu);
  });

  it("rejects an extra input", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.artifacts, "unexpected.txt"), "not part of the release\n");
    await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(/exactly four input files/iu);
  });

  it("rejects a directory in place of a regular input file", async () => {
    const fixture = await createFixture();
    const manifestPath = join(fixture.artifacts, "modeleaf.json");
    await rm(manifestPath);
    await mkdir(manifestPath);
    await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(/regular file/iu);
  });

  it.each(["modeleaf.json", "package-receipt.json"])(
    "rejects malformed JSON metadata in %s",
    async (name) => {
      const fixture = await createFixture();
      await writeFile(join(fixture.artifacts, name), "{malformed-json\n");
      await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(/not valid JSON/iu);
    },
  );

  it.each([
    { name: "modeleaf.json", bytes: 64 * 1024 + 1 },
    { name: "package-receipt.json", bytes: 64 * 1024 + 1 },
    { name: "SHA256SUMS", bytes: 4 * 1024 + 1 },
  ])("rejects oversized bounded metadata in $name", async ({ name, bytes }) => {
    const fixture = await createFixture();
    await writeFile(join(fixture.artifacts, name), " ".repeat(bytes));
    await expect(validateScoopRelease(validatorOptions(fixture))).rejects.toThrow(/metadata size limit/iu);
  });

  it("creates release notes through the CLI and preserves every artifact byte", async () => {
    const fixture = await createFixture();
    const expected = await validateScoopRelease(validatorOptions(fixture));
    const before = await artifactSnapshot(fixture.artifacts);

    const cli = runCli(fixture);
    requireCliSuccess(cli);

    const stdout = JSON.parse(cli.stdout) as Record<string, unknown>;
    expect(stdout).toEqual({
      version: VERSION,
      sourceCommit: SOURCE_COMMIT,
      zipSha256: ZIP_SHA256,
      assetBasenames: ASSET_BASENAMES,
      notesCreated: true,
    });
    expect(cli.stdout).not.toContain(fixture.base);
    expect(cli.stdout.length).toBeLessThan(1024);
    expect(await readFile(fixture.notesFile, "utf8")).toBe(expected.releaseNotes);
    expect(await artifactSnapshot(fixture.artifacts)).toEqual(before);
  });

  it("creates notes exclusively without overwriting an existing output", async () => {
    const fixture = await createFixture();
    const sentinel = "existing owner-reviewed notes\n";
    await writeFile(fixture.notesFile, sentinel);
    const before = await artifactSnapshot(fixture.artifacts);

    expect(requireCliFailure(runCli(fixture))).toMatch(/already exists.*refusing to overwrite/iu);
    expect(await readFile(fixture.notesFile, "utf8")).toBe(sentinel);
    expect(await artifactSnapshot(fixture.artifacts)).toEqual(before);
  });

  it("does not create notes when CLI validation fails", async () => {
    const fixture = await createFixture();
    const before = await artifactSnapshot(fixture.artifacts);

    expect(requireCliFailure(runCli(fixture, { zipSha256: OTHER_SHA256 }))).toMatch(/manifest ZIP hash.*approved/iu);
    expect(existsSync(fixture.notesFile)).toBe(false);
    expect(await artifactSnapshot(fixture.artifacts)).toEqual(before);
  });

  it("rejects a notes output inside the artifact directory", async () => {
    const fixture = await createFixture();
    const inside = join(fixture.artifacts, "release-notes.md");
    const before = await artifactSnapshot(fixture.artifacts);

    expect(requireCliFailure(runCli(fixture, { notesFile: inside }))).toMatch(/outside the artifact directory/iu);
    expect(existsSync(inside)).toBe(false);
    expect(await artifactSnapshot(fixture.artifacts)).toEqual(before);
  });
});
