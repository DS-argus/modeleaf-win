import { PdfFailureError } from "../core/PdfFailureDiagnostic";
import { PDFDataRangeTransport } from "pdfjs-dist";

/** Additional process-wide assembly credit, distinct from the document limit. */
export const PDF_ASSEMBLY_MAX_BYTES = 512 * 1024 * 1024;
export const PDF_ASSEMBLY_PHYSICAL_PART_BYTES = 4 * 1024 * 1024;
export const PDF_ASSEMBLY_DESCRIPTOR_LIMIT = 512;

export type PdfAssemblyReleaseProof = "UNALLOCATED" | "DISCARDED" | "TRANSFERRED";

export interface PdfAssemblyBoundary {
  reserve(requestSequence: number, begin: number, end: number): Promise<{ readonly leaseId: number; readonly byteLength: number }>;
  cancel(requestSequence: number): Promise<void>;
  release(leaseId: number, proof: PdfAssemblyReleaseProof): Promise<void>;
  finish(): Promise<void>;
}

export type PdfAssemblyPartReader = (begin: number, end: number, signal: AbortSignal) => Promise<Uint8Array>;

export interface PdfRangeAssemblyOptions {
  readonly length: number;
  readonly boundary: PdfAssemblyBoundary;
  readonly readPart: PdfAssemblyPartReader;
  readonly onDataRange: (begin: number, bytes: Uint8Array) => void;
  readonly onFailure?: (error: Error) => void;
}

type Descriptor = {
  readonly requestSequence: number;
  readonly begin: number;
  readonly end: number;
};

type ActiveAssembly = {
  readonly descriptor: Descriptor;
  readonly abort: AbortController;
  settlement?: Promise<void>;
  leaseId?: number;
  bytes?: Uint8Array;
  handoffAttempted: boolean;
  handoffPending: boolean;
  cancelled: boolean;
  releaseTarget?: PdfAssemblyReleaseProof;
  releaseCompletedProof?: PdfAssemblyReleaseProof;
  releaseInFlight?: Promise<void>;
  releaseError?: unknown;
};

const finiteFailure = (code: "PDF_CANCELLED" | "PDF_RANGE_FETCH" | "PDF_RANGE_BODY" | "PDF_RANGE_LENGTH" | "PDF_RESOURCE_LIMIT"): PdfFailureError =>
  new PdfFailureError({ code });
const asError = (error: unknown, fallback: "PDF_RANGE_FETCH" | "PDF_RESOURCE_LIMIT"): Error => {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null && "tag" in error && typeof error.tag === "string") {
    const tagged = new Error(error.tag);
    Object.defineProperty(tagged, "tag", { value: error.tag, enumerable: true });
    return tagged;
  }
  return finiteFailure(fallback);
};
const isAbortError = (error: unknown): boolean => (typeof DOMException !== "undefined" && error instanceof DOMException)
  ? error.name === "AbortError"
  : error instanceof Error && /abort|cancel/i.test(error.message);

/**
 * Bounded exact logical range assembly for PDF.js.
 *
 * The two fixed descriptor arrays retain only original logical begin/end pairs.
 * A logical request receives one exact whole-buffer response; physical reads are
 * sequential implementation details and are never exposed as reader fragments.
 */
export class PdfRangeAssembly {
  private readonly begins = new Uint32Array(PDF_ASSEMBLY_DESCRIPTOR_LIMIT);
  private readonly ends = new Uint32Array(PDF_ASSEMBLY_DESCRIPTOR_LIMIT);
  private queueHead = 0;
  private queueTail = 0;
  private queueCount = 0;
  private nextRequestSequence = 1;
  private active: ActiveAssembly | undefined;
  private readonly pumping = new Set<Promise<void>>();
  private stopped = false;
  private finished = false;
  private failureReported = false;
  private finishPromise: Promise<void> | undefined;
  private cancellation: Promise<void> | undefined;

  public constructor(private readonly options: PdfRangeAssemblyOptions) {
    if (!Number.isSafeInteger(options.length) || options.length < 0 || options.length > PDF_ASSEMBLY_MAX_BYTES) {
      throw new Error("PDF_ASSEMBLY_LENGTH_INVALID");
    }
  }

  /** Retained logical descriptors, including the active descriptor. */
  public get pendingCount(): number {
    return this.queueCount + (this.active === undefined ? 0 : 1);
  }

