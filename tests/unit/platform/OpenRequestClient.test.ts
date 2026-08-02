import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_FAILURE_EVENT, OPEN_REQUEST_EVENT, createOpenRequestClient, type OpenRequestAdoption, type OpenRequestListener } from "../../../src/platform/OpenRequestClient";

const opaque = (character: string) => character.repeat(64);
const request = (requestId: string) => ({ tag: "OPEN_REQUEST", requestId });
const failure = (failureId: string, failureTag: "PDF_INVALID" | "REMOTE_PATH" = "PDF_INVALID") => ({ tag: "OPEN_FAILURE", failureId, failureTag });
const claim = () => ({ sessionId: opaque("b"), documentGeneration: 1, ownerGeneration: 7, length: 42, displayName: "Safe document.pdf" });
const settle = async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); };
async function waitFor(predicate: () => boolean): Promise<void> { for (let attempt = 0; attempt < 128; attempt += 1) { if (predicate()) return; await settle(); } throw new Error("Timed out waiting for open ingress."); }
function listenerHarness() {
  const handlers = new Map<string, (event: { readonly payload: unknown }) => void>();
  const unlisten = vi.fn();
  const listen: OpenRequestListener = vi.fn(async (event, handler) => { handlers.set(event, handler); return unlisten; });
  return { listen, unlisten, emitRequest: (payload: unknown) => handlers.get(OPEN_REQUEST_EVENT)?.({ payload }), emitFailure: (payload: unknown) => handlers.get(OPEN_FAILURE_EVENT)?.({ payload }) };
}
afterEach(() => vi.useRealTimers());

