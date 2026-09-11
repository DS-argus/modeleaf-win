import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { validateScoopRelease } from "./prepare-scoop-release.mjs";

const PUBLIC_REPOSITORY = "DS-argus/modeleaf-win";
const MANIFEST_BASENAME = "modeleaf.json";
const MAX_PATH_ARGUMENT_LENGTH = 32 * 1024;
const MAX_RELEASE_JSON_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_REDIRECTS = 5;
const USER_AGENT = "modeleaf-scoop-bucket-preparer";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const GITHUB_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

class ScoopBucketPreparationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScoopBucketPreparationError";
  }
}

/** @returns {never} */
function reject(message) {
  throw new ScoopBucketPreparationError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireOutputPath(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_PATH_ARGUMENT_LENGTH
    || value.includes("\0")
  ) {
    reject("Output directory must be a non-empty filesystem path.");
  }
  return resolve(value);
}

function isWithin(parentPath, candidatePath) {
  const child = relative(parentPath, candidatePath);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function isMissingPathError(error) {
  return isRecord(error) && error.code === "ENOENT";
}

async function requireAbsentOutputDirectory(outputDirectory, artifacts) {
  const outputPath = requireOutputPath(outputDirectory);
  const parentPath = dirname(outputPath);

  let canonicalParent;
  let canonicalArtifacts;
  try {
    [canonicalParent, canonicalArtifacts] = await Promise.all([
      realpath(parentPath),
      realpath(resolve(artifacts)),
    ]);
  } catch {
    reject("Output parent and artifact directory must already exist and be accessible.");
  }

  let parentStat;
  try {
    parentStat = await lstat(canonicalParent);
  } catch {
    reject("Output parent cannot be inspected.");
  }
  if (!parentStat.isDirectory()) {
    reject("Output parent must be a directory.");
  }

  const canonicalOutput = join(canonicalParent, basename(outputPath));
  if (isWithin(canonicalArtifacts, canonicalOutput)) {
    reject("Output directory must be outside the artifact directory.");
  }

  try {
    await lstat(canonicalOutput);
  } catch (error) {
    if (isMissingPathError(error)) {
      return canonicalOutput;
    }
    reject("Output directory cannot be inspected safely.");
  }
  reject("Output directory already exists; refusing to overwrite it.");
}

async function inspectLocalAsset(path, name, captureBytes) {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    reject(`Validated local asset ${name} cannot be opened.`);
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      reject(`Validated local asset ${name} must remain a regular file.`);
    }
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      reject(`Validated local asset ${name} is too large for GitHub metadata verification.`);
    }

    const hash = createHash("sha256");
    const chunks = captureBytes ? [] : null;
    let bytesRead = 0n;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytesRead += BigInt(chunk.length);
      if (chunks !== null) {
        chunks.push(chunk);
      }
    }

    const after = await handle.stat({ bigint: true });
    if (before.size !== bytesRead || after.size !== bytesRead) {
      reject(`Validated local asset ${name} changed while it was being inspected.`);
    }

    return {
      name,
      bytes: Number(bytesRead),
      sha256: hash.digest("hex"),
      content: chunks === null ? null : Buffer.concat(chunks, Number(bytesRead)),
    };
  } catch (error) {
    if (error instanceof ScoopBucketPreparationError) {
      throw error;
    }
    reject(`Validated local asset ${name} could not be inspected safely.`);
  } finally {
    await handle.close();
  }
}

async function inspectLocalAssets(artifacts, assetBasenames) {
  const artifactsPath = resolve(artifacts);
  const assets = new Map();
  for (const name of assetBasenames) {
    assets.set(
      name,
      await inspectLocalAsset(join(artifactsPath, name), name, name === MANIFEST_BASENAME),
    );
  }
  return assets;
}

async function withFetchTimeout(label, operation) {
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, rejectPromise) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      rejectPromise(new ScoopBucketPreparationError(`${label} timed out.`));
    }, FETCH_TIMEOUT_MS);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } catch (error) {
    if (error instanceof ScoopBucketPreparationError) {
      throw error;
    }
    if (controller.signal.aborted) {
      reject(`${label} timed out.`);
    }
    reject(`${label} failed.`);
  } finally {
    clearTimeout(timeoutId);
  }
}

function requireResponse(response, label) {
  if (
    !isRecord(response)
    || typeof response.status !== "number"
    || !isRecord(response.headers)
    || typeof response.headers.get !== "function"
  ) {
    reject(`${label} returned an invalid response.`);
  }
  return response;
}

