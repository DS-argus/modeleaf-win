import { describe, expect, it } from "vitest";
import { createShellOpenCoordinator } from "../../../src/platform/ShellOpenCoordinator";

const REQUEST_ID = "a".repeat(64);
function harness(invokeImpl: (command: string) => Promise<unknown>) {
  const pendingStates: boolean[] = [];
  const coordinator = createShellOpenCoordinator({
    listen: () => () => undefined,
    invoke: (command) => invokeImpl(command),
    dialog: { setPending: (pending) => pendingStates.push(pending), reportFailure: () => undefined },
    adopt: () => undefined,
    onFailure: () => undefined,
  });
  return { coordinator, pendingStates, isPending: () => pendingStates.at(-1) === true };
}
const settle = async (): Promise<void> => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

describe("shell open epoch", () => {
  it("releases when the native dialog is cancelled", async () => {
    const { coordinator, isPending } = harness(async (command) => command === "open_pdf_dialog" ? { tag: "CANCELLED" } : undefined);
    coordinator.requestOpen(); await settle(); expect(isPending()).toBe(false); coordinator.dispose();
  });

  it("allows a second open after cancellation", async () => {
    let dialogCalls = 0;
    const { coordinator } = harness(async (command) => { if (command === "open_pdf_dialog") { dialogCalls += 1; return { tag: "CANCELLED" }; } return undefined; });
    coordinator.requestOpen(); await settle(); coordinator.requestOpen(); await settle();
    expect(dialogCalls).toBe(2); coordinator.dispose();
  });

  it("releases only after a selected request reaches terminal acknowledgement", async () => {
    let selected = false;
    const { coordinator, isPending } = harness(async (command) => {
      if (command === "open_pdf_dialog") { selected = true; return { tag: "ADMITTED", requestId: REQUEST_ID }; }
      if (command === "list_pending_open_ingress") return selected ? [{ tag: "OPEN_REQUEST", requestId: REQUEST_ID }] : [];
      if (command === "claim_open_request") return { sessionId: "s".repeat(64), documentGeneration: 1, ownerGeneration: 1, length: 10, displayName: "a.pdf" };
      return undefined;
    });
    coordinator.requestOpen();
    for (let attempt = 0; attempt < 20 && isPending(); attempt += 1) await settle();
    expect(isPending()).toBe(false); coordinator.dispose();
  });

  it("retains one epoch through retryable adoption and ignores re-entry", async () => {
    let dialogCalls = 0;
    const { coordinator, isPending } = harness(async (command) => {
      if (command === "open_pdf_dialog") { dialogCalls += 1; return { tag: "ADMITTED", requestId: REQUEST_ID }; }
      if (command === "claim_open_request") throw new Error("TRANSIENT_BACKEND_ERROR");
      return undefined;
    });
    coordinator.requestOpen(); await settle(); coordinator.requestOpen(); await settle(); coordinator.requestOpen(); await settle();
    expect(isPending()).toBe(true); expect(dialogCalls).toBe(1); coordinator.dispose(); expect(isPending()).toBe(false);
  });

  it("releases when the dialog invoke rejects or returns a malformed admission", async () => {
    const rejected = harness(async (command) => { if (command === "open_pdf_dialog") throw new Error("DIALOG_FAILED"); return undefined; });
    rejected.coordinator.requestOpen(); await settle(); expect(rejected.isPending()).toBe(false); rejected.coordinator.dispose();
    const malformed = harness(async (command) => command === "open_pdf_dialog" ? { tag: "ADMITTED", requestId: "bad" } : undefined);
    malformed.coordinator.requestOpen(); await settle(); expect(malformed.isPending()).toBe(false); malformed.coordinator.dispose();
  });

  it("suppresses concurrent requests only while the native transition is active", async () => {
    let dialogCalls = 0;
    let resolveDialog: ((value: unknown) => void) | undefined;
    const { coordinator } = harness(async (command) => {
      if (command === "open_pdf_dialog") { dialogCalls += 1; return new Promise((resolve) => { resolveDialog = resolve; }); }
      return undefined;
    });
    coordinator.requestOpen(); await settle(); coordinator.requestOpen(); await settle(); expect(dialogCalls).toBe(1);
    resolveDialog?.({ tag: "CANCELLED" }); await settle(); coordinator.requestOpen(); await settle(); expect(dialogCalls).toBe(2); coordinator.dispose();
  });

  it("rejects browse and recent admissions that arrive after disposal", async () => {
    const recentId = "b".repeat(64);
    let resolveDialog!: (value: unknown) => void;
    const rejected: string[] = [];
    const { coordinator } = harness(async (command) => {
      if (command === "open_pdf_dialog") return new Promise((resolve) => { resolveDialog = resolve; });
      if (command === "reject_open_request") { rejected.push(command); return undefined; }
      return undefined;
    });
    coordinator.requestOpen();
    await settle();
    coordinator.dispose();
    resolveDialog({ tag: "ADMITTED", requestId: REQUEST_ID });
    expect(coordinator.admitOpen({ tag: "ADMITTED", requestId: recentId })).toBe(false);
    await settle();
    expect(rejected).toHaveLength(2);
  });
});
