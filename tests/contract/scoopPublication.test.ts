import { compileFunction, constants } from "node:vm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const workflow = JSON.parse(readFileSync(".github/workflows/publish-scoop.yml", "utf8"));
const job = workflow.jobs.publish;
const source = "a".repeat(40);
const repository = { owner: "fixture-owner", repo: "modeleaf-fixture" };
const context = { repo: repository, ref: "refs/tags/v1.2.3", eventName: "push", payload: { repository: { private: false } } };
const roots: string[] = [];
const nativeRequire = createRequire(import.meta.url);

afterEach(async () => {
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

async function execute(name: string, github: ReturnType<typeof api>, env: Record<string, string> = {}, privateRepository = false) {
  const step = job.steps.find((entry: { name: string }) => entry.name === name);
  const core = { setOutput: vi.fn(), info: vi.fn() };
  const run = compileFunction(`return (async () => {${step.with.script}\n})();`, ["github", "context", "core", "process", "require"], {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  await run(github, { ...context, payload: { repository: { private: privateRepository } } }, core, {
    env: { APPROVED_SOURCE_SHA: source, APPROVED_ZIP_SHA256: "b".repeat(64), GITHUB_WORKSPACE: process.cwd(), ...env },
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
      homepage: "https://github.com/fixture-owner/modeleaf-fixture", license: "MIT",
      architecture: { "64bit": { url: "https://github.com/fixture-owner/modeleaf-fixture/releases/download/v1.2.3/" + basename, hash } },
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
    expect(job.if).toBe("github.event.repository.private == false && vars.MODELEAF_APPROVED_RELEASE_SHA != '' && vars.MODELEAF_APPROVED_ZIP_SHA256 != ''");
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
