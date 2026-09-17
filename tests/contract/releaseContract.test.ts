import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
      readonly nsis?: { readonly installMode?: string; readonly installerHooks?: string };
    };
  };
}

const tauriConfig = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")) as TauriConfig;
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { readonly version: string };
const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
const packageLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
  readonly version: string;
  readonly packages: { readonly "": { readonly version: string } };
};
const cargoLock = readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8");

describe("Windows installer configuration", () => {
  it("bundles a per-user NSIS installer with WebView2 bootstrap", () => {
    expect(tauriConfig.bundle.active).toBe(true);
    expect(tauriConfig.bundle.targets).toEqual(["nsis"]);
    expect(tauriConfig.bundle.windows?.nsis?.installMode).toBe("currentUser");
    expect(tauriConfig.bundle.windows?.webviewInstallMode?.type).toBe("downloadBootstrapper");
    expect(tauriConfig.bundle.publisher?.length ?? 0).toBeGreaterThan(0);
  });

  it("registers a PDF handler candidate through the explicit NSIS hook", () => {
    expect(tauriConfig.bundle.fileAssociations).toBeUndefined();
    expect(tauriConfig.bundle.windows?.nsis?.installerHooks).toBe("nsis/pdf-handler-candidate.nsh");
  });

  it("keeps all package manifests and lockfiles on release version 0.1.4", () => {
    const cargoVersion = /^version\s*=\s*"([^"]+)"/mu.exec(cargoToml)?.[1];
    expect(cargoVersion).toBeDefined();
    expect(tauriConfig.version).toBe(packageJson.version);
    expect(cargoVersion).toBe(packageJson.version);
    expect(tauriConfig.version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u);
    expect(packageJson.version).toBe("0.1.4");
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""].version).toBe(packageJson.version);
    const cargoLockVersion = /^name = "modeleaf"\r?\nversion = "([^"]+)"$/mu.exec(cargoLock)?.[1];
    expect(cargoLockVersion).toBe(packageJson.version);
    expect(tauriConfig.identifier).toBe("com.dsargus.modeleaf");
  });

  it("ships neither repository signing credentials nor an automatic updater", () => {
    const raw = readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8");
    for (const forbidden of ["certificateThumbprint", "signCommand", "digestAlgorithm", "timestampUrl", "\"updater\"", "pubkey"]) {
      expect(raw, `${forbidden} must not be configured`).not.toContain(forbidden);
    }
  });
});
