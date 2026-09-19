import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const DESCRIPTION = "Keyboard-first read-only PDF viewer for Windows";
const MANIFEST_BASENAME = "modeleaf.json";
const CHECKSUMS_BASENAME = "SHA256SUMS";
const RECEIPT_BASENAME = "package-receipt.json";
const MANIFEST_NOTES = [
  "Requires Windows 11 x64.",
  "Requires the Microsoft Edge WebView2 Runtime to be installed.",
];
const MAX_JSON_BYTES = 64 * 1024;
const MAX_CHECKSUM_BYTES = 4 * 1024;
const MAX_PATH_ARGUMENT_LENGTH = 32 * 1024;
const SEMVER_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*)|(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9][0-9]*)|(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;
const COMMIT_PATTERN = /^[0-9A-Fa-f]{40}$/u;
const SHA256_PATTERN = /^[0-9A-Fa-f]{64}$/u;

class ReleaseValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseValidationError";
  }
}

/** @returns {never} */
function reject(message) {
  throw new ReleaseValidationError(message);
}

function requirePathArgument(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_PATH_ARGUMENT_LENGTH
    || value.includes("\0")
  ) {
    reject(`${label} must be a non-empty filesystem path.`);
  }
  return value;
}

function validateRepository(value) {
  if (
    typeof value !== "string"
    || value.length > 140
    || value !== value.trim()
    || !REPOSITORY_PATTERN.test(value)
  ) {
    reject("Repository must be a safe GitHub owner/repository slug.");
  }
  return value;
}

function validateTag(value) {
  if (
    typeof value !== "string"
    || value.length < 2
    || value.length > 129
    || value !== value.trim()
    || value[0] !== "v"
    || !SEMVER_PATTERN.test(value.slice(1))
  ) {
    reject("Tag must be v followed by a safe semantic version.");
  }
  return { tag: value, version: value.slice(1) };
}

function validateCommit(value, label) {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    reject(`${label} must be exactly 40 hexadecimal characters.`);
  }
  return value.toLowerCase();
}

function validateSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    reject(`${label} must be exactly 64 hexadecimal characters.`);
  }
  return value.toLowerCase();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(value, keys, label) {
  if (!isRecord(value)) {
    reject(`${label} must be a JSON object.`);
  }

  const actualKeys = Object.keys(value);
  if (actualKeys.some((key) => !keys.includes(key))) {
    reject(`${label} contains an unsupported field.`);
  }
  if (keys.some((key) => !Object.hasOwn(value, key))) {
    reject(`${label} is missing a required field.`);
  }
  if (actualKeys.length !== keys.length) {
    reject(`${label} must contain only its required fields.`);
  }
  return value;
}

function exactString(value, expected, label) {
  if (value !== expected) {
    reject(`${label} does not match the packaging contract.`);
  }
}

function exactStringArray(value, expected, label) {
  if (
    !Array.isArray(value)
    || value.length !== expected.length
    || value.some((item, index) => item !== expected[index])
  ) {
    reject(`${label} does not match the packaging contract.`);
  }
}

async function inspectArtifactDirectory(artifactsPath, expectedBasenames) {
  let directoryStat;
  try {
    directoryStat = await lstat(artifactsPath);
  } catch {
    reject("Artifact directory is missing or cannot be inspected.");
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    reject("Artifacts must identify a real directory, not a symlink or file.");
  }

  let entries;
  try {
    entries = await readdir(artifactsPath, { withFileTypes: true });
  } catch {
    reject("Artifact directory cannot be read.");
  }
  if (entries.length !== expectedBasenames.length) {
    reject("Artifact directory must contain exactly four input files.");
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  if (
    byName.size !== expectedBasenames.length
    || expectedBasenames.some((name) => !byName.has(name))
  ) {
    reject("Artifact directory does not match the tag-derived four-file contract.");
  }

  for (const expectedBasename of expectedBasenames) {
    const entry = byName.get(expectedBasename);
    if (!entry?.isFile() || entry.isSymbolicLink()) {
      reject("Every release input must be a regular file, not a symlink or directory.");
    }

    let inputStat;
    try {
      inputStat = await lstat(join(artifactsPath, expectedBasename));
    } catch {
      reject("A required release input disappeared during validation.");
    }
    if (inputStat.isSymbolicLink() || !inputStat.isFile()) {
      reject("Every release input must remain a regular file during validation.");
    }
  }
}

async function readBoundedUtf8(path, label, maximumBytes) {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    reject(`${label} cannot be opened for reading.`);
  }

  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) {
      reject(`${label} must be a regular file.`);
    }
    if (stat.size > BigInt(maximumBytes)) {
      reject(`${label} exceeds the metadata size limit.`);
    }

    const chunks = [];
    let bytesRead = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytesRead += chunk.length;
      if (bytesRead > maximumBytes) {
        reject(`${label} exceeds the metadata size limit.`);
      }
      chunks.push(chunk);
    }

    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytesRead));
    } catch {
      reject(`${label} must contain valid UTF-8 text.`);
    }
    return text;
  } catch (error) {
    if (error instanceof ReleaseValidationError) {
      throw error;
    }
    reject(`${label} could not be read safely.`);
  } finally {
    await handle.close();
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    reject(`${label} is not valid JSON.`);
  }
}

