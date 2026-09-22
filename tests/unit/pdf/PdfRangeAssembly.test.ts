import { describe, expect, it, vi } from "vitest";
vi.mock("pdfjs-dist", async () => vi.importActual("pdfjs-dist/legacy/build/pdf.mjs"));
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  PDF_ASSEMBLY_PHYSICAL_PART_BYTES,
  PdfRangeAssembly,
  PdfRangeAssemblyTransport,
  type PdfAssemblyBoundary,
  type PdfAssemblyReleaseProof,
} from "../../../src/pdf/PdfRangeAssembly";

const settle = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function boundary() {
  let nextLease = 1;
  const active = new Set<number>();
  const released: Array<{ leaseId: number; proof: string }> = [];
  const native: PdfAssemblyBoundary = {
    reserve: vi.fn(async (_sequence, begin, end) => {
      if (active.size !== 0) throw new Error("ACTIVE_ASSEMBLY");
      const leaseId = nextLease++;
      active.add(leaseId);
      return { leaseId, byteLength: end - begin };
    }),
    cancel: vi.fn(async () => undefined),
    release: vi.fn(async (leaseId, proof) => {
      active.delete(leaseId);
      released.push({ leaseId, proof });
    }),
    finish: vi.fn(async () => { active.clear(); }),
  };
  return { native, active, released };
}

