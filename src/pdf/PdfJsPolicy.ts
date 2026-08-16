export const PDFJS_VERSION = "6.2.108" as const;

export type PdfJsAssetKind =
  | "worker"
  | "core"
  | "viewer"
  | "viewerCss"
  | "cMaps"
  | "standardFonts"
  | "wasm"
  | "icc";

export interface PdfJsAssetRecord {
  readonly kind: PdfJsAssetKind;
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface PdfJsAssetManifest {
  readonly pdfjsVersion: typeof PDFJS_VERSION;
  readonly assets: readonly PdfJsAssetRecord[];
}

export type PdfJsPolicyTag = "ASSET_MISSING" | "ASSET_MANIFEST_INVALID" | "ASSET_UNLISTED";

export class PdfJsPolicyError extends Error {
  public constructor(public readonly tag: PdfJsPolicyTag, message: string) {
    super(message);
    this.name = "PdfJsPolicyError";
  }
}

const assetUrl = (name: string): string => `./assets/pdfjs-${PDFJS_VERSION}/${name}`;

/** Frozen inputs for PDF.js 6.2.108. Only a range transport may supply document bytes. */
export const PDFJS_POLICY = Object.freeze({
  pdfjsVersion: PDFJS_VERSION,
  getDocument: Object.freeze({
    rangeChunkSize: 1_048_576,
    disableRange: false,
    disableStream: true,
    disableAutoFetch: true,
    isEvalSupported: false,
    enableXfa: false,
    enableHWA: false,
    useWasm: true,
    useWorkerFetch: false,
    maxImageSize: 25_000_000,
    canvasMaxAreaInBytes: 268_435_456,
    docBaseUrl: undefined,
    withCredentials: false,
    httpHeaders: undefined,
    url: undefined,
  }),
  assets: Object.freeze({
    workerSrc: assetUrl("build/pdf.worker.min.mjs"),
    coreSrc: assetUrl("build/pdf.mjs"),
    viewerSrc: assetUrl("web/pdf_viewer.mjs"),
    viewerCssSrc: assetUrl("web/pdf_viewer.css"),
    cMapUrl: assetUrl("cmaps/"),
    standardFontDataUrl: assetUrl("standard_fonts/"),
    wasmUrl: assetUrl("wasm/"),
    iccUrl: assetUrl("iccs/"),
    cMapPacked: true,
  }),
  viewer: Object.freeze({
    annotationMode: "disabled",
    forms: "disabled",
    scripting: "disabled",
    editors: "disabled",
    autoLinking: "disabled",
    externalLinkService: "disabled",
    download: "disabled",
    print: "disabled",
    newWindow: "disabled",
  }),
});

export const REQUIRED_PDFJS_ASSET_KINDS: readonly PdfJsAssetKind[] = Object.freeze([
  "worker", "core", "viewer", "viewerCss", "cMaps", "standardFonts", "wasm", "icc",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const ASSET_PREFIX = `./assets/pdfjs-${PDFJS_VERSION}/`;
const ASSET_PATH_CHARS = /^[A-Za-z0-9._/-]+$/;

const EXACT_ASSET_PATHS: Partial<Record<PdfJsAssetKind, string>> = Object.freeze({
  worker: assetUrl("build/pdf.worker.min.mjs"),
  core: assetUrl("build/pdf.mjs"),
  viewer: assetUrl("web/pdf_viewer.mjs"),
  viewerCss: assetUrl("web/pdf_viewer.css"),
});
const DIRECTORY_ASSET_PREFIXES: Partial<Record<PdfJsAssetKind, string>> = Object.freeze({
  cMaps: assetUrl("cmaps/"),
  standardFonts: assetUrl("standard_fonts/"),
  wasm: assetUrl("wasm/"),
  icc: assetUrl("iccs/"),
});

function isPathBoundToKind(asset: PdfJsAssetRecord): boolean {
  const exact = EXACT_ASSET_PATHS[asset.kind];
  if (exact !== undefined) return asset.path === exact;
  const prefix = DIRECTORY_ASSET_PREFIXES[asset.kind];
  return prefix !== undefined && asset.path.startsWith(prefix) && asset.path.length > prefix.length;
}
function isExactLocalAssetPath(path: string): boolean {
  if (!path.startsWith(ASSET_PREFIX)) return false;
  const relativePath = path.slice(ASSET_PREFIX.length);
  return relativePath.length > 0
    && ASSET_PATH_CHARS.test(relativePath)
    && relativePath.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Rejects malformed, version-mismatched, incomplete, or duplicate-file manifests. */
export function validatePdfJsAssetManifest(manifest: PdfJsAssetManifest): void {
  if (manifest.pdfjsVersion !== PDFJS_VERSION) {
    throw new PdfJsPolicyError("ASSET_MANIFEST_INVALID", "PDF.js asset manifest version mismatch");
  }

  const listedPaths = new Set<string>();
  const listedKinds = new Set<PdfJsAssetKind>();
  for (const asset of manifest.assets) {
    if (!REQUIRED_PDFJS_ASSET_KINDS.includes(asset.kind) || listedPaths.has(asset.path)) {
      throw new PdfJsPolicyError("ASSET_MANIFEST_INVALID", "Asset kind is unsupported or file path is duplicate");
    }
    if (!isExactLocalAssetPath(asset.path) || !isPathBoundToKind(asset) || !Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0 || !SHA256.test(asset.sha256)) {
      throw new PdfJsPolicyError("ASSET_MANIFEST_INVALID", "Asset metadata is invalid");
    }
    listedPaths.add(asset.path);
    listedKinds.add(asset.kind);
  }
  for (const [kind, path] of Object.entries(EXACT_ASSET_PATHS)) {
    if (manifest.assets.filter((asset) => asset.kind === kind && asset.path === path).length !== 1) {
      throw new PdfJsPolicyError("ASSET_MISSING", "Required fixed PDF.js asset is missing");
    }
  }
  if (REQUIRED_PDFJS_ASSET_KINDS.some((kind) => !listedKinds.has(kind))) {
    throw new PdfJsPolicyError("ASSET_MISSING", "Required PDF.js asset is missing");
  }
}

/** Resolves only an exact, manifest-listed packaged file; there is no URL fallback. */
export function requirePdfJsAsset(manifest: PdfJsAssetManifest, path: string): PdfJsAssetRecord {
  validatePdfJsAssetManifest(manifest);
  const asset = manifest.assets.find((candidate) => candidate.path === path);
  if (asset === undefined) {
    throw new PdfJsPolicyError("ASSET_UNLISTED", "Runtime PDF.js asset is not listed");
  }
  return asset;
}