function validateManifest(value, { repository, tag, version, zipBasename }) {
  const manifest = exactObject(
    value,
    ["version", "description", "homepage", "license", "architecture", "bin", "shortcuts", "notes"],
    "Scoop manifest",
  );
  exactString(manifest.version, version, "Scoop manifest version");
  exactString(manifest.description, DESCRIPTION, "Scoop manifest description");
  exactString(manifest.homepage, `https://github.com/${repository}`, "Scoop manifest homepage");
  exactString(manifest.license, "MIT", "Scoop manifest license");
  exactString(manifest.bin, "modeleaf.exe", "Scoop manifest bin target");
  exactStringArray(manifest.notes, MANIFEST_NOTES, "Scoop manifest prerequisite notes");

  if (
    !Array.isArray(manifest.shortcuts)
    || manifest.shortcuts.length !== 1
    || !Array.isArray(manifest.shortcuts[0])
    || manifest.shortcuts[0].length !== 2
    || manifest.shortcuts[0][0] !== "modeleaf.exe"
    || manifest.shortcuts[0][1] !== "Modeleaf"
  ) {
    reject("Scoop manifest shortcut does not match the packaging contract.");
  }

  const architecture = exactObject(manifest.architecture, ["64bit"], "Scoop manifest architecture");
  const target = exactObject(architecture["64bit"], ["url", "hash"], "Scoop manifest 64bit target");
  const expectedUrl = `https://github.com/${repository}/releases/download/${tag}/${zipBasename}`;
  exactString(target.url, expectedUrl, "Scoop manifest release URL");
  return validateSha256(target.hash, "Scoop manifest ZIP hash");
}

function validateReceipt(value, { version, sourceCommit, zipBasename }) {
  const receipt = exactObject(value, ["source", "artifact", "status"], "Package receipt");
  const source = exactObject(receipt.source, ["commit", "version"], "Package receipt source");
  const artifact = exactObject(receipt.artifact, ["basename", "sha256", "bytes"], "Package receipt artifact");
  const status = exactObject(
    receipt.status,
    ["signature", "executableValidation", "nativeAcceptance"],
    "Package receipt status",
  );

  exactString(source.version, version, "Package receipt source version");
  const receiptCommit = validateCommit(source.commit, "Package receipt source commit");
  if (receiptCommit !== sourceCommit) {
    reject("Package receipt source commit does not match the approved source commit.");
  }

  exactString(artifact.basename, zipBasename, "Package receipt artifact basename");
  const receiptSha256 = validateSha256(artifact.sha256, "Package receipt ZIP hash");
  if (
    typeof artifact.bytes !== "number"
    || !Number.isSafeInteger(artifact.bytes)
    || artifact.bytes < 0
  ) {
    reject("Package receipt artifact byte count must be a non-negative safe integer.");
  }

  if (status.signature !== "not-verified") {
    reject("Package receipt must keep signature status as not-verified.");
  }
  if (status.executableValidation !== "header-only") {
    reject("Package receipt must keep executable validation status as header-only.");
  }
  if (status.nativeAcceptance !== "not-verified") {
    reject("Package receipt must keep native acceptance status as not-verified.");
  }

  return { receiptSha256, receiptBytes: BigInt(artifact.bytes) };
}

function validateChecksumText(text, zipBasename) {
  const match = /^([0-9A-Fa-f]{64}) {2}([^\r\n]+)\r?\n$/u.exec(text);
  if (match === null) {
    reject("SHA256SUMS must contain exactly one canonical checksum line.");
  }
  if (match[2] !== zipBasename) {
    reject("SHA256SUMS filename does not match the tag-derived ZIP basename.");
  }
  return validateSha256(match[1], "SHA256SUMS digest");
}

