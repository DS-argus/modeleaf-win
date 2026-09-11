import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareScoopBucket } from "../../../tools/releases/prepare-scoop-bucket.mjs";

const VERSION = "1.2.3";
const TAG = `v${VERSION}`;
const REPOSITORY = "DS-argus/modeleaf-win";
const SOURCE_COMMIT = "a".repeat(40);
const ZIP_BASENAME = `modeleaf-${VERSION}-windows-x64.zip`;
const ASSET_BASENAMES = [ZIP_BASENAME, "modeleaf.json", "SHA256SUMS", "package-receipt.json"] as const;
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/tags/${TAG}`;

// Disposable test-only ZIP bytes. Tests never execute, sign, or publish them.
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

type Fixture = {
  base: string;
  artifacts: string;
  outputDirectory: string;
  manifestBytes: Buffer;
  assetBytes: Map<string, Buffer>;
};

type ReleaseAssetFixture = {
  name: string;
  state: string;
  size: number;
  digest: string;
  browser_download_url: string;
};

type ReleaseFixture = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: ReleaseAssetFixture[];
};

type FetchCall = {
  url: string;
  redirect: RequestRedirect | undefined;
  credentials: RequestCredentials | undefined;
  hasAuthorization: boolean;
  hasSignal: boolean;
};

type FetchHarnessOptions = {
  releaseStatus?: number;
  apiError?: Error;
  downloads?: ReadonlyMap<string, Uint8Array>;
  downloadErrorName?: string;
  redirectUrl?: (name: string) => string;
};

const cleanupRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanupRoots].map((path) => rm(path, { recursive: true, force: true })));
  cleanupRoots.clear();
});

function manifestFixture(): Record<string, unknown> {
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

function receiptFixture(): Record<string, unknown> {
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
  const base = await mkdtemp(join(tmpdir(), "modeleaf-scoop-bucket-"));
  cleanupRoots.add(base);
  const artifacts = join(base, "artifacts");
  const outputDirectory = join(base, "scoop-bucket-output");
  await mkdir(artifacts);

  const manifestBytes = Buffer.from(`${JSON.stringify(manifestFixture(), null, 2)}\n`);
  const checksumBytes = Buffer.from(`${ZIP_SHA256}  ${ZIP_BASENAME}\n`);
  const receiptBytes = Buffer.from(`${JSON.stringify(receiptFixture(), null, 2)}\n`);
  const assetBytes = new Map<string, Buffer>([
    [ZIP_BASENAME, SYNTHETIC_ZIP_BYTES],
    ["modeleaf.json", manifestBytes],
    ["SHA256SUMS", checksumBytes],
    ["package-receipt.json", receiptBytes],
  ]);
  await Promise.all(
    [...assetBytes].map(async ([name, bytes]) => writeFile(join(artifacts, name), bytes)),
  );
  return { base, artifacts, outputDirectory, manifestBytes, assetBytes };
}

function releaseFixture(fixture: Fixture): ReleaseFixture {
  return {
    tag_name: TAG,
    draft: false,
    prerelease: true,
    published_at: "2026-09-11T00:00:00Z",
    assets: ASSET_BASENAMES.map((name) => {
      const bytes = fixture.assetBytes.get(name);
      if (!bytes) throw new Error(`Missing fixture bytes for ${name}`);
      return {
        name,
        state: "uploaded",
        size: bytes.byteLength,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${TAG}/${name}`,
      };
    }),
  };
}

