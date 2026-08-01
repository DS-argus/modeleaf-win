import { RESOURCE_LIMITS, type ResourceTag, validateRange } from "./ResourceBudget";

export type RangeTransportTag = ResourceTag | "RANGE_STALE" | "RANGE_CANCELLED" | "RANGE_LENGTH_MISMATCH" | "RANGE_FAILED";

export interface PdfRangeSession {
  readonly sessionId: string;
  readonly documentGeneration: number;
  readonly byteLength: number;
}

export interface PdfRangeRequest {
  readonly sessionId: string;
  readonly documentGeneration: number;
  readonly requestId: string;
  readonly offset: number;
  readonly length: number;
}

export interface BinaryRangeInvoker {
  /** CP1 wires this to a typed Tauri binary invoke; it must return only response bytes. */
  invoke(request: PdfRangeRequest, signal: AbortSignal): Promise<Uint8Array>;
}

export interface RangeCancellationRegistration {
  readonly requestId: string;
  cancel(): void;
}

export type RangeResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly tag: RangeTransportTag };

export function validatePdfRangeRequest(session: PdfRangeSession, request: PdfRangeRequest): RangeTransportTag | undefined {
  if (request.sessionId !== session.sessionId || request.documentGeneration !== session.documentGeneration || request.requestId.length === 0) return "RANGE_STALE";
  return validateRange(request.offset, request.length, session.byteLength);
}

/** A range response is exact, except a final read may end at EOF. */
export function validatePdfRangeResponse(session: PdfRangeSession, request: PdfRangeRequest, byteLength: number): RangeTransportTag | undefined {
  const requestTag = validatePdfRangeRequest(session, request);
  if (requestTag !== undefined) return requestTag;
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) return "RANGE_LENGTH_MISMATCH";
  const expected = Math.min(request.length, session.byteLength - request.offset);
  return byteLength === expected ? undefined : "RANGE_LENGTH_MISMATCH";
}

/**
 * Narrow frontend-only adapter. It has no URL, path, whole-file, or PDF.js dependency.
 * A caller must discard stale generations rather than allowing old work to update a view.
 */
export class BinaryRangeTransport {
  private readonly active = new Map<string, AbortController>();

  public constructor(
    private readonly session: PdfRangeSession,
    private readonly invoker: BinaryRangeInvoker,
    private readonly isGenerationCurrent: (generation: number) => boolean,
  ) {}

  public registerCancellation(requestId: string): RangeCancellationRegistration {
    const existing = this.active.get(requestId);
    existing?.abort();
    const controller = new AbortController();
    this.active.set(requestId, controller);
    return Object.freeze({ requestId, cancel: () => controller.abort() });
  }

  public cancel(requestId: string): boolean {
    const controller = this.active.get(requestId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  public async read(request: PdfRangeRequest): Promise<RangeResult> {
    const validation = validatePdfRangeRequest(this.session, request);
    if (validation !== undefined || !this.isGenerationCurrent(request.documentGeneration)) return { ok: false, tag: validation ?? "RANGE_STALE" };
    const registration = this.registerCancellation(request.requestId);
    const controller = this.active.get(registration.requestId);
    if (controller === undefined) return { ok: false, tag: "RANGE_CANCELLED" };
    try {
      const bytes = await this.invoker.invoke(request, controller.signal);
      if (controller.signal.aborted) return { ok: false, tag: "RANGE_CANCELLED" };
      if (!this.isGenerationCurrent(request.documentGeneration)) return { ok: false, tag: "RANGE_STALE" };
      const responseValidation = validatePdfRangeResponse(this.session, request, bytes.byteLength);
      return responseValidation === undefined ? { ok: true, bytes } : { ok: false, tag: responseValidation };
    } catch {
      return { ok: false, tag: controller.signal.aborted ? "RANGE_CANCELLED" : "RANGE_FAILED" };
    } finally {
      if (this.active.get(request.requestId) === controller) this.active.delete(request.requestId);
    }
  }
}

export const MAX_BINARY_RANGE_BYTES = RESOURCE_LIMITS.maxRangeBytes;