async function streamZipSha256(path) {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    reject("Release ZIP cannot be opened for reading.");
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      reject("Release ZIP must be a regular file.");
    }
    if (before.size === 0n) {
      reject("Release ZIP must not be empty.");
    }

    const hash = createHash("sha256");
    let bytesRead = 0n;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytesRead += BigInt(chunk.length);
    }

    const after = await handle.stat({ bigint: true });
    if (before.size !== bytesRead || after.size !== bytesRead) {
      reject("Release ZIP changed while it was being validated.");
    }
    return { sha256: hash.digest("hex"), bytes: bytesRead };
  } catch (error) {
    if (error instanceof ReleaseValidationError) {
      throw error;
    }
    reject("Release ZIP could not be streamed safely.");
  } finally {
    await handle.close();
  }
}

function buildReleaseNotes({ repository, tag, version }) {
  const manifestUrl = `https://github.com/${repository}/releases/download/${tag}/${MANIFEST_BASENAME}`;
  return [
    `# Modeleaf ${version} for Windows`,
    "",
    "This is an experimental Modeleaf release for Windows 11 x64. Release-candidate native behavior, DPI scaling, Narrator accessibility, clean-machine installation, and Authenticode signature checks are unverified. Automated tests and package validation do not certify installed behavior.",
    "",
    "Changes since 0.1.4:",
    "- Improved rapid and held-key page navigation, boundary landings, and viewport settlement.",
    "- Added password-protected PDF support with modal password entry, incorrect-password retry, and cancellation. Passwords are not persisted.",
    "- PDF-provided links support keyboard hints with f, required external-URL confirmation, and transient internal destination-coordinate feedback.",
    "",
    "Known limitations:",
    "- CLI enhancements and update notifications are not included in this release. The app does not download or install updates.",
    "- Embedded table of contents (TOC) remains retired.",
    "",
    "Prerequisite: Install the Microsoft Edge WebView2 Runtime before launching Modeleaf.",
    "",
    "Install through the maintained Scoop bucket after its manifest is published:",
    "",
    "```powershell",
    "scoop bucket add modeleaf https://github.com/DS-argus/scoop-bucket",
    "scoop install modeleaf/modeleaf",
    "```",
    "",
    "Scoop updates are user-invoked: run `scoop update` then `scoop update modeleaf`. The bucket is updated only after the published release downloads are verified; availability can lag the release. The app does not update itself.",
    "",
    "For this exact version independently of the bucket:",
    "",
    "```powershell",
    `scoop install ${manifestUrl}`,
    "```",
    "",
  ].join("\n");
}

/**
 * Validates an immutable four-file Scoop release candidate without performing
 * network access, process launch, signing, publication, or filesystem writes.
 *
 * @param {{
 *   artifacts: string,
 *   repository: string,
 *   tag: string,
 *   sourceCommit: string,
 *   zipSha256: string,
 * }} options
 * @returns {Promise<{
 *   version: string,
 *   sourceCommit: string,
 *   zipSha256: string,
 *   assetBasenames: string[],
 *   releaseNotes: string,
 * }>}
 */
