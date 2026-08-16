import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAdversarialPdfs, generateAdversarialPdfs } from "../../../tools/fixtures/generate-adversarial-pdfs.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const padding = Buffer.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);
function rc4(key: Buffer, input: Buffer): Buffer {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let index = 0; index < 256; index += 1) {
    const stateValue = state[index]!;
    const keyValue = key[index % key.length]!;
    j = (j + stateValue + keyValue) & 255;
    [state[index], state[j]] = [state[j]!, stateValue];
  }

  const output = Buffer.alloc(input.length);
  let i = 0;
  j = 0;
  for (let index = 0; index < input.length; index += 1) {
    i = (i + 1) & 255;
    j = (j + state[i]!) & 255;
    const stateValue = state[i]!;
    [state[i], state[j]] = [state[j]!, stateValue];
    output[index] = input[index]! ^ state[(state[i]! + state[j]!) & 255]!;
  }
  return output;
}

function padded(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, "latin1"), padding]).subarray(0, 32);
}
describe("adversarial PDF fixtures", () => {
  it("is byte-stable, accurately manifested, and structurally classified", async () => {
    const first = await mkdtemp(join(process.cwd(), "fixtures", ".adversarial-fixture-"));
    const second = await mkdtemp(join(process.cwd(), "fixtures", ".adversarial-fixture-"));
    try {
      const firstDirectory = join(first, "output"); const secondDirectory = join(second, "output");
      const one = await generateAdversarialPdfs({ outputDirectory: firstDirectory, manifestPath: join(first, "manifest.json") });
      const two = await generateAdversarialPdfs({ outputDirectory: secondDirectory, manifestPath: join(second, "manifest.json") });
      const committed = JSON.parse(await readFile(join(process.cwd(), "fixtures", "adversarial-pdfs.manifest.json"), "utf8"));
      expect(two).toEqual(one); expect(one).toEqual(committed); expect(one.generatorSha256).toMatch(/^[a-f0-9]{64}$/); expect(Object.keys(one)).not.toContain("password");
      for (const entry of one.outputs) {
        const firstBytes = await readFile(join(firstDirectory, entry.name)); const secondBytes = await readFile(join(secondDirectory, entry.name));
        expect(firstBytes.equals(secondBytes)).toBe(true); expect(hash(firstBytes)).toBe(entry.sha256); expect(firstBytes.subarray(0, 8).toString("ascii")).toBe("%PDF-1.4");
      }
      const fixtures = createAdversarialPdfs();
      expect(one.outputs.map((entry) => entry.name)).toEqual([...fixtures.keys()]);
      const read = async (name: string) => (await readFile(join(firstDirectory, name))).toString("latin1");
      expect(await read("malformed-truncated-xref.pdf")).not.toContain("%%EOF");
      expect(await read("empty-zero-pages.pdf")).toContain("/Count 0");
      expect(await read("huge-page-canvas-limit.pdf")).toContain("/MediaBox [0 0 20000 20000]");
      expect(await read("no-text-image-only.pdf")).toContain("/Subtype /Image");
      expect(await read("links-allowed-and-forbidden.pdf")).toContain("https://example.invalid/allowed");
      expect(await read("links-allowed-and-forbidden.pdf")).toContain("file:///C:/forbidden");
      expect((await readFile(join(firstDirectory, "slow-cancel-range.pdf"))).length).toBeGreaterThan(1024 * 1024);
      const protectedPdf = await readFile(join(firstDirectory, "password-user-modeleaf.pdf")); const protectedText = protectedPdf.toString("latin1");
      expect(protectedText).toContain("/Filter /Standard /V 1 /R 2"); expect(protectedText).not.toContain("Password protected fixture");
      const owner = Buffer.from(/\/O <([a-f0-9]{64})>/.exec(protectedText)?.[1] ?? "", "hex");
      const user = Buffer.from(/\/U <([a-f0-9]{64})>/.exec(protectedText)?.[1] ?? "", "hex");
      const id = Buffer.from(/\/ID \[<([a-f0-9]{32})>/.exec(protectedText)?.[1] ?? "", "hex");
      const key = createHash("md5").update(Buffer.concat([padded("modeleaf"), owner, Buffer.from([0xfc, 0xff, 0xff, 0xff]), id])).digest().subarray(0, 5);
      expect(owner).toHaveLength(32); expect(user).toHaveLength(32); expect(rc4(key, padding).equals(user)).toBe(true);
      let passwordAttempt = 0;
      const loadingTask = getDocument({
        data: new Uint8Array(protectedPdf),
        isEvalSupported: false,
        useWorkerFetch: false,
      } as never);
      loadingTask.onPassword = (updatePassword: (password: string) => void) => {
        updatePassword(passwordAttempt++ === 0 ? "incorrect" : "modeleaf");
      };
      const protectedDocument = await loadingTask.promise;
      expect(protectedDocument.numPages).toBe(1);
      expect(passwordAttempt).toBe(2);
      await loadingTask.destroy();
    } finally { await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); }
  });
});