describe("OpenRequestClient", () => {
  it("consumes the authoritative native merged order, including failure before request", async () => {
    const events = listenerHarness();
    const first = opaque("1");
    const second = opaque("2");
    const order: string[] = [];
    const invoke = vi.fn(async (command: string) => command === "list_pending_open_ingress" ? [failure(first), request(second)] : command === "claim_open_request" ? claim() : undefined);
    const client = createOpenRequestClient({ listen: events.listen, invoke, adopt: vi.fn(async (entry: OpenRequestAdoption) => { order.push(`request:${entry.requestId}`); }), onFailure: (tag) => order.push(`failure:${tag}`) });
    await client.ready;
    await waitFor(() => order.length === 2);
    expect(order).toEqual(["failure:PDF_INVALID", `request:${second}`]);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["list_pending_open_ingress", "ack_open_failure", "claim_open_request", "ack_open_request"]);
    client.dispose();
  });

  it("preserves native order when a chooser wake retries a transient head", async () => {
    vi.useFakeTimers();
    const events = listenerHarness();
    const first = opaque("3");
    const second = opaque("4");
    let firstClaims = 0;
    const adopted: string[] = [];
    const terminal = vi.fn();
    const invoke = vi.fn(async (command: string, args: { requestId?: string }) => {
      if (command === "list_pending_open_ingress") return [request(first), request(second)];
      if (command === "claim_open_request" && args.requestId === first && firstClaims++ === 0) throw new Error("transient");
      return command === "claim_open_request" ? claim() : undefined;
    });
    const client = createOpenRequestClient({ listen: events.listen, invoke, adopt: vi.fn((entry: OpenRequestAdoption) => { adopted.push(entry.requestId); }) });
    await client.ready;
    client.admitNotice({ requestId: second }, terminal);
    events.emitRequest({ requestId: second, path: "C:\\secret.pdf" });
    await vi.advanceTimersByTimeAsync(0);
    expect(adopted).toEqual([first, second]);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith(second);
    client.dispose();
  });

  it("does not adopt a later ingress while the FIFO head remains retryable", async () => {
    vi.useFakeTimers();
    const events = listenerHarness();
    const first = opaque("d");
    const second = opaque("e");
    let recover = false;
    const adopted: string[] = [];
    const invoke = vi.fn(async (command: string, args: { requestId?: string }) => {
      if (command === "list_pending_open_ingress") return [request(first), request(second)];
      if (command === "claim_open_request" && args.requestId === first && !recover) throw new Error("transient");
      return command === "claim_open_request" ? claim() : undefined;
    });
    const client = createOpenRequestClient({ listen: events.listen, invoke, adopt: vi.fn((entry: OpenRequestAdoption) => { adopted.push(entry.requestId); }) });
    await client.ready;
    events.emitRequest({ requestId: second });
    await vi.advanceTimersByTimeAsync(50);
    expect(adopted).toEqual([]);
    recover = true;
    client.retryPending();
    await vi.advanceTimersByTimeAsync(0);
    expect(adopted).toEqual([first, second]);
    client.dispose();
  });
  it("uses event payloads only as reconciliation wakeups", async () => {
    const events = listenerHarness();
    const listed = opaque("5");
    const payloadOnly = opaque("6");
    let enumerations = 0;
    const invoke = vi.fn(async (command: string) => {
      if (command === "list_pending_open_ingress") { enumerations += 1; return enumerations === 2 ? [request(listed)] : []; }
      return command === "claim_open_request" ? claim() : undefined;
    });
    const adopt = vi.fn();
    const client = createOpenRequestClient({ listen: events.listen, invoke, adopt });
    await client.ready;
    events.emitRequest({ requestId: payloadOnly, path: "C:\\secret.pdf" });
    events.emitFailure({ failureId: opaque("7"), tag: "PDF_INVALID" });
    await waitFor(() => adopt.mock.calls.length === 1);
    expect(adopt).toHaveBeenCalledWith(expect.objectContaining({ requestId: listed }));
    expect(adopt).not.toHaveBeenCalledWith(expect.objectContaining({ requestId: payloadOnly }));
    client.dispose();
  });

  it("retries a throwing failure callback before acknowledging it, then publishes and acknowledges once", async () => {
    vi.useFakeTimers();
    const events = listenerHarness();
    const failureId = opaque("8");
    let publications = 0;
    const onFailure = vi.fn(() => { publications += 1; if (publications === 1) throw new Error("renderer unavailable"); });
    const invoke = vi.fn(async (command: string) => command === "list_pending_open_ingress" ? [failure(failureId)] : undefined);
    const client = createOpenRequestClient({ listen: events.listen, invoke, adopt: vi.fn(), onFailure });
    await client.ready;
    expect(invoke.mock.calls.filter(([command]) => command === "ack_open_failure")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls.filter(([command]) => command === "ack_open_failure")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls.filter(([command]) => command === "ack_open_failure")).toHaveLength(1);
    client.dispose();
  });

  it("keeps retryable outcomes pending until acknowledgement succeeds and invokes the chooser terminal once", async () => {
    vi.useFakeTimers();
    const events = listenerHarness();
    const requestId = opaque("9");
    let acknowledgements = 0;
    const terminal = vi.fn();
    const invoke = vi.fn(async (command: string) => {
      if (command === "list_pending_open_ingress") return [request(requestId)];
      if (command === "claim_open_request") return claim();
      if (command === "ack_open_request" && acknowledgements++ === 0) throw new Error("transport unavailable");
      return undefined;
    });
    const client = createOpenRequestClient({ listen: events.listen, invoke, adopt: vi.fn() });
    client.admitNotice({ requestId }, terminal);
    await client.ready;
    expect(terminal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith(requestId);
    expect(acknowledgements).toBe(2);
    client.dispose();
  });

  it("rejects oversized native ingress batches and bounds completed request history", async () => {
    const events = listenerHarness();
    const requestIds = Array.from({ length: 65 }, (_, index) => index.toString(16).padStart(64, "0"));
    let ingress: unknown[] = Array.from({ length: 17 }, (_, index) => request(opaque(index.toString(16))));
    const invoke = vi.fn(async (command: string) => command === "list_pending_open_ingress" ? ingress : command === "claim_open_request" ? claim() : undefined);
    const adopt = vi.fn();
    const client = createOpenRequestClient({ listen: events.listen, invoke, adopt });
    await client.ready;
    expect(adopt).not.toHaveBeenCalled();
    for (const id of requestIds) {
      ingress = [request(id)];
      client.retryPending();
      await waitFor(() => adopt.mock.calls.length === requestIds.indexOf(id) + 1);
    }
    ingress = [request(requestIds[0]!)];
    client.retryPending();
    await waitFor(() => adopt.mock.calls.length === 66);
    client.dispose();
  });

  it("preserves strict terminal parsing and path secrecy", async () => {
    const events = listenerHarness();
    const accepted = opaque("a");
    const malformed = opaque("c");
    const terminal = vi.fn();
    let ingress: unknown[] = [request(accepted), request(malformed)];
    const invoke = vi.fn(async (command: string, args: { requestId?: string }) => {
      if (command === "list_pending_open_ingress") return ingress;
      if (command === "claim_open_request" && args.requestId === malformed) return { ...claim(), displayName: "C:\\secret.pdf" };
      return command === "claim_open_request" ? claim() : undefined;
    });
    const client = createOpenRequestClient({ listen: events.listen, invoke, adopt: vi.fn() });
    client.admitNotice({ requestId: accepted }, terminal);
    client.admitNotice({ requestId: malformed }, terminal);
    await client.ready;
    await waitFor(() => terminal.mock.calls.length === 2);
    expect(terminal.mock.calls.map(([id]) => id)).toEqual([accepted, malformed]);
    expect(invoke.mock.calls.some(([, args]) => JSON.stringify(args).includes("secret.pdf"))).toBe(false);
    client.dispose();
  });
});