export async function validateScoopRelease(options) {
  if (!isRecord(options)) {
    reject("Validation options must be an object.");
  }

  const artifacts = requirePathArgument(options.artifacts, "Artifacts");
  const artifactsPath = resolve(artifacts);
  const repository = validateRepository(options.repository);
  const { tag, version } = validateTag(options.tag);
  const sourceCommit = validateCommit(options.sourceCommit, "Approved source commit");
  const approvedZipSha256 = validateSha256(options.zipSha256, "Approved ZIP SHA-256");
  const zipBasename = `modeleaf-${version}-windows-x64.zip`;
  const assetBasenames = [zipBasename, MANIFEST_BASENAME, CHECKSUMS_BASENAME, RECEIPT_BASENAME];

  await inspectArtifactDirectory(artifactsPath, assetBasenames);

  const manifestText = await readBoundedUtf8(
    join(artifactsPath, MANIFEST_BASENAME),
    "Scoop manifest",
    MAX_JSON_BYTES,
  );
  const receiptText = await readBoundedUtf8(
    join(artifactsPath, RECEIPT_BASENAME),
    "Package receipt",
    MAX_JSON_BYTES,
  );
  const checksumText = await readBoundedUtf8(
    join(artifactsPath, CHECKSUMS_BASENAME),
    "SHA256SUMS",
    MAX_CHECKSUM_BYTES,
  );

  const manifestSha256 = validateManifest(parseJson(manifestText, "Scoop manifest"), {
    repository,
    tag,
    version,
    zipBasename,
  });
  const { receiptSha256, receiptBytes } = validateReceipt(parseJson(receiptText, "Package receipt"), {
    version,
    sourceCommit,
    zipBasename,
  });
  const checksumSha256 = validateChecksumText(checksumText, zipBasename);

  if (manifestSha256 !== approvedZipSha256) {
    reject("Scoop manifest ZIP hash does not match the approved ZIP SHA-256.");
  }
  if (receiptSha256 !== approvedZipSha256) {
    reject("Package receipt ZIP hash does not match the approved ZIP SHA-256.");
  }
  if (checksumSha256 !== approvedZipSha256) {
    reject("SHA256SUMS digest does not match the approved ZIP SHA-256.");
  }

  const streamedZip = await streamZipSha256(join(artifactsPath, zipBasename));
  if (streamedZip.sha256 !== approvedZipSha256) {
    reject("Streamed release ZIP hash does not match the approved ZIP SHA-256.");
  }
  if (streamedZip.bytes !== receiptBytes) {
    reject("Streamed release ZIP byte count does not match the package receipt.");
  }

  return {
    version,
    sourceCommit,
    zipSha256: streamedZip.sha256,
    assetBasenames,
    releaseNotes: buildReleaseNotes({ repository, tag, version }),
  };
}

function isWithin(parentPath, candidatePath) {
  const child = relative(parentPath, candidatePath);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function writeReleaseNotesExclusive({ artifacts, notesFile, releaseNotes }) {
  const artifactsPath = resolve(requirePathArgument(artifacts, "Artifacts"));
  const notesPath = resolve(requirePathArgument(notesFile, "Notes file"));
  if (isWithin(artifactsPath, notesPath)) {
    reject("Notes output must be outside the artifact directory.");
  }

  let canonicalArtifacts;
  let canonicalParent;
  try {
    [canonicalArtifacts, canonicalParent] = await Promise.all([
      realpath(artifactsPath),
      realpath(dirname(notesPath)),
    ]);
  } catch {
    reject("Notes output parent must already exist and be accessible.");
  }

  const canonicalNotesPath = join(canonicalParent, basename(notesPath));
  if (isWithin(canonicalArtifacts, canonicalNotesPath)) {
    reject("Notes output must be outside the artifact directory.");
  }

  let parentStat;
  try {
    parentStat = await lstat(canonicalParent);
  } catch {
    reject("Notes output parent cannot be inspected.");
  }
  if (!parentStat.isDirectory()) {
    reject("Notes output parent must be a directory.");
  }

  try {
    await writeFile(canonicalNotesPath, releaseNotes, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      reject("Notes output already exists; refusing to overwrite it.");
    }
    reject("Notes output could not be created exclusively.");
  }
}

const CLI_FLAGS = new Map([
  ["--artifacts", "artifacts"],
  ["--repository", "repository"],
  ["--tag", "tag"],
  ["--source-commit", "sourceCommit"],
  ["--zip-sha256", "zipSha256"],
  ["--notes-file", "notesFile"],
]);

function parseCliArguments(args) {
  if (args.length !== CLI_FLAGS.size * 2) {
    reject("Expected exactly --artifacts, --repository, --tag, --source-commit, --zip-sha256, and --notes-file.");
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
  const result = await validateScoopRelease({
    artifacts: values.artifacts,
    repository: values.repository,
    tag: values.tag,
    sourceCommit: values.sourceCommit,
    zipSha256: values.zipSha256,
  });
  await writeReleaseNotesExclusive({
    artifacts: values.artifacts,
    notesFile: values.notesFile,
    releaseNotes: result.releaseNotes,
  });

  const stdoutMetadata = {
    version: result.version,
    sourceCommit: result.sourceCommit,
    zipSha256: result.zipSha256,
    assetBasenames: result.assetBasenames,
    notesCreated: true,
  };
  process.stdout.write(`${JSON.stringify(stdoutMetadata)}\n`);
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
  const message = error instanceof Error ? error.message : "Unknown release preparation failure.";
  const oneLine = message.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return (oneLine || "Unknown release preparation failure.").slice(0, 500);
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.exitCode = 1;
    process.stderr.write(`prepare-scoop-release: ${boundedErrorMessage(error)}\n`);
  });
}