function streamedResponse(bytes: Uint8Array): Response {
  let offset = 0;
  const chunkSize = Math.max(1, Math.ceil(bytes.byteLength / 3));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const nextOffset = Math.min(bytes.byteLength, offset + chunkSize);
      controller.enqueue(bytes.slice(offset, nextOffset));
      offset = nextOffset;
    },
  });
  return new Response(body, { status: 200 });
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function createFetchHarness(
  release: ReleaseFixture,
  fixture: Fixture,
  options: FetchHarnessOptions = {},
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const cdnUrls = new Map(
    ASSET_BASENAMES.map((name) => [
      options.redirectUrl?.(name) ?? `https://release-assets.githubusercontent.com/modeleaf-test/${encodeURIComponent(name)}`,
      name,
    ]),
  );

  const fetchImplementation = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = inputUrl(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      redirect: init?.redirect,
      credentials: init?.credentials,
      hasAuthorization: headers.has("authorization"),
      hasSignal: init?.signal !== undefined && init.signal !== null,
    });

    if (url === API_URL) {
      if (options.apiError) throw options.apiError;
      const status = options.releaseStatus ?? 200;
      return new Response(JSON.stringify(release), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    const releaseAssetName = ASSET_BASENAMES.find(
      (name) => url === `https://github.com/${REPOSITORY}/releases/download/${TAG}/${name}`,
    );
    if (releaseAssetName) {
      if (options.downloadErrorName === releaseAssetName) {
        throw new Error("simulated public download failure");
      }
      const redirectUrl = options.redirectUrl?.(releaseAssetName)
        ?? `https://release-assets.githubusercontent.com/modeleaf-test/${encodeURIComponent(releaseAssetName)}`;
      return new Response(null, { status: 302, headers: { location: redirectUrl } });
    }

    const cdnAssetName = cdnUrls.get(url);
    if (cdnAssetName) {
      const bytes = options.downloads?.get(cdnAssetName) ?? fixture.assetBytes.get(cdnAssetName);
      if (!bytes) throw new Error(`Missing download bytes for ${cdnAssetName}`);
      return streamedResponse(bytes);
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  return { fetch: fetchImplementation as typeof fetch, calls };
}

function bucketOptions(fixture: Fixture, fetchImplementation: typeof fetch) {
  return {
    artifacts: fixture.artifacts,
    repository: REPOSITORY,
    tag: TAG,
    sourceCommit: SOURCE_COMMIT,
    zipSha256: ZIP_SHA256,
    outputDirectory: fixture.outputDirectory,
    fetch: fetchImplementation,
  };
}

async function artifactSnapshot(artifacts: string): Promise<Map<string, Buffer>> {
  const names = (await readdir(artifacts)).sort();
  return new Map(
    await Promise.all(names.map(async (name) => [name, await readFile(join(artifacts, name))] as const)),
  );
}

async function expectNoOutputAndUnchangedArtifacts(
  fixture: Fixture,
  before: Map<string, Buffer>,
): Promise<void> {
  expect(existsSync(fixture.outputDirectory)).toBe(false);
  expect(await artifactSnapshot(fixture.artifacts)).toEqual(before);
}

describe("Scoop bucket public-release promotion", () => {
  it("accepts a published prerelease, verifies streamed public bytes, and writes only the exact manifest", async () => {
    const fixture = await createFixture();
    const before = await artifactSnapshot(fixture.artifacts);
    const release = releaseFixture(fixture);
    expect(release.prerelease).toBe(true);
    const transport = createFetchHarness(release, fixture);

    const result = await prepareScoopBucket(bucketOptions(fixture, transport.fetch));

    const manifestSha256 = createHash("sha256").update(fixture.manifestBytes).digest("hex");
    expect(result).toEqual({
      sourceCommit: SOURCE_COMMIT,
      version: VERSION,
      zipSha256: ZIP_SHA256,
      manifestSha256,
      publicDownloadVerification: true,
    });
    expect(JSON.stringify(result)).not.toContain(fixture.base);
    expect(JSON.stringify(result)).not.toMatch(/signature|native/iu);
    expect(await readdir(fixture.outputDirectory)).toEqual(["bucket"]);
    expect(await readdir(join(fixture.outputDirectory, "bucket"))).toEqual(["modeleaf.json"]);
    expect(await readFile(join(fixture.outputDirectory, "bucket", "modeleaf.json"))).toEqual(fixture.manifestBytes);
    expect(await artifactSnapshot(fixture.artifacts)).toEqual(before);

    const initialUrls = [
      API_URL,
      ...ASSET_BASENAMES.map(
        (name) => `https://github.com/${REPOSITORY}/releases/download/${TAG}/${name}`,
      ),
    ];
    for (const url of initialUrls) {
      expect(transport.calls.filter((call) => call.url === url)).toHaveLength(1);
    }
    expect(transport.calls).toHaveLength(1 + ASSET_BASENAMES.length * 2);
    expect(transport.calls.every((call) => call.redirect === "manual")).toBe(true);
    expect(transport.calls.every((call) => !call.hasAuthorization)).toBe(true);
    expect(transport.calls.every((call) => call.credentials === "omit")).toBe(true);
    expect(transport.calls.every((call) => call.hasSignal)).toBe(true);
  });

  it.each([
    {
      name: "an absent or private release",
      configure: (release: ReleaseFixture) => ({ release, status: 404 }),
      expected: /absent or not publicly accessible/iu,
    },
    {
      name: "a draft release",
      configure: (release: ReleaseFixture) => {
        release.draft = true;
        return { release, status: 200 };
      },
      expected: /must not be a draft/iu,
    },
    {
      name: "an unpublished release",
      configure: (release: ReleaseFixture) => {
        release.published_at = null;
        return { release, status: 200 };
      },
      expected: /published_at/iu,
    },
    {
      name: "a release for the wrong tag",
      configure: (release: ReleaseFixture) => {
        release.tag_name = "v1.2.4";
        return { release, status: 200 };
      },
      expected: /tag does not match/iu,
    },
  ])("rejects $name before creating output", async ({ configure, expected }) => {
    const fixture = await createFixture();
    const before = await artifactSnapshot(fixture.artifacts);
    const configured = configure(releaseFixture(fixture));
    const transport = createFetchHarness(configured.release, fixture, { releaseStatus: configured.status });

    await expect(prepareScoopBucket(bucketOptions(fixture, transport.fetch))).rejects.toThrow(expected);
    await expectNoOutputAndUnchangedArtifacts(fixture, before);
  });

  it.each([
    {
      name: "invalid upload state metadata",
      mutate: (release: ReleaseFixture) => {
        release.assets[0]!.state = "new";
      },
      expected: /not fully uploaded/iu,
    },
    {
      name: "unexpected name",
      mutate: (release: ReleaseFixture) => {
        release.assets[0]!.name = "other.zip";
      },
      expected: /unexpected asset name/iu,
    },
    {
      name: "duplicate name",
      mutate: (release: ReleaseFixture) => {
        release.assets[1]!.name = release.assets[0]!.name;
      },
      expected: /duplicate asset name/iu,
    },
    {
      name: "missing asset",
      mutate: (release: ReleaseFixture) => {
        release.assets.pop();
      },
      expected: /exactly the four expected assets/iu,
    },
    {
      name: "extra asset",
      mutate: (release: ReleaseFixture) => {
        release.assets.push({
          ...release.assets[0]!,
          name: "unexpected.txt",
          browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${TAG}/unexpected.txt`,
        });
      },
      expected: /exactly the four expected assets/iu,
    },
    {
      name: "non-allowlisted browser URL",
      mutate: (release: ReleaseFixture) => {
        release.assets[0]!.browser_download_url = "https://example.invalid/untrusted.zip";
      },
      expected: /browser download URL is not allowlisted/iu,
    },
    {
      name: "digest mismatch",
      mutate: (release: ReleaseFixture) => {
        release.assets[0]!.digest = `sha256:${OTHER_SHA256}`;
      },
      expected: /SHA-256 digest does not match/iu,
    },
    {
      name: "size mismatch",
      mutate: (release: ReleaseFixture) => {
        release.assets[0]!.size += 1;
      },
      expected: /size does not match/iu,
    },
  ])("rejects release asset $name", async ({ mutate, expected }) => {
    const fixture = await createFixture();
    const before = await artifactSnapshot(fixture.artifacts);
    const release = releaseFixture(fixture);
    mutate(release);
    const transport = createFetchHarness(release, fixture);

    await expect(prepareScoopBucket(bucketOptions(fixture, transport.fetch))).rejects.toThrow(expected);
    await expectNoOutputAndUnchangedArtifacts(fixture, before);
  });

  it("rejects same-size corrupted bytes from an actual public asset download", async () => {
    const fixture = await createFixture();
    const before = await artifactSnapshot(fixture.artifacts);
    const downloads = new Map<string, Uint8Array>(fixture.assetBytes);
    const corruptedZip = Buffer.from(SYNTHETIC_ZIP_BYTES);
    corruptedZip[0] = corruptedZip[0]! ^ 0xff;
    downloads.set(ZIP_BASENAME, corruptedZip);
    const transport = createFetchHarness(releaseFixture(fixture), fixture, { downloads });

    await expect(prepareScoopBucket(bucketOptions(fixture, transport.fetch))).rejects.toThrow(
      /public asset download.*SHA-256 does not match/iu,
    );
    await expectNoOutputAndUnchangedArtifacts(fixture, before);
  });

  it.each([
    { name: "truncated", change: (bytes: Buffer) => bytes.subarray(0, bytes.byteLength - 1), expected: /size does not match/iu },
    { name: "oversized", change: (bytes: Buffer) => Buffer.concat([bytes, Buffer.from([0])]), expected: /exceeded.*size/iu },
  ])("rejects a $name actual public download", async ({ change, expected }) => {
    const fixture = await createFixture();
    const before = await artifactSnapshot(fixture.artifacts);
    const downloads = new Map<string, Uint8Array>(fixture.assetBytes);
    downloads.set(ZIP_BASENAME, change(SYNTHETIC_ZIP_BYTES));
    const transport = createFetchHarness(releaseFixture(fixture), fixture, { downloads });

    await expect(prepareScoopBucket(bucketOptions(fixture, transport.fetch))).rejects.toThrow(expected);
    await expectNoOutputAndUnchangedArtifacts(fixture, before);
  });

  it("rejects a non-HTTPS release asset redirect", async () => {
    const fixture = await createFixture();
    const before = await artifactSnapshot(fixture.artifacts);
    const transport = createFetchHarness(releaseFixture(fixture), fixture, {
      redirectUrl: (name) => `http://release-assets.example.invalid/${encodeURIComponent(name)}`,
    });

    await expect(prepareScoopBucket(bucketOptions(fixture, transport.fetch))).rejects.toThrow(
      /redirect must remain credential-free HTTPS/iu,
    );
    await expectNoOutputAndUnchangedArtifacts(fixture, before);
  });

  it("preserves an existing output directory without issuing network requests", async () => {
    const fixture = await createFixture();
    const before = await artifactSnapshot(fixture.artifacts);
    await mkdir(fixture.outputDirectory);
    const sentinelPath = join(fixture.outputDirectory, "owner-work.txt");
    await writeFile(sentinelPath, "preserve me\n");
    const transport = createFetchHarness(releaseFixture(fixture), fixture);

    await expect(prepareScoopBucket(bucketOptions(fixture, transport.fetch))).rejects.toThrow(
      /already exists.*refusing to overwrite/iu,
    );
    expect(await readFile(sentinelPath, "utf8")).toBe("preserve me\n");
    expect(await readdir(fixture.outputDirectory)).toEqual(["owner-work.txt"]);
    expect(await artifactSnapshot(fixture.artifacts)).toEqual(before);
    expect(transport.calls).toHaveLength(0);
  });

  it("does not write output when the public release lookup fails on the network", async () => {
    const fixture = await createFixture();
    const before = await artifactSnapshot(fixture.artifacts);
    const transport = createFetchHarness(releaseFixture(fixture), fixture, {
      apiError: new Error("simulated API network failure"),
    });

    await expect(prepareScoopBucket(bucketOptions(fixture, transport.fetch))).rejects.toThrow(
      /public GitHub release lookup failed/iu,
    );
    await expectNoOutputAndUnchangedArtifacts(fixture, before);
  });

  it("does not write output when public transport fails", async () => {
    const fixture = await createFixture();
    const before = await artifactSnapshot(fixture.artifacts);
    const transport = createFetchHarness(releaseFixture(fixture), fixture, {
      downloadErrorName: "modeleaf.json",
    });

    await expect(prepareScoopBucket(bucketOptions(fixture, transport.fetch))).rejects.toThrow(
      /public asset download modeleaf\.json failed/iu,
    );
    await expectNoOutputAndUnchangedArtifacts(fixture, before);
  });

  it("validates the local four-file candidate before any network access or output write", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.artifacts, "SHA256SUMS"), `${OTHER_SHA256}  ${ZIP_BASENAME}\n`);
    const before = await artifactSnapshot(fixture.artifacts);
    const transport = createFetchHarness(releaseFixture(fixture), fixture);

    await expect(prepareScoopBucket(bucketOptions(fixture, transport.fetch))).rejects.toThrow(
      /SHA256SUMS digest.*approved/iu,
    );
    await expectNoOutputAndUnchangedArtifacts(fixture, before);
    expect(transport.calls).toHaveLength(0);
  });
});
