import { compileFunction, constants } from "node:vm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const workflow = JSON.parse(readFileSync(".github/workflows/publish-scoop.yml", "utf8"));
const job = workflow.jobs.publish;
const source = "a".repeat(40);
const repository = { owner: "DS-argus", repo: "modeleaf-win" };
const context = { repo: repository, ref: "refs/tags/v1.2.3", eventName: "push", payload: { repository: { private: false } } };
const roots: string[] = [];
const nativeRequire = createRequire(import.meta.url);

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function api() {
  return { paginate: vi.fn().mockResolvedValue([]), rest: {
    repos: {
      listReleases: vi.fn(),
      getCommit: vi.fn().mockResolvedValue({ data: { sha: source } }),
      createRelease: vi.fn().mockResolvedValue({ data: { id: 123, html_url: "https://example.invalid/release" } }),
      uploadReleaseAsset: vi.fn().mockImplementation(async ({ data }: { data: Buffer }) => ({ data: {
        state: "uploaded", size: data.length, digest: "sha256:" + createHash("sha256").update(data).digest("hex"),
      } })),
      updateRelease: vi.fn().mockResolvedValue({ data: {} }),
    },
    actions: {
      listWorkflowRuns: vi.fn().mockResolvedValue({ data: { workflow_runs: [
        { id: 42, head_sha: source, head_branch: "main", conclusion: "success", event: "push" },
      ] } }),
      listWorkflowRunArtifacts: vi.fn().mockResolvedValue({ data: { artifacts: [
        { id: 77, name: "modeleaf-scoop-review-" + source, expired: false },
      ] } }),
    },
  } };
}

