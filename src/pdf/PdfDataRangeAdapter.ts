import { PDFDataRangeTransport } from "pdfjs-dist";
import {
  BinaryRangeTransport,
  type BinaryRangeInvoker,
  type PdfRangeSession,
  type RangeTransportTag,
} from "./BinaryRangeTransport";
import { RESOURCE_LIMITS } from "./ResourceBudget";

export type PdfDataRangeAdapterTag = RangeTransportTag | "TRANSPORT_ABORTED" | "NATIVE_CLOSE_FAILED";

export interface OpaquePdfSessionMetadata extends PdfRangeSession {}

export interface NativePdfSessionLifecycle {
  cancel(session: OpaquePdfSessionMetadata): Promise<void>;
  waitForBarrier(session: OpaquePdfSessionMetadata): Promise<void>;
  close(session: OpaquePdfSessionMetadata): Promise<void>;
}

export interface PdfRangeProgress {
  readonly loaded: number;
  readonly total: number;
}

export interface PdfDataRangeAdapterOptions {
  readonly session: OpaquePdfSessionMetadata;
  readonly invoker: BinaryRangeInvoker;
  readonly isGenerationCurrent: (generation: number) => boolean;
  readonly nativeLifecycle: NativePdfSessionLifecycle;
  readonly onProgress?: (progress: PdfRangeProgress) => void;
  readonly onFailure?: (tag: PdfDataRangeAdapterTag) => void;
}

export type PdfRangeListener = (begin: number, bytes: Uint8Array) => void;
export type PdfProgressListener = (progress: PdfRangeProgress) => void;

export interface PdfDataRangeAdapterHandle {
  readonly transport: OpaquePdfDataRangeTransport;
  readonly rangeChunkSize: typeof RESOURCE_LIMITS.normalRangeBytes;
  abort(): Promise<void>;
  destroy(): Promise<void>;
}

/**
 * PDF.js range transport backed exclusively by opaque typed binary requests.
 * It deliberately has no initial data, URL, fetch, stream, or full-document route.
 */
export class OpaquePdfDataRangeTransport extends PDFDataRangeTransport {
  private readonly binary: BinaryRangeTransport;
  private readonly activeRequestIds = new Set<string>();
  private readonly deliveredOffsets = new Set<number>();
  private requestSequence = 0;
  private loaded = 0;
  private shutdown: Promise<void> | undefined;
  private stopped = false;
  private readonly rangeListeners = new Set<PdfRangeListener>();
  private readonly progressListeners = new Set<PdfProgressListener>();

  public constructor(private readonly options: PdfDataRangeAdapterOptions) {
    super(options.session.byteLength, null, true);
    this.binary = new BinaryRangeTransport(options.session, options.invoker, options.isGenerationCurrent);
    this.transportReady((event: { readonly type: string; readonly begin?: number; readonly chunk?: Uint8Array | null }) => {
      if (event.type === "range" && event.begin !== undefined && event.chunk !== null && event.chunk !== undefined) {
        for (const listener of this.rangeListeners) listener(event.begin, event.chunk);
      }
    });
  }

  public addRangeListener(listener: PdfRangeListener): () => void {
    this.rangeListeners.add(listener);
    return () => this.rangeListeners.delete(listener);
  }

  public addProgressListener(listener: PdfProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  public override requestDataRange(begin: number, end: number): void {
    if (this.stopped || !this.options.isGenerationCurrent(this.options.session.documentGeneration)) {
      this.fail(this.stopped ? "TRANSPORT_ABORTED" : "RANGE_STALE");
      return;
    }
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end < begin || begin > this.options.session.byteLength) {
      this.fail("RANGE_INVALID");
      return;
    }
    const cappedEnd = Math.min(end, this.options.session.byteLength);
    for (let offset = begin; offset < cappedEnd; offset += RESOURCE_LIMITS.normalRangeBytes) {
      const length = Math.min(RESOURCE_LIMITS.normalRangeBytes, cappedEnd - offset);
      void this.readChunk(offset, length);
    }
  }

  /** PDF.js calls this synchronously; native teardown continues through the shared once-only promise. */
  public override abort(): void {
    void this.destroy().catch(() => {});
  }

  public destroy(): Promise<void> {
    if (this.shutdown === undefined) {
      this.stopped = true;
      for (const requestId of this.activeRequestIds) this.binary.cancel(requestId);
      this.shutdown = this.closeNativeSession();
    }
    return this.shutdown;
  }

  private async readChunk(offset: number, length: number): Promise<void> {
    if (this.stopped) return;
    const requestId = `pdf-range-${this.options.session.documentGeneration}-${this.requestSequence++}`;
    this.activeRequestIds.add(requestId);
    try {
      const result = await this.binary.read({
        sessionId: this.options.session.sessionId,
        documentGeneration: this.options.session.documentGeneration,
        requestId,
        offset,
        length,
      });
      if (!result.ok) {
        this.fail(result.tag);
        return;
      }
      if (this.stopped || !this.options.isGenerationCurrent(this.options.session.documentGeneration)) {
        this.fail(this.stopped ? "TRANSPORT_ABORTED" : "RANGE_STALE");
        return;
      }
      this.onDataRange(offset, result.bytes);
      if (!this.deliveredOffsets.has(offset)) {
        this.deliveredOffsets.add(offset);
        this.loaded += result.bytes.byteLength;
        const progress = { loaded: this.loaded, total: this.options.session.byteLength };
        this.options.onProgress?.(progress);
        for (const listener of this.progressListeners) listener(progress);
      }
    } finally {
      this.activeRequestIds.delete(requestId);
    }
  }

  private async closeNativeSession(): Promise<void> {
    try {
      await this.options.nativeLifecycle.cancel(this.options.session);
      await this.options.nativeLifecycle.waitForBarrier(this.options.session);
      await this.options.nativeLifecycle.close(this.options.session);
    } catch (error) {
      this.fail("NATIVE_CLOSE_FAILED");
      throw error;
    }
  }

  private fail(tag: PdfDataRangeAdapterTag): void {
    this.options.onFailure?.(tag);
  }
}

export function createPdfDataRangeAdapter(options: PdfDataRangeAdapterOptions): PdfDataRangeAdapterHandle {
  const transport = new OpaquePdfDataRangeTransport(options);
  return Object.freeze({
    transport,
    rangeChunkSize: RESOURCE_LIMITS.normalRangeBytes,
    abort: () => transport.destroy(),
    destroy: () => transport.destroy(),
  });
}