async function readBoundedResponseBytes(response, maximumBytes, label) {
  if (!isRecord(response.body) || typeof response.body.getReader !== "function") {
    reject(`${label} did not return a readable response body.`);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        reject(`${label} returned an invalid response body chunk.`);
      }
      bytesRead += result.value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel().catch(() => {});
        reject(`${label} exceeded its response size limit.`);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof ScoopBucketPreparationError) {
      throw error;
    }
    reject(`${label} response body could not be read.`);
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytesRead);
}

function decodeReleaseJson(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    reject("Public GitHub release metadata must be valid UTF-8.");
  }

  try {
    return JSON.parse(text);
  } catch {
    reject("Public GitHub release metadata is not valid JSON.");
  }
}

async function fetchPublicRelease(fetchImplementation, tag) {
  const apiUrl = `https://api.github.com/repos/${PUBLIC_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`;
  return withFetchTimeout("Public GitHub release lookup", async (signal) => {
    let response;
    try {
      response = requireResponse(await fetchImplementation(apiUrl, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": USER_AGENT,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "manual",
        cache: "no-store",
        credentials: "omit",
        signal,
      }), "Public GitHub release lookup");
    } catch (error) {
      if (error instanceof ScoopBucketPreparationError) {
        throw error;
      }
      throw new ScoopBucketPreparationError("Public GitHub release lookup failed.");
    }

    if (response.status !== 200) {
      await cancelResponseBody(response);
      reject("Public GitHub release is absent or not publicly accessible.");
    }
    const bytes = await readBoundedResponseBytes(
      response,
      MAX_RELEASE_JSON_BYTES,
      "Public GitHub release metadata",
    );
    return decodeReleaseJson(bytes);
  });
}

function validatePublishedRelease(release, tag, localAssets) {
  if (!isRecord(release)) {
    reject("Public GitHub release metadata must be an object.");
  }
  if (release.tag_name !== tag) {
    reject("Public GitHub release tag does not match the requested tag.");
  }
  if (release.draft !== false) {
    reject("Public GitHub release must not be a draft.");
  }
  if (typeof release.prerelease !== "boolean") {
    reject("Public GitHub release prerelease metadata is invalid.");
  }
  if (
    typeof release.published_at !== "string"
    || !GITHUB_TIMESTAMP_PATTERN.test(release.published_at)
    || !Number.isFinite(Date.parse(release.published_at))
  ) {
    reject("Public GitHub release must have a valid published_at timestamp.");
  }
  if (!Array.isArray(release.assets) || release.assets.length !== localAssets.size) {
    reject("Public GitHub release must contain exactly the four expected assets.");
  }

  const assetsByName = new Map();
  for (const asset of release.assets) {
    if (!isRecord(asset) || typeof asset.name !== "string") {
      reject("Public GitHub release contains invalid asset metadata.");
    }
    if (!localAssets.has(asset.name)) {
      reject("Public GitHub release contains an unexpected asset name.");
    }
    if (assetsByName.has(asset.name)) {
      reject("Public GitHub release contains a duplicate asset name.");
    }
    assetsByName.set(asset.name, asset);
  }

  for (const [name, localAsset] of localAssets) {
    const asset = assetsByName.get(name);
    if (!asset) {
      reject("Public GitHub release is missing an expected asset.");
    }
    if (asset.state !== "uploaded") {
      reject(`Public GitHub release asset ${name} is not fully uploaded.`);
    }
    if (!Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size !== localAsset.bytes) {
      reject(`Public GitHub release asset ${name} size does not match the validated local bytes.`);
    }
    if (asset.digest !== `sha256:${localAsset.sha256}`) {
      reject(`Public GitHub release asset ${name} SHA-256 digest does not match the validated local bytes.`);
    }
    const expectedUrl = `https://github.com/${PUBLIC_REPOSITORY}/releases/download/${tag}/${name}`;
    if (asset.browser_download_url !== expectedUrl) {
      reject(`Public GitHub release asset ${name} browser download URL is not allowlisted.`);
    }
  }
}

async function cancelResponseBody(response) {
  if (isRecord(response.body) && typeof response.body.cancel === "function") {
    await response.body.cancel().catch(() => {});
  }
}

