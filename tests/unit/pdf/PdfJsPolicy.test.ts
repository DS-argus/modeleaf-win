import { describe, expect, it } from "vitest";
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
          "cMapUrl": "./assets/pdfjs-5.7.284/cmaps/",
          "coreSrc": "./assets/pdfjs-5.7.284/build/pdf.mjs",
          "iccUrl": "./assets/pdfjs-5.7.284/iccs/",
          "standardFontDataUrl": "./assets/pdfjs-5.7.284/standard_fonts/",
          "viewerCssSrc": "./assets/pdfjs-5.7.284/web/pdf_viewer.css",
          "viewerSrc": "./assets/pdfjs-5.7.284/web/pdf_viewer.mjs",
          "wasmUrl": "./assets/pdfjs-5.7.284/wasm/",
          "workerSrc": "./assets/pdfjs-5.7.284/build/pdf.worker.min.mjs",
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
        "pdfjsVersion": "5.7.284",
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

  it("accepts multiple runtime files for each directory kind", () => {
    expect(() => validatePdfJsAssetManifest(manifest)).not.toThrow();
    expect(requirePdfJsAsset(manifest, `./assets/pdfjs-${PDFJS_VERSION}/cmaps/UniJIS-UTF16-H.bcmap`).kind).toBe("cMaps");
  });

  it("rejects invalid manifests and every unlisted runtime file", () => {
    expect(() => validatePdfJsAssetManifest({ ...manifest, pdfjsVersion: "5.7.283" as unknown as typeof PDFJS_VERSION })).toThrow("version mismatch");
    expect(() => validatePdfJsAssetManifest({ ...manifest, assets: manifest.assets.filter((entry) => entry.kind !== "wasm") })).toThrow("missing");
    expect(() => validatePdfJsAssetManifest({ ...manifest, assets: [...manifest.assets, { ...manifest.assets[0]! }] })).toThrow("duplicate");
    expect(() => validatePdfJsAssetManifest({ ...manifest, assets: [{ ...manifest.assets[0]!, path: "https://cdn.invalid/worker.mjs" }, ...manifest.assets.slice(1)] })).toThrow("invalid");
    expect(() => validatePdfJsAssetManifest({ ...manifest, assets: [{ ...manifest.assets[0]!, path: `./assets/pdfjs-${PDFJS_VERSION}/cmaps/../worker.mjs` }, ...manifest.assets.slice(1)] })).toThrow("invalid");
    expect(() => requirePdfJsAsset(manifest, `./assets/pdfjs-${PDFJS_VERSION}/cmaps/not-listed.bcmap`)).toThrow("not listed");
  });
});
