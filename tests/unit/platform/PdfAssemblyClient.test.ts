import { describe, expect, it, vi } from "vitest";
import { createPdfAssemblyBoundary } from "../../../src/platform/PdfAssemblyClient";
import type { PdfAssemblyReleaseProof } from "../../../src/pdf/PdfRangeAssembly";
import type { NativeInvoke } from "../../../src/platform/tauri-commands";

const session = { sessionId: "a".repeat(64), documentGeneration: 7 };

describe("owner-bound native assembly client", () => {
  it("captures native identity and sends one strict reservation request", async () => {
    const invoke = vi.fn(async (_command: string, _args?: object) => ({ leaseId: 19, byteLength: 10 }));
    const identity = { ...session };
    const boundary = createPdfAssemblyBoundary(invoke as NativeInvoke, identity, 3);
    identity.sessionId = "b".repeat(64);
    expect(await boundary.reserve(2, 11, 21)).toEqual({ leaseId: 19, byteLength: 10 });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("reserve_pdf_assembly", {
      request: { ...session, ownerGeneration: 3, requestSequence: 2, begin: 11, end: 21 },
    });
  });

  it.each([
    null, [], { leaseId: 0, byteLength: 10 }, { leaseId: 1.5, byteLength: 10 },
    { leaseId: Number.MAX_SAFE_INTEGER + 1, byteLength: 10 },
    { leaseId: 1, byteLength: 9 }, { leaseId: 1, byteLength: 0 },
    { leaseId: 1, byteLength: 10, extra: "not allowed" },
  ])("rejects malformed grants without inventing release proof: %j", async (reply) => {
    const invoke = vi.fn(async (_command: string, _args?: object) => reply);
    const boundary = createPdfAssemblyBoundary(invoke as NativeInvoke, session, 3);
    await expect(boundary.reserve(1, 0, 10)).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toBe("reserve_pdf_assembly");
  });

  it.each([
    [0, 0, 10], [1, -1, 10], [1, 0, 0], [1, 1.5, 10],
    [1, 0, Number.NaN], [1, 0, 512 * 1_048_576 + 1],
  ])("rejects invalid logical demand before invoking native admission", async (sequence, begin, end) => {
    const invoke = vi.fn();
    const boundary = createPdfAssemblyBoundary(invoke as NativeInvoke, session, 3);
    await expect(boundary.reserve(sequence, begin, end)).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps cancel, proven release and post-destroy finish distinct", async () => {
    const invoke = vi.fn(async (_command: string, _args?: object) => null);
    const boundary = createPdfAssemblyBoundary(invoke as NativeInvoke, session, 3);
    await boundary.cancel(2);
    await boundary.release(19, "TRANSFERRED");
    await boundary.finish();
    expect(invoke.mock.calls).toEqual([
      ["cancel_pdf_assembly", { ...session, ownerGeneration: 3, requestSequence: 2 }],
      ["release_pdf_assembly", { ...session, ownerGeneration: 3, leaseId: 19, proof: "TRANSFERRED" }],
      ["finish_pdf_assemblies", { ...session, ownerGeneration: 3 }],
    ]);
  });

  it("rejects forged release kinds and does not turn a failed release into success", async () => {
    const invoke = vi.fn(async (_command: string, _args?: object) => { throw new Error("IPC_UNAVAILABLE"); });
    const boundary = createPdfAssemblyBoundary(invoke as NativeInvoke, session, 3);
    await expect(boundary.release(19, "CALLER_ABANDONED" as PdfAssemblyReleaseProof)).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    expect(invoke).not.toHaveBeenCalled();
    await expect(boundary.release(19, "DISCARDED")).rejects.toThrow("IPC_UNAVAILABLE");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
