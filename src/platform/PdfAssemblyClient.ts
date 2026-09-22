import type { PdfAssemblyBoundary, PdfAssemblyReleaseProof } from "../pdf/PdfRangeAssembly";
import type { NativeInvoke } from "./tauri-commands";
export type { PdfAssemblyBoundary, PdfAssemblyReleaseProof } from "../pdf/PdfRangeAssembly";

export interface PdfAssemblySession {
  readonly sessionId: string;
  readonly documentGeneration: number;
}

const MAX_BYTES = 512 * 1024 * 1024;
const PROOFS = new Set<PdfAssemblyReleaseProof>(["UNALLOCATED", "DISCARDED", "TRANSFERRED"]);

const contractError = (): Error => new Error("NATIVE_CONTRACT_INVALID");
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): void => {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) throw contractError();
};
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw contractError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw contractError();
  return value as Record<string, unknown>;
};
const positiveInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw contractError();
  return value;
};
const nonNegativeInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw contractError();
  return value;
};
const validateSession = (session: PdfAssemblySession, ownerGeneration: number): void => {
  if (typeof session.sessionId !== "string" || session.sessionId.length === 0 || new TextEncoder().encode(session.sessionId).byteLength > 128
    || /[\u0000-\u001f\u007f]/u.test(session.sessionId)
    || !Number.isSafeInteger(session.documentGeneration) || session.documentGeneration < 1
    || !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 1) throw contractError();
};
const validateRequest = (requestSequence: number, begin: number, end: number): void => {
  if (!Number.isSafeInteger(requestSequence) || requestSequence < 1
    || !Number.isSafeInteger(begin) || begin < 0
    || !Number.isSafeInteger(end) || end <= begin || end - begin > MAX_BYTES) throw contractError();
};
const baseArgs = (session: PdfAssemblySession, ownerGeneration: number): Record<string, unknown> => ({
  sessionId: session.sessionId,
  documentGeneration: session.documentGeneration,
  ownerGeneration,
});
const decodeVoid = (value: unknown): void => {
  if (value !== undefined && value !== null) throw contractError();
};

function decodeReservation(value: unknown, expectedLength: number): { readonly leaseId: number; readonly byteLength: number } {
  const decoded = object(value);
  exactKeys(decoded, ["leaseId", "byteLength"]);
  const leaseId = positiveInteger(decoded.leaseId);
  const byteLength = nonNegativeInteger(decoded.byteLength);
  if (byteLength !== expectedLength || byteLength > MAX_BYTES) throw contractError();
  return Object.freeze({ leaseId, byteLength });
}

/** Owner/session-bound Tauri adapter for the native assembly-memory ledger. */
export function createPdfAssemblyBoundary(
  invoke: NativeInvoke,
  session: PdfAssemblySession,
  ownerGeneration: number,
): PdfAssemblyBoundary {
  validateSession(session, ownerGeneration);
  const base = baseArgs(session, ownerGeneration);
  return Object.freeze({
    reserve: async (requestSequence: number, begin: number, end: number) => {
      validateRequest(requestSequence, begin, end);
      const value = await invoke<unknown>("reserve_pdf_assembly", {
        request: {
          ...base,
          requestSequence,
          begin,
          end,
        },
      });
      return decodeReservation(value, end - begin);
    },
    cancel: async (requestSequence: number): Promise<void> => {
      if (!Number.isSafeInteger(requestSequence) || requestSequence < 1) throw contractError();
      decodeVoid(await invoke<unknown>("cancel_pdf_assembly", { ...base, requestSequence }));
    },
    release: async (leaseId: number, proof: PdfAssemblyReleaseProof): Promise<void> => {
      if (!Number.isSafeInteger(leaseId) || leaseId < 1 || !PROOFS.has(proof)) throw contractError();
      decodeVoid(await invoke<unknown>("release_pdf_assembly", { ...base, leaseId, proof }));
    },
    finish: async (): Promise<void> => {
      decodeVoid(await invoke<unknown>("finish_pdf_assemblies", base));
    },
  });
}
