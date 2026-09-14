import {
  checkedCanvasBytes,
  type ResourceReservation,
  type ResourceReservationManager,
} from "./ResourceBudget";

export interface PdfPrintRenderTask {
  readonly promise: Promise<void>;
  cancel(): void;
}

export interface PdfPrintPage {
  /** PDF.js exposes the page's intrinsic /Rotate value here. */
  readonly rotate?: number;
  getViewport(options: { readonly scale: number; readonly rotation: number }): {
    readonly width: number;
    readonly height: number;
  };
  render(options: {
    readonly canvas: HTMLCanvasElement;
    readonly canvasContext: CanvasRenderingContext2D;
    readonly viewport: unknown;
    readonly annotationMode: number;
    readonly intent: "print";
    readonly background: "rgb(255,255,255)";
  }): PdfPrintRenderTask;
}

export interface PdfPrintDocument {
  getPage(pageNumber: number): Promise<PdfPrintPage>;
}

export interface PdfPrintPageRange {
  readonly from: number;
  readonly to: number;
}

export type PdfPrintNativePhase =
  | "dialog"
  | "ready"
  | "printing"
  | "submitted"
  | "cancelled"
  | "failed";

export interface PdfPrintSnapshot {
  readonly jobId: string;
  readonly phase: PdfPrintNativePhase;
  readonly pageCount: number;
  readonly pageRanges: readonly PdfPrintPageRange[];
  readonly submittedPages: number;
  readonly error: string | null;
}

export interface PdfPrintStartRequest {
  readonly pageCount: number;
  readonly currentPage: number;
  readonly title: string;
}

export interface PdfPrintNative {
  start(request: PdfPrintStartRequest): Promise<PdfPrintSnapshot>;
  poll(jobId: string): Promise<PdfPrintSnapshot>;
  submit(jobId: string, payload: Uint8Array): Promise<PdfPrintSnapshot>;
  finish(jobId: string): Promise<PdfPrintSnapshot>;
  cancel(jobId: string): Promise<PdfPrintSnapshot>;
  release(jobId: string): Promise<void>;
}

export type PdfPrintPhase =
  | "opening-dialog"
  | "preparing"
  | "submitting"
  | "submitted"
  | "cancelled"
  | "failed";

export interface PdfPrintProgress {
  readonly phase: PdfPrintPhase;
  readonly preparedPages: number;
  readonly totalPages: number;
  readonly fraction: number;
  readonly currentPage?: number;
}

export interface PdfPrintServiceOptions {
  readonly document: PdfPrintDocument;
  readonly native: PdfPrintNative;
  readonly pageCount: number;
  readonly annotationMode: number;
  readonly resources: ResourceReservationManager;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly currentPage?: number;
  readonly title?: string;
  readonly stageTimeoutMs?: number;
  readonly onProgress?: (progress: PdfPrintProgress) => void;
  /**
   * Registers the complete ownership barrier. It remains pending after an
   * interrupted call returns until every raw PDF.js/native operation and its
   * resource cleanup have actually settled.
   */
  readonly onOwnershipSettlement?: (settlement: Promise<void>) => void;
}

export type PdfPrintOutcome =
  | { readonly kind: "submitted"; readonly pageCount: number }
  | { readonly kind: "cancelled"; readonly preparedPages: number }
  | { readonly kind: "failed"; readonly reason: string; readonly preparedPages: number };

const DEFAULT_STAGE_TIMEOUT_MS = 15_000;
const PRINT_POLL_INTERVAL_MS = 50;
const RENDER_SLOT_RETRY_MS = 10;
const PRINT_SCALE = 300 / 72;
const PRINT_HEADER_BYTES = 32;
const MAX_NATIVE_PAGE_BYTES = 64 * 1_048_576;
const MAX_PRINT_RANGES = 16;
const MAX_U32 = 0xffff_ffff;
const JOB_ID = /^[0-9a-f]{64}$/u;
const SNAPSHOT_KEYS = new Set([
  "jobId",
  "phase",
  "pageCount",
  "pageRanges",
  "submittedPages",
  "error",
]);
const NATIVE_PHASES = new Set<PdfPrintNativePhase>([
  "dialog",
  "ready",
  "printing",
  "submitted",
  "cancelled",
  "failed",
]);

