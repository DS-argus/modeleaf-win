import Ajv2020 from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { join, relative } from "node:path";

interface EvidenceRecord {
  readonly recordType: string;
  readonly result: "pass" | "fail";
  readonly app: { readonly sourceTreeSha256: string; readonly binarySha256: string };
  readonly recordId: string;
  readonly fixture: { readonly id: string; readonly sha256: string; readonly bytes: number };
  readonly sourceHashes: { readonly before: string; readonly after: string };
  readonly artifactRefs: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
  readonly details: Record<string, unknown>;
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const evidenceRoot = fileURLToPath(new URL("../../docs/evidence/w02/", import.meta.url));
const recordsRoot = fileURLToPath(new URL("../../docs/evidence/w02/records/", import.meta.url));
const schema = JSON.parse(readFileSync(new URL("../../docs/evidence/w02/evidence-record.schema.json", import.meta.url), "utf8")) as object;
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const recordNames = [
  "capability.json",
  "geometry.json",
  "outline.json",
  "print.json",
  "resource.json",
  "transport.json",
];

const expectedRecords = [
  ["capability.json", "w02-capability", "capability", "artifacts/capabilities.json"],
  ["geometry.json", "w02-geometry", "geometry", "artifacts/geometry.json"],
  ["outline.json", "w02-outline", "outline", "artifacts/outline.json"],
  ["print.json", "w02-print", "print", "artifacts/print.json"],
  ["resource.json", "w02-resource", "resource", "artifacts/resources.json"],
  ["transport.json", "w02-transport", "transport", "artifacts/transport.json"],
] as const;

interface ArtifactFixtureRef {
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly beforeSha256: string;
  readonly afterSha256: string;
}
const records = (): EvidenceRecord[] => recordNames.map((name) =>
  JSON.parse(readFileSync(`${recordsRoot}${name}`, "utf8")) as EvidenceRecord);

describe("W02 evidence contract", () => {
  it("validates every mandatory hard-gate record against the canonical discriminated schema", () => {
    expect(readdirSync(recordsRoot).filter((name) => name.endsWith(".json")).sort()).toEqual(recordNames);
    const loaded = records();
    expect(loaded.map((record, index) => [
      recordNames[index],
      record.recordId,
      record.recordType,
      record.artifactRefs[0]?.path,
    ])).toEqual(expectedRecords);
    expect(new Set(loaded.map((record) => record.recordId)).size).toBe(expectedRecords.length);
    expect(new Set(loaded.map((record) => record.recordType)).size).toBe(expectedRecords.length);
    expect(loaded.every((record) => record.result === "pass")).toBe(true);
    const expectedGeometryKeys = new Set(
      [1, 1.25, 1.5, 2].flatMap((dpr) => [0, 90, 180, 270].map((rotation) => `${dpr}:${rotation}`)),
    );
    const geometry = loaded.find((record) => record.recordType === "geometry")!;
    const geometryCases = geometry.details.cases as { readonly dpr: number; readonly rotation: number }[];
    expect(new Set(geometryCases.map(({ dpr, rotation }) => `${dpr}:${rotation}`))).toEqual(expectedGeometryKeys);
    const geometryArtifact = JSON.parse(readFileSync(`${evidenceRoot}artifacts/geometry.json`, "utf8")) as {
      readonly cases: readonly { readonly dpr: number; readonly rotation: number; readonly maxLayerEdgeDeltaCssPx: number }[];
      readonly thresholdCssPx: number;
      readonly maximumDeltaCssPx: number;
      readonly allLinkOverlaysInsideFrame: boolean;
      readonly allTextSpansInsideFrame: boolean;
    };
    expect(new Set(geometryArtifact.cases.map(({ dpr, rotation }) => `${dpr}:${rotation}`))).toEqual(expectedGeometryKeys);
    expect(geometryArtifact.cases).toEqual(geometryCases);
    expect(geometryArtifact.thresholdCssPx).toBe(1);
    expect(geometryArtifact.maximumDeltaCssPx).toBeLessThanOrEqual(1);
    expect(geometryArtifact.cases.every((entry) => entry.maxLayerEdgeDeltaCssPx <= 1)).toBe(true);
    expect(geometryArtifact.allLinkOverlaysInsideFrame).toBe(true);
    expect(geometryArtifact.allTextSpansInsideFrame).toBe(true);
    const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
    for (const record of records()) {
      expect(validate(record), `${record.recordId}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("binds every record to immutable fixture bytes and checksummed evidence artifacts", () => {
    for (const record of records()) {
      const fixturePath = `${root}fixtures/pdf/${record.fixture.id}`;
      const fixtureBytes = readFileSync(fixturePath);
      expect(fixtureBytes.byteLength, record.recordId).toBe(record.fixture.bytes);
      expect(sha256(fixtureBytes), record.recordId).toBe(record.fixture.sha256);
      expect(record.sourceHashes).toEqual({ before: record.fixture.sha256, after: record.fixture.sha256 });

      for (const reference of record.artifactRefs) {
        const artifactPath = `${evidenceRoot}${reference.path}`;
        const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { readonly fixtureRefs?: readonly ArtifactFixtureRef[] };
        expect(artifact.fixtureRefs?.length, reference.path).toBeGreaterThan(0);
        expect(artifact.fixtureRefs?.some((fixture) => fixture.id === record.fixture.id), reference.path).toBe(true);
        for (const fixture of artifact.fixtureRefs ?? []) {
          const bytes = readFileSync(`${root}fixtures/pdf/${fixture.id}`);
          expect(bytes.byteLength, `${reference.path}:${fixture.id}`).toBe(fixture.bytes);
          expect(sha256(bytes), `${reference.path}:${fixture.id}`).toBe(fixture.sha256);
          expect(fixture.beforeSha256, fixture.id).toBe(fixture.sha256);
          expect(fixture.afterSha256, fixture.id).toBe(fixture.sha256);
        }
        const artifactBytes = readFileSync(artifactPath);
        expect(statSync(artifactPath).isFile()).toBe(true);
        expect(artifactBytes.byteLength, reference.path).toBe(reference.bytes);
        expect(sha256(artifactBytes), reference.path).toBe(reference.sha256);
      }
    }
  });

  it("recomputes the documented source tree and verifies the retained packaged binary", () => {
    const sourceFiles: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else sourceFiles.push(absolute);
      }
    };
    visit(join(root, "src"));
    visit(join(root, "src-tauri", "src"));
    sourceFiles.push(
      join(root, "package.json"),
      join(root, "package-lock.json"),
      join(root, "src-tauri", "tauri.conf.json"),
      join(root, "public", "assets", "pdfjs-6.2.108", "pdfjs-assets-6.2.108.json"),
    );
    sourceFiles.sort((left, right) => relative(root, left).replaceAll("\\", "/")
      .localeCompare(relative(root, right).replaceAll("\\", "/")));
    const digest = createHash("sha256");
    for (const file of sourceFiles) {
      digest.update(relative(root, file).replaceAll("\\", "/"));
      digest.update(Buffer.from([0]));
      digest.update(readFileSync(file));
      digest.update(Buffer.from([0]));
    }
    const expectedSource = records()[0]!.app.sourceTreeSha256;
    expect(digest.digest("hex")).toBe(expectedSource);
    expect(records().every((record) => record.app.sourceTreeSha256 === expectedSource)).toBe(true);

    const binary = join(root, "src-tauri", "target", "debug", "modeleaf.exe");
    if (existsSync(binary)) {
      const expectedBinary = records()[0]!.app.binarySha256;
      expect(sha256(readFileSync(binary))).toBe(expectedBinary);
      expect(records().every((record) => record.app.binarySha256 === expectedBinary)).toBe(true);
    }
  });
  it("keeps decoded evidence values path-free and credential-free", () => {
    const prohibited: string[] = [];
    const scan = (value: unknown, location: string): void => {
      if (typeof value === "string") {
        if (/^(?:[A-Za-z]:[\\/]|\\\\)|\/Users\//u.test(value)) prohibited.push(`${location}=${value}`);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => scan(entry, `${location}[${index}]`));
        return;
      }
      if (typeof value !== "object" || value === null) return;
      for (const [key, entry] of Object.entries(value)) {
        if (/^(?:password|credential|sourcePath|filesystemPath)$/iu.test(key)) prohibited.push(`${location}.${key}`);
        scan(entry, `${location}.${key}`);
      }
    };
    for (const [index, record] of records().entries()) {
      scan(record, `records[${index}]`);
      for (const reference of record.artifactRefs) {
        scan(JSON.parse(readFileSync(`${evidenceRoot}${reference.path}`, "utf8")), reference.path);
      }
    }
    expect(prohibited).toEqual([]);
  });
});