async function hashExactResponseBody(response, expectedBytes, label) {
  if (!isRecord(response.body) || typeof response.body.getReader !== "function") {
    reject(`${label} did not return a readable response body.`);
  }

  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let bytesRead = 0n;
  const expected = BigInt(expectedBytes);
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        reject(`${label} returned an invalid response body chunk.`);
      }
      bytesRead += BigInt(result.value.byteLength);
      if (bytesRead > expected) {
        await reader.cancel().catch(() => {});
        reject(`${label} exceeded the validated local asset size.`);
      }
      hash.update(result.value);
    }
  } catch (error) {
    if (error instanceof ScoopBucketPreparationError) {
      throw error;
    }
    reject(`${label} response body could not be read.`);
  } finally {
    reader.releaseLock();
  }

  if (bytesRead !== expected) {
    reject(`${label} size does not match the validated local asset size.`);
  }
  return hash.digest("hex");
}

async function verifyPublicDownload(fetchImplementation, tag, localAsset, allowedInitialUrls) {
  const initialUrl = `https://github.com/${PUBLIC_REPOSITORY}/releases/download/${tag}/${localAsset.name}`;
  if (!allowedInitialUrls.has(initialUrl)) {
    reject("Public asset download URL is not in the exact release allowlist.");
  }

  const label = `Public asset download ${localAsset.name}`;
  await withFetchTimeout(label, async (signal) => {
    let currentUrl = initialUrl;
    for (let redirectCount = 0; ; redirectCount += 1) {
      let response;
      try {
        response = requireResponse(await fetchImplementation(currentUrl, {
          method: "GET",
          headers: {
            Accept: "application/octet-stream",
            "User-Agent": USER_AGENT,
          },
          redirect: "manual",
          cache: "no-store",
          credentials: "omit",
          signal,
        }), label);
      } catch (error) {
        if (error instanceof ScoopBucketPreparationError) {
          throw error;
        }
        throw new ScoopBucketPreparationError(`${label} failed.`);
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        await cancelResponseBody(response);
        if (redirectCount >= MAX_DOWNLOAD_REDIRECTS) {
          reject(`${label} exceeded the redirect limit.`);
        }
        const location = response.headers.get("location");
        if (typeof location !== "string" || location.length === 0) {
          reject(`${label} returned a redirect without a location.`);
        }

        let redirectUrl;
        try {
          redirectUrl = new URL(location, currentUrl);
        } catch {
          reject(`${label} returned an invalid redirect URL.`);
        }
        if (
          redirectUrl.protocol !== "https:"
          || redirectUrl.username !== ""
          || redirectUrl.password !== ""
        ) {
          reject(`${label} redirect must remain credential-free HTTPS.`);
        }
        currentUrl = redirectUrl.href;
        continue;
      }

      if (response.status !== 200) {
        await cancelResponseBody(response);
        reject(`${label} was not publicly downloadable.`);
      }
      const downloadedSha256 = await hashExactResponseBody(response, localAsset.bytes, label);
      if (downloadedSha256 !== localAsset.sha256) {
        reject(`${label} SHA-256 does not match the validated local asset.`);
      }
      return;
    }
  });
}

async function cleanupCreatedOutput({ handle, manifestPath, manifestCreated, bucketPath, bucketCreated, outputPath, outputCreated }) {
  let cleanupFailed = false;
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      cleanupFailed = true;
    }
  }
  if (manifestCreated) {
    try {
      await unlink(manifestPath);
    } catch {
      cleanupFailed = true;
    }
  }
  if (bucketCreated) {
    try {
      await rmdir(bucketPath);
    } catch {
      cleanupFailed = true;
    }
  }
  if (outputCreated) {
    try {
      await rmdir(outputPath);
    } catch {
      cleanupFailed = true;
    }
  }
  return cleanupFailed;
}

