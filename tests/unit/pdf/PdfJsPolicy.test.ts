import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import {
  PDFJS_POLICY,
  PDFJS_VERSION,
  requirePdfJsAsset,
  validatePdfJsAssetManifest,
  type PdfJsAssetKind,
  type PdfJsAssetManifest,
} from "../../../src/pdf/PdfJsPolicy";

const asset = (kind: PdfJsAssetKind, path: string) => ({
  kind,
  path: `./assets/pdfjs-${PDFJS_VERSION}/${path}`,
  byteLength: 1,
  sha256: "a".repeat(64),
});

const manifest: PdfJsAssetManifest = {
  pdfjsVersion: PDFJS_VERSION,
  assets: [
    asset("worker", "build/pdf.worker.min.mjs"),
    asset("core", "build/pdf.mjs"),
    asset("viewer", "web/pdf_viewer.mjs"),
    asset("viewerCss", "web/pdf_viewer.css"),
    asset("cMaps", "cmaps/Adobe-Japan1-UCS2.bcmap"),
    asset("cMaps", "cmaps/UniJIS-UTF16-H.bcmap"),
    asset("standardFonts", "standard_fonts/FoxitSans.pfb"),
    asset("standardFonts", "standard_fonts/FoxitSerif.pfb"),
    asset("wasm", "wasm/openjpeg.wasm"),
    asset("wasm", "wasm/qcms_bg.wasm"),
    asset("icc", "iccs/CGATS001Compat-v2-micro.icc"),
  ],
};

describe("PDF.js policy", () => {
  it("snapshots the exact pinned loading and local asset policy", () => {
    expect(PDFJS_POLICY).toMatchInlineSnapshot(`
      {
        "assets": {
          "cMapPacked": true,
          "cMapUrl": "./assets/pdfjs-6.2.108/cmaps/",
          "coreSrc": "./assets/pdfjs-6.2.108/build/pdf.mjs",
          "iccUrl": "./assets/pdfjs-6.2.108/iccs/",
          "standardFontDataUrl": "./assets/pdfjs-6.2.108/standard_fonts/",
          "viewerCssSrc": "./assets/pdfjs-6.2.108/web/pdf_viewer.css",
          "viewerSrc": "./assets/pdfjs-6.2.108/web/pdf_viewer.mjs",
          "wasmUrl": "./assets/pdfjs-6.2.108/wasm/",
          "workerSrc": "./assets/pdfjs-6.2.108/build/pdf.worker.min.mjs",
        },
        "getDocument": {
          "canvasMaxAreaInBytes": 268435456,
          "disableAutoFetch": true,
          "disableRange": false,
          "disableStream": true,
          "docBaseUrl": undefined,
          "enableHWA": false,
          "enableXfa": false,
          "httpHeaders": undefined,
          "isEvalSupported": false,
          "maxImageSize": 25000000,
          "rangeChunkSize": 1048576,
          "url": undefined,
          "useWasm": true,
          "useWorkerFetch": false,
          "withCredentials": false,
        },
        "pdfjsVersion": "6.2.108",
        "viewer": {
          "annotationMode": "disabled",
          "autoLinking": "disabled",
          "download": "disabled",
          "editors": "disabled",
          "externalLinkService": "disabled",
          "forms": "disabled",
          "newWindow": "disabled",
          "print": "disabled",
          "scripting": "disabled",
        },
      }
    `);
  });

  it("allows only packaged and custom PDF origins through the Tauri CSP", () => {
    const config = JSON.parse(readFileSync(new URL("../../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
    const csp = config.app.security.csp as string;
    const connectSources = csp.match(/(?:^|; )connect-src ([^;]+)/)?.[1]?.split(/\s+/);
    expect(connectSources).toEqual(["'self'", "ipc:", "http://ipc.localhost", "http://modeleaf-pdf.localhost"]);
  });

  it("validates the complete generated 6.2.108 asset inventory", () => {
    const generated = JSON.parse(readFileSync(new URL(
      `../../../public/assets/pdfjs-${PDFJS_VERSION}/pdfjs-assets-${PDFJS_VERSION}.json`,
      import.meta.url,
    ), "utf8")) as PdfJsAssetManifest;
    expect(() => validatePdfJsAssetManifest(generated)).not.toThrow();
    const root = fileURLToPath(new URL(`../../../public/assets/pdfjs-${PDFJS_VERSION}/`, import.meta.url));
    const physical: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.name !== `pdfjs-assets-${PDFJS_VERSION}.json`) {
          physical.push(relative(root, absolute).replaceAll("\\", "/"));
        }
      }
    };
    visit(root);
    const prefix = `./assets/pdfjs-${PDFJS_VERSION}/`;
    expect(physical.sort()).toEqual(generated.assets.map((entry) => entry.path.slice(prefix.length)).sort());
    for (const entry of generated.assets) {
      const bytes = readFileSync(join(root, entry.path.slice(prefix.length)));
      expect(bytes.byteLength, entry.path).toBe(entry.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex"), entry.path).toBe(entry.sha256);
    }
    expect(Object.fromEntries([...new Set(generated.assets.map((entry) => entry.kind))]
      .map((kind) => [kind, generated.assets.filter((entry) => entry.kind === kind).length])))
      .toEqual({ core: 1, worker: 1, cMaps: 169, icc: 2, standardFonts: 16, wasm: 13, viewerCss: 1, viewer: 1 });
  });
  it("accepts multiple runtime files for each directory kind", () => {
    expect(() => validatePdfJsAssetManifest(manifest)).not.toThrow();
    expect(requirePdfJsAsset(manifest, `./assets/pdfjs-${PDFJS_VERSION}/cmaps/UniJIS-UTF16-H.bcmap`).kind).toBe("cMaps");
  });

  it("rejects invalid manifests and every unlisted runtime file", () => {
    expect(() => validatePdfJsAssetManifest({ ...manifest, pdfjsVersion: "6.2.107" as unknown as typeof PDFJS_VERSION })).toThrow("version mismatch");
    expect(() => validatePdfJsAssetManifest({ ...manifest, assets: manifest.assets.filter((entry) => entry.kind !== "wasm") })).toThrow("missing");
    expect(() => validatePdfJsAssetManifest({ ...manifest, assets: [...manifest.assets, { ...manifest.assets[0]! }] })).toThrow("duplicate");
    expect(() => validatePdfJsAssetManifest({ ...manifest, assets: [{ ...manifest.assets[0]!, path: `./assets/pdfjs-${PDFJS_VERSION}/cmaps/fake.bcmap` }, ...manifest.assets.slice(1)] })).toThrow("invalid");
    expect(() => validatePdfJsAssetManifest({ ...manifest, assets: [{ ...manifest.assets[0]!, path: "https://cdn.invalid/worker.mjs" }, ...manifest.assets.slice(1)] })).toThrow("invalid");
    expect(() => validatePdfJsAssetManifest({ ...manifest, assets: [{ ...manifest.assets[0]!, path: `./assets/pdfjs-${PDFJS_VERSION}/cmaps/../worker.mjs` }, ...manifest.assets.slice(1)] })).toThrow("invalid");
    expect(() => requirePdfJsAsset(manifest, `./assets/pdfjs-${PDFJS_VERSION}/cmaps/not-listed.bcmap`)).toThrow("not listed");
  });
});