interface OwnedOperation<T> {
  readonly raw: Promise<T>;
  settlement: Promise<void>;
  settled: boolean;
}

interface PageWork {
  canvas?: HTMLCanvasElement;
  payload?: Uint8Array;
  readonly reservation: ResourceReservation;
  released: boolean;
}

const failure = (reason: string, preparedPages: number): PdfPrintOutcome => ({
  kind: "failed",
  reason,
  preparedPages,
});

const reasonOf = (error: unknown, fallback = "PRINT_FAILED"): string => {
  if (typeof error === "object" && error !== null && "tag" in error
    && typeof (error as { readonly tag?: unknown }).tag === "string") {
    return (error as { readonly tag: string }).tag;
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return fallback;
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new Error("PRINT_CANCELLED");
};

const isTerminal = (phase: PdfPrintNativePhase): boolean =>
  phase === "submitted" || phase === "cancelled" || phase === "failed";

const selectedPageCount = (ranges: readonly PdfPrintPageRange[]): number => {
  let count = 0;
  for (const range of ranges) {
    const length = range.to - range.from + 1;
    if (!Number.isSafeInteger(length) || !Number.isSafeInteger(count + length)) {
      throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
    }
    count += length;
  }
  return count;
};

const sameRanges = (
  left: readonly PdfPrintPageRange[],
  right: readonly PdfPrintPageRange[],
): boolean => left.length === right.length && left.every((range, index) => {
  const other = right[index];
  return other !== undefined && range.from === other.from && range.to === other.to;
});

function decodeSnapshot(
  value: unknown,
  expectedPageCount: number,
  expectedJobId?: string,
): PdfPrintSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== SNAPSHOT_KEYS.size || keys.some((key) => !SNAPSHOT_KEYS.has(key))) {
    throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
  }
  if (typeof object.jobId !== "string" || !JOB_ID.test(object.jobId)
    || (expectedJobId !== undefined && object.jobId !== expectedJobId)
    || object.pageCount !== expectedPageCount
    || typeof object.phase !== "string"
    || !NATIVE_PHASES.has(object.phase as PdfPrintNativePhase)
    || !Number.isSafeInteger(object.submittedPages)
    || (object.submittedPages as number) < 0
    || !Array.isArray(object.pageRanges)
    || object.pageRanges.length > MAX_PRINT_RANGES) {
    throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
  }

  const ranges: PdfPrintPageRange[] = [];
  let priorTo = 0;
  for (const valueRange of object.pageRanges) {
    if (typeof valueRange !== "object" || valueRange === null || Array.isArray(valueRange)) {
      throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
    }
    const range = valueRange as Record<string, unknown>;
    const rangeKeys = Object.keys(range);
    if (rangeKeys.length !== 2 || !rangeKeys.includes("from") || !rangeKeys.includes("to")
      || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)) {
      throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
    }
    const from = range.from as number;
    const to = range.to as number;
    // Adjacent ranges are non-normalized and must have been merged natively.
    if (from < 1 || to < from || to > expectedPageCount || from <= priorTo + (ranges.length === 0 ? 0 : 1)) {
      throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
    }
    ranges.push(Object.freeze({ from, to }));
    priorTo = to;
  }

  const phase = object.phase as PdfPrintNativePhase;
  const submittedPages = object.submittedPages as number;
  const rangePageCount = selectedPageCount(ranges);
  if (submittedPages > rangePageCount
    || (ranges.length === 0 && submittedPages !== 0)
    || (phase === "dialog" && (ranges.length !== 0 || submittedPages !== 0))
    || (phase === "ready" && (ranges.length === 0 || submittedPages !== 0))
    || (phase === "printing" && ranges.length === 0)
    || (phase === "submitted" && (ranges.length === 0 || submittedPages !== rangePageCount))) {
    throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
  }
  if (phase === "failed") {
    if (typeof object.error !== "string" || object.error.length === 0 || object.error.length > 512
      || /[\u0000-\u001f\u007f]/u.test(object.error)) {
      throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
    }
  } else if (object.error !== null) {
    throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
  }

  return Object.freeze({
    jobId: object.jobId,
    phase,
    pageCount: expectedPageCount,
    pageRanges: Object.freeze(ranges),
    submittedPages,
    error: phase === "failed" ? object.error as string : null,
  });
}

