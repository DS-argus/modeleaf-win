import { createHash } from "node:crypto";
import { validateTag } from "./prepare-scoop-release.mjs";

const SOURCE = "DS-argus/modeleaf-win";
const BUCKET = { owner: "DS-argus", repo: "scoop-bucket" };
const PATH = "bucket/modeleaf.json";
const BASE = "main";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

export function requirePromotionContext(context, sourceCommit) {
  requireCondition(
    context.eventName === "push"
      && `${context.repo.owner}/${context.repo.repo}` === SOURCE
      && context.payload.repository.private === false
      && context.ref.startsWith("refs/tags/v")
      && /^[0-9a-f]{40}$/u.test(sourceCommit),
    "Promotion requires the public source repository's approved tag push.",
  );
  return validateTag(context.ref.slice("refs/tags/".length));
}

// SemVer precedence, including arbitrarily large numeric components. Build
// metadata does not establish ordering; different equal-precedence tags conflict.
export function compareVersions(left, right) {
  const parse = (version) => {
    validateTag(`v${version}`);
    const [core, ...prerelease] = version.split("+")[0].split("-");
    return { core: core.split(".").map(BigInt), pre: prerelease.length ? prerelease.join("-").split(".") : [] };
  };
  const a = parse(left);
  const b = parse(right);
  const order = (x, y) => x < y ? -1 : x > y ? 1 : 0;
  for (let i = 0; i < 3; i += 1) {
    const compared = order(a.core[i], b.core[i]);
    if (compared) return compared;
  }
  if (!a.pre.length || !b.pre.length) return order(b.pre.length ? 1 : 0, a.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const numericA = /^\d+$/u.test(a.pre[i]);
    const numericB = /^\d+$/u.test(b.pre[i]);
    const compared = numericA && numericB ? order(BigInt(a.pre[i]), BigInt(b.pre[i]))
      : numericA !== numericB ? (numericA ? -1 : 1) : order(a.pre[i], b.pre[i]);
    if (compared) return compared;
  }
  return 0;
}

function patchManifest(current, release) {
  requireCondition(current && typeof current === "object" && !Array.isArray(current)
    && current.architecture?.["64bit"] && typeof current.architecture["64bit"] === "object"
    && !Array.isArray(current.architecture["64bit"]), "Bucket manifest lacks a 64bit target.");
  const updated = structuredClone(current);
  updated.version = release.version;
  updated.architecture["64bit"].url = release.architecture["64bit"].url;
  updated.architecture["64bit"].hash = release.architecture["64bit"].hash;
  return `${JSON.stringify(updated, null, 2)}\n`;
}

