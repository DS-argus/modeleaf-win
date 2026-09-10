import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Binds the packaging configuration to the ADR 0001 distribution decision.
 *
 * Every value here is a product decision, not a build detail: current-user
 * install, x64 NSIS, the WebView2 download bootstrapper, and a `.pdf`
 * association that does not seize the system default. Drift in any of them
 * changes what users receive, so it fails the gate rather than shipping.
 */
const root = process.cwd();

interface TauriConfig {
  readonly productName: string;
  readonly version: string;
  readonly identifier: string;
  readonly bundle: {
    readonly active: boolean;
    readonly targets: readonly string[];
    readonly publisher?: string;
    readonly fileAssociations?: readonly { readonly ext: readonly string[]; readonly role?: string }[];
    readonly windows?: {
      readonly webviewInstallMode?: { readonly type: string };
      readonly nsis?: { readonly installMode?: string };
    };
  };
}

const tauriConfig = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")) as TauriConfig;
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { readonly version: string };
const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");

describe("installer configuration", () => {
  it("bundles NSIS only", () => {
    expect(tauriConfig.bundle.active).toBe(true);
    expect(tauriConfig.bundle.targets).toEqual(["nsis"]);
    // MSI and Store are explicitly outside the ADR 0001 decision.
    expect(tauriConfig.bundle.targets).not.toContain("msi");
  });

  it("installs per user so no elevation or machine-wide state is required", () => {
    expect(tauriConfig.bundle.windows?.nsis?.installMode).toBe("currentUser");
  });

  it("fetches WebView2 with the download bootstrapper", () => {
    expect(tauriConfig.bundle.windows?.webviewInstallMode?.type).toBe("downloadBootstrapper");
  });

  it("names a publisher so the installer is attributable", () => {
    expect(tauriConfig.bundle.publisher?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("file association", () => {
  it("registers .pdf as a viewer", () => {
    const association = tauriConfig.bundle.fileAssociations?.find((entry) => entry.ext.includes("pdf"));
    expect(association).toBeDefined();
    // Viewer, not Editor: the product is read-only.
    expect(association?.role).toBe("Viewer");
  });

  it("claims no association other than .pdf", () => {
    const extensions = (tauriConfig.bundle.fileAssociations ?? []).flatMap((entry) => entry.ext);
    expect(extensions).toEqual(["pdf"]);
  });
});

describe("version metadata consistency", () => {
  it("keeps the three manifests on one version", () => {
    // A mismatch produces an installer whose reported version disagrees with
    // the binary, which breaks update comparison in a way users cannot debug.
    const cargoVersion = /^version\s*=\s*"([^"]+)"/mu.exec(cargoToml)?.[1];
    expect(cargoVersion, "Cargo.toml version missing").toBeDefined();
    expect(tauriConfig.version).toBe(packageJson.version);
    expect(cargoVersion).toBe(packageJson.version);
  });

  it("uses a parseable semantic version", () => {
    expect(tauriConfig.version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u);
  });

  it("keeps a stable bundle identifier", () => {
    expect(tauriConfig.identifier).toBe("com.dsargus.modeleaf");
  });
});

describe("release boundary", () => {
  it("configures no signing credentials in the repository", () => {
    // Signing is a human-only step with real credentials; nothing may be
    // committed that implies the repository can sign.
    const raw = readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8");
    for (const forbidden of ["certificateThumbprint", "signCommand", "digestAlgorithm", "timestampUrl"]) {
      expect(raw, `${forbidden} must not be configured`).not.toContain(forbidden);
    }
  });

  it("ships no updater endpoint, because updates are notify-only", () => {
    const raw = readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8");
    expect(raw).not.toContain("\"updater\"");
    expect(raw).not.toContain("pubkey");
  });

  it("keeps macOS install phrasing out of Windows-facing text", () => {
    // §15 lists Homebrew/macOS phrasing leaking into Windows docs as a defect.
    const windowsFacing = [
      readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
      readFileSync(join(root, "docs", "windows-release-checklist.md"), "utf8"),
      readFileSync(join(root, "docs", "troubleshooting.md"), "utf8"),
    ].join("\n");
    for (const phrase of ["brew install", "Homebrew", "brew upgrade", ".dmg", "macOS app bundle"]) {
      expect(windowsFacing, `${phrase} must not appear in Windows-facing text`).not.toContain(phrase);
    }
  });
});

describe("release checklist", () => {
  const checklist = readFileSync(join(root, "docs", "windows-release-checklist.md"), "utf8");

  it("marks every manual gate explicitly human-only", () => {
    for (const item of ["clean Windows", "SmartScreen", "Narrator", "Authenticode"]) {
      expect(checklist, `${item} missing from the checklist`).toContain(item);
    }
    expect(checklist).toContain("HUMAN-ONLY");
  });

  it("keeps candidate verification distinct from publication and final owner approval", () => {
    expect(checklist).toContain("Treat a candidate as **unreleased** until its matching GitHub prerelease and verified assets exist.");
    expect(checklist).toContain("final owner review immediately before public conversion");
  });

  it("does not certify unperformed native validation", () => {
    // Basic owner use does not certify these specific native scenarios.
    expect(checklist).not.toMatch(/verified on a clean VM|SmartScreen passed|Narrator verified/iu);
  });
});
