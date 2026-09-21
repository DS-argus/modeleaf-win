import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe.skipIf(process.platform !== "win32")("source-bound preview profiles", () => {
  it.each([false, true])("rejects the opposite profile receipt before launch: release=%s", release => {
    const root = mkdtempSync(join(tmpdir(), "modeleaf-preview-profile-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    try {
      git("init", "--quiet", "--initial-branch=preview-test");
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(root, ".gitignore"), "node_modules/\n.internal/\n");
      git("add", "package.json", ".gitignore");
      git("-c", "user.name=Preview Test", "-c", "user.email=preview@example.invalid", "commit", "--quiet", "-m", "fixture");
      mkdirSync(join(root, "node_modules/@tauri-apps/cli"), { recursive: true });
      writeFileSync(join(root, "node_modules/@tauri-apps/cli/tauri.js"), "");
      for (const profile of ["debug", "release"]) {
        mkdirSync(join(root, ".internal/preview-target", profile), { recursive: true });
        writeFileSync(join(root, ".internal/preview-target", profile, "modeleaf.exe"), "not-an-executable");
      }
      writeFileSync(join(root, ".internal/preview-target/preview-receipt.json"), JSON.stringify({
        kind: release ? "standalone-tauri-debug-no-bundle" : "standalone-tauri-release-no-bundle",
        branch: "preview-test", source: { head: git("rev-parse", "HEAD"), statusSha256: hash(""), diffSha256: hash("") },
        executableSha256: hash("not-an-executable"),
      }));
      const result = spawnSync("powershell.exe", ["-NoProfile", "-Command",
        `function Get-Process { @() }; & $env:PREVIEW_TEST_SCRIPT -Worktree $env:PREVIEW_TEST_ROOT -SkipBuild ${release ? "-Release" : ""}`], {
        encoding: "utf8", timeout: 30_000,
        env: { ...process.env, PREVIEW_TEST_ROOT: root, PREVIEW_TEST_SCRIPT: resolve("tools/windows/preview-worktree.ps1") },
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("Preview receipt is stale");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
