import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { compareVersions, promoteScoopBucket } from "../../../tools/releases/promote-scoop-bucket.mjs";

const source = "a".repeat(40);
const hash = "b".repeat(64);
const mainSha = "c".repeat(40);
const headSha = "d".repeat(40);
const branch = "heads/modeleaf/v1.2.3";
const context = { eventName: "push", repo: { owner: "DS-argus", repo: "modeleaf-win" },
  ref: "refs/tags/v1.2.3", payload: { repository: { private: false } } };
const release = { version: "1.2.3", architecture: { "64bit": {
  url: "https://github.com/DS-argus/modeleaf-win/releases/download/v1.2.3/modeleaf-1.2.3-windows-x64.zip", hash,
} } };
const manifestBytes = Buffer.from(JSON.stringify(release));
const receipt = { version: release.version, sourceCommit: source, zipSha256: hash,
  manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), publicDownloadVerification: true };
const missing = () => Object.assign(new Error("not found"), { status: 404 });

type Commit = { message: string; parents: { sha: string }[]; tree: { sha: string } };
type Pull = { number: number; state: string; merged_at: string | null;
  base: { ref: string; repo: { full_name: string } }; head: { sha: string; repo: { full_name: string } } };

function harness() {
  const current = { version: "1.2.2", architecture: { "64bit": { url: "old", hash: "old", extract_dir: "keep" } },
    post_install: "& $dir/modeleaf-pdf-handler.ps1 Register", pre_uninstall: ["Unregister", "keep exact order"],
    notes: ["keep"], arbitrary: { nested: true } };
  const refs = new Map([["heads/main", mainSha]]);
  const files = new Map([[mainSha, JSON.stringify(current)]]);
  const commits = new Map<string, Commit>([[mainSha, { tree: { sha: "base-tree" }, message: "base", parents: [] }]]);
  const prs: Pull[] = [];
  let content = "";
  const git = {
    getRef: vi.fn(async ({ ref }: { ref: string }) => {
      const sha = refs.get(ref); if (!sha) throw missing(); return { data: { object: { sha } } };
    }),
    getCommit: vi.fn(async ({ commit_sha }: { commit_sha: string }) => ({ data: commits.get(commit_sha)! })),
    createTree: vi.fn(async ({ tree }: { tree: { content: string }[] }) => { content = tree[0]!.content; return { data: { sha: "new-tree" } }; }),
    createCommit: vi.fn(async ({ message, parents }: { message: string; parents: string[] }) => {
      commits.set(headSha, { message, parents: parents.map((sha) => ({ sha })), tree: { sha: "new-tree" } });
      files.set(headSha, content); return { data: { sha: headSha } };
    }),
    createRef: vi.fn(async ({ ref, sha }: { ref: string; sha: string }) => {
      const key = ref.replace(/^refs\//u, "");
      if (refs.has(key)) throw Object.assign(new Error("exists"), { status: 422 });
      refs.set(key, sha); return { data: {} };
    }),
  };
  const repos = {
    getContent: vi.fn(async ({ ref }: { ref: string }) => {
      const text = files.get(ref); if (!text) throw missing();
      return { data: { type: "file", encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") } };
    }),
    compareCommits: vi.fn(async ({ base, head }: { base: string; head: string }) => ({ data: {
      status: base === head ? "identical" : "ahead", total_commits: 1,
      files: [{ filename: "bucket/modeleaf.json", status: "modified" }],
    } })),
  };
  const pulls = {
    list: vi.fn(),
    get: vi.fn(async ({ pull_number }: { pull_number: number }) => ({ data: prs.find((pr) => pr.number === pull_number)! })),
    create: vi.fn(async () => {
      const pr: Pull = { number: 42, state: "open", merged_at: null,
        base: { ref: "main", repo: { full_name: "DS-argus/scoop-bucket" } },
        head: { sha: headSha, repo: { full_name: "DS-argus/scoop-bucket" } } };
      prs.push(pr); return { data: pr };
    }),
    update: vi.fn(async () => ({ data: {} })),
  };
  const github = { rest: { git, repos, pulls }, paginate: vi.fn(async () => prs) };
  const run = (overrides = {}) => promoteScoopBucket({ github, context, receipt, manifestBytes, credentialAvailable: true, ...overrides });
  const writes = () => [git.createTree, git.createCommit, git.createRef, pulls.create, pulls.update];
  const clearWrites = () => writes().forEach((mock) => mock.mockClear());
  const noWrites = () => writes().forEach((mock) => expect(mock).not.toHaveBeenCalled());
  return { current, refs, files, commits, prs, github, git, repos, pulls, run, noWrites, clearWrites };
}

describe("immutable verified Scoop promotion", () => {
  it("creates one focused branch and Draft PR, preserving hooks and every unrelated sibling", async () => {
    const h = harness();
    expect(await h.run()).toEqual({ status: "pr-created", number: 42 });
    const changed = JSON.parse(h.files.get(headSha)!);
    expect(changed).toEqual({ ...h.current, version: "1.2.3", architecture: { "64bit": {
      ...h.current.architecture["64bit"], ...release.architecture["64bit"],
    } } });
    expect(h.git.createTree).toHaveBeenCalledWith(expect.objectContaining({ owner: "DS-argus", repo: "scoop-bucket", base_tree: "base-tree",
      tree: [{ path: "bucket/modeleaf.json", type: "blob", mode: "100644", content: h.files.get(headSha) }] }));
    expect(h.git.createRef).toHaveBeenCalledExactlyOnceWith({ owner: "DS-argus", repo: "scoop-bucket", ref: `refs/${branch}`, sha: headSha });
    expect(h.pulls.create).toHaveBeenCalledWith(expect.objectContaining({ draft: true, base: "main", head: "modeleaf/v1.2.3",
      body: expect.stringContaining(receipt.manifestSha256) }));
    expect(h.refs.get("heads/main")).toBe(mainSha);
  });

  it("reuses an open PR and refreshes its evidence without modifying its branch", async () => {
    const h = harness(); await h.run(); h.clearWrites();
    expect(await h.run()).toEqual({ status: "pr-updated", number: 42 });
    expect(h.git.createRef).not.toHaveBeenCalled();
    expect(h.git.createCommit).not.toHaveBeenCalled();
    expect(h.pulls.create).not.toHaveBeenCalled();
    expect(h.pulls.update).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 42 }));
  });

  it("recovers a complete branch after PR creation fails, without duplicating commits", async () => {
    const h = harness(); h.pulls.create.mockRejectedValueOnce(new Error("connection lost"));
    await expect(h.run()).rejects.toThrow("connection lost");
    expect(h.refs.get(branch)).toBe(headSha); h.clearWrites();
    expect(await h.run()).toEqual({ status: "pr-created", number: 42 });
    expect(h.git.createCommit).not.toHaveBeenCalled();
    expect(h.git.createRef).not.toHaveBeenCalled();
    expect(h.pulls.create).toHaveBeenCalledOnce();
  });

  it.each(["already-current", "newer-version-present"])("does not write when %s", async (status) => {
    const h = harness();
    h.files.set(mainSha, JSON.stringify(status === "already-current" ? release : { ...release, version: "2.0.0" }));
    expect(await h.run()).toMatchObject({ status }); h.noWrites();
  });

  it.each(["hash", "url", "build"])("refuses a same-precedence %s conflict", async (field) => {
    const h = harness(); const conflict = structuredClone(release);
    if (field === "build") conflict.version += "+different";
    else conflict.architecture["64bit"][field as "hash" | "url"] = "conflicting";
    h.files.set(mainSha, JSON.stringify(conflict));
    await expect(h.run()).rejects.toThrow(/conflicting/u); h.noWrites();
  });

  it.each([false, true])("does not reopen a closed PR (merged=%s) when main lacks the version", async (merged) => {
    const h = harness(); await h.run(); h.clearWrites();
    h.prs[0]!.state = "closed"; h.prs[0]!.merged_at = merged ? "2026-09-20T00:00:00Z" : null;
    await expect(h.run()).rejects.toThrow(/closed or merged/u); h.noWrites();
    h.files.set(mainSha, JSON.stringify(release));
    expect(await h.run()).toMatchObject({ status: "already-current" }); h.noWrites();
  });

  it.each(["message", "parents", "diff", "content", "hooks", "ancestry", "base-version"])("refuses an unsafe existing branch: %s", async (kind) => {
    const h = harness(); await h.run(); h.clearWrites();
    if (kind === "message") h.commits.get(headSha)!.message = "unrelated";
    if (kind === "parents") h.commits.get(headSha)!.parents = [];
    if (kind === "diff") h.repos.compareCommits.mockResolvedValue({ data: { status: "ahead", total_commits: 1, files: [{ filename: "README.md", status: "modified" }] } });
    if (kind === "content") h.files.set(headSha, "{}");
    if (kind === "hooks") h.files.set(mainSha, JSON.stringify({ ...h.current, post_install: "changed by owner" }));
    if (kind === "ancestry") h.repos.compareCommits.mockResolvedValue({ data: { status: "diverged", total_commits: 1, files: [] } });
    if (kind === "base-version") {
      const oldParent = "e".repeat(40); h.commits.get(headSha)!.parents = [{ sha: oldParent }];
      h.files.set(oldParent, JSON.stringify(release));
    }
    await expect(h.run()).rejects.toThrow(); h.noWrites();
  });

  it("refuses ambiguous PR history, a missing PR branch and a changed PR base", async () => {
    const h = harness(); await h.run(); h.clearWrites();
    h.prs.push(h.prs[0]!); await expect(h.run()).rejects.toThrow(/Ambiguous/u); h.noWrites();
    h.prs.pop(); h.refs.delete(branch); await expect(h.run()).rejects.toThrow(/lost its branch/u); h.noWrites();
    h.refs.set(branch, headSha); h.prs[0]!.base.ref = "other";
    await expect(h.run()).rejects.toThrow(/unexpected base or head/u); h.noWrites();
  });

  it("allows unrelated main advancement but never overwrites newer hook content", async () => {
    const h = harness(); await h.run(); h.clearWrites();
    const newMain = "f".repeat(40); h.refs.set("heads/main", newMain); h.files.set(newMain, h.files.get(mainSha)!);
    expect(await h.run()).toMatchObject({ status: "pr-updated" });
    h.clearWrites(); h.files.set(newMain, JSON.stringify({ ...h.current, notes: ["new owner guidance"] }));
    await expect(h.run()).rejects.toThrow(/safe current patch/u); h.noWrites();
  });

  it("fails a main race before publishing a branch", async () => {
    const h = harness(); h.git.createCommit.mockImplementationOnce(async () => {
      h.refs.set("heads/main", "changed"); return { data: { sha: headSha } };
    });
    await expect(h.run()).rejects.toThrow(/main changed/u);
    expect(h.git.createRef).not.toHaveBeenCalled(); expect(h.pulls.create).not.toHaveBeenCalled();
  });

  it("fails a competing branch creation without overwriting it", async () => {
    const h = harness(); h.git.createRef.mockImplementationOnce(async () => { h.refs.set(branch, "other"); throw Object.assign(new Error("collision"), { status: 422 }); });
    await expect(h.run()).rejects.toThrow(/collision/u);
    expect(h.refs.get(branch)).toBe("other"); expect(h.pulls.create).not.toHaveBeenCalled();
  });

  it.each(["create", "update"])("does not confirm success when refs move during PR %s", async (operation) => {
    const h = harness();
    if (operation === "update") {
      await h.run();
      h.pulls.update.mockImplementationOnce(async () => { h.refs.set(branch, "unverified"); return { data: {} }; });
    } else {
      const create = h.pulls.create.getMockImplementation()!;
      h.pulls.create.mockImplementationOnce(async () => { const result = await create(); h.refs.set(branch, "unverified"); return result; });
    }
    await expect(h.run()).rejects.toThrow(/changed during the write/u);
    expect(h.refs.get("heads/main")).toBe(mainSha);
  });

  it("fails a post-creation ref race without creating a PR", async () => {
    const h = harness(); h.git.createRef.mockImplementationOnce(async () => { h.refs.set(branch, "other"); return { data: {} }; });
    await expect(h.run()).rejects.toThrow(/refs changed/u); expect(h.pulls.create).not.toHaveBeenCalled();
  });

  it("treats absent credentials and invalid receipts as zero-network setup failures", async () => {
    const h = harness();
    await expect(h.run({ credentialAvailable: false })).rejects.toThrow(/Setup blocked/u);
    await expect(h.run({ receipt: { ...receipt, publicDownloadVerification: false } })).rejects.toThrow(/receipt/u);
    await expect(h.run({ manifestBytes: Buffer.from("tampered") })).rejects.toThrow(/receipt/u);
    expect(h.git.getRef).not.toHaveBeenCalled(); h.noWrites();
  });

  it.each([
    { eventName: "pull_request" }, { eventName: "pull_request_target" }, { eventName: "release" },
    { repo: { owner: "fork", repo: "modeleaf-win" } }, { ref: "refs/heads/main" },
    { payload: { repository: { private: true } } },
  ])("refuses untrusted execution before network access: %j", async (override) => {
    const h = harness(); await expect(h.run({ context: { ...context, ...override } })).rejects.toThrow(/approved tag push/u);
    expect(h.git.getRef).not.toHaveBeenCalled(); h.noWrites();
  });
});

describe("SemVer downgrade prevention", () => {
  it.each([
    ["1.2.3", "1.2.4", -1], ["2.0.0", "1.99.99", 1], ["1.2.3-alpha", "1.2.3", -1],
    ["1.2.3", "1.2.3-alpha", 1], ["1.2.3-alpha.2", "1.2.3-alpha.10", -1],
    ["1.2.3-alpha.1", "1.2.3-alpha.beta", -1], ["1.2.3-alpha", "1.2.3-alpha.1", -1],
    ["1.2.3-beta", "1.2.3-alpha", 1], ["1.2.3+one", "1.2.3+two", 0],
    ["99999999999999999999.0.0", "99999999999999999998.0.0", 1],
  ])("compares %s with %s as %s", (a, b, expected) => expect(compareVersions(a, b)).toBe(expected));
  it.each(["1.2", "01.2.3", "1.2.3-01", "../bad"])("rejects invalid version %s", (version) => {
    expect(() => compareVersions(version, "1.2.3")).toThrow();
  });
});