  /** PDF.js may re-enter while a prior range is being delivered. */
  public requestDataRange(begin: number, end: number): void {
    if (this.stopped || this.finished || this.failureReported) return;
    const cappedEnd = Math.min(end, this.options.length);
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end)
      || begin < 0 || end < begin || begin > this.options.length || cappedEnd <= begin
      || cappedEnd - begin > PDF_ASSEMBLY_MAX_BYTES) {
      this.fail(finiteFailure("PDF_RANGE_LENGTH"));
      return;
    }
    if (this.pendingCount >= PDF_ASSEMBLY_DESCRIPTOR_LIMIT) {
      this.fail(finiteFailure("PDF_RESOURCE_LIMIT"));
      return;
    }
    this.begins[this.queueTail] = begin;
    this.ends[this.queueTail] = cappedEnd;
    this.queueTail = (this.queueTail + 1) % PDF_ASSEMBLY_DESCRIPTOR_LIMIT;
    this.queueCount += 1;
    this.pump();
  }

  /** Stops every queued/active logical demand; only the active native waiter is cancelled. */
  public abort(): void {
    if (this.stopped || this.finished) return;
    this.stopped = true;
    this.queueHead = 0;
    this.queueTail = 0;
    this.queueCount = 0;
    this.cancelActiveNativeWaiter();
  }

  /** Settlements that can stop on abort; handoff proof is intentionally absent. */
  public settlements(): readonly Promise<void>[] {
    const release = this.active?.releaseInFlight;
    const owned = this.cancellation === undefined ? [...this.pumping] : [...this.pumping, this.cancellation];
    return release === undefined ? owned : [...owned, release];
  }

  /** Public loadingTask.onProgress is the only transfer wake signal. */
  public notifyProgress(): void {
    const active = this.active;
    if (active === undefined || !active.handoffPending || active.releaseInFlight !== undefined
      || active.releaseCompletedProof !== undefined) return;
    if (active.bytes === undefined || active.bytes.byteLength !== 0 || active.bytes.buffer.byteLength !== 0) return;
    // Clear the holder before starting native release; no local payload alias survives the call.
    delete active.bytes;
    void this.releaseHandoff(active, "TRANSFERRED");
  }

  /** Called only after PDF.js destroy resolves. */
  public finishAfterPdfDestroy(): Promise<void> {
    if (this.finishPromise !== undefined) return this.finishPromise;
    this.stopped = true;
    this.queueHead = 0;
    this.queueTail = 0;
    this.queueCount = 0;
    this.cancelActiveNativeWaiter();
    const finish = this.finishAfterPdfDestroyOnce();
    this.finishPromise = finish;
    void finish.catch(() => {
      if (this.finishPromise === finish) this.finishPromise = undefined;
    });
    return finish;
  }

  private async finishAfterPdfDestroyOnce(): Promise<void> {
    if (this.cancellation !== undefined) await this.cancellation;
    const active = this.active;
    if (active !== undefined) {
      const settlement = active.settlement;
      if (settlement !== undefined) await settlement;
      const current = this.active;
      if (current !== undefined) {
        const transferred = current.bytes !== undefined
          && current.bytes.byteLength === 0
          && current.bytes.buffer.byteLength === 0;
        delete current.bytes;
        await this.releaseHandoff(current, transferred ? "TRANSFERRED" : "DISCARDED");
        if (this.active !== undefined) throw asError(this.active.releaseError, "PDF_RESOURCE_LIMIT");
      }
    }
    await this.options.boundary.finish();
    this.finished = true;
  }

  private allocateRequestSequence(): number | undefined {
    const sequence = this.nextRequestSequence;
    if (!Number.isSafeInteger(sequence) || sequence < 1) return undefined;
    this.nextRequestSequence = sequence === Number.MAX_SAFE_INTEGER ? Number.NaN : sequence + 1;
    return sequence;
  }

  private pump(): void {
    if (this.stopped || this.finished || this.failureReported || this.active !== undefined) return;
    while (this.queueCount > 0) {
      const requestSequence = this.allocateRequestSequence();
      if (requestSequence === undefined) {
        this.fail(finiteFailure("PDF_RESOURCE_LIMIT"));
        return;
      }
      const index = this.queueHead;
      const descriptor: Descriptor = {
        requestSequence,
        begin: this.begins[index]!,
        end: this.ends[index]!,
      };
      this.queueHead = (this.queueHead + 1) % PDF_ASSEMBLY_DESCRIPTOR_LIMIT;
      this.queueCount -= 1;
      const active: ActiveAssembly = {
        descriptor,
        abort: new AbortController(),
        handoffAttempted: false,
        handoffPending: false,
        cancelled: false,
      };
      this.active = active;
      const settlement = this.execute(active);
      active.settlement = settlement;
      this.pumping.add(settlement);
      void settlement.then(
        () => {
          this.pumping.delete(settlement);
          this.pump();
        },
        () => {
          this.pumping.delete(settlement);
          this.pump();
        },
      );
      return;
    }
  }

  private cancelActiveNativeWaiter(): void {
    const active = this.active;
    if (active === undefined || active.cancelled) return;
    active.cancelled = true;
    active.abort.abort();
    const cancellation = this.options.boundary.cancel(active.descriptor.requestSequence);
    this.cancellation = cancellation;
    void cancellation.catch((error: unknown) => { this.surfaceReleaseFailure(error); });
  }

  private async execute(active: ActiveAssembly): Promise<void> {
    const { descriptor } = active;
    let reserved = false;
    try {
      const grant = await this.options.boundary.reserve(descriptor.requestSequence, descriptor.begin, descriptor.end);
      active.leaseId = grant.leaseId;
      reserved = true;
      if (!Number.isSafeInteger(grant.leaseId) || grant.leaseId < 1
        || grant.byteLength !== descriptor.end - descriptor.begin
        || grant.byteLength > PDF_ASSEMBLY_MAX_BYTES) {
        this.fail(finiteFailure("PDF_RANGE_LENGTH"));
        delete active.bytes;
        await this.releaseHandoff(active, "UNALLOCATED");
        return;
      }
      if (this.stopped || active.cancelled) {
        delete active.bytes;
        await this.releaseHandoff(active, "UNALLOCATED");
        return;
      }
      try {
        active.bytes = new Uint8Array(grant.byteLength);
      } catch (error) {
        delete active.bytes;
        this.fail(asError(error, "PDF_RESOURCE_LIMIT"));
        await this.releaseHandoff(active, "UNALLOCATED");
        return;
      }
      if (active.bytes === undefined || active.bytes.byteOffset !== 0
        || active.bytes.byteLength !== active.bytes.buffer.byteLength) {
        delete active.bytes;
        this.fail(finiteFailure("PDF_RESOURCE_LIMIT"));
        await this.releaseHandoff(active, "DISCARDED");
        return;
      }
      for (let begin = descriptor.begin; begin < descriptor.end; begin += PDF_ASSEMBLY_PHYSICAL_PART_BYTES) {
        if (this.stopped || active.cancelled) throw finiteFailure("PDF_CANCELLED");
        const end = Math.min(descriptor.end, begin + PDF_ASSEMBLY_PHYSICAL_PART_BYTES);
        const part = await this.options.readPart(begin, end, active.abort.signal);
        if (this.stopped || active.cancelled) throw finiteFailure("PDF_CANCELLED");
        if (part.byteLength !== end - begin) throw finiteFailure("PDF_RANGE_LENGTH");
        // The holder is read only after the await; no payload alias survives another await.
        if (active.bytes === undefined) throw finiteFailure("PDF_RANGE_LENGTH");
        active.bytes.set(part, begin - descriptor.begin);
      }
      if (this.stopped || active.cancelled) throw finiteFailure("PDF_CANCELLED");
      if (active.bytes === undefined) throw finiteFailure("PDF_RANGE_LENGTH");
      active.handoffAttempted = true;
      active.handoffPending = true;
      try {
        this.options.onDataRange(descriptor.begin, active.bytes);
      } catch (error) {
        this.fail(asError(error, "PDF_RESOURCE_LIMIT"));
      }
    } catch (error) {
      if (active.handoffAttempted) {
        this.fail(asError(error, "PDF_RESOURCE_LIMIT"));
        return;
      }
      const aborted = this.stopped || active.cancelled || isAbortError(error);
      delete active.bytes;
      if (!aborted) this.fail(asError(error, "PDF_RANGE_FETCH"));
      if (reserved) await this.releaseHandoff(active, "DISCARDED");
      else this.finishActive(active);
    }
  }

  private async releaseHandoff(active: ActiveAssembly, proof: PdfAssemblyReleaseProof): Promise<void> {
    if (active.releaseCompletedProof !== undefined) return;
    const inFlight = active.releaseInFlight;
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    const target = active.releaseTarget ?? proof;
    active.releaseTarget = target;
    if (active.leaseId === undefined) {
      active.releaseCompletedProof = target;
      this.finishActive(active);
      return;
    }
    // All local holders must be removed before native credit release starts.
    delete active.bytes;
    const release = Promise.resolve().then(() => this.options.boundary.release(active.leaseId!, target)).then(
      () => {
        delete active.releaseInFlight;
        active.releaseError = undefined;
        active.releaseCompletedProof = target;
        if (this.active === active) this.finishActive(active);
      },
      (error: unknown) => {
        delete active.releaseInFlight;
        active.releaseError = error;
        this.surfaceReleaseFailure(error);
      },
    );
    active.releaseInFlight = release;
    await release;
  }

  private finishActive(active: ActiveAssembly): void {
    if (this.active !== active || active.releaseError !== undefined
      || (active.leaseId !== undefined && active.releaseCompletedProof === undefined)) return;
    this.active = undefined;
    if (!this.stopped) this.pump();
  }

  private surfaceReleaseFailure(error: unknown): void {
    // Preserve the exact cleanup obligation on the active holder while surfacing
    // one finite diagnostic to the controller; no retry/replay of file reads occurs.
    if (this.active !== undefined) this.active.releaseError = error;
    this.fail(finiteFailure("PDF_RESOURCE_LIMIT"));
  }

  private fail(error: Error): void {
    if (this.failureReported || this.finished) return;
    this.failureReported = true;
    this.stopped = true;
    this.queueHead = 0;
    this.queueTail = 0;
    this.queueCount = 0;
    this.cancelActiveNativeWaiter();
    try { this.options.onFailure?.(error); } catch { /* failure observers do not own cleanup */ }
  }
}