function assertStableRanges(
  snapshot: PdfPrintSnapshot,
  ranges: readonly PdfPrintPageRange[] | undefined,
): void {
  if (ranges !== undefined && !sameRanges(snapshot.pageRanges, ranges)) {
    throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
  }
}

function* selectedPages(ranges: readonly PdfPrintPageRange[]): Generator<number> {
  for (const range of ranges) {
    for (let page = range.from; page <= range.to; page += 1) yield page;
  }
}

const delay = (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      reject(new Error("PRINT_CANCELLED"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
};

/**
 * Opens the native system dialog first, then renders and acknowledges exactly
 * the native-selected pages one at a time. A successful outcome means only
 * that the native print job accepted all pages; it is not physical-output
 * confirmation.
 */
export async function printPdfDocument(options: PdfPrintServiceOptions): Promise<PdfPrintOutcome> {
  let preparedPages = 0;
  let progressTotal = options.pageCount;
  let progressPage: number | undefined;
  const report = (phase: PdfPrintPhase): void => {
    const progress: PdfPrintProgress = Object.freeze({
      phase,
      preparedPages,
      totalPages: progressTotal,
      fraction: progressTotal > 0 ? Math.min(1, preparedPages / progressTotal) : 0,
      ...(progressPage === undefined ? {} : { currentPage: progressPage }),
    });
    try { options.onProgress?.(progress); } catch { /* Observers do not own printing. */ }
  };

  if (!Number.isSafeInteger(options.pageCount) || options.pageCount < 1 || options.pageCount > MAX_U32) {
    report("failed");
    return failure("PRINT_PAGE_LIMIT", preparedPages);
  }
  const currentPage = options.currentPage ?? 1;
  if (!Number.isSafeInteger(currentPage) || currentPage < 1 || currentPage > options.pageCount) {
    report("failed");
    return failure("PRINT_PAGE_LIMIT", preparedPages);
  }
  const stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  if (!Number.isFinite(stageTimeoutMs) || stageTimeoutMs <= 0) {
    report("failed");
    return failure("PRINT_STAGE_TIMEOUT", preparedPages);
  }
  if (options.native === undefined) {
    report("failed");
    return failure("PRINT_NATIVE_UNAVAILABLE", preparedPages);
  }

  let resolveOwnership!: () => void;
  let rejectOwnership!: (error: unknown) => void;
  const ownershipBarrier = new Promise<void>((resolve, reject) => {
    resolveOwnership = resolve;
    rejectOwnership = reject;
  });
  void ownershipBarrier.catch(() => undefined);
  try { options.onOwnershipSettlement?.(ownershipBarrier); } catch { /* The barrier remains authoritative. */ }

  const pendingOwnership = new Set<Promise<void>>();
  let ownershipError: unknown;
  let interruptedRaw = false;
  let ownershipIncomplete = false;
  const registerSettlement = (settlement: Promise<void>): Promise<void> => {
    pendingOwnership.add(settlement);
    void settlement.then(
      () => { pendingOwnership.delete(settlement); },
      (error: unknown) => {
        ownershipError ??= error;
        pendingOwnership.delete(settlement);
      },
    );
    return settlement;
  };
  const own = <T>(operation: () => Promise<T> | T, cleanup?: () => void): OwnedOperation<T> => {
    const owned: OwnedOperation<T> = {
      raw: Promise.resolve().then(operation),
      settlement: Promise.resolve(),
      settled: false,
    };
    const settlement = owned.raw.then(
      () => { cleanup?.(); },
      () => { cleanup?.(); },
    ).finally(() => { owned.settled = true; });
    owned.settlement = registerSettlement(settlement);
    return owned;
  };
  const ownAfter = (dependency: Promise<void>, cleanup: () => void): void => {
    registerSettlement(dependency.then(cleanup, cleanup));
  };
  const awaitInterruptible = async <T>(
    operation: OwnedOperation<T>,
    timeoutTag?: "PRINT_METADATA_TIMEOUT" | "PRINT_RENDER_TIMEOUT",
  ): Promise<T> => {
    throwIfAborted(options.signal);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      if (timeoutTag !== undefined) {
        timeout = setTimeout(() => reject(new Error(timeoutTag)), stageTimeoutMs);
      }
      abort = () => reject(new Error("PRINT_CANCELLED"));
      options.signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([operation.raw, interrupted]);
    } catch (error) {
      if (!operation.settled && (options.signal?.aborted || reasonOf(error) === timeoutTag)) interruptedRaw = true;
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (abort !== undefined) options.signal?.removeEventListener("abort", abort);
    }
  };

  const works = new Set<PageWork>();
  const releaseReservation = (reservation: ResourceReservation): void => {
    if (!options.resources.release(reservation)) throw new Error("PRINT_RESOURCE_CLEANUP_FAILED");
  };
  const releaseWork = (work: PageWork): void => {
    if (work.released) return;
    work.released = true;
    if (work.canvas !== undefined) {
      work.canvas.width = 0;
      work.canvas.height = 0;
      delete work.canvas;
    }
    if (work.payload !== undefined) delete work.payload;
    works.delete(work);
    releaseReservation(work.reservation);
  };
  const reserveRenderSlot = async (): Promise<ResourceReservation> => {
    const deadline = Date.now() + stageTimeoutMs;
    for (;;) {
      throwIfAborted(options.signal);
      const result = options.resources.reserve({
        kind: "render",
        amount: 1,
        sessionId: options.sessionId,
      });
      if (result.ok) return result.reservation;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("PRINT_RENDER_CAPACITY");
      await delay(Math.min(RENDER_SLOT_RETRY_MS, remaining), options.signal);
    }
  };
  const reservePageWork = (rgbaBytes: number): ResourceReservation => {
    const controlledBytes = rgbaBytes * 2 + PRINT_HEADER_BYTES;
    if (!Number.isSafeInteger(controlledBytes)) throw new Error("PRINT_IMAGE_LIMIT");
    const result = options.resources.reserve({
      kind: "canvas-bytes",
      amount: controlledBytes,
      sessionId: options.sessionId,
    });
    if (!result.ok) throw new Error("PRINT_IMAGE_LIMIT");
    return result.reservation;
  };

  let activeRenderTask: PdfPrintRenderTask | undefined;
  let startOperation: OwnedOperation<unknown> | undefined;
  let cancelOperation: OwnedOperation<unknown> | undefined;
  let jobId: string | undefined;
  let ranges: readonly PdfPrintPageRange[] | undefined;
  let terminal: PdfPrintSnapshot | undefined;
  let released = false;

  const beginCancel = (): void => {
    if (jobId === undefined || cancelOperation !== undefined || terminal !== undefined || released) return;
    cancelOperation = own(() => options.native.cancel(jobId!));
  };
  const cancelOnAbort = (): void => {
    try { activeRenderTask?.cancel(); } catch { /* Raw render settlement still owns cleanup. */ }
    beginCancel();
  };
  options.signal?.addEventListener("abort", cancelOnAbort);

  const validateForJob = (value: unknown): PdfPrintSnapshot => {
    if (jobId === undefined) throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
    const snapshot = decodeSnapshot(value, options.pageCount, jobId);
    assertStableRanges(snapshot, ranges);
    return snapshot;
  };
  const releaseTerminal = async (): Promise<void> => {
    if (jobId === undefined || terminal === undefined || !isTerminal(terminal.phase)) {
      throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
    }
    const operation = own(() => options.native.release(jobId!));
    await operation.raw;
    await operation.settlement;
    released = true;
  };
  const cancelToTerminal = async (): Promise<PdfPrintSnapshot> => {
    if (jobId === undefined) throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
    beginCancel();
    let snapshot: PdfPrintSnapshot | undefined;
    let cancelError: unknown;
    try {
      snapshot = validateForJob(await cancelOperation!.raw);
    } catch (error) {
      cancelError = error;
    }
    if (snapshot !== undefined && isTerminal(snapshot.phase)) return snapshot;
    if (cancelError !== undefined) {
      // Repeated cancel is native-idempotent; one retry distinguishes a lost
      // response from a job that was never asked to stop.
      cancelOperation = own(() => options.native.cancel(jobId!));
      try {
        snapshot = validateForJob(await cancelOperation.raw);
      } catch (error) {
        throw new Error(reasonOf(error, reasonOf(cancelError, "PRINT_CANCEL_FAILED")));
      }
      if (isTerminal(snapshot.phase)) return snapshot;
    }
    for (;;) {
      await delay(PRINT_POLL_INTERVAL_MS);
      snapshot = validateForJob(await own(() => options.native.poll(jobId!)).raw);
      if (isTerminal(snapshot.phase)) return snapshot;
      if (snapshot.phase === "ready" && ranges === undefined) ranges = snapshot.pageRanges;
      if (snapshot.phase === "printing" && ranges === undefined) {
        throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
      }
    }
  };

  let outcome: PdfPrintOutcome | undefined;
  try {
    throwIfAborted(options.signal);
    progressPage = currentPage;
    report("opening-dialog");
    throwIfAborted(options.signal);

    startOperation = own(() => options.native.start({
      pageCount: options.pageCount,
      currentPage,
      title: options.title ?? "Document",
    }));
    const started = decodeSnapshot(await awaitInterruptible(startOperation), options.pageCount);
    jobId = started.jobId;
    if (started.phase !== "dialog") throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
    if (options.signal?.aborted) {
      beginCancel();
      throw new Error("PRINT_CANCELLED");
    }

    let snapshot = started;
    for (;;) {
      throwIfAborted(options.signal);
      const polled = own(() => options.native.poll(jobId!));
      snapshot = validateForJob(await awaitInterruptible(polled));
      if (snapshot.phase === "ready") {
        ranges = snapshot.pageRanges;
        break;
      }
      if (snapshot.phase === "cancelled") {
        terminal = snapshot;
        outcome = { kind: "cancelled", preparedPages };
        break;
      }
      if (snapshot.phase === "failed") {
        terminal = snapshot;
        outcome = failure(snapshot.error ?? "PRINT_FAILED", preparedPages);
        break;
      }
      if (snapshot.phase !== "dialog") throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
      await delay(PRINT_POLL_INTERVAL_MS, options.signal);
    }

    if (outcome === undefined) {
      if (ranges === undefined) throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
      progressTotal = selectedPageCount(ranges);
      let acknowledgedPages = 0;
      for (const pageNumber of selectedPages(ranges)) {
        throwIfAborted(options.signal);
        progressPage = pageNumber;
        report("preparing");
        throwIfAborted(options.signal);

        const pageOperation = own(() => options.document.getPage(pageNumber));
        const page = await awaitInterruptible(pageOperation, "PRINT_METADATA_TIMEOUT");
        throwIfAborted(options.signal);

        const rotation = Number.isFinite(page.rotate) ? page.rotate as number : 0;
        const pointViewport = page.getViewport({ scale: 1, rotation });
        const printViewport = page.getViewport({ scale: PRINT_SCALE, rotation });
        if (!Number.isFinite(pointViewport.width) || pointViewport.width <= 0
          || !Number.isFinite(pointViewport.height) || pointViewport.height <= 0
          || !Number.isFinite(printViewport.width) || printViewport.width <= 0
          || !Number.isFinite(printViewport.height) || printViewport.height <= 0) {
          throw new Error("PRINT_IMAGE_LIMIT");
        }
        const width = Math.ceil(printViewport.width);
        const height = Math.ceil(printViewport.height);
        const canvasBytes = checkedCanvasBytes(width, height, 1);
        if (typeof canvasBytes === "string"
          || canvasBytes + PRINT_HEADER_BYTES > MAX_NATIVE_PAGE_BYTES
          || width > MAX_U32 || height > MAX_U32) {
          throw new Error("PRINT_IMAGE_LIMIT");
        }

        const renderReservation = await reserveRenderSlot();
        let work: PageWork | undefined;
        let renderOwned: OwnedOperation<void> | undefined;
        try {
          const reservation = reservePageWork(canvasBytes);
          work = { reservation, released: false };
          works.add(work);
          const canvas = document.createElement("canvas");
          work.canvas = canvas;
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
          if (context === null) throw new Error("PRINT_CANVAS_UNAVAILABLE");
          const task = page.render({
            canvas,
            canvasContext: context,
            viewport: printViewport,
            annotationMode: options.annotationMode,
            intent: "print",
            background: "rgb(255,255,255)",
          });
          activeRenderTask = task;
          renderOwned = own(() => task.promise, () => {
            if (activeRenderTask === task) activeRenderTask = undefined;
            releaseReservation(renderReservation);
          });
          try {
            await awaitInterruptible(renderOwned, "PRINT_RENDER_TIMEOUT");
          } catch (error) {
            try { task.cancel(); } catch { /* Settlement owns the render slot and canvas. */ }
            const interruptedWork = work;
            ownAfter(renderOwned.settlement, () => releaseWork(interruptedWork));
            work = undefined;
            throw error;
          }
          await renderOwned.settlement;

          throwIfAborted(options.signal);
          const pixels = context.getImageData(0, 0, width, height).data;
          if (pixels.byteLength !== canvasBytes) throw new Error("PRINT_IMAGE_INVALID");
          // ImageData is an independent copy. Drop the backing canvas before
          // allocating the binary payload, so only two page buffers coexist.
          canvas.width = 0;
          canvas.height = 0;
          delete work.canvas;
          const payload = new Uint8Array(canvasBytes + PRINT_HEADER_BYTES);
          const header = new DataView(payload.buffer, payload.byteOffset, PRINT_HEADER_BYTES);
          header.setUint32(0, 0x3152_504d, true);
          header.setUint32(4, pageNumber, true);
          header.setUint32(8, width, true);
          header.setUint32(12, height, true);
          header.setFloat64(16, pointViewport.width, true);
          header.setFloat64(24, pointViewport.height, true);
          for (let source = 0, target = PRINT_HEADER_BYTES; source < pixels.length; source += 4, target += 4) {
            const alpha = pixels[source + 3]!;
            if (alpha === 255) {
              payload[target] = pixels[source + 2]!;
              payload[target + 1] = pixels[source + 1]!;
              payload[target + 2] = pixels[source]!;
            } else {
              const inverse = 255 - alpha;
              payload[target] = Math.floor((pixels[source + 2]! * alpha + 255 * inverse + 127) / 255);
              payload[target + 1] = Math.floor((pixels[source + 1]! * alpha + 255 * inverse + 127) / 255);
              payload[target + 2] = Math.floor((pixels[source]! * alpha + 255 * inverse + 127) / 255);
            }
            payload[target + 3] = 255;
          }
          work.payload = payload;
          preparedPages += 1;
          report("submitting");
          throwIfAborted(options.signal);

          const submitWork = work;
          const submitted = own(
            () => options.native.submit(jobId!, submitWork.payload!),
            () => releaseWork(submitWork),
          );
          work = undefined;
          snapshot = validateForJob(await awaitInterruptible(submitted));
          if (snapshot.phase === "cancelled") {
            terminal = snapshot;
            outcome = { kind: "cancelled", preparedPages };
            break;
          }
          if (snapshot.phase === "failed") {
            terminal = snapshot;
            outcome = failure(snapshot.error ?? "PRINT_FAILED", preparedPages);
            break;
          }
          acknowledgedPages += 1;
          if (snapshot.phase !== "printing" || snapshot.submittedPages !== acknowledgedPages) {
            throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
          }
          await submitted.settlement;
        } catch (error) {
          if (renderOwned === undefined) releaseReservation(renderReservation);
          if (work !== undefined) releaseWork(work);
          throw error;
        }
      }

      if (outcome === undefined) {
        if (ranges === undefined) throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
        const deliveredPages = selectedPageCount(ranges);
        const finished = own(() => options.native.finish(jobId!));
        const snapshot = validateForJob(await awaitInterruptible(finished));
        if (snapshot.phase === "cancelled") {
          terminal = snapshot;
          outcome = { kind: "cancelled", preparedPages };
        } else if (snapshot.phase === "failed") {
          terminal = snapshot;
          outcome = failure(snapshot.error ?? "PRINT_FAILED", preparedPages);
        } else if (snapshot.phase === "submitted" && snapshot.submittedPages === deliveredPages) {
          terminal = snapshot;
          outcome = { kind: "submitted", pageCount: snapshot.submittedPages };
        } else {
          throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
        }
      }
    }
  } catch (error) {
    const reason = reasonOf(error);
    outcome = reason === "PRINT_CANCELLED" || options.signal?.aborted
      ? { kind: "cancelled", preparedPages }
      : failure(reason, preparedPages);
  }

  try {
    if (jobId === undefined && startOperation !== undefined) {
      const started = decodeSnapshot(await startOperation.raw, options.pageCount);
      jobId = started.jobId;
      if (started.phase !== "dialog") throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
    }
    if (jobId !== undefined) {
      if (terminal === undefined) terminal = await cancelToTerminal();
      if (terminal.phase === "failed") {
        outcome = failure(terminal.error ?? "PRINT_FAILED", preparedPages);
      } else if (terminal.phase === "submitted" && outcome?.kind === "cancelled") {
        const delivered = selectedPageCount(terminal.pageRanges);
        if (terminal.submittedPages !== delivered) throw new Error("PRINT_NATIVE_CONTRACT_INVALID");
        outcome = { kind: "submitted", pageCount: delivered };
      }
      await releaseTerminal();
    }
  } catch (cleanupError) {
    if (jobId !== undefined && !released) ownershipIncomplete = true;
    outcome = failure(reasonOf(cleanupError, "PRINT_CLEANUP_FAILED"), preparedPages);
  } finally {
    options.signal?.removeEventListener("abort", cancelOnAbort);
  }

  const drainOwnership = async (): Promise<void> => {
    while (pendingOwnership.size > 0) {
      await Promise.allSettled([...pendingOwnership]);
    }
    for (const work of [...works]) releaseWork(work);
    if (ownershipError !== undefined) throw ownershipError;
  };
  const ownershipFinalization = drainOwnership();
  if (!ownershipIncomplete) void ownershipFinalization.then(resolveOwnership, rejectOwnership);
  if (!interruptedRaw) {
    try {
      await ownershipFinalization;
    } catch (cleanupError) {
      outcome = failure(reasonOf(cleanupError, "PRINT_CLEANUP_FAILED"), preparedPages);
    }
  }

  outcome ??= failure("PRINT_FAILED", preparedPages);
  progressPage = undefined;
  report(outcome.kind === "submitted" ? "submitted" : outcome.kind);
  return outcome;
}