function source(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = index % 251;
  return bytes;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/** Valid pinned PDF.js fixture: one raw 2048x2048 RGB image (~12MiB). */
function imagePdfFixture(): Uint8Array {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  const image = new Uint8Array(12 * 1024 * 1024);
  image.fill(32);
  const content = encode("q 2048 0 0 2048 0 0 cm /Im1 Do Q\n");
  const objects = [
    encode("<< /Type /Catalog /Pages 2 0 R >>"),
    encode("<< /Type /Pages /Count 1 /Kids [3 0 R] >>"),
    encode("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2048 2048] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>"),
    concatBytes([encode(`<< /Length ${content.byteLength} >>\nstream\n`), content, encode("endstream")]),
    concatBytes([encode(`<< /Type /XObject /Subtype /Image /Width 2048 /Height 2048 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.byteLength} >>\nstream\n`), image, encode("\nendstream")]),
  ];
  const chunks: Uint8Array[] = [encode("%PDF-1.7\n")];
  const offsets: number[] = [0];
  let size = chunks[0]!.byteLength;
  objects.forEach((object, index) => {
    offsets.push(size);
    const chunk = concatBytes([encode(`${index + 1} 0 obj\n`), object, encode("\nendobj\n")]);
    chunks.push(chunk);
    size += chunk.byteLength;
  });
  const xref = size;
  chunks.push(encode(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return concatBytes(chunks);
}

describe("PdfRangeAssembly", () => {
  it("assembles one exact logical reply from sequential physical parts", async () => {
    const bytes = source(PDF_ASSEMBLY_PHYSICAL_PART_BYTES * 2 + 17);
    const reads: Array<{ begin: number; end: number }> = [];
    const delivered: Array<{ begin: number; bytes: Uint8Array }> = [];
    const fake = boundary();
    const assembly = new PdfRangeAssembly({
      length: bytes.byteLength,
      boundary: fake.native,
      readPart: async (begin, end) => {
        reads.push({ begin, end });
        return bytes.slice(begin, end);
      },
      onDataRange: (begin, value) => delivered.push({ begin, bytes: value }),
    });

    assembly.requestDataRange(3, bytes.byteLength - 4);
    await settle();
    await Promise.all(assembly.settlements());

    expect(reads.every(({ begin, end }) => end - begin <= PDF_ASSEMBLY_PHYSICAL_PART_BYTES)).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.begin).toBe(3);
    expect(Buffer.compare(Buffer.from(delivered[0]!.bytes), Buffer.from(bytes.subarray(3, bytes.byteLength - 4)))).toBe(0);
    expect(fake.released).toEqual([]);

    await assembly.finishAfterPdfDestroy();
    expect(fake.released).toEqual([{ leaseId: 1, proof: "DISCARDED" }]);
    expect(fake.native.finish).toHaveBeenCalledOnce();
  });

  it("keeps adjacent and overlapping logical demands independent", async () => {
    const bytes = source(64);
    const delivered: Array<{ begin: number; bytes: Uint8Array }> = [];
    const fake = boundary();
    let assembly!: PdfRangeAssembly;
    assembly = new PdfRangeAssembly({
      length: bytes.byteLength,
      boundary: fake.native,
      readPart: async (begin, end) => bytes.slice(begin, end),
      onDataRange: (begin, value) => {
        delivered.push({ begin, bytes: value.slice() });
        structuredClone(value, { transfer: [value.buffer as ArrayBuffer] });
        assembly.notifyProgress();
      },
    });

    assembly.requestDataRange(0, 8);
    assembly.requestDataRange(8, 16);
    assembly.requestDataRange(4, 12);
    await settle();
    await settle();

    expect(delivered.map(({ begin, bytes: value }) => [begin, value.byteLength])).toEqual([
      [0, 8], [8, 8], [4, 8],
    ]);
    expect(fake.released.map(({ proof }) => proof)).toEqual(["TRANSFERRED", "TRANSFERRED", "TRANSFERRED"]);
    await assembly.finishAfterPdfDestroy();
  });

  it("caps a final logical demand at EOF", async () => {
    const bytes = source(32);
    const reads: Array<{ begin: number; end: number }> = [];
    const delivered: Array<{ begin: number; bytes: Uint8Array }> = [];
    const fake = boundary();
    const assembly = new PdfRangeAssembly({
      length: bytes.byteLength,
      boundary: fake.native,
      readPart: async (begin, end) => {
        reads.push({ begin, end });
        return bytes.slice(begin, end);
      },
      onDataRange: (begin, value) => delivered.push({ begin, bytes: value }),
    });

    assembly.requestDataRange(28, 100);
    await Promise.all(assembly.settlements());
    expect(reads).toEqual([{ begin: 28, end: 32 }]);
    expect(delivered).toEqual([{ begin: 28, bytes: bytes.slice(28) }]);
    await assembly.finishAfterPdfDestroy();
  });

  it("does not pump a reentrant demand until release acknowledgement", async () => {
    const bytes = source(32);
    const releaseGate = deferred<void>();
    const active = new Set<number>();
    let nextLease = 1;
    let reentered = false;
    let assembly!: PdfRangeAssembly;
    const reads: Array<{ begin: number; end: number }> = [];
    const native: PdfAssemblyBoundary = {
      reserve: vi.fn(async (_sequence, begin, end) => {
        const leaseId = nextLease++;
        active.add(leaseId);
        return { leaseId, byteLength: end - begin };
      }),
      cancel: vi.fn(async () => undefined),
      release: vi.fn(async (leaseId) => {
        if (!reentered) {
          reentered = true;
          assembly.requestDataRange(8, 16);
          await releaseGate.promise;
        }
        active.delete(leaseId);
      }),
      finish: vi.fn(async () => undefined),
    };
    assembly = new PdfRangeAssembly({
      length: bytes.byteLength,
      boundary: native,
      readPart: async (begin, end) => {
        reads.push({ begin, end });
        return bytes.slice(begin, end);
      },
      onDataRange: (_begin, value) => {
        structuredClone(value, { transfer: [value.buffer as ArrayBuffer] });
        assembly.notifyProgress();
      },
    });

    assembly.requestDataRange(0, 8);
    await settle();
    expect(reads).toEqual([{ begin: 0, end: 8 }]);
    expect(native.release).toHaveBeenCalledOnce();
    expect(reads).toEqual([{ begin: 0, end: 8 }]);
    releaseGate.resolve();
    await settle();
    await settle();
    expect(reads).toEqual([{ begin: 0, end: 8 }, { begin: 8, end: 16 }]);
    await assembly.finishAfterPdfDestroy();
  });

  it("surfaces a lost release acknowledgement and retries only during cleanup", async () => {
    const bytes = source(8);
    const failures: Error[] = [];
    let attempts = 0;
    const fake = boundary();
    fake.native.release = vi.fn(async (leaseId: number, proof: PdfAssemblyReleaseProof) => {
      attempts += 1;
      if (attempts === 1) throw new Error("release ack lost");
      fake.active.delete(leaseId);
      fake.released.push({ leaseId, proof });
    });
    const assembly = new PdfRangeAssembly({
      length: bytes.byteLength,
      boundary: fake.native,
      readPart: async (begin, end) => bytes.slice(begin, end),
      onDataRange: (_begin, value) => structuredClone(value, { transfer: [value.buffer as ArrayBuffer] }),
      onFailure: (error) => failures.push(error),
    });

    assembly.requestDataRange(0, 8);
    await Promise.all(assembly.settlements());
    expect(attempts).toBe(0);
    assembly.notifyProgress();
    await settle();
    expect(attempts).toBe(1);
    expect(failures).toHaveLength(1);
    await assembly.finishAfterPdfDestroy();
    expect(attempts).toBe(2);
    expect(fake.native.finish).toHaveBeenCalledOnce();
  });

  it("releases a late grant as UNALLOCATED after abort before allocation", async () => {
    const grant = deferred<{ readonly leaseId: number; readonly byteLength: number }>();
    const fake = boundary();
    fake.native.reserve = vi.fn(() => grant.promise);
    const assembly = new PdfRangeAssembly({
      length: 8,
      boundary: fake.native,
      readPart: async (begin, end) => source(end - begin),
      onDataRange: vi.fn(),
    });

    assembly.requestDataRange(0, 8);
    await settle();
    assembly.abort();
    grant.resolve({ leaseId: 1, byteLength: 8 });
    await Promise.all(assembly.settlements());
    expect(fake.released).toEqual([{ leaseId: 1, proof: "UNALLOCATED" }]);
    await assembly.finishAfterPdfDestroy();
  });

  it("probes pinned PDF.js with a real 12MiB RGB image and exact one-buffer replies", async () => {
    const fixture = imagePdfFixture();
    const fake = boundary();
    const handoffs: Uint8Array[] = [];
    const physicalReads: Array<{ begin: number; end: number }> = [];
    class ObservedTransport extends PdfRangeAssemblyTransport {
      public override onDataRange(begin: number, value: Uint8Array): void {
        handoffs.push(value);
        super.onDataRange(begin, value);
      }
    }
    const transport = new ObservedTransport({
      length: fixture.byteLength,
      boundary: fake.native,
      readPart: async (begin, end) => {
        physicalReads.push({ begin, end });
        return fixture.slice(begin, end);
      },
    });
    const loading = getDocument({
      range: transport,
      rangeChunkSize: 1024 * 1024,
      disableRange: false,
      disableStream: true,
      disableAutoFetch: true,
      useSystemFonts: false,
      disableFontFace: true,
    });
    const priorProgress = vi.fn();
    const wrapper = (progress: { loaded: number; total: number; percent?: number }): void => {
      try { priorProgress(progress); }
      finally { transport.notifyProgress(); }
    };
    loading.onProgress = wrapper;
    try {
      const document = await loading.promise;
      const page = await document.getPage(1);
      const operatorList = await page.getOperatorList();
      expect(operatorList.fnArray.length).toBeGreaterThan(0);
      expect(physicalReads.every(({ begin, end }) => end - begin <= PDF_ASSEMBLY_PHYSICAL_PART_BYTES)).toBe(true);
      expect(handoffs.length).toBeGreaterThan(0);
      expect(handoffs.some((value) => value.byteLength === 0 && value.buffer.byteLength === 0)).toBe(true);
      expect(fake.released.some(({ proof }) => proof === "TRANSFERRED")).toBe(true);
      expect(priorProgress).toHaveBeenCalled();
    } finally {
      await loading.destroy();
      await transport.finishAfterPdfDestroy();
      if (loading.onProgress === wrapper) loading.onProgress = priorProgress;
    }
  });

  it("cancels an active physical read and discards its untransferred allocation", async () => {
    const fake = boundary();
    const assembly = new PdfRangeAssembly({
      length: 32,
      boundary: fake.native,
      readPart: async (_begin, _end, signal) => await new Promise<Uint8Array>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
      onDataRange: vi.fn(),
    });

    assembly.requestDataRange(0, 32);
    await settle();
    assembly.abort();
    await Promise.all(assembly.settlements());
    expect(fake.native.cancel).toHaveBeenCalledOnce();
    expect(fake.released).toEqual([{ leaseId: 1, proof: "DISCARDED" }]);
    await assembly.finishAfterPdfDestroy();
  });
});