async function writeBucketExclusively(outputPath, manifestBytes) {
  const bucketPath = join(outputPath, "bucket");
  const manifestPath = join(bucketPath, MANIFEST_BASENAME);
  let outputCreated = false;
  let bucketCreated = false;
  let manifestCreated = false;
  let handle;

  try {
    await mkdir(outputPath, { recursive: false, mode: 0o700 });
    outputCreated = true;
    await mkdir(bucketPath, { recursive: false, mode: 0o700 });
    bucketCreated = true;
    handle = await open(manifestPath, "wx", 0o600);
    manifestCreated = true;
    await handle.writeFile(manifestBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    const cleanupFailed = await cleanupCreatedOutput({
      handle,
      manifestPath,
      manifestCreated,
      bucketPath,
      bucketCreated,
      outputPath,
      outputCreated,
    });
    if (cleanupFailed) {
      reject("Bucket output failed and invocation-created paths could not be fully cleaned.");
    }
    if (!outputCreated && isRecord(error) && error.code === "EEXIST") {
      reject("Output directory already exists; refusing to overwrite it.");
    }
    reject("Bucket output could not be created exclusively.");
  }
}

/**
 * Verifies a locally validated release against its actual public GitHub release
 * and downloads before exclusively producing a dedicated Scoop bucket payload.
 *
 * @param {{
 *   artifacts: string,
 *   repository: string,
 *   tag: string,
 *   sourceCommit: string,
 *   zipSha256: string,
 *   outputDirectory: string,
 *   fetch?: typeof globalThis.fetch,
 * }} options
 * @returns {Promise<{
 *   sourceCommit: string,
 *   version: string,
 *   zipSha256: string,
 *   manifestSha256: string,
 *   publicDownloadVerification: true,
 * }>}
 */
export async function prepareScoopBucket(options) {
  const validated = await validateScoopRelease(options);
  if (!isRecord(options)) {
    reject("Bucket preparation options must be an object.");
  }
  if (options.repository !== PUBLIC_REPOSITORY) {
    reject(`Bucket preparation is restricted to ${PUBLIC_REPOSITORY}.`);
  }

  const fetchImplementation = options.fetch === undefined ? globalThis.fetch : options.fetch;
  if (typeof fetchImplementation !== "function") {
    reject("A Fetch-compatible public transport is required.");
  }

  const outputPath = await requireAbsentOutputDirectory(options.outputDirectory, options.artifacts);
  const localAssets = await inspectLocalAssets(options.artifacts, validated.assetBasenames);
  const localZip = localAssets.get(validated.assetBasenames[0]);
  const localManifest = localAssets.get(MANIFEST_BASENAME);
  if (!localZip || localZip.sha256 !== validated.zipSha256 || !localManifest?.content) {
    reject("Validated local release bytes changed before public verification.");
  }

  const release = await fetchPublicRelease(fetchImplementation, options.tag);
  validatePublishedRelease(release, options.tag, localAssets);

  const allowedInitialUrls = new Set(
    validated.assetBasenames.map(
      (name) => `https://github.com/${PUBLIC_REPOSITORY}/releases/download/${options.tag}/${name}`,
    ),
  );
  for (const name of validated.assetBasenames) {
    const localAsset = localAssets.get(name);
    if (!localAsset) {
      reject("Validated local release is missing an expected asset snapshot.");
    }
    await verifyPublicDownload(fetchImplementation, options.tag, localAsset, allowedInitialUrls);
  }

  await writeBucketExclusively(outputPath, localManifest.content);
  return {
    sourceCommit: validated.sourceCommit,
    version: validated.version,
    zipSha256: validated.zipSha256,
    manifestSha256: localManifest.sha256,
    publicDownloadVerification: true,
  };
}

const CLI_FLAGS = new Map([
  ["--artifacts", "artifacts"],
  ["--tag", "tag"],
  ["--source-commit", "sourceCommit"],
  ["--zip-sha256", "zipSha256"],
  ["--output", "outputDirectory"],
]);

function parseCliArguments(args) {
  if (args.length !== CLI_FLAGS.size * 2) {
    reject("Expected exactly --artifacts, --tag, --source-commit, --zip-sha256, and --output.");
  }

  const values = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const key = CLI_FLAGS.get(flag);
    if (key === undefined) {
      reject("An unknown CLI argument was provided.");
    }
    if (Object.hasOwn(values, key)) {
      reject("A CLI argument was provided more than once.");
    }
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      reject(`CLI argument ${flag} requires a value.`);
    }
    values[key] = value;
  }
  return values;
}

async function runCli(args) {
  const values = parseCliArguments(args);
  const result = await prepareScoopBucket({
    artifacts: values.artifacts,
    repository: PUBLIC_REPOSITORY,
    tag: values.tag,
    sourceCommit: values.sourceCommit,
    zipSha256: values.zipSha256,
    outputDirectory: values.outputDirectory,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function isMainModule() {
  if (typeof process.argv[1] !== "string") {
    return false;
  }
  try {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

function boundedErrorMessage(error) {
  const message = error instanceof Error ? error.message : "Unknown Scoop bucket preparation failure.";
  const oneLine = message.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return (oneLine || "Unknown Scoop bucket preparation failure.").slice(0, 500);
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.exitCode = 1;
    process.stderr.write(`prepare-scoop-bucket: ${boundedErrorMessage(error)}\n`);
  });
}
