import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Step {
  readonly name: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, string>;
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly permissions: Record<string, string>;
  readonly jobs: Record<string, {
    readonly "runs-on": string;
    readonly "timeout-minutes": number;
    readonly env: Record<string, string>;
    readonly steps: readonly Step[];
  }>;
}

// JSON is valid YAML; this workflow uses that subset so its complete structure
// can be checked without adding a parser dependency to the reader project.
const raw = readFileSync(resolve(process.cwd(), ".github/workflows/windows-scoop.yml"), "utf8");
const workflow = JSON.parse(raw) as Workflow;
const job = workflow.jobs["verify-and-package"]!;
const steps = job.steps;

function step(name: string): Step {
  const found = steps.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing workflow step: ${name}`);
  return found;
}

function index(name: string): number {
  step(name);
  return steps.findIndex((entry) => entry.name === name);
}

describe("Scoop preparation workflow", () => {
  it("never grants publication authority or runs on release/tag events", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(workflow.on.push).toEqual({ branches: ["main"] });
    expect(workflow.on.pull_request).toEqual({ branches: ["main"] });
    expect(Object.keys(workflow.jobs)).toEqual(["verify-and-package"]);
    for (const forbidden of ["pull_request_target", "secrets.", "gh release", "gh repo edit", "git tag", "git push", "action-gh-release", "continue-on-error"]) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
  });

  it("pins external actions and keeps checkout credentials out of build scripts", () => {
    const actions = steps.filter((entry) => entry.uses !== undefined);
    expect(actions.map((entry) => entry.uses?.split("@")[0])).toEqual([
      "actions/checkout", "actions/setup-node", "actions/upload-artifact",
    ]);
    for (const action of actions) expect(action.uses).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/u);
    expect(step("Check out source").with?.["persist-credentials"]).toBe(false);
    expect(step("Check out source").with?.["fetch-depth"]).toBe(0);
    expect(step("Set up pinned Node.js").with?.["node-version-file"]).toBe("package.json");
  });

  it("requires every applicable automated gate before preparing artifacts", () => {
    const expectedCommands: Record<string, string> = {
      "Install locked dependencies": "npm ci",
      "Verify copied assets and notices": "npm run legal:verify",
      "Audit production dependencies": "npm run security:verify",
      "Test frontend and packaging": "npm test -- --maxWorkers=2",
      "Build frontend": "npm run build",
      "Check Rust formatting": "cargo fmt --check --manifest-path src-tauri/Cargo.toml",
      "Lint Rust": "cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings",
      "Test Rust": "cargo test --locked --manifest-path src-tauri/Cargo.toml -- --test-threads=2",
    };
    for (const [name, command] of Object.entries(expectedCommands)) {
      expect(step(name).run).toBe(command);
      expect(index(name)).toBeLessThan(index("Build standalone candidate"));
    }
    expect(step("Build standalone candidate").run).toBe("npm run tauri -- build --no-bundle");
    expect(step("Reject modified build inputs").run).toContain("git diff --exit-code");
    expect(index("Build standalone candidate")).toBeLessThan(index("Reject modified build inputs"));
    expect(index("Reject modified build inputs")).toBeLessThan(index("Prepare ZIP and Scoop metadata"));
    expect(index("Prepare ZIP and Scoop metadata")).toBeLessThan(index("Retain review artifacts without publishing"));
  });

  it("uses runner context only after execution has a runner", () => {
    expect(job.env).toEqual({ CARGO_BUILD_JOBS: "2" });
    const setup = step("Set isolated output directories");
    expect(setup.env).toEqual({
      CARGO_TARGET_DIR: "${{ runner.temp }}/modeleaf-tests",
      MODELEAF_RELEASE_TARGET: "${{ runner.temp }}/modeleaf-standalone",
      MODELEAF_PACKAGE_OUTPUT: "${{ runner.temp }}/modeleaf-scoop",
    });
    for (const name of Object.keys(setup.env!)) {
      expect(setup.run).toContain(`${name}=$env:${name}`);
    }
    expect(setup.run).toContain("$env:GITHUB_ENV");
    expect(index("Set isolated output directories")).toBeLessThan(index("Test Rust"));
  });
  it("isolates test/build state and retains private or main-only short-lived review output", () => {
    expect(job["runs-on"]).toBe("windows-latest");
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(45);
    expect(job.env.CARGO_BUILD_JOBS).toBe("2");
    const buildTarget = step("Build standalone candidate").env?.CARGO_TARGET_DIR;
    expect(buildTarget).toBe("${{ env.MODELEAF_RELEASE_TARGET }}");
    const directories = step("Set isolated output directories").env!;
    expect(directories.MODELEAF_RELEASE_TARGET).not.toBe(directories.CARGO_TARGET_DIR);
    expect(step("Prepare ZIP and Scoop metadata").run).toContain("-OutputDirectory $env:MODELEAF_PACKAGE_OUTPUT");
    const upload = step("Retain review artifacts without publishing");
    expect(upload.if).toBe("${{ github.event.repository.private == true || github.ref == 'refs/heads/main' }}");
    expect(upload.with).toMatchObject({
      path: "${{ env.MODELEAF_PACKAGE_OUTPUT }}",
      "if-no-files-found": "error",
      "retention-days": 7,
      "include-hidden-files": false,
    });
  });
});