async function execute(name: string, github: ReturnType<typeof api>, env: Record<string, string> = {}, privateRepository = false, overrideContext = {}) {
  const step = [...job.steps, ...workflow.jobs.promote.steps].find((entry: { name: string }) => entry.name === name);
  const core = {
    setOutput: vi.fn(), info: vi.fn(), setFailed: vi.fn((message: string) => { throw new Error(message); }),
    summary: { addHeading: vi.fn().mockReturnThis(), addRaw: vi.fn().mockReturnThis(), write: vi.fn().mockResolvedValue(undefined) },
  };
  const run = compileFunction(`return (async () => {${step.with.script}\n})();`, ["github", "context", "core", "process", "require"], {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  await run(github, { ...context, payload: { repository: { private: privateRepository } }, ...overrideContext }, core, {
    env: { APPROVED_SOURCE_SHA: source, APPROVED_ZIP_SHA256: "b".repeat(64), GITHUB_WORKSPACE: process.cwd(), RUNNER_TEMP: tmpdir(), ...env },
  }, nativeRequire);
  return core;
}
async function candidate() {
  const directory = await mkdtemp(join(tmpdir(), "modeleaf-publication-test-"));
  roots.push(directory);
  // Synthetic transport bytes only; publication APIs are mocked and nothing is launched.
  const zip = Buffer.from("synthetic reviewed ZIP transport fixture");
  const hash = createHash("sha256").update(zip).digest("hex");
  const basename = "modeleaf-1.2.3-windows-x64.zip";
  const files = {
    [basename]: zip,
    "modeleaf.json": JSON.stringify({
      version: "1.2.3", description: "Keyboard-first read-only PDF viewer for Windows",
      homepage: "https://github.com/DS-argus/modeleaf-win", license: "MIT",
      architecture: { "64bit": { url: "https://github.com/DS-argus/modeleaf-win/releases/download/v1.2.3/" + basename, hash } },
      bin: "modeleaf.exe", shortcuts: [["modeleaf.exe", "Modeleaf"]],
      notes: ["Requires Windows 11 x64.", "Requires the Microsoft Edge WebView2 Runtime to be installed."],
    }),
    "SHA256SUMS": `${hash}  ${basename}\n`,
    "package-receipt.json": JSON.stringify({
      source: { commit: source, version: "1.2.3" },
      artifact: { basename, sha256: hash, bytes: zip.length },
      status: { signature: "not-verified", executableValidation: "header-only", nativeAcceptance: "not-verified" },
    }),
  };
  await Promise.all(Object.entries(files).map(([name, bytes]) => writeFile(join(directory, name), bytes)));
  return { ARTIFACT_DIRECTORY: directory, APPROVED_ZIP_SHA256: hash };
}

describe("review-bound tag publication", () => {
  it("restricts publication to public approved tags without rebuilding or cancellation", () => {
    expect(workflow.on).toEqual({ push: { tags: ["v*"] } });
    expect(job.if).toBe("github.repository == 'DS-argus/modeleaf-win' && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && github.event.repository.private == false && vars.MODELEAF_APPROVED_RELEASE_SHA != '' && vars.MODELEAF_APPROVED_ZIP_SHA256 != ''");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "write", actions: "read" });
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(job.steps.every((step: { uses: string }) => /^actions\/[a-z-]+@[0-9a-f]{40}$/u.test(step.uses))).toBe(true);
    expect(JSON.stringify(job)).not.toContain("npm run tauri");
    expect(job.steps.find((step: { name: string }) => step.name === "Download exact reviewed bytes").with["digest-mismatch"]).toBe("error");
  });

  it("selects only a successful main artifact bound to the approved tag source", async () => {
    const github = api();
    const core = await execute("Find the approved main artifact", github);
    expect(github.rest.repos.getCommit).toHaveBeenCalledWith({ ...repository, ref: context.ref });
    expect(core.setOutput).toHaveBeenCalledWith("run-id", "42");
    expect(core.setOutput).toHaveBeenCalledWith("artifact-name", "modeleaf-scoop-review-" + source);
  });

  it("rejects private repositories and unapproved tag sources before artifact lookup", async () => {
    const github = api();
    await expect(execute("Find the approved main artifact", github, {}, true)).rejects.toThrow(/public repository/iu);
    github.rest.repos.getCommit.mockResolvedValue({ data: { sha: "c".repeat(40) } });
    await expect(execute("Find the approved main artifact", github)).rejects.toThrow(/differs from owner-approved/iu);
    expect(github.rest.actions.listWorkflowRuns).not.toHaveBeenCalled();
  });

  it("does not promote PR builds or expired artifacts", async () => {
    const github = api();
    github.rest.actions.listWorkflowRuns.mockResolvedValueOnce({ data: { workflow_runs: [
      { id: 42, head_sha: source, head_branch: "main", conclusion: "success", event: "pull_request" },
    ] } });
    await expect(execute("Find the approved main artifact", github)).rejects.toThrow(/No successful main/iu);
    github.rest.actions.listWorkflowRunArtifacts.mockResolvedValue({ data: { artifacts: [
      { id: 77, name: "modeleaf-scoop-review-" + source, expired: true },
    ] } });
    await expect(execute("Find the approved main artifact", github)).rejects.toThrow(/missing, expired or ambiguous/iu);
  });

  it("uploads all verified bytes to a draft before publishing an experimental release", async () => {
    const github = api();
    await execute("Validate and publish through a draft", github, await candidate());
    expect(github.rest.repos.createRelease).toHaveBeenCalledWith(expect.objectContaining({ draft: true, prerelease: true, target_commitish: source }));
    expect(github.rest.repos.uploadReleaseAsset).toHaveBeenCalledTimes(4);
    expect(github.rest.repos.updateRelease).toHaveBeenCalledWith(expect.objectContaining({ release_id: 123, draft: false, prerelease: true }));
    expect(github.rest.repos.updateRelease.mock.invocationCallOrder[0]).toBeGreaterThan(github.rest.repos.uploadReleaseAsset.mock.invocationCallOrder.at(-1)!);
  });

  it("leaves the draft unpublished if an uploaded digest is wrong", async () => {
    const github = api();
    github.rest.repos.uploadReleaseAsset.mockResolvedValueOnce({ data: { state: "uploaded", size: 0, digest: "sha256:wrong" } });
    await expect(execute("Validate and publish through a draft", github, await candidate())).rejects.toThrow(/remains a draft/iu);
    expect(github.rest.repos.updateRelease).not.toHaveBeenCalled();
  });

  it("never uploads into or overwrites an existing release", async () => {
    const github = api();
    github.paginate.mockResolvedValue([{ tag_name: "v1.2.3", draft: true }]);
    await expect(execute("Validate and publish through a draft", github, await candidate())).rejects.toThrow(/already exists/iu);
    expect(github.rest.repos.createRelease).not.toHaveBeenCalled();
    expect(github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled();
    expect(github.rest.repos.updateRelease).not.toHaveBeenCalled();
  });
});

async function publicFixture() {
  const env = await candidate();
  const temporary = await mkdtemp(join(tmpdir(), "modeleaf-public-transport-"));
  roots.push(temporary);
  const files = new Map(await Promise.all((await readdir(env.ARTIFACT_DIRECTORY)).map(async (name) => [name, await readFile(join(env.ARTIFACT_DIRECTORY, name))] as const)));
  const release = { tag_name: "v1.2.3", draft: false, prerelease: true, published_at: "2026-09-20T00:00:00Z", assets: [...files].map(([name, bytes]) => ({
    name, size: bytes.length, state: "uploaded", digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
    browser_download_url: `https://github.com/DS-argus/modeleaf-win/releases/download/v1.2.3/${name}`,
  })) };
  const transport = vi.fn(async (url: string, options: RequestInit) => {
    expect(new Headers(options.headers).has("authorization")).toBe(false);
    expect(options.credentials).toBe("omit");
    if (url === "https://api.github.com/repos/DS-argus/modeleaf-win/releases/tags/v1.2.3") return new Response(JSON.stringify(release));
    const asset = release.assets.find((entry) => entry.browser_download_url === url);
    if (!asset) throw new Error("Unexpected test network destination");
    return new Response(new Uint8Array(files.get(asset.name)!));
  });
  vi.stubGlobal("fetch", transport);
  return { env: { ...env, RUNNER_TEMP: temporary, VERIFIED_DIRECTORY: join(temporary, "verified") }, transport, files, release };
}

describe("explicit protected publication-to-promotion linkage", () => {
  const promote = workflow.jobs.promote;
  it("uses a successful same-workflow dependency, pinned trusted source and read-only source token", () => {
    expect(promote.needs).toBe("publish");
    expect(promote.if).toBe("github.repository == 'DS-argus/modeleaf-win' && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && github.event.repository.private == false");
    expect(promote.permissions).toEqual({ contents: "read", actions: "read" });
    expect(promote.concurrency).toEqual({ group: "scoop-bucket-modeleaf", "cancel-in-progress": false });
    expect(promote.steps[0].with).toEqual({ ref: "${{ needs.publish.outputs.source }}", "persist-credentials": false });
    expect(promote.env.APPROVED_SOURCE_SHA).toBe("${{ needs.publish.outputs.source }}");
    expect(promote.env.APPROVED_ZIP_SHA256).toBe("${{ needs.publish.outputs.zip }}");
    expect(job.outputs.source).toBe("${{ steps.published.outputs.source }}");
    expect(job.outputs.zip).toBe("${{ steps.published.outputs.zip }}");
    expect(promote.steps.every((step: { uses: string }) => /^actions\/[a-z-]+@[0-9a-f]{40}$/u.test(step.uses))).toBe(true);
    const download = promote.steps.find((step: { name: string }) => step.name === "Download exact reviewed bytes");
    expect(download.with["run-id"]).toBe("${{ needs.publish.outputs.run-id }}");
    expect(download.with.name).toBe("${{ needs.publish.outputs.artifact-name }}");
    expect(download.with["digest-mismatch"]).toBe("error");
    const writer = promote.steps.findIndex((step: { id: string }) => step.id === "promotion");
    const verifier = promote.steps.findIndex((step: { id: string }) => step.id === "verified");
    expect(writer).toBeGreaterThan(verifier);
    expect(promote.steps[writer].with["github-token"]).toBe("${{ secrets.MODELEAF_SCOOP_BUCKET_TOKEN }}");
    expect(promote.steps.filter((step: { with: Record<string, string> }) => step.with["github-token"] === "${{ secrets.MODELEAF_SCOOP_BUCKET_TOKEN }}")).toHaveLength(1);
    expect(promote.steps.slice(0, verifier + 1).some((step: unknown) => JSON.stringify(step).includes("secrets."))).toBe(false);
    expect(promote.steps[writer].if).toBeUndefined(); // default success(): never always() on writes
    expect(promote.steps.at(-1).if).toBe("always()");
    expect(JSON.stringify(workflow)).not.toMatch(/pull_request_target|enablePullRequestAutoMerge|mergePullRequest/u);
  });

  it("accepts an already-published release on rerun only after public byte verification", async () => {
    const { env, transport } = await publicFixture();
    const github = api();
    github.paginate.mockResolvedValue([{ tag_name: "v1.2.3", draft: false }]);
    const core = await execute("Validate and publish through a draft", github, env);
    expect(transport).toHaveBeenCalledTimes(5);
    expect(core.setOutput).toHaveBeenCalledWith("source", source);
    expect(github.rest.repos.createRelease).not.toHaveBeenCalled();
    expect(github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled();
    expect(github.rest.repos.updateRelease).not.toHaveBeenCalled();
  });

  it("binds public bytes and persists the receipt before bucket credentials are available", async () => {
    const { env, transport } = await publicFixture();
    const github = api();
    const core = await execute("Verify public assets without bucket credentials", github, env);
    expect(transport).toHaveBeenCalledTimes(5);
    expect(core.setOutput).toHaveBeenCalledWith("public-verified", "true");
    expect(JSON.parse(await readFile(join(env.VERIFIED_DIRECTORY, "verification.json"), "utf8"))).toMatchObject({
      sourceCommit: source, zipSha256: env.APPROVED_ZIP_SHA256, publicDownloadVerification: true,
    });
    expect(github.rest.repos.createRelease).not.toHaveBeenCalled();
    expect(github.rest.repos.updateRelease).not.toHaveBeenCalled();
  });

  it.each(["missing", "mismatch"])("rejects %s public assets without reaching write operations", async (failure) => {
    const { env, files, release, transport } = await publicFixture();
    if (failure === "missing") transport.mockResolvedValue(new Response("absent", { status: 404 }));
    else files.set(release.assets[0]!.name, Buffer.from("wrong"));
    const github = api();
    const writeStep = vi.fn();
    await expect((async () => {
      await execute("Verify public assets without bucket credentials", github, env);
      writeStep();
    })()).rejects.toThrow(/public|size|SHA-256/iu);
    expect(writeStep).not.toHaveBeenCalled();
    await expect(readFile(join(env.VERIFIED_DIRECTORY, "verification.json"))).rejects.toThrow();
  });

  it("fails setup explicitly for an absent credential rather than using the source token", async () => {
    await expect(execute("Require bucket credential configuration", api(), { BUCKET_TOKEN_CONFIGURED: "false" })).rejects.toThrow(/Setup blocked.*Release is published.*not created/u);
    await expect(execute("Require bucket credential configuration", api(), { BUCKET_TOKEN_CONFIGURED: "true" })).resolves.toBeDefined();
  });

  it.each([
    { eventName: "pull_request" }, { eventName: "pull_request_target" }, { eventName: "release" },
    { repo: { owner: "attacker", repo: "modeleaf-win" } }, { ref: "refs/heads/main" },
    { payload: { repository: { private: true } } },
  ])("rejects an untrusted promotion context before public transport: %j", async (override) => {
    const { env, transport } = await publicFixture();
    await expect(execute("Verify public assets without bucket credentials", api(), env, false, override)).rejects.toThrow(/approved tag push/u);
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects a moved published tag before public verification", async () => {
    const { env, transport } = await publicFixture();
    const github = api();
    github.rest.repos.getCommit.mockResolvedValue({ data: { sha: "c".repeat(40) } });
    await expect(execute("Verify public assets without bucket credentials", github, env)).rejects.toThrow(/tag changed/u);
    expect(transport).not.toHaveBeenCalled();
  });

  it("reports a bucket API failure without echoing request credentials or changing the release", async () => {
    const { env } = await publicFixture();
    const github = api();
    await execute("Verify public assets without bucket credentials", github, env);
    Object.assign(github.rest, { git: { getRef: vi.fn().mockRejectedValue(Object.assign(new Error("sensitive request metadata"), { status: 403 })) } });
    await expect(execute("Create or update bucket promotion Draft PR", github, env)).rejects.toThrow("Bucket promotion failed; release remains published. Inspect branch/PR state before retry. GitHub HTTP 403");
    expect(github.rest.repos.updateRelease).not.toHaveBeenCalled();
    expect(github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled();
  });

  it("reports publication separately when promotion did not complete", async () => {
    const core = await execute("Report publication and promotion independently", api(), { PUBLIC_VERIFIED: "true", PROMOTION_STATUS: "", PROMOTION_PR: "" });
    expect(core.summary.addRaw).toHaveBeenCalledWith(expect.stringContaining("release published"));
    expect(core.summary.addRaw).toHaveBeenCalledWith(expect.stringContaining("not completed; inspect failing step"));
    expect(core.summary.addRaw).toHaveBeenCalledWith(expect.stringContaining("none confirmed"));
    expect(core.summary.addRaw).toHaveBeenCalledWith(expect.stringContaining("merge: not performed"));
    expect(core.summary.write).toHaveBeenCalledOnce();
  });
});