async function optional(get) {
  try { return await get(); } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

/** Consumes same-job public verification evidence. No release writes, ref updates,
 * force pushes, branch deletion, PR reopening, or merging are implemented. */
export async function promoteScoopBucket({ github, context, receipt, manifestBytes, credentialAvailable }) {
  const { version, tag } = requirePromotionContext(context, receipt.sourceCommit);
  requireCondition(receipt.publicDownloadVerification === true && receipt.version === version
    && /^[0-9a-f]{64}$/u.test(receipt.zipSha256)
    && createHash("sha256").update(manifestBytes).digest("hex") === receipt.manifestSha256,
  "Public verification receipt does not bind the promotion manifest.");
  const release = JSON.parse(manifestBytes.toString("utf8"));
  requireCondition(release.version === version
    && release.architecture?.["64bit"]?.hash === receipt.zipSha256
    && release.architecture["64bit"].url === `https://github.com/${SOURCE}/releases/download/${tag}/modeleaf-${version}-windows-x64.zip`,
  "Promotion manifest does not match the verified release.");
  requireCondition(credentialAvailable === true, "Setup blocked: MODELEAF_SCOOP_BUCKET_TOKEN is required; release remains published, bucket PR not created.");

  const { repos, git, pulls } = github.rest;
  const getRef = async (ref) => (await git.getRef({ ...BUCKET, ref })).data.object.sha;
  const readManifest = async (ref) => {
    const { data } = await repos.getContent({ ...BUCKET, path: PATH, ref });
    requireCondition(data.type === "file" && data.encoding === "base64" && data.size <= 65536,
      "Bucket manifest must be a bounded regular file.");
    return Buffer.from(data.content, "base64").toString("utf8");
  };
  const mainSha = await getRef(`heads/${BASE}`);
  const main = JSON.parse(await readManifest(mainSha));
  const compared = compareVersions(main.version, version);
  if (compared > 0) return { status: "newer-version-present", version: main.version };
  if (compared === 0) {
    requireCondition(main.version === version
      && main.architecture?.["64bit"]?.url === release.architecture["64bit"].url
      && main.architecture?.["64bit"]?.hash === receipt.zipSha256,
    "Bucket has conflicting bytes or tag at the same version; refusing overwrite.");
    return { status: "already-current", version };
  }
  const content = patchManifest(main, release);
  const branch = `modeleaf/${tag}`;
  const message = `Promote Modeleaf ${tag}\n\nSource: ${receipt.sourceCommit}\nZIP-SHA256: ${receipt.zipSha256}\nRelease-manifest-SHA256: ${receipt.manifestSha256}`;
  const body = `${message}\n\nPublic release assets verified against the reviewed four-file candidate.\nhttps://github.com/${SOURCE}/releases/tag/${tag}\n\nOnly version, 64bit URL and ZIP hash change; existing bucket hooks and other fields are preserved. Manual review and merge are required. Recheck against current main before merging; no auto-merge.`;
  const existing = await github.paginate(pulls.list, { ...BUCKET, state: "all", head: `${BUCKET.owner}:${branch}`, per_page: 100 });
  requireCondition(existing.length <= 1, "Ambiguous promotion PR history; manual reconciliation required.");
  if (existing.length) {
    requireCondition(existing[0].state === "open" && !existing[0].merged_at,
      "Promotion PR is closed or merged but main lacks the target; manual reconciliation required.");
  }
  let headSha = await optional(() => getRef(`heads/${branch}`));
  if (headSha) {
    const { data: commit } = await git.getCommit({ ...BUCKET, commit_sha: headSha });
    requireCondition(commit.message === message && commit.parents.length === 1,
      "Existing promotion branch is unrelated; refusing overwrite.");
    const parent = commit.parents[0].sha;
    const { data: ancestry } = await repos.compareCommits({ ...BUCKET, base: parent, head: mainSha });
    requireCondition(["ahead", "identical"].includes(ancestry.status), "Promotion branch base is not an ancestor of main.");
    const { data: diff } = await repos.compareCommits({ ...BUCKET, base: parent, head: headSha });
    requireCondition(diff.total_commits === 1 && diff.files?.length === 1
      && diff.files[0].filename === PATH && diff.files[0].status === "modified",
    "Existing promotion branch contains unrelated changes; refusing overwrite.");
    const parentManifest = JSON.parse(await readManifest(parent));
    requireCondition(compareVersions(parentManifest.version, version) < 0,
      "Existing promotion branch does not upgrade its base.");
    const branchContent = await readManifest(headSha);
    requireCondition(branchContent === patchManifest(parentManifest, release) && branchContent === content,
      "Existing promotion branch differs from the safe current patch; manual reconciliation required.");
  } else {
    requireCondition(existing.length === 0, "Open promotion PR has lost its branch; manual reconciliation required.");
    const { data: baseCommit } = await git.getCommit({ ...BUCKET, commit_sha: mainSha });
    const { data: tree } = await git.createTree({ ...BUCKET, base_tree: baseCommit.tree.sha,
      tree: [{ path: PATH, mode: "100644", type: "blob", content }] });
    const { data: commit } = await git.createCommit({ ...BUCKET, message, tree: tree.sha, parents: [mainSha] });
    requireCondition(await getRef(`heads/${BASE}`) === mainSha, "Bucket main changed; retry against its new head.");
    // A single atomic create publishes the complete branch. Collisions fail closed;
    // a retry inspects the existing branch instead of ever overwriting it.
    await git.createRef({ ...BUCKET, ref: `refs/heads/${branch}`, sha: commit.sha });
    headSha = commit.sha;
  }
  const confirmPr = async (number) => {
    const { data: pr } = await pulls.get({ ...BUCKET, pull_number: number });
    requireCondition(pr.state === "open" && !pr.merged_at
      && pr.base.ref === BASE && pr.base.repo.full_name === `${BUCKET.owner}/${BUCKET.repo}`
      && pr.head.sha === headSha && pr.head.repo.full_name === `${BUCKET.owner}/${BUCKET.repo}`
      && await getRef(`heads/${BASE}`) === mainSha
      && await getRef(`heads/${branch}`) === headSha,
    "Promotion PR or bucket refs changed during the write; manual inspection required, success not confirmed.");
  };
  requireCondition(await getRef(`heads/${BASE}`) === mainSha
    && await getRef(`heads/${branch}`) === headSha, "Bucket refs changed; retry before PR creation.");
  if (existing.length) {
    const pr = existing[0];
    requireCondition(pr.base.ref === BASE && pr.base.repo.full_name === `${BUCKET.owner}/${BUCKET.repo}`
      && pr.head.sha === headSha && pr.head.repo.full_name === `${BUCKET.owner}/${BUCKET.repo}`,
    "Existing promotion PR has an unexpected base or head.");
    await pulls.update({ ...BUCKET, pull_number: pr.number, title: `Update Modeleaf to ${version}`, body });
    await confirmPr(pr.number);
    return { status: "pr-updated", number: pr.number };
  }
  const { data: pr } = await pulls.create({ ...BUCKET, base: BASE, head: branch,
    title: `Update Modeleaf to ${version}`, body, draft: true });
  await confirmPr(pr.number);
  return { status: "pr-created", number: pr.number };
}
