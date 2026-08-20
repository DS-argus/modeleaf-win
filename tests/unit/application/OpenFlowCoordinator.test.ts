import { describe, expect, it, vi } from "vitest";
import { createOpenFlowCoordinator } from "../../../src/application/OpenFlowCoordinator";

const id = "a".repeat(64);
const descriptor = { sessionId: "b".repeat(64), documentGeneration: 1, ownerGeneration: 1, length: 10, displayName: "a.pdf" };
describe("OpenFlowCoordinator", () => {
  it("creates one epoch, ignores bursts, and releases exactly once", () => {
    const terminal = vi.fn();
    const flow = createOpenFlowCoordinator(terminal);
    const epoch = flow.begin("empty")!;
    expect(flow.begin("empty")).toBeUndefined();
    expect(flow.showDialog(epoch)).toBe(true);
    expect(flow.admit(epoch, "browse", id)).toBe(true);
    expect(flow.advance(epoch, id, "ADOPT", descriptor)).toBe(true);
    expect(flow.release(epoch, { tag: "ADOPTED", requestId: id, completion: "ACKNOWLEDGED" })).toBe(true);
    expect(flow.release(epoch, { tag: "ADOPTED", requestId: id, completion: "ACKNOWLEDGED" })).toBe(false);
    expect(terminal).toHaveBeenCalledOnce();
  });
  it("rejects stale callbacks and never stores a partial malformed descriptor", () => {
    const flow = createOpenFlowCoordinator();
    const epoch = flow.begin("reader")!;
    expect(flow.admit(epoch, "recent", id)).toBe(true);
    expect(flow.advance(epoch + 1, id, "REJECT", undefined, "CLAIM_INVALID")).toBe(false);
    expect(flow.advance(epoch, id, "REJECT", undefined, "CLAIM_INVALID")).toBe(true);
    expect(flow.state).not.toHaveProperty("trustedDescriptor");
    expect(flow.release(epoch, { tag: "REJECTED", requestId: id, phase: "REJECT", baseReason: "CLAIM_INVALID", cleanup: "NATIVE_LIFECYCLE_ONLY_NO_DESCRIPTOR" })).toBe(true);
  });
  it("keeps base failure orthogonal to descriptor cleanup", () => {
    const flow = createOpenFlowCoordinator();
    const epoch = flow.begin("reader")!;
    flow.admit(epoch, "recent", id);
    flow.advance(epoch, id, "REJECT", descriptor, "ADOPTION_FAILED");
    expect(flow.release(epoch, { tag: "REJECTED", requestId: id, phase: "REJECT", baseReason: "ADOPTION_FAILED", cleanup: "TRANSFERRED_TRUSTED_DESCRIPTOR" })).toBe(true);
  });
});