/** PDF.js-facing transport around the bounded assembler. */
export class PdfRangeAssemblyTransport extends PDFDataRangeTransport {
  private readonly assembly: PdfRangeAssembly;

  public constructor(options: Omit<PdfRangeAssemblyOptions, "onDataRange">) {
    super(options.length, null, true);
    this.assembly = new PdfRangeAssembly({
      ...options,
      onDataRange: (begin, bytes) => this.onDataRange(begin, bytes),
    });
  }

  public override requestDataRange(begin: number, end: number): void {
    this.assembly.requestDataRange(begin, end);
  }

  public override abort(): void {
    this.assembly.abort();
  }

  public notifyProgress(): void {
    this.assembly.notifyProgress();
  }

  public settlements(): readonly Promise<void>[] {
    return this.assembly.settlements();
  }

  public finishAfterPdfDestroy(): Promise<void> {
    return this.assembly.finishAfterPdfDestroy();
  }

  public get pendingCount(): number {
    return this.assembly.pendingCount;
  }
}

/** Creates a bounded physical reader for the existing opaque protocol URL. */
export function createPdfAssemblyPartReader(url: string, documentLength: number): PdfAssemblyPartReader {
  return async (begin, end, signal) => {
    let response: Response;
    try {
      response = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` }, signal });
    } catch (error) {
      if (signal.aborted) throw finiteFailure("PDF_CANCELLED");
      throw error instanceof PdfFailureError ? error : finiteFailure("PDF_RANGE_FETCH");
    }
    if (response.status !== 206) {
      throw new PdfFailureError(response.status >= 100 && response.status <= 599
        ? { code: "PDF_RANGE_STATUS", httpStatus: response.status }
        : { code: "PDF_RANGE_FETCH" });
    }
    const expectedRange = `bytes ${begin}-${end - 1}/${documentLength}`;
    if (response.headers.get("content-range") !== expectedRange
      || response.headers.get("content-length") !== String(end - begin)) {
      throw new PdfFailureError({ code: "PDF_RANGE_HEADERS" });
    }
    let result: Uint8Array;
    try {
      result = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (signal.aborted) throw finiteFailure("PDF_CANCELLED");
      throw error instanceof PdfFailureError ? error : finiteFailure("PDF_RANGE_BODY");
    }
    if (signal.aborted) throw finiteFailure("PDF_CANCELLED");
    if (result.byteLength !== end - begin) throw finiteFailure("PDF_RANGE_LENGTH");
    return result;
  };
}
