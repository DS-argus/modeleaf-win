import { describe, expect, it, vi } from "vitest";
import { createRemovedTabTeardownSupervisor, createShellOpenCoordinator, createWorkspaceTransitionQueue } from "../../src/platform/ShellOpenCoordinator";
import { publishActivateAndAdoptPdfTab } from "../../src/pdf/PdfTabSession";
const opaque = (character: string) => character.repeat(64);
const claim = () => ({ sessionId: opaque("d"), documentGeneration: 1, ownerGeneration: 1, length: 1, displayName: "report.pdf" });
async function waitFor(check: () => void): Promise<void> { for (let attempt = 0; attempt < 100; attempt += 1) { try { check(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 0)); } } check(); }

describe("CP4 shell open coordinator", () => {
  it("acknowledges only after visible adoption commit and rejects malformed claims", async () => {
    const accepted = opaque("a"); const malformed = opaque("b"); let ingress: unknown[] = []; let chooser: unknown = null; let commitVisible!: () => void;
    const visibleCommit = new Promise<void>((resolve) => { commitVisible = resolve; }); const pending: boolean[] = []; const adopted: string[] = [];
    const invoke = vi.fn(async (command: string, args: { requestId?: string }) => command === "open_pdf_dialog" ? chooser : command === "list_pending_open_ingress" ? ingress : command === "claim_open_request" ? args.requestId === malformed ? { ...claim(), displayName: "\\\\server\\secret.pdf" } : claim() : undefined);
    const coordinator = createShellOpenCoordinator({ invoke, listen: async () => () => undefined, dialog: { setPending: (value) => pending.push(value), reportFailure: () => undefined }, adopt: async (request) => { adopted.push(request.requestId); if (request.requestId === accepted) await visibleCommit; }, onFailure: () => undefined });
    await coordinator.ready; chooser = { requestId: accepted }; ingress = [{ tag: "OPEN_REQUEST", requestId: accepted }]; coordinator.requestOpen();
    await waitFor(() => expect(adopted).toEqual([accepted])); expect(invoke).not.toHaveBeenCalledWith("ack_open_request", { requestId: accepted });
    commitVisible(); await waitFor(() => expect(invoke).toHaveBeenCalledWith("ack_open_request", { requestId: accepted }));
    chooser = { requestId: malformed }; ingress = [{ tag: "OPEN_REQUEST", requestId: malformed }]; coordinator.requestOpen(); await waitFor(() => expect(invoke).toHaveBeenCalledWith("reject_open_request", { requestId: malformed }));
    expect(adopted).toEqual([accepted]); expect(pending).toEqual([true, false, true, false]); coordinator.dispose();
  });
  it("publishes visibility before activation and adoption", async () => { const order: string[] = []; await publishActivateAndAdoptPdfTab(() => { order.push("visible"); }, { activate: vi.fn(async () => { order.push("activate"); }) } as never, async () => { order.push("adopt"); }); expect(order).toEqual(["visible", "activate", "adopt"]); });
  it("rejects exactly once when adoption rejects with undefined and never records recent", async () => {
    const requestId = opaque("f"); const invoke = vi.fn(async (command: string) => command === "list_pending_open_ingress" ? [{ tag: "OPEN_REQUEST", requestId }] : command === "claim_open_request" ? claim() : undefined);
    const coordinator = createShellOpenCoordinator({ invoke, listen: async () => () => undefined, dialog: { setPending: () => undefined, reportFailure: () => undefined }, adopt: () => Promise.reject(), onFailure: () => undefined });
    await coordinator.ready; await waitFor(() => expect(invoke).toHaveBeenCalledWith("reject_open_request", { requestId }));
    expect(invoke.mock.calls.filter(([command]) => command === "reject_open_request")).toHaveLength(1); expect(invoke).not.toHaveBeenCalledWith("ack_open_request", { requestId }); expect(invoke.mock.calls.some(([command]) => command === "record_recent")).toBe(false); coordinator.dispose();
  });
  it("rejects saturated ownership adoption before acknowledgement", async () => {
    const requestId = opaque("e"); const queue = createWorkspaceTransitionQueue(() => undefined, 1, 0); const invoke = vi.fn(async (command: string) => command === "list_pending_open_ingress" ? [{ tag: "OPEN_REQUEST", requestId }] : command === "claim_open_request" ? claim() : undefined);
    const coordinator = createShellOpenCoordinator({ invoke, listen: async () => () => undefined, dialog: { setPending: () => undefined, reportFailure: () => undefined }, adopt: () => queue.enqueueOwnership(() => undefined), onFailure: () => undefined });
    await coordinator.ready; await waitFor(() => expect(invoke).toHaveBeenCalledWith("reject_open_request", { requestId })); expect(invoke).not.toHaveBeenCalledWith("ack_open_request", { requestId }); coordinator.dispose();
  });
  it("settles a 10,000 activation burst without retaining superseded waiters", async () => {
    const overflow = vi.fn(); const queue = createWorkspaceTransitionQueue(overflow, 1, 1); const order: string[] = []; let release!: () => void;
    const running = queue.enqueue(async () => { order.push("close"); await new Promise<void>((resolve) => { release = resolve; }); }); const queuedNormal = queue.enqueue(() => { order.push("normal"); }); const overflowed = queue.enqueue(() => { order.push("overflow"); });
    const activations = Array.from({ length: 10_000 }, (_, index) => queue.enqueueActivation(() => { order.push(`activation-${index}`); })); const ownership = queue.enqueueOwnership(() => { order.push("ownership"); });
    await expect(queue.enqueueOwnership(() => undefined)).rejects.toThrow("OWNERSHIP_QUEUE_CAPACITY"); expect(overflow).toHaveBeenCalledOnce(); await Promise.all(activations.slice(0, -1)); release(); await Promise.all([running, queuedNormal, overflowed, ownership, activations[activations.length - 1]!]); expect(order).toEqual(["close", "normal", "activation-9999", "ownership"]);
  });
  it("parks retained teardown after bounded retries until lifecycle retry", async () => { vi.useFakeTimers(); const close = vi.fn(async () => { throw new Error("retry"); }); const remove = vi.fn(); const tab = {}; const teardown = createRemovedTabTeardownSupervisor({ remove, close, initialDelayMs: 10, maxAttempts: 2 }); teardown.remove(tab); await Promise.resolve(); await vi.advanceTimersByTimeAsync(10); await Promise.resolve(); expect(close).toHaveBeenCalledTimes(2); await vi.advanceTimersByTimeAsync(1_000); expect(close).toHaveBeenCalledTimes(2); teardown.retryParked(); await Promise.resolve(); expect(close).toHaveBeenCalledTimes(3); expect(remove).toHaveBeenCalledWith(tab); teardown.dispose(); vi.useRealTimers(); });
});
