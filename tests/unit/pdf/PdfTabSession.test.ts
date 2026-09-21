import { describe, expect, it, vi } from "vitest";
import { PdfTabSession } from "../../../src/pdf/PdfTabSession";
import type { PdfReaderController, PdfViewportRestoreOutcome } from "../../../src/pdf/PdfReaderController";
import type { PdfSearchResult } from "../../../src/pdf/PdfContentController";
import { ResourceReservationManager } from "../../../src/pdf/ResourceBudget";
function createSession(onStatus?: (status: string) => void): PdfTabSession {
  const session = new PdfTabSession({
    native: {} as never,
    pdf: {} as never,
    resources: new ResourceReservationManager(),
    canvasHost: Object.assign(new EventTarget(), { clientWidth: 200, clientHeight: 100, clientLeft: 0, clientTop: 0,
      getBoundingClientRect: () => ({ left: 0, top: 0 }), scrollWidth: 2_000, scrollHeight: 2_000, scrollLeft: 0, scrollTop: 0 }) as unknown as HTMLElement,
    ...(onStatus === undefined ? {} : { onStatus }),
    createContentOptions: () => ({}) as never,
  });
  const reader = (session as unknown as SessionInternals).pdfReader;
  vi.spyOn(reader, "getPageTopLanding").mockImplementation(async (page) => ({ pageIndex: page - 1, x: 0, y: 0 }));
  vi.spyOn(reader, "setPresentationTopology").mockImplementation(async (_topology, page, transform, guard) => reader.renderPageWithTransform(page, transform, guard));
  vi.spyOn(reader, "setOpeningPresentationAtTop").mockImplementation(async (_topology, page, transform, guard) => reader.renderPageWithTransform(page, transform, guard));
  return session;
}

type SearchSnapshot = {
  query: string;
  results: readonly PdfSearchResult[];
  searchPending: boolean;
  searchIncomplete: boolean;
};
type SessionInternals = {
  content?: {
    snapshot: SearchSnapshot;
    nextMatch: (reverse: boolean) => unknown;
    search: (query: string) => Promise<void>;
    suspend: () => void;
    resumeInteractions: () => void;
    restoreEvictedSearch: () => Promise<void>;
    applyQueuedDestinationToResidentPage: (pageNumber: number) => boolean;
    queueDestination: (page: number, destination: readonly unknown[]) => number | undefined;
    awaitDestinationScroll: (intentId: number) => Promise<void>;
    cancelDestination: (intentId?: number, preserveLinkActivation?: boolean) => void;
    synchronizeResidentPages: (pages: readonly number[]) => Promise<void>;
    activateResidentPage: (page: number) => boolean;
    activateVisiblePages: (pages: readonly number[]) => number;
    clearVisibleLinkAuthority: () => void;
    cancelVisibleLinkActivation: () => void;
    evictInactiveHeavyResources: () => boolean;
  };
  pdfReader: {
    evictInactiveCanvas: () => boolean;
    adopt: () => Promise<true>;
    getPageTopLanding: (page: number, transform: unknown, guard: () => boolean) => Promise<{ pageIndex: number; x: number; y: number } | undefined>;
    getPageNaturalSize: (page: number, rotation: number, guard: () => boolean) => Promise<{ width: number; height: number } | undefined>;
    suspend: () => Promise<void>;
    resolvePageReference: (reference: unknown, guard: () => boolean) => Promise<number | null>;
    captureViewportLanding: () => { pageIndex: number; x: number; y: number } | undefined;
    restoreViewportLanding: (
      target: { pageIndex: number; x: number; y: number },
      guard: () => boolean,
      transform?: unknown,
      placement?: "center" | "page-top",
      onViewportOwnershipLost?: () => void,
    ) => Promise<PdfViewportRestoreOutcome>;
    setPresentationTopology: (topology: "continuous" | "single-page", page: number, transform: unknown, guard: () => boolean) => Promise<boolean>;
    setOpeningPresentationAtTop: (topology: "continuous" | "single-page", page: number, transform: unknown, guard: () => boolean) => Promise<boolean>;
    invalidateViewportSynchronization: () => void;
    synchronizeViewport: (scrollTop: number, clientHeight: number, guard: () => boolean) => Promise<boolean>;
    renderPageWithTransform: (page: number, transform: unknown, guard: () => boolean) => Promise<boolean>;
    setViewTransformAtPointer: (transform: unknown, viewportOffset: { x: number; y: number }, guard: () => boolean) => Promise<boolean>;
  };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
const SEARCH_RESULT: PdfSearchResult = { pageNumber: 1, index: 0, length: 1 };

function installContent(session: PdfTabSession, snapshot: SearchSnapshot) {
  const content = {
    snapshot,
    get searchQuery() { return snapshot.query; },
    nextMatch: vi.fn(),
    search: vi.fn(async () => undefined),
    suspend: vi.fn(),
    resumeInteractions: vi.fn(),
    restoreEvictedSearch: vi.fn(async () => undefined),
    queueDestination: vi.fn(() => 1),
    cancelDestination: vi.fn(),
    awaitDestinationScroll: vi.fn(async () => undefined),
    applyQueuedDestinationToResidentPage: vi.fn(() => true),
    takeDestinationLanding: vi.fn<(intentId: number) => { pageIndex: number; x: number; y: number } | undefined>(() => undefined),
    synchronizeResidentPages: vi.fn(async () => undefined),
    activateResidentPage: vi.fn(() => true),
    activateVisiblePages: vi.fn(() => 0),
    clearVisibleLinkAuthority: vi.fn(),
    cancelVisibleLinkActivation: vi.fn(),
    evictInactiveHeavyResources: vi.fn(() => true),
  };
  (session as unknown as SessionInternals).content = content;
  return content;
}

describe("PdfTabSession CP4 pressure and search ownership", () => {
  it("forwards search ownership and clears only the latest search-owned message", async () => {
    const notify = vi.fn();
    const session = new PdfTabSession({
      native: {} as never, pdf: {} as never,
      resources: new ResourceReservationManager(),
      canvasHost: new EventTarget() as unknown as HTMLElement,
      createContentOptions: () => ({ onSearchResults: vi.fn() }) as never,
      onStatus: notify,
    });
    session.reader.mountDocument(3);
    const content = (session as unknown as { createContent: (identity: { sessionId: string; documentGeneration: number }, generation: number) => import("../../../src/pdf/PdfContentController").PdfContentController }).createContent({ sessionId: "status", documentGeneration: 1 }, 1);
    await content.search("needle");
    (session as unknown as { content: typeof content }).content = content;
    const snapshotRead = vi.spyOn(content, "snapshot", "get");
    expect(session.query).toBe("needle");
    expect(snapshotRead).not.toHaveBeenCalled();
    snapshotRead.mockRestore();
    expect(session.snapshot.status).toBe("Search is unavailable.");
    content.invalidateSearch();
    expect(session.snapshot.status).toContain("Page 1 of 3");
    expect(notify).toHaveBeenLastCalledWith(session.snapshot.status);
    await content.search("needle");
    // Even identical text published by an unrelated owner must survive clear.
    session.reader.setStatus("Search is unavailable.");
    content.invalidateSearch();
    expect(session.snapshot.status).toBe("Search is unavailable.");
    await content.search("needle");
    session.reader.setStatus("PDF cleanup pending");
    content.invalidateSearch();
    expect(session.snapshot.status).toBe("PDF cleanup pending");
    await content.search("needle");
    await content.search("  ");
    expect(session.snapshot.status).toContain("Page 1 of 3");
  });
  it("derives page jumps from the target viewport visual top", async () => {
    const session = createSession();
    session.reader.mountDocument(2);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    vi.mocked(reader.getPageTopLanding).mockResolvedValue({ pageIndex: 1, x: 10, y: 90 });
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue({ pageIndex: 0, x: 0, y: 100 });
    const restore = vi.spyOn(reader, "restoreViewportLanding").mockResolvedValue({ kind: "verified", landing: { pageIndex: 1, x: 10, y: 90 } });

    await expect(session.navigatePagePrompt(2)).resolves.toEqual({ kind: "verifiedLanding" });
    expect(reader.getPageTopLanding).toHaveBeenCalledWith(2, expect.objectContaining({ rotation: 0 }), expect.any(Function));
    expect(restore.mock.calls[0]?.[0]).toEqual({ pageIndex: 1, x: 10, y: 90 });
    expect(restore.mock.calls[0]?.[3]).toBe("page-top");
  });
  it("compensates to the origin when a physically verified landing fails history verification", async () => {
    const session = createSession();
    session.reader.mountDocument(2);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    const origin = { pageIndex: 0, x: 5, y: 6 };
    const target = { pageIndex: 1, x: 0, y: 100 };
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue(origin);
    vi.mocked(reader.getPageTopLanding).mockResolvedValue(target);
    const restore = vi.spyOn(reader, "restoreViewportLanding")
      .mockResolvedValueOnce({ kind: "verified", landing: { pageIndex: 1, x: 50, y: 50 } })
      .mockResolvedValueOnce({ kind: "verified", landing: origin });

    await expect(session.navigatePagePrompt(2)).resolves.toEqual({ kind: "compensatedFailure" });
    expect(restore.mock.calls.map((call) => call[0])).toEqual([target, origin]);
    expect(session.canHistoryBack).toBe(false);
  });
  it("derives adjacent pages from the captured viewport and leaves history unchanged", async () => {
    const session = createSession();
    session.reader.mountDocument(4);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue({ pageIndex: 2, x: 5, y: 6 });
    vi.mocked(reader.getPageTopLanding).mockResolvedValue({ pageIndex: 1, x: 0, y: 100 });
    const restore = vi.spyOn(reader, "restoreViewportLanding").mockResolvedValue({ kind: "verified", landing: { pageIndex: 1, x: 0, y: 100 } });

    await expect(session.navigateAdjacentPage(-1)).resolves.toEqual({ kind: "verifiedLanding" });
    expect(reader.getPageTopLanding).toHaveBeenCalledWith(2, expect.objectContaining({ rotation: 0 }), expect.any(Function));
    expect(restore.mock.calls[0]?.[3]).toBe("page-top");
    expect(session.canHistoryBack).toBe(false);
  });
  it("serializes repeated adjacent navigation and stops truthfully at document boundaries", async () => {
    const session = createSession();
    session.reader.mountDocument(3);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    vi.spyOn(reader, "captureViewportLanding")
      .mockReturnValueOnce({ pageIndex: 0, x: 0, y: 0 })
      .mockReturnValueOnce({ pageIndex: 1, x: 0, y: 0 })
      .mockReturnValue({ pageIndex: 2, x: 0, y: 0 });
    vi.mocked(reader.getPageTopLanding).mockImplementation(async (page) => ({ pageIndex: page - 1, x: 0, y: 100 }));
    const firstRestore = deferred<Awaited<ReturnType<SessionInternals["pdfReader"]["restoreViewportLanding"]>>>();
    const restore = vi.spyOn(reader, "restoreViewportLanding")
      .mockImplementationOnce(() => firstRestore.promise)
      .mockResolvedValue({ kind: "verified", landing: { pageIndex: 2, x: 0, y: 100 } });

    const first = session.navigateAdjacentPage(1);
    const second = session.navigateAdjacentPage(1);
    await vi.waitFor(() => expect(reader.getPageTopLanding).toHaveBeenCalledTimes(1));
    firstRestore.resolve({ kind: "verified", landing: { pageIndex: 1, x: 0, y: 100 } });
    await expect(first).resolves.toEqual({ kind: "verifiedLanding" });
    await expect(second).resolves.toEqual({ kind: "verifiedLanding" });
    expect(reader.getPageTopLanding).toHaveBeenNthCalledWith(2, 3, expect.any(Object), expect.any(Function));
    expect(restore).toHaveBeenCalledTimes(2);
    await expect(session.navigateAdjacentPage(1)).resolves.toEqual({ kind: "noOp" });
    expect(restore).toHaveBeenCalledTimes(2);
  });
  it("keeps only the latest pending direction during a delayed adjacent landing", async () => {
    const session = createSession();
    session.reader.mountDocument(5);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    let displayed = { pageIndex: 2, x: 0, y: 0 };
    vi.spyOn(reader, "captureViewportLanding").mockImplementation(() => displayed);
    const blocked = deferred<void>();
    const restore = vi.spyOn(reader, "restoreViewportLanding").mockImplementation(async (target, guard) => {
      await blocked.promise;
      if (!guard()) return { kind: "staleOrCancelled" };
      displayed = target;
      return { kind: "verified", landing: target };
    });
    const first = session.navigateAdjacentPage(1);
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
    const replaced = Array.from({ length: 100 }, (_, index) => session.navigateAdjacentPage(index % 2 === 0 ? 1 : -1));
    const latest = session.navigateAdjacentPage(-1);
    expect(await Promise.all(replaced)).toEqual(Array.from({ length: 100 }, () => ({ kind: "stale" })));
    expect(restore).toHaveBeenCalledOnce();
    blocked.resolve();
    await expect(first).resolves.toEqual({ kind: "verifiedLanding" });
    await expect(latest).resolves.toEqual({ kind: "verifiedLanding" });
    expect(restore.mock.calls.map(([target]) => target.pageIndex)).toEqual([3, 2]);
    expect(displayed.pageIndex).toBe(2);
    expect(session.navigationLandingInProgress).toBe(false);
    expect(session.canHistoryBack).toBe(false);
  });
  it("keeps invocation order authoritative when absolute preflights settle out of order", async () => {
    const session = createSession();
    session.reader.mountDocument(3);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue({ pageIndex: 0, x: 0, y: 100 });
    const firstTarget = deferred<{ pageIndex: number; x: number; y: number }>();
    vi.mocked(reader.getPageTopLanding)
      .mockImplementationOnce(() => firstTarget.promise)
      .mockResolvedValueOnce({ pageIndex: 2, x: 0, y: 100 });
    const restore = vi.spyOn(reader, "restoreViewportLanding").mockResolvedValue({ kind: "verified", landing: { pageIndex: 2, x: 0, y: 100 } });

    const earlier = session.navigatePagePrompt(2);
    await vi.waitFor(() => expect(reader.getPageTopLanding).toHaveBeenCalledTimes(1));
    const later = session.navigateLastPage();
    await expect(later).resolves.toEqual({ kind: "verifiedLanding" });
    firstTarget.resolve({ pageIndex: 1, x: 0, y: 100 });
    await expect(earlier).resolves.toEqual({ kind: "stale" });
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore.mock.calls[0]?.[0]).toEqual({ pageIndex: 2, x: 0, y: 100 });
  });
  it("invalidates queued adjacent steps when navigation is cancelled", async () => {
    const session = createSession();
    session.reader.mountDocument(3);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue({ pageIndex: 0, x: 0, y: 100 });
    vi.mocked(reader.getPageTopLanding).mockResolvedValue({ pageIndex: 1, x: 0, y: 100 });
    const firstRestore = deferred<Awaited<ReturnType<SessionInternals["pdfReader"]["restoreViewportLanding"]>>>();
    const restore = vi.spyOn(reader, "restoreViewportLanding").mockImplementationOnce(() => firstRestore.promise);

    const first = session.navigateAdjacentPage(1);
    const queued = session.navigateAdjacentPage(1);
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
    session.cancelPendingNavigation();
    firstRestore.resolve({ kind: "staleOrCancelled" });
    await expect(first).resolves.toEqual({ kind: "stale" });
    await expect(queued).resolves.toEqual({ kind: "stale" });
    expect(reader.getPageTopLanding).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
  });
  it("handles backward boundaries, compensates failed adjacent landings, and resolves mixed queued moves", async () => {
    const session = createSession();
    session.reader.mountDocument(3);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    const capture = vi.spyOn(reader, "captureViewportLanding");
    const pageTop = vi.mocked(reader.getPageTopLanding);
    const restore = vi.spyOn(reader, "restoreViewportLanding");

    capture.mockReturnValue({ pageIndex: 0, x: 0, y: 100 });
    await expect(session.navigateAdjacentPage(-1)).resolves.toEqual({ kind: "noOp" });
    expect(pageTop).not.toHaveBeenCalled();

    const origin = { pageIndex: 1, x: 2, y: 80 };
    const target = { pageIndex: 2, x: 0, y: 100 };
    capture.mockReturnValueOnce(origin).mockReturnValue(origin);
    pageTop.mockResolvedValueOnce(target);
    restore.mockResolvedValueOnce({ kind: "failed", landing: { pageIndex: 1, x: 9, y: 9 } }).mockResolvedValueOnce({ kind: "verified", landing: origin });
    await expect(session.navigateAdjacentPage(1)).resolves.toEqual({ kind: "compensatedFailure" });
    expect(restore.mock.calls.slice(-2).map((call) => call[0])).toEqual([target, origin]);
    expect(session.canHistoryBack).toBe(false);

    capture.mockReset();
    pageTop.mockReset();
    restore.mockReset();
    capture.mockReturnValueOnce({ pageIndex: 1, x: 0, y: 90 }).mockReturnValueOnce({ pageIndex: 2, x: 0, y: 90 });
    pageTop.mockImplementation(async (page) => ({ pageIndex: page - 1, x: 0, y: 100 }));
    restore.mockImplementation(async (landing) => ({ kind: "verified", landing }));
    const forward = session.navigateAdjacentPage(1);
    const backward = session.navigateAdjacentPage(-1);
    await expect(forward).resolves.toEqual({ kind: "verifiedLanding" });
    await expect(backward).resolves.toEqual({ kind: "verifiedLanding" });
    expect(pageTop.mock.calls.map((call) => call[0])).toEqual([3, 2]);
  });
  it("recaptures the continuous viewport origin after target preflight", async () => {
    const session = createSession();
    session.reader.mountDocument(3);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    const staleOrigin = { pageIndex: 0, x: 1, y: 1 };
    const latestOrigin = { pageIndex: 1, x: 2, y: 2 };
    const target = { pageIndex: 2, x: 0, y: 100 };
    vi.spyOn(reader, "captureViewportLanding")
      .mockReturnValueOnce(staleOrigin)
      .mockReturnValueOnce(latestOrigin)
      .mockReturnValue(target);
    vi.mocked(reader.getPageTopLanding).mockResolvedValue(target);
    const restore = vi.spyOn(reader, "restoreViewportLanding")
      .mockResolvedValueOnce({ kind: "verified", landing: target })
      .mockResolvedValueOnce({ kind: "verified", landing: latestOrigin });

    await expect(session.navigateLastPage()).resolves.toEqual({ kind: "verifiedLanding" });
    await expect(session.navigateHistoryBack()).resolves.toEqual({ kind: "verifiedLanding" });
    expect(restore.mock.calls[1]?.[0]).toEqual(latestOrigin);
  });
  it("cancels an in-flight prompt landing without committing history", async () => {
    const session = createSession();
    session.reader.mountDocument(2);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue({ pageIndex: 0, x: 0, y: 0 });
    vi.mocked(reader.getPageTopLanding).mockResolvedValue({ pageIndex: 1, x: 0, y: 100 });
    const landing = deferred<Awaited<ReturnType<SessionInternals["pdfReader"]["restoreViewportLanding"]>>>();
    vi.spyOn(reader, "restoreViewportLanding").mockImplementationOnce(() => landing.promise);

    const navigation = session.navigatePagePrompt(2);
    await vi.waitFor(() => expect(reader.restoreViewportLanding).toHaveBeenCalledOnce());
    session.cancelPendingNavigation();
    const invalidateViewport = vi.spyOn(reader, "invalidateViewportSynchronization");
    await expect(session.synchronizeViewport(0, 100)).resolves.toBe(false);
    session.invalidateViewportSynchronization();
    expect(invalidateViewport).not.toHaveBeenCalled();
    landing.resolve({ kind: "verified", landing: { pageIndex: 1, x: 0, y: 100 } });
    await expect(navigation).resolves.toEqual({ kind: "stale" });
    expect(session.canHistoryBack).toBe(false);
  });
  it("uses concrete content synchronization and link-authority methods during navigation", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
    };
    session.reader.mountDocument(3);
    await session.activate();
    Object.defineProperty(internals.pdfReader, "visiblePageNumbers", { configurable: true, get: () => [1, 2] });

    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    expect(content.activateResidentPage).toHaveBeenLastCalledWith(1);
    expect(content.activateVisiblePages).toHaveBeenLastCalledWith([1, 2]);

    session.apply({ type: "page.next" });
    session.clearVisibleLinkAuthority();
    expect(content.clearVisibleLinkAuthority).toHaveBeenCalledTimes(2);
  });
  it("keeps resident link authority through a no-op scroll and fences only after host movement", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    session.reader.mountDocument(1);
    await session.activate();

    session.apply({ type: "scroll.byCssPixels", axis: "horizontal", delta: 32 });
    expect(content.clearVisibleLinkAuthority).not.toHaveBeenCalled();

    session.cancelVisibleLinkActivation();
    expect(content.cancelVisibleLinkActivation).toHaveBeenCalledOnce();
    expect(content.clearVisibleLinkAuthority).not.toHaveBeenCalled();

    session.apply({ type: "view.zoom", factor: 1.1 });
    expect(content.clearVisibleLinkAuthority).toHaveBeenCalledOnce();
  });
  it("commits verified history, traverses directionally, and preserves stacks on compensated failure", async () => {
    const session = createSession();
    session.reader.mountDocument(3);
    session.reader.apply({ type: "view.fitWidth" });
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    const origin = { pageIndex: 0, x: 10, y: 20 };
    const pageTwo = { pageIndex: 1, x: 0, y: 0 };
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue(origin);
    const restore = vi.spyOn(reader, "restoreViewportLanding");
    restore.mockResolvedValueOnce({ kind: "verified", landing: pageTwo });

    await expect(session.navigatePagePrompt(2)).resolves.toEqual({ kind: "verifiedLanding" });
    expect(restore.mock.calls[0]?.[2]).toMatchObject({ scale: 2, rotation: 0 });
    expect(session.canHistoryBack).toBe(true);
    expect(session.canHistoryForward).toBe(false);

    vi.mocked(reader.captureViewportLanding).mockReturnValue(pageTwo);
    restore.mockResolvedValueOnce({ kind: "verified", landing: origin });
    await expect(session.navigateHistoryBack()).resolves.toEqual({ kind: "verifiedLanding" });
    expect(session.canHistoryBack).toBe(false);
    expect(session.canHistoryForward).toBe(true);

    vi.mocked(reader.captureViewportLanding).mockReturnValue(origin);
    restore.mockResolvedValueOnce({ kind: "failed", landing: pageTwo }).mockResolvedValueOnce({ kind: "verified", landing: origin });
    await expect(session.navigateLastPage()).resolves.toEqual({ kind: "compensatedFailure" });
    expect(session.canHistoryForward).toBe(true);
  });

  it("coalesces query replacements into one history boundary while displaying every verified result", async () => {
    const session = createSession();
    session.reader.mountDocument(3);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    const pageOne = { pageIndex: 0, x: 4, y: 5 };
    const pageTwo = { pageIndex: 1, x: 6, y: 7 };
    const pageThree = { pageIndex: 2, x: 8, y: 9 };
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue(pageOne);
    const restore = vi.spyOn(reader, "restoreViewportLanding")
      .mockResolvedValueOnce({ kind: "verified", landing: pageTwo })
      .mockResolvedValueOnce({ kind: "verified", landing: pageThree })
      .mockResolvedValueOnce({ kind: "verified", landing: { pageIndex: 0, x: 0, y: 0 } });

    const epoch = session.beginSearchLandingEpoch();
    expect(session.beginSearchLandingEpoch()).toBe(epoch);
    await expect(session.navigateSearchLanding({ searchGeneration: 1, selectionSequence: 1, resultIndex: 0, result: { pageNumber: 2, index: 0, length: 1, geometry: { x: 6, y: 7, width: 1, height: 1 } }, provenance: "initial" })).resolves.toEqual({ kind: "verifiedLanding" });
    vi.mocked(reader.captureViewportLanding).mockReturnValue(pageTwo);
    await expect(session.navigateSearchLanding({ searchGeneration: 1, selectionSequence: 2, resultIndex: 1, result: { pageNumber: 3, index: 0, length: 1, geometry: { x: 8, y: 9, width: 1, height: 1 } }, provenance: "next" })).resolves.toEqual({ kind: "verifiedLanding" });
    expect(restore).toHaveBeenCalledTimes(2);

    vi.mocked(reader.captureViewportLanding).mockReturnValue(pageThree);
    await expect(session.navigateFirstPage()).resolves.toEqual({ kind: "verifiedLanding" });
    expect(session.beginSearchLandingEpoch()).toBeGreaterThan(epoch);
  });
  it("keeps search display-only when no origin was available at arming", async () => {
    const session = createSession();
    session.reader.mountDocument(2);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    const capture = vi.spyOn(reader, "captureViewportLanding").mockReturnValueOnce(undefined).mockReturnValue({ pageIndex: 0, x: 1, y: 1 });
    vi.spyOn(reader, "restoreViewportLanding").mockResolvedValue({ kind: "verified", landing: { pageIndex: 1, x: 2, y: 3 } });

    session.beginSearchLandingEpoch();
    await expect(session.navigateSearchLanding({ searchGeneration: 1, selectionSequence: 1, resultIndex: 0, result: { pageNumber: 2, index: 0, length: 1, geometry: { x: 2, y: 3, width: 1, height: 1 } }, provenance: "initial" })).resolves.toEqual({ kind: "verifiedLanding" });
    expect(capture).toHaveBeenCalled();
    expect(session.canHistoryBack).toBe(false);
  });
  it("physically verifies a later result at the armed origin without another history mutation", async () => {
    const session = createSession();
    session.reader.mountDocument(2);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    const armed = { pageIndex: 0, x: 2, y: 3 };
    const match = { pageIndex: 1, x: 4, y: 5 };
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue(armed);
    const restore = vi.spyOn(reader, "restoreViewportLanding")
      .mockResolvedValueOnce({ kind: "verified", landing: match })
      .mockResolvedValueOnce({ kind: "verified", landing: armed });

    session.beginSearchLandingEpoch();
    await expect(session.navigateSearchLanding({ searchGeneration: 1, selectionSequence: 1, resultIndex: 0, result: { pageNumber: 2, index: 0, length: 1, geometry: { x: 4, y: 5, width: 1, height: 1 } }, provenance: "initial" })).resolves.toEqual({ kind: "verifiedLanding" });
    vi.mocked(reader.captureViewportLanding).mockReturnValue(match);
    await expect(session.navigateSearchLanding({ searchGeneration: 1, selectionSequence: 2, resultIndex: 1, result: { pageNumber: 1, index: 0, length: 1, geometry: { x: 2, y: 3, width: 1, height: 1 } }, provenance: "next" })).resolves.toEqual({ kind: "verifiedLanding" });
    expect(restore).toHaveBeenCalledTimes(2);
    expect(session.canHistoryBack).toBe(true);
  });
  it("records the armed pre-search origin rather than a later live scroll", async () => {
    const session = createSession();
    session.reader.mountDocument(2);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    const armed = { pageIndex: 0, x: 2, y: 3 };
    const scrolled = { pageIndex: 0, x: 20, y: 30 };
    const match = { pageIndex: 1, x: 4, y: 5 };
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue(armed);
    const restore = vi.spyOn(reader, "restoreViewportLanding")
      .mockResolvedValueOnce({ kind: "verified", landing: match })
      .mockResolvedValueOnce({ kind: "verified", landing: armed });

    session.beginSearchLandingEpoch();
    vi.mocked(reader.captureViewportLanding).mockReturnValue(scrolled);
    await expect(session.navigateSearchLanding({ searchGeneration: 1, selectionSequence: 1, resultIndex: 0, result: { pageNumber: 2, index: 0, length: 1, geometry: { x: 4, y: 5, width: 1, height: 1 } }, provenance: "initial" })).resolves.toEqual({ kind: "verifiedLanding" });
    vi.mocked(reader.captureViewportLanding).mockReturnValue(match);
    await expect(session.navigateHistoryBack()).resolves.toEqual({ kind: "verifiedLanding" });
    expect(restore.mock.calls[1]?.[0]).toEqual(armed);
  });
  it("rejects a landing invalidated by query replacement without committing history", async () => {
    const session = createSession();
    session.reader.mountDocument(2);
    await session.activate();
    installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue({ pageIndex: 0, x: 1, y: 1 });
    const landing = deferred<{ kind: "verified"; landing: { pageIndex: number; x: number; y: number } }>();
    vi.spyOn(reader, "restoreViewportLanding").mockReturnValue(landing.promise);

    session.startSearch("alpha");
    const pending = session.navigateSearchLanding({ searchGeneration: 1, selectionSequence: 1, resultIndex: 0, result: { pageNumber: 2, index: 0, length: 1, geometry: { x: 0, y: 0, width: 1, height: 1 } }, provenance: "initial" });
    session.startSearch("beta");
    landing.resolve({ kind: "verified", landing: { pageIndex: 1, x: 0, y: 0 } });
    await expect(pending).resolves.toEqual({ kind: "stale" });
    expect(session.canHistoryBack).toBe(false);
  });

  it("does not compensate a preflight rejection that cannot have moved presentation", async () => {
    const session = createSession();
    session.reader.mountDocument(2);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue({ pageIndex: 0, x: 1, y: 1 });
    const restore = vi.spyOn(reader, "restoreViewportLanding").mockResolvedValue({ kind: "preflightRejected" });

    await expect(session.navigateLastPage()).resolves.toEqual({ kind: "preflightRejected" });
    expect(restore).toHaveBeenCalledOnce();
    expect(session.canHistoryBack).toBe(false);
  });
  it("fails history closed when landing compensation cannot restore authority", async () => {
    const session = createSession();
    session.reader.mountDocument(2);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue({ pageIndex: 0, x: 5, y: 5 });
    vi.spyOn(reader, "restoreViewportLanding")
      .mockResolvedValueOnce({ kind: "failed", landing: { pageIndex: 1, x: 0, y: 0 } })
      .mockResolvedValueOnce({ kind: "failed", landing: { pageIndex: 1, x: 0, y: 0 } });

    await expect(session.navigateLastPage()).resolves.toEqual({ kind: "uncompensatedInvariantFailure" });
    expect(session.canHistoryBack).toBe(false);
    await expect(session.navigatePagePrompt(2)).resolves.toEqual({ kind: "unavailable" });
  });
  it("never evicts an active tab and offers eviction after an inactive tab is suspended", async () => {
    const active = createSession();
    const inactive = createSession();
    const activeEviction = vi.spyOn((active as unknown as SessionInternals).pdfReader, "evictInactiveCanvas").mockReturnValue(false);
    const inactiveEviction = vi.spyOn((inactive as unknown as SessionInternals).pdfReader, "evictInactiveCanvas").mockReturnValue(false);

    active.activate();
    active.evictInactiveHeavyResources();
    await inactive.deactivate();
    inactive.evictInactiveHeavyResources();

    expect(activeEviction).not.toHaveBeenCalled();
    expect(inactiveEviction).toHaveBeenCalledOnce();
  });

  it("captures the inactive viewport anchor before content removes the shared page frame", async () => {
    const session = createSession();
    const content = installContent(session, { query: "match", results: [SEARCH_RESULT], searchPending: false, searchIncomplete: false });
    const reader = (session as unknown as SessionInternals).pdfReader;
    await session.activate();
    await session.deactivate();
    const order: string[] = [];
    vi.spyOn(reader, "evictInactiveCanvas").mockImplementation(() => {
      order.push("canvas-anchor");
      expect(content.evictInactiveHeavyResources).not.toHaveBeenCalled();
      return true;
    });
    content.evictInactiveHeavyResources.mockImplementation(() => {
      order.push("content-layer");
      return true;
    });

    session.evictInactiveHeavyResources();

    expect(order).toEqual(["canvas-anchor", "content-layer"]);
  });
  it("cycles completed results but restarts every prompt query including the same query", async () => {
    const session = createSession();
    await session.activate();
    const content = installContent(session, { query: "match", results: [SEARCH_RESULT], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { pageStepGeneration: number };
    const initialPageStepGeneration = internals.pageStepGeneration;

    expect(session.cycleSearch(true)).toEqual({ kind: "cycle", reverse: true });
    expect(internals.pageStepGeneration).toBe(initialPageStepGeneration + 1);
    expect(content.nextMatch).toHaveBeenCalledWith(true);
    expect(content.search).not.toHaveBeenCalled();
    session.nextMatch(false);
    expect(content.nextMatch).toHaveBeenCalledWith(false);
    expect(internals.pageStepGeneration).toBe(initialPageStepGeneration + 2);

    expect(session.startSearch("  MATCH  ")).toEqual({ kind: "search", query: "match" });
    expect(content.search).toHaveBeenCalledWith("match");
    expect(session.startSearch("Different")).toEqual({ kind: "search", query: "different" });
    expect(content.search).toHaveBeenCalledWith("different");
  });

  it("does not cycle partial results while an interrupted search is waiting to restore", async () => {
    const session = createSession();
    installContent(session, { query: "match", results: [SEARCH_RESULT], searchPending: false, searchIncomplete: true });
    await session.activate();
    expect(session.cycleSearch()).toEqual({ kind: "ignore" });
  });
  it("activates the page nearest the scrolling viewport", async () => {
    const session = createSession();
    const internals = session as unknown as SessionInternals;
    session.reader.mountDocument(3);
    session.reader.restoreView({ zoomMode: "custom", customScale: 1, fitPageReference: undefined, rotationQuarterTurns: 0 });
    await session.activate();
    const render = vi.spyOn(internals.pdfReader, "renderPageWithTransform").mockResolvedValue(true);

    expect(await session.activateViewportPage(2)).toBe(true);
    expect(session.snapshot.reader.page).toBe(2);
    expect(render).toHaveBeenCalledWith(2, expect.objectContaining({ scale: 1 }), expect.any(Function));
  });
  it("preserves fit and custom zoom modes when a canvas commit publishes its transform", () => {
    const session = createSession();
    const internals = session as unknown as { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    session.reader.mountDocument(1);
    session.reader.apply({ type: "view.fitWidth" });
    internals.onPage(1, { scale: 0.75, rotation: 0, devicePixelRatio: 1 });
    expect(session.snapshot.reader.zoomMode).toBe("fit-width");
    expect(session.snapshot.reader.customScale).toBe(0.75);
    session.reader.apply({ type: "view.zoom", factor: 2 });
    internals.onPage(1, { scale: 1.5, rotation: 0, devicePixelRatio: 1 });
    expect(session.snapshot.reader.zoomMode).toBe("custom");
    expect(session.snapshot.reader.customScale).toBe(1.5);
  });
  it("publishes committed title and page state after each reader page callback", () => {
    const statuses: string[] = [];
    const session = createSession((status) => statuses.push(status));
    const callbacks = (session as unknown as {
      pdfReader: {
        options: {
          onCommitted: (pageCount: number, displayName: string) => void;
          onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
        };
      };
    }).pdfReader.options;

    callbacks.onCommitted(3, "fixture.pdf");
    expect(session.snapshot.title).toBe("fixture.pdf");
    expect(session.snapshot.reader.page).toBe(1);
    expect(statuses).toEqual([]);

    callbacks.onPage(1, { scale: 1.25, rotation: 0, devicePixelRatio: 1 });
    const openingStatus = session.snapshot.status;
    expect(statuses).toEqual([openingStatus]);

    expect(session.snapshot.title).toBe("fixture.pdf");
    expect(session.snapshot.reader.page).toBe(1);
    callbacks.onPage(2, { scale: 1.25, rotation: 0, devicePixelRatio: 1 });
    expect(session.snapshot.title).toBe("fixture.pdf");
    expect(session.snapshot.reader.page).toBe(2);
    expect(statuses).toEqual([openingStatus, session.snapshot.status]);
  });
  it("rolls activity back when native resident publication fails", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    content.synchronizeResidentPages.mockRejectedValueOnce(new Error("activate registry failed"));

    await expect(session.activate()).rejects.toThrow("activate registry failed");
    expect(session.snapshot.active).toBe(false);

    vi.spyOn(session, "renderCurrentView").mockResolvedValue(true);
    await session.activate();
    expect(session.snapshot.active).toBe(true);
    content.synchronizeResidentPages.mockRejectedValueOnce(new Error("deactivate registry failed"));
    await expect(session.deactivate()).rejects.toThrow("PDF_ACTIVITY_AUTHORITY_INCOMPLETE");
    expect(session.snapshot.active).toBe(false);
    await expect(session.activate()).rejects.toThrow("PDF_ACTIVITY_AUTHORITY_INCOMPLETE");
  });


  it("revokes resident authority when a later activation restore stage fails", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { presentationDirty: boolean };
    internals.presentationDirty = true;
    vi.spyOn(internals.pdfReader, "suspend").mockResolvedValue();
    vi.spyOn(session, "renderCurrentView").mockRejectedValueOnce(new Error("restore failed"));

    await expect(session.activate()).rejects.toThrow("restore failed");
    expect(session.snapshot.active).toBe(false);
    expect(content.suspend).toHaveBeenCalledOnce();
    expect(content.synchronizeResidentPages).toHaveBeenLastCalledWith([]);
  });

  it("retries a transient false physical restore within the activation lease", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { presentationDirty: boolean };
    internals.presentationDirty = true;
    const render = vi.spyOn(session, "renderCurrentView").mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await session.activate();
    expect(render).toHaveBeenCalledTimes(2);
    expect(session.snapshot.active).toBe(true);
    expect(content.resumeInteractions).toHaveBeenCalledOnce();
  });
  it("fails closed after the bounded presentation restore retries are exhausted", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { presentationDirty: boolean };
    internals.presentationDirty = true;
    vi.spyOn(internals.pdfReader, "suspend").mockResolvedValue();
    const render = vi.spyOn(session, "renderCurrentView").mockResolvedValue(false);

    await expect(session.activate()).rejects.toThrow("PDF_PRESENTATION_RESTORE_FAILED");
    expect(render).toHaveBeenCalledTimes(2);
    expect(session.snapshot.active).toBe(false);
    expect(content.synchronizeResidentPages).toHaveBeenLastCalledWith([]);
  });
  it("keeps links suspended until activation restoration fully settles", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & {
      presentationDirty: boolean;
      presentationEvicted: boolean;
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
    };
    session.reader.mountDocument(1);
    internals.presentationDirty = true;
    internals.presentationEvicted = true;
    let releaseRestore!: () => void;
    content.restoreEvictedSearch.mockImplementationOnce(() => new Promise<undefined>((resolve) => { releaseRestore = () => resolve(undefined); }));
    vi.spyOn(session, "renderCurrentView").mockImplementationOnce(async () => {
      internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
      return true;
    });

    const activation = session.activate();
    await vi.waitFor(() => expect(content.restoreEvictedSearch).toHaveBeenCalledOnce());
    expect(content.resumeInteractions).not.toHaveBeenCalled();
    releaseRestore();
    await activation;
    expect(content.resumeInteractions).toHaveBeenCalledOnce();
  });
  it("prevents a stale activation failure from clearing a newer activation lease", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & {
      presentationDirty: boolean;
      presentationEvicted: boolean;
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
    };
    session.reader.mountDocument(1);
    let rejectFirst!: (error: Error) => void;
    content.synchronizeResidentPages.mockImplementationOnce(() => new Promise<undefined>((_resolve, reject) => { rejectFirst = reject; }));
    const firstActivation = session.activate();
    await vi.waitFor(() => expect(content.synchronizeResidentPages).toHaveBeenCalledOnce());
    await session.deactivate();

    internals.presentationDirty = true;
    internals.presentationEvicted = true;
    let releaseRestore!: () => void;
    content.restoreEvictedSearch.mockImplementationOnce(() => new Promise<undefined>((resolve) => { releaseRestore = () => resolve(undefined); }));
    vi.spyOn(session, "renderCurrentView").mockImplementationOnce(async () => {
      internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
      return true;
    });
    const secondActivation = session.activate();
    await vi.waitFor(() => expect(content.restoreEvictedSearch).toHaveBeenCalledOnce());

    rejectFirst(new Error("stale activation failed"));
    await expect(firstActivation).rejects.toThrow("stale activation failed");
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    expect(content.resumeInteractions).not.toHaveBeenCalled();

    releaseRestore();
    await secondActivation;
    expect(content.resumeInteractions).toHaveBeenCalledOnce();
  });
  it("shares overlapping deactivation settlement and blocks reactivation until revocation completes", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    session.reader.mountDocument(1);
    await session.activate();
    content.resumeInteractions.mockClear();
    let releaseRevocation!: () => void;
    content.synchronizeResidentPages.mockImplementationOnce(() => new Promise<undefined>((resolve) => { releaseRevocation = () => resolve(undefined); }));

    const firstDeactivation = session.deactivate();
    const secondDeactivation = session.deactivate();
    await vi.waitFor(() => expect(content.synchronizeResidentPages).toHaveBeenCalledTimes(2));
    const reactivation = session.activate();
    await Promise.resolve();
    expect(content.synchronizeResidentPages).toHaveBeenCalledTimes(2);
    expect(content.resumeInteractions).not.toHaveBeenCalled();

    releaseRevocation();
    await Promise.all([firstDeactivation, secondDeactivation]);
    await reactivation;
    expect(content.synchronizeResidentPages).toHaveBeenCalledTimes(3);
    expect(content.resumeInteractions).toHaveBeenCalledOnce();
    expect(session.snapshot.active).toBe(true);
  });
  it("quarantines activation when compensating authority revocation fails", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { presentationDirty: boolean };
    internals.presentationDirty = true;
    vi.spyOn(internals.pdfReader, "suspend").mockResolvedValue();
    vi.spyOn(session, "renderCurrentView").mockRejectedValueOnce(new Error("restore failed"));
    content.synchronizeResidentPages.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("revoke failed"));

    await expect(session.activate()).rejects.toThrow("PDF_ACTIVITY_AUTHORITY_INCOMPLETE");
    await expect(session.activate()).rejects.toThrow("PDF_ACTIVITY_AUTHORITY_INCOMPLETE");
    expect(session.snapshot.active).toBe(false);
    expect(content.suspend).toHaveBeenCalledOnce();
  });
  it("keeps public activity committed while compensation settles and blocks retry overlap", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { presentationDirty: boolean };
    internals.presentationDirty = true;
    let releaseSuspend!: () => void;
    let releaseRevoke!: () => void;
    vi.spyOn(internals.pdfReader, "suspend").mockImplementation(() => new Promise<void>((resolve) => { releaseSuspend = resolve; }));
    content.synchronizeResidentPages.mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise<undefined>((resolve) => { releaseRevoke = () => resolve(undefined); }));
    vi.spyOn(session, "renderCurrentView").mockRejectedValueOnce(new Error("restore failed")).mockResolvedValueOnce(true);

    const activation = session.activate();
    await vi.waitFor(() => expect(content.synchronizeResidentPages).toHaveBeenCalledTimes(2));
    expect(session.snapshot.active).toBe(true);
    let retrySettled = false;
    const retry = session.activate().then(() => { retrySettled = true; });
    await Promise.resolve();
    expect(retrySettled).toBe(false);
    expect(session.startSearch("blocked")).toEqual({ kind: "ignore" });
    releaseSuspend();
    releaseRevoke();
    await expect(activation).rejects.toThrow("restore failed");
    await retry;
    expect(session.snapshot.active).toBe(true);
  });

  it("still attempts empty authority publication when reader suspension fails", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { presentationDirty: boolean };
    internals.presentationDirty = true;
    vi.spyOn(internals.pdfReader, "suspend").mockRejectedValue(new Error("suspend failed"));
    vi.spyOn(session, "renderCurrentView").mockRejectedValueOnce(new Error("restore failed"));

    await expect(session.activate()).rejects.toThrow("PDF_ACTIVITY_AUTHORITY_INCOMPLETE");
    expect(content.synchronizeResidentPages).toHaveBeenLastCalledWith([]);
    expect(content.synchronizeResidentPages).toHaveBeenCalledTimes(2);
    expect(session.snapshot.active).toBe(false);
  });
  it("rolls back a failed page render only for its owning active generation", () => {
    const session = createSession();
    session.reader.mountDocument(3);
    session.activate();
    (session as unknown as { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void })
      .onPage(1, { scale: 1.25, rotation: 0, devicePixelRatio: 1 });
    session.apply({ type: "page.next" });
    const internals = session as unknown as { rollbackPendingRender: (intent: number, activityGeneration: number) => void };
    internals.rollbackPendingRender(1, 1);
    expect(session.snapshot.reader.page).toBe(1);

    session.apply({ type: "page.next" });
    internals.rollbackPendingRender(2, 0);
    expect(session.snapshot.reader.page).toBe(2);
  });
  it("rolls a failed successor back to the retained canvas commit after a cancelled intent", () => {
    const session = createSession();
    const internals = session as unknown as {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      rollbackPendingRender: (intent: number, activityGeneration: number) => void;
    };
    session.reader.mountDocument(3);
    session.activate();
    internals.onPage(1, { scale: 1.25, rotation: 0, devicePixelRatio: 1 });

    session.apply({ type: "page.next" });
    session.apply({ type: "page.next" });
    internals.rollbackPendingRender(1, 1);
    internals.rollbackPendingRender(2, 1);

    expect(session.snapshot.reader.page).toBe(1);
  });
  it("rolls logical and content ownership back when presentation recovery rejects", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    session.reader.mountDocument(3);
    session.reader.restoreView({ zoomMode: "custom", customScale: 1, fitPageReference: undefined, rotationQuarterTurns: 0 });
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    Object.defineProperty(internals.pdfReader, "activePageNumber", { configurable: true, get: () => 1 });
    const onReaderStatus = (internals.pdfReader as unknown as { options: { onStatus: (status: string) => void } }).options.onStatus;
    internals.pdfReader.renderPageWithTransform = vi.fn(async () => {
      onReaderStatus("PDF direct rollback was incomplete.");
      throw new Error("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
    });
    session.apply({ type: "page.next" });

    await expect(session.renderPage(2)).rejects.toThrow("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
    expect(session.snapshot.reader.page).toBe(1);
    expect(content.activateResidentPage).toHaveBeenLastCalledWith(1);
    expect(session.snapshot.status).toBe("PDF direct rollback was incomplete.");
  });

  it("preserves a precise viewport recovery diagnostic while observing rejection", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    const reader = internals.pdfReader as unknown as {
      activePageNumber?: number;
      options: { onStatus: (status: string) => void };
      synchronizeViewport: (scrollTop: number, clientHeight: number, guard: () => boolean) => Promise<boolean>;
    };
    session.reader.mountDocument(3);
    session.reader.restoreView({ zoomMode: "custom", customScale: 1, fitPageReference: undefined, rotationQuarterTurns: 0 });
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    Object.defineProperty(reader, "activePageNumber", { configurable: true, get: () => 1 });
    reader.synchronizeViewport = vi.fn(async () => {
      reader.options.onStatus("PDF viewport rollback was incomplete.");
      throw new Error("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
    });

    await expect(session.synchronizeViewport(0, 100)).rejects.toThrow("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
    expect(session.snapshot.status).toBe("PDF viewport rollback was incomplete.");
    expect(content.activateResidentPage).toHaveBeenLastCalledWith(1);
  });
  it("suspends content when recovery has no physical active page", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { recoverFailedPresentation: (intent: number, activityGeneration: number) => void; presentationDirty: boolean };
    session.reader.mountDocument(1);
    await session.activate();
    Object.defineProperty(internals.pdfReader, "activePageNumber", { configurable: true, get: () => undefined });

    internals.recoverFailedPresentation(0, 1);
    expect(content.suspend).toHaveBeenCalledOnce();
    expect(internals.presentationDirty).toBe(true);
    (session as unknown as { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void })
      .onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    expect(content.resumeInteractions).toHaveBeenCalled();
  });
  it("guards ordinary PDF page-reference resolution with foreground ownership", async () => {
    const session = createSession();
    const reader = (session as unknown as SessionInternals).pdfReader;
    const reference = Object.freeze({ num: 8, gen: 0 });
    const resolve = vi.spyOn(reader, "resolvePageReference")
      .mockImplementation(async (_reference, guard) => guard() ? 2 : null);

    await expect(session.resolveDestinationPage(reference)).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    await session.activate();
    await expect(session.resolveDestinationPage(reference)).resolves.toBe(2);
    expect(resolve).toHaveBeenCalledWith(reference, expect.any(Function));
    const ownershipGuard = resolve.mock.calls[0]?.[1];
    expect(ownershipGuard?.()).toBe(true);
    await session.deactivate();
    expect(ownershipGuard?.()).toBe(false);
    await expect(session.resolveDestinationPage(reference)).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledOnce();
  });
  it("keeps one landing owner through awaited viewport materialization before committing history", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    const reader = internals.pdfReader;
    session.reader.mountDocument(3);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    reader.getPageNaturalSize = vi.fn(async () => ({ width: 200, height: 100 }));
    const origin = { pageIndex: 0, x: 5, y: 6 };
    const displayedTarget = { pageIndex: 1, x: 20, y: 30 };
    vi.spyOn(reader, "captureViewportLanding").mockReturnValueOnce(origin).mockReturnValue(displayedTarget);
    vi.spyOn(reader, "renderPageWithTransform").mockImplementation(async (page, transform, guard) => {
      if (!guard()) return false;
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    });
    content.takeDestinationLanding.mockReturnValue(displayedTarget);
    content.applyQueuedDestinationToResidentPage.mockReturnValue(false);
    let activationCurrent = true;
    content.cancelDestination.mockImplementation((intentId, preserveLinkActivation) => {
      if (intentId === undefined && !preserveLinkActivation) activationCurrent = false;
    });
    const materialization = deferred<void>();
    const restore = vi.spyOn(reader, "restoreViewportLanding").mockImplementationOnce(async (target, guard) => {
      await materialization.promise;
      return guard() ? { kind: "verified", landing: target } : { kind: "staleOrCancelled" };
    });

    let settled = false;
    const navigation = session.navigateToDestination(2, [null, { name: "XYZ" }, 20, 30, null], "internal-link", () => activationCurrent)
      .then((outcome) => { settled = true; return outcome; });
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());

    expect(settled).toBe(false);
    expect(session.navigationLandingInProgress).toBe(true);
    expect(session.canHistoryBack).toBe(false);
    await expect(session.synchronizeViewport(25, 100)).resolves.toBe(false);
    (session as unknown as { options: { canvasHost: EventTarget } }).options.canvasHost.dispatchEvent(new Event("scroll"));
    expect(session.navigationLandingInProgress).toBe(true);
    const renderGuard = vi.mocked(reader.renderPageWithTransform).mock.calls[0]?.[2];
    expect(renderGuard?.()).toBe(true);

    materialization.resolve();
    await expect(navigation).resolves.toEqual({ kind: "verified" });
    expect(restore).toHaveBeenCalledWith(
      displayedTarget,
      expect.any(Function),
      expect.objectContaining({ scale: 1, rotation: 0 }),
      "center",
      expect.any(Function),
    );
    expect(content.queueDestination).toHaveBeenCalledOnce();
    expect(content.applyQueuedDestinationToResidentPage).toHaveBeenCalledWith(2);
    expect(content.cancelDestination).toHaveBeenCalledWith(undefined, true);
    expect(activationCurrent).toBe(true);
    expect(session.navigationLandingInProgress).toBe(false);
    expect(session.canHistoryBack).toBe(true);
    expect(session.canHistoryForward).toBe(false);
  });
  it.each([true, false])("verifies the constrained completion against actual capture before history commit: %s", async (captureMatches) => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    const reader = internals.pdfReader;
    session.reader.mountDocument(3);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    reader.getPageNaturalSize = vi.fn(async () => ({ width: 200, height: 100 }));
    const origin = { pageIndex: 0, x: 5, y: 6 };
    const initialLanding = { pageIndex: 1, x: 20, y: 30 };
    const constrainedLanding = { pageIndex: 1, x: 20, y: 25 };
    const actualLanding = captureMatches ? constrainedLanding : { ...constrainedLanding, y: 15 };
    const capture = vi.spyOn(reader, "captureViewportLanding").mockReturnValueOnce(origin).mockReturnValue(actualLanding);
    vi.spyOn(reader, "renderPageWithTransform").mockImplementation(async (page, transform, guard) => {
      if (!guard()) return false;
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    });
    content.takeDestinationLanding.mockReturnValue(initialLanding);
    const restore = vi.spyOn(reader, "restoreViewportLanding")
      .mockResolvedValueOnce({ kind: "constrainedEdgeVerified", landing: constrainedLanding, expected: constrainedLanding })
      .mockImplementationOnce(async (target) => {
        capture.mockReturnValue(origin);
        internals.onPage(target.pageIndex + 1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
        return { kind: "verified", landing: target };
      });

    await expect(session.navigateToDestination(2, [null, { name: "XYZ" }, 20, 30, null]))
      .resolves.toEqual({ kind: captureMatches ? "verified" : "failed" });
    expect(restore.mock.calls.map((call) => call[0])).toEqual(captureMatches ? [initialLanding] : [initialLanding, origin]);
    expect(session.canHistoryBack).toBe(captureMatches);
    expect(session.canHistoryForward).toBe(false);
    expect(session.snapshot.reader.page).toBe(captureMatches ? 2 : 1);
    expect(session.navigationLandingInProgress).toBe(false);
  });
  it("compensates the origin when post-scroll viewport materialization fails", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    const reader = internals.pdfReader;
    session.reader.mountDocument(3);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    reader.getPageNaturalSize = vi.fn(async () => ({ width: 200, height: 100 }));
    const origin = { pageIndex: 0, x: 5, y: 6 };
    const displayedTarget = { pageIndex: 1, x: 20, y: 30 };
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue(origin);
    vi.spyOn(reader, "renderPageWithTransform").mockImplementation(async (page, transform, guard) => {
      if (!guard()) return false;
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    });
    content.takeDestinationLanding.mockReturnValue(displayedTarget);
    const restore = vi.spyOn(reader, "restoreViewportLanding")
      .mockResolvedValueOnce({ kind: "failed" })
      .mockImplementationOnce(async (target) => {
        internals.onPage(target.pageIndex + 1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
        return { kind: "verified", landing: target };
      });

    await expect(session.navigateToDestination(2, [null, { name: "XYZ" }, 20, 30, null])).resolves.toEqual({ kind: "failed" });
    expect(restore.mock.calls.map((call) => call[0])).toEqual([displayedTarget, origin]);
    expect(session.snapshot.reader.page).toBe(1);
    expect(session.canHistoryBack).toBe(false);
  });
  it("fences a raw viewport change during materialization without restoring over the newer position", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void; options: { canvasHost: HTMLElement } };
    const reader = internals.pdfReader;
    const host = internals.options.canvasHost;
    session.reader.mountDocument(2);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    reader.getPageNaturalSize = vi.fn(async () => ({ width: 200, height: 100 }));
    const origin = { pageIndex: 0, x: 5, y: 6 };
    const displayedTarget = { pageIndex: 1, x: 20, y: 30 };
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue(origin);
    vi.spyOn(reader, "renderPageWithTransform").mockImplementation(async (page, transform, guard) => {
      if (!guard()) return false;
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    });
    content.takeDestinationLanding.mockReturnValue(displayedTarget);
    const materialization = deferred<void>();
    const restore = vi.spyOn(reader, "restoreViewportLanding").mockImplementationOnce(async (
      target,
      guard,
      _transform,
      _placement,
      onViewportOwnershipLost,
    ) => {
      const ownedLeft = host.scrollLeft;
      const ownedTop = host.scrollTop;
      await materialization.promise;
      if (host.scrollLeft !== ownedLeft || host.scrollTop !== ownedTop) {
        onViewportOwnershipLost?.();
        return { kind: "staleOrCancelled" };
      }
      return guard() ? { kind: "verified", landing: target } : { kind: "staleOrCancelled" };
    });

    const navigation = session.navigateToDestination(2, [null, { name: "XYZ" }, 20, 30, null]);
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
    host.scrollLeft = 17;
    host.scrollTop = 61;
    host.dispatchEvent(new Event("scroll"));
    materialization.resolve();

    await expect(navigation).resolves.toEqual({ kind: "stale" });
    expect(restore).toHaveBeenCalledOnce();
    expect({ left: host.scrollLeft, top: host.scrollTop }).toEqual({ left: 17, top: 61 });
    expect(session.snapshot.reader.page).toBe(2);
    expect(session.canHistoryBack).toBe(false);
  });
  it("retains the explicit-cancellation landing owner until origin compensation settles", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    const reader = internals.pdfReader;
    session.reader.mountDocument(2);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    reader.getPageNaturalSize = vi.fn(async () => ({ width: 200, height: 100 }));
    const origin = { pageIndex: 0, x: 5, y: 6 };
    const displayedTarget = { pageIndex: 1, x: 20, y: 30 };
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue(origin);
    vi.spyOn(reader, "renderPageWithTransform").mockImplementation(async (page, transform, guard) => {
      if (!guard()) return false;
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    });
    content.takeDestinationLanding.mockReturnValue(displayedTarget);
    const materialization = deferred<void>();
    const compensationStarted = deferred<void>();
    const compensation = deferred<void>();
    const restore = vi.spyOn(reader, "restoreViewportLanding")
      .mockImplementationOnce(async (_target, guard) => {
        await materialization.promise;
        return guard() ? { kind: "verified", landing: displayedTarget } : { kind: "staleOrCancelled" };
      })
      .mockImplementationOnce(async (target, guard) => {
        compensationStarted.resolve();
        await compensation.promise;
        if (!guard()) return { kind: "staleOrCancelled" };
        internals.onPage(target.pageIndex + 1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
        return { kind: "verified", landing: target };
      });

    const navigation = session.navigateToDestination(2, [null, { name: "XYZ" }, 20, 30, null]);
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
    session.cancelPendingNavigation();
    materialization.resolve();
    await compensationStarted.promise;

    expect(session.navigationLandingInProgress).toBe(true);
    expect(session.canHistoryBack).toBe(false);
    const viewportSync = vi.spyOn(reader, "synchronizeViewport");
    await expect(session.synchronizeViewport(25, 100)).resolves.toBe(false);
    expect(viewportSync).not.toHaveBeenCalled();

    compensation.resolve();
    await expect(navigation).resolves.toEqual({ kind: "stale" });
    expect(restore.mock.calls[1]?.[0]).toEqual(origin);
    expect(session.navigationLandingInProgress).toBe(false);
    expect(session.snapshot.reader.page).toBe(1);
    expect(session.canHistoryBack).toBe(false);
  });
  it("retains the landing owner while compensating a stale link activation", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    const reader = internals.pdfReader;
    session.reader.mountDocument(2);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    reader.getPageNaturalSize = vi.fn(async () => ({ width: 200, height: 100 }));
    const origin = { pageIndex: 0, x: 5, y: 6 };
    const displayedTarget = { pageIndex: 1, x: 20, y: 30 };
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue(origin);
    vi.spyOn(reader, "renderPageWithTransform").mockImplementation(async (page, transform, guard) => {
      if (!guard()) return false;
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    });
    content.takeDestinationLanding.mockReturnValue(displayedTarget);
    const materialization = deferred<void>();
    const compensationStarted = deferred<void>();
    const compensation = deferred<void>();
    const restore = vi.spyOn(reader, "restoreViewportLanding")
      .mockImplementationOnce(async (_target, guard) => {
        await materialization.promise;
        return guard() ? { kind: "verified", landing: displayedTarget } : { kind: "staleOrCancelled" };
      })
      .mockImplementationOnce(async (target, guard) => {
        compensationStarted.resolve();
        await compensation.promise;
        if (!guard()) return { kind: "staleOrCancelled" };
        internals.onPage(target.pageIndex + 1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
        return { kind: "verified", landing: target };
      });
    let activationCurrent = true;

    const navigation = session.navigateToDestination(
      2,
      [null, { name: "XYZ" }, 20, 30, null],
      "internal-link",
      () => activationCurrent,
    );
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
    activationCurrent = false;
    materialization.resolve();
    await compensationStarted.promise;

    expect(session.navigationLandingInProgress).toBe(true);
    expect(session.canHistoryBack).toBe(false);
    const viewportSync = vi.spyOn(reader, "synchronizeViewport");
    await expect(session.synchronizeViewport(25, 100)).resolves.toBe(false);
    expect(viewportSync).not.toHaveBeenCalled();

    compensation.resolve();
    await expect(navigation).resolves.toEqual({ kind: "stale" });
    expect(restore.mock.calls[1]?.[0]).toEqual(origin);
    expect(session.navigationLandingInProgress).toBe(false);
    expect(session.snapshot.reader.page).toBe(1);
    expect(session.canHistoryBack).toBe(false);
  });
  it("lets newer raw input fence explicit-cancellation compensation", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      options: { canvasHost: HTMLElement };
    };
    const reader = internals.pdfReader;
    const host = internals.options.canvasHost;
    session.reader.mountDocument(2);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    reader.getPageNaturalSize = vi.fn(async () => ({ width: 200, height: 100 }));
    const origin = { pageIndex: 0, x: 5, y: 6 };
    const displayedTarget = { pageIndex: 1, x: 20, y: 30 };
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue(origin);
    vi.spyOn(reader, "renderPageWithTransform").mockImplementation(async (page, transform, guard) => {
      if (!guard()) return false;
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    });
    content.takeDestinationLanding.mockReturnValue(displayedTarget);
    const materialization = deferred<void>();
    const compensationStarted = deferred<void>();
    const compensation = deferred<void>();
    const restore = vi.spyOn(reader, "restoreViewportLanding")
      .mockImplementationOnce(async (_target, guard) => {
        await materialization.promise;
        return guard() ? { kind: "verified", landing: displayedTarget } : { kind: "staleOrCancelled" };
      })
      .mockImplementationOnce(async (target, guard) => {
        compensationStarted.resolve();
        await compensation.promise;
        if (!guard()) return { kind: "staleOrCancelled" };
        internals.onPage(target.pageIndex + 1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
        return { kind: "verified", landing: target };
      });

    const navigation = session.navigateToDestination(2, [null, { name: "XYZ" }, 20, 30, null]);
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
    session.cancelPendingNavigation();
    materialization.resolve();
    await compensationStarted.promise;

    expect(session.navigationLandingInProgress).toBe(true);
    host.scrollLeft = 17;
    host.scrollTop = 61;
    host.dispatchEvent(new Event("wheel"));
    expect(session.navigationLandingInProgress).toBe(true);
    await expect(session.synchronizeViewport(17, 100)).resolves.toBe(false);
    compensation.resolve();

    await expect(navigation).resolves.toEqual({ kind: "stale" });
    expect(restore).toHaveBeenCalledTimes(2);
    expect({ left: host.scrollLeft, top: host.scrollTop }).toEqual({ left: 17, top: 61 });
    expect(session.navigationLandingInProgress).toBe(false);
    expect(session.snapshot.reader.page).toBe(2);
    expect(session.canHistoryBack).toBe(false);
  });
  it("does not let a stale materialization clear or overwrite a newer destination", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    const reader = internals.pdfReader;
    session.reader.mountDocument(3);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    reader.getPageNaturalSize = vi.fn(async () => ({ width: 200, height: 100 }));
    const origin = { pageIndex: 0, x: 5, y: 6 };
    const firstTarget = { pageIndex: 1, x: 20, y: 30 };
    const secondTarget = { pageIndex: 2, x: 40, y: 50 };
    vi.spyOn(reader, "captureViewportLanding").mockImplementation(() => {
      if (session.snapshot.reader.page === 1) return origin;
      return session.snapshot.reader.page === 2 ? firstTarget : secondTarget;
    });
    vi.spyOn(reader, "renderPageWithTransform").mockImplementation(async (page, transform, guard) => {
      if (!guard()) return false;
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    });
    content.queueDestination.mockReturnValueOnce(1).mockReturnValueOnce(2);
    content.takeDestinationLanding.mockImplementation((intentId) => intentId === 1 ? firstTarget : secondTarget);
    const firstMaterialization = deferred<void>();
    const secondMaterialization = deferred<void>();
    const restore = vi.spyOn(reader, "restoreViewportLanding")
      .mockImplementationOnce(async (target, guard) => {
        await firstMaterialization.promise;
        return guard() ? { kind: "verified", landing: target } : { kind: "staleOrCancelled" };
      })
      .mockImplementationOnce(async (target, guard) => {
        await secondMaterialization.promise;
        return guard() ? { kind: "verified", landing: target } : { kind: "staleOrCancelled" };
      });

    const first = session.navigateToDestination(2, [null, { name: "XYZ" }, 20, 30, null]);
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
    const second = session.navigateToDestination(3, [null, { name: "XYZ" }, 40, 50, null]);
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(2));

    firstMaterialization.resolve();
    await expect(first).resolves.toEqual({ kind: "stale" });
    expect(session.navigationLandingInProgress).toBe(true);
    expect(session.snapshot.reader.page).toBe(3);
    expect(session.canHistoryBack).toBe(false);

    secondMaterialization.resolve();
    await expect(second).resolves.toEqual({ kind: "verified" });
    expect(session.navigationLandingInProgress).toBe(false);
    expect(session.snapshot.reader.page).toBe(3);
    expect(session.canHistoryBack).toBe(true);
  });
  it("compensates a published destination when its independently captured center is unavailable", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    const reader = internals.pdfReader;
    session.reader.mountDocument(2);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    reader.getPageNaturalSize = vi.fn(async () => ({ width: 200, height: 100 }));
    const origin = { pageIndex: 0, x: 5, y: 6 };
    vi.spyOn(reader, "captureViewportLanding").mockReturnValue(origin);
    vi.spyOn(reader, "renderPageWithTransform").mockImplementation(async (page, transform, guard) => {
      if (!guard()) return false;
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    });
    const restore = vi.spyOn(reader, "restoreViewportLanding").mockImplementation(async (target) => {
      internals.onPage(target.pageIndex + 1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
      return { kind: "verified", landing: target };
    });
    content.takeDestinationLanding.mockReturnValue(undefined);

    await expect(session.navigateToDestination(2, [null, { name: "XYZ" }, 20, 30, null])).resolves.toEqual({ kind: "failed" });
    expect(restore).toHaveBeenCalledWith(origin, expect.any(Function), expect.any(Object), "center");
    expect(session.snapshot.reader.page).toBe(1);
    expect(session.canHistoryBack).toBe(false);
  });
  it("rejects a destination before queuing when history preflight is unavailable", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    session.reader.mountDocument(3);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    internals.pdfReader.getPageNaturalSize = vi.fn(async () => ({ width: 200, height: 100 }));
    internals.pdfReader.getPageTopLanding = vi.fn(async () => ({ pageIndex: 1, x: 0, y: 100 }));
    internals.pdfReader.renderPageWithTransform = vi.fn(async () => { throw new Error("PDF_RESIDENT_AUTHORITY_INCOMPLETE"); });
    Object.defineProperty(internals.pdfReader, "activePageNumber", { configurable: true, get: () => 1 });

    await expect(session.navigateToDestination(2, [null, { name: "XYZ" }, 0, 100, null])).resolves.toEqual({ kind: "rejected" });
    expect(content.cancelDestination).not.toHaveBeenCalled();
    expect(session.snapshot.reader.page).toBe(1);
  });
  it("marks an interrupted render dirty and restores the current intent on reactivation", async () => {
    const session = createSession();
    vi.spyOn((session as unknown as SessionInternals).pdfReader, "synchronizeViewport").mockResolvedValue(true);
    const internals = session as unknown as {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      pdfReader: {
        renderPageWithTransform: (page: number, transform: unknown, guard: () => boolean) => Promise<boolean>;
        suspend: () => Promise<void>;
      };
    };
    session.reader.mountDocument(3);
    session.activate();
    internals.onPage(1, { scale: 1.25, rotation: 0, devicePixelRatio: 1 });
    session.reader.apply({ type: "view.zoom", factor: 1 });
    let settleRender!: (committed: boolean) => void;
    const interrupted = new Promise<boolean>((resolve) => { settleRender = resolve; });
    vi.spyOn(internals.pdfReader, "renderPageWithTransform")
      .mockImplementationOnce(() => interrupted)
      .mockResolvedValueOnce(true);
    vi.spyOn(internals.pdfReader, "suspend").mockResolvedValue();

    session.apply({ type: "page.next" });
    const rendering = session.renderPage(2);
    await Promise.resolve();
    await session.deactivate();
    settleRender(false);
    await expect(rendering).resolves.toBe(false);

    const restore = vi.spyOn(session, "renderCurrentView");
    await session.activate();
    expect(restore).toHaveBeenCalledOnce();
    expect(internals.pdfReader.renderPageWithTransform).toHaveBeenLastCalledWith(2, expect.anything(), expect.any(Function));
  });

  it("keeps a render failure diagnostic after rolling state back to the committed canvas", () => {
    const session = createSession();
    const internals = session as unknown as {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      rollbackPendingRender: (intent: number, activityGeneration: number, failureStatus?: string) => void;
    };
    session.reader.mountDocument(3);
    session.activate();
    internals.onPage(1, { scale: 1.25, rotation: 0, devicePixelRatio: 1 });
    session.apply({ type: "page.next" });

    internals.rollbackPendingRender(1, 1, "Could not read this PDF.");

    expect(session.snapshot.reader.page).toBe(1);
    expect(session.snapshot.status).toBe("Could not read this PDF.");
  });

  it("restores an inactive tab when its committed DPR differs from the current DPR", async () => {
    const globalWindow = globalThis as unknown as { window?: { devicePixelRatio: number } };
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
    try {
      const session = createSession();
      const internals = session as unknown as { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
      session.reader.mountDocument(1);
      session.activate();
      internals.onPage(1, { scale: 1.25, rotation: 0, devicePixelRatio: 1 });
      await session.deactivate();
      globalWindow.window!.devicePixelRatio = 2;
      const restore = vi.spyOn(session, "renderCurrentView").mockResolvedValue(true);

      await session.activate();

      expect(restore).toHaveBeenCalledOnce();
    } finally {
      if (windowDescriptor === undefined) delete globalWindow.window;
      else Object.defineProperty(globalThis, "window", windowDescriptor);
    }
  });

  it("returns committed adoption success and rejects a non-commit", async () => {
    const session = createSession();
    const internals = session as unknown as SessionInternals;
    vi.spyOn(internals.pdfReader, "adopt").mockResolvedValue(true);
    await expect(session.adopt({ sessionId: "ok", documentGeneration: 1, length: 1, displayName: "ok.pdf" }, 1)).resolves.toBe(true);
    internals.pdfReader.adopt = vi.fn(async () => { throw new Error("PDF_ADOPTION_NOT_COMMITTED"); });
    await expect(session.adopt({ sessionId: "failed", documentGeneration: 2, length: 1, displayName: "failed.pdf" }, 2)).rejects.toThrow("PDF_ADOPTION_NOT_COMMITTED");
  });
  it("starts the mounted opening fit render with the opening canvas retained as rollback", async () => {
    const onStatus = vi.fn();
    const session = createSession(onStatus);
    const internals = session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      openingFitRenderPending: boolean;
      pendingRenderRollback?: { page: number; devicePixelRatio: number };
    };
    session.reader.mountDocument(1);
    await session.activate();
    internals.openingFitRenderPending = true;
    vi.spyOn(internals.pdfReader, "getPageNaturalSize").mockResolvedValue({ width: 200, height: 100 });
    vi.spyOn(internals.pdfReader, "renderPageWithTransform").mockResolvedValue(true);

    onStatus.mockClear();
    internals.onPage(1, { scale: 1.25, rotation: 0, devicePixelRatio: 1 });
    await vi.waitFor(() => expect(internals.pdfReader.renderPageWithTransform).toHaveBeenCalledWith(1, { scale: 1, rotation: 0, devicePixelRatio: 1 }, expect.any(Function)));
    expect(onStatus).toHaveBeenCalledWith(session.snapshot.status);

    expect(internals.pendingRenderRollback).toMatchObject({ page: 1, devicePixelRatio: 1 });
  });

  it("keeps a newer committed opening presentation after late fit settlement rejection", async () => {
    const onStatus = vi.fn();
    const session = createSession(onStatus);
    const internals = session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      openingFitRenderPending: boolean;
      openingFitRenderInFlight: boolean;
    };
    session.reader.mountDocument(1);
    await session.activate();
    internals.openingFitRenderPending = true;
    vi.spyOn(internals.pdfReader, "getPageNaturalSize").mockResolvedValue({ width: 200, height: 100 });
    vi.spyOn(internals.pdfReader, "renderPageWithTransform").mockImplementation(async () => {
      internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
      throw new Error("POST_COMMIT_SETTLEMENT_FAILED");
    });
    onStatus.mockClear();

    internals.onPage(1, { scale: 1.25, rotation: 0, devicePixelRatio: 1 });
    await vi.waitFor(() => expect(internals.openingFitRenderInFlight).toBe(false));

    expect(session.snapshot.status).not.toBe("PDF presentation could not be updated.");
    expect(onStatus).not.toHaveBeenCalledWith("PDF presentation could not be updated.");
  });

  it.each([
    { type: "page.next" } as const,
    { type: "view.fitWidth" } as const,
    { type: "scroll.byViewport", factor: 1 } as const,
  ])("does not queue a slow destination superseded by $type", async (action) => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals;
    session.reader.mountDocument(2);
    await session.activate();
    let resolveSize!: (size: { width: number; height: number }) => void;
    vi.spyOn(internals.pdfReader, "getPageNaturalSize").mockReturnValue(new Promise((resolve) => { resolveSize = resolve; }));

    const destination = session.navigateToDestination(2, [null, { name: "Fit" }]);
    session.apply(action);
    resolveSize({ width: 200, height: 100 });
    await destination;

    expect(content.queueDestination).not.toHaveBeenCalled();
    expect(content.cancelDestination).toHaveBeenCalled();
  });
  it("keeps an already active session generation stable for an opening-fit successor", async () => {
    const session = createSession();
    const internals = session as unknown as { activityGeneration: number };

    await session.activate();
    const generation = internals.activityGeneration;
    await session.activate();

    expect(internals.activityGeneration).toBe(generation);
  });

  it("uses the padded host content box for fit scales and destination views", async () => {
    const session = createSession();
    const internals = session as unknown as {
      availableContentSize: () => { width: number; height: number };
      pdfReader: { getPageNaturalSize: (page: number, rotation: number, guard: () => boolean) => Promise<{ width: number; height: number }> };
    };
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
    Object.defineProperty(globalThis, "getComputedStyle", {
      configurable: true,
      value: () => ({ paddingLeft: "20px", paddingRight: "20px", paddingTop: "10px", paddingBottom: "10px" }),
    });
    try {
      expect(internals.availableContentSize()).toEqual({ width: 160, height: 80 });
      session.reader.mountDocument(1);
      vi.spyOn((internals as unknown as SessionInternals).pdfReader, "renderPageWithTransform").mockResolvedValue(true);
      await session.activate();
      session.reader.apply({ type: "view.fitPage" });
      vi.spyOn(internals.pdfReader, "getPageNaturalSize").mockResolvedValue({ width: 320, height: 80 });
      await session.renderCurrentView();
      expect((internals.pdfReader as unknown as { renderPageWithTransform: ReturnType<typeof vi.fn> }).renderPageWithTransform)
        .toHaveBeenCalledWith(1, expect.objectContaining({ scale: 0.5 }), expect.any(Function));
    } finally {
      if (descriptor === undefined) delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
      else Object.defineProperty(globalThis, "getComputedStyle", descriptor);
    }
  });

  it.each([
    { hostWidth: 785, hostHeight: 620, padding: { left: 12, right: 8, top: 10, bottom: 6 }, pageWidth: 640, pageHeight: 900 },
    { hostWidth: 420, hostHeight: 260, padding: { left: 24, right: 16, top: 18, bottom: 12 }, pageWidth: 300, pageHeight: 180 },
  ])("publishes a hidden opening before fitting its $pageWidth x $pageHeight page to the padded $hostWidth x $hostHeight host top", async ({ hostWidth, hostHeight, padding, pageWidth, pageHeight }) => {
    let session!: PdfTabSession;
    let published = false;
    session = createSession(() => {
      if (!session.snapshot.reader.hasDocument) return;
      const host = (session as unknown as SessionInternals & { options: { canvasHost: { clientWidth: number; clientHeight: number } } }).options.canvasHost;
      host.clientWidth = hostWidth;
      host.clientHeight = hostHeight;
      published = true;
    });
    const internals = session as unknown as SessionInternals & {
      openingFitRenderPending: boolean;
      options: { canvasHost: { clientWidth: number; clientHeight: number; scrollTop: number } };
      pdfReader: SessionInternals["pdfReader"] & {
        options: {
          onCommitted: (pageCount: number, displayName: string) => void;
          onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
        };
      };
    };
    internals.options.canvasHost.clientWidth = 0;
    internals.options.canvasHost.clientHeight = 0;
    const styleDescriptor = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({
      paddingLeft: `${padding.left}px`, paddingRight: `${padding.right}px`,
      paddingTop: `${padding.top}px`, paddingBottom: `${padding.bottom}px`,
    }) });
    try {
      await session.activate();
      vi.spyOn(internals.pdfReader, "getPageNaturalSize").mockResolvedValue({ width: pageWidth, height: pageHeight });
      const opening = vi.mocked(internals.pdfReader.setOpeningPresentationAtTop).mockImplementation(async (_topology, _page, _transform, guard) => {
        if (!guard()) return false;
        internals.options.canvasHost.scrollTop = 0;
        return true;
      });

      internals.pdfReader.options.onCommitted(3, "hidden.pdf");
      expect(internals.openingFitRenderPending).toBe(true);
      internals.options.canvasHost.scrollTop = 0;
      internals.pdfReader.options.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });

      await session.activate();
      expect(opening).toHaveBeenCalledOnce();
      expect(published).toBe(true);
      expect(opening.mock.calls[0]?.[0]).toBe("continuous");
      expect(opening.mock.calls[0]?.[1]).toBe(1);
      expect((opening.mock.calls[0]?.[2] as { scale: number }).scale)
        .toBeCloseTo(Math.min(
          (hostWidth - padding.left - padding.right) / pageWidth,
          (hostHeight - padding.top - padding.bottom) / pageHeight,
        ));
      expect(internals.options.canvasHost.scrollTop).toBe(0);
      expect(internals.openingFitRenderPending).toBe(false);
    } finally {
      if (styleDescriptor === undefined) delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
      else Object.defineProperty(globalThis, "getComputedStyle", styleDescriptor);
    }
  });
  it("keeps a committed opening active when its follow-up Fit Page render is transiently stale", async () => {
    const session = createSession();
    const internals = session as unknown as SessionInternals & { openingFitRenderPending: boolean };
    session.reader.mountDocument(1);
    await session.activate();
    internals.openingFitRenderPending = true;
    vi.spyOn(internals.pdfReader, "getPageNaturalSize").mockResolvedValue({ width: 200, height: 100 });
    const render = vi.spyOn(internals.pdfReader, "setOpeningPresentationAtTop").mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(session.activate()).resolves.toBeUndefined();
    expect(session.snapshot.active).toBe(true);
    expect(render).toHaveBeenCalledTimes(2);
    expect(internals.openingFitRenderPending).toBe(false);
  });
  it("retains a committed opening when both bounded refit attempts are stale", async () => {
    const session = createSession();
    const internals = session as unknown as SessionInternals & { openingFitRenderPending: boolean };
    session.reader.mountDocument(1);
    await session.activate();
    internals.openingFitRenderPending = true;
    vi.spyOn(internals.pdfReader, "getPageNaturalSize").mockResolvedValue({ width: 200, height: 100 });
    const render = vi.spyOn(internals.pdfReader, "setOpeningPresentationAtTop").mockResolvedValue(false);

    await expect(session.activate()).resolves.toBeUndefined();
    expect(session.snapshot.active).toBe(true);
    expect(render).toHaveBeenCalledTimes(2);
    expect(internals.openingFitRenderPending).toBe(true);
  });
  it("retries opening fit for a hidden empty adoption host after geometry returns", async () => {
    const session = createSession();
    const internals = session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      openingFitRenderPending: boolean;
      options: { canvasHost: { clientWidth: number; clientHeight: number } };
    };
    internals.options.canvasHost.clientWidth = 0;
    internals.options.canvasHost.clientHeight = 0;
    session.reader.mountDocument(1);
    await session.activate();
    internals.openingFitRenderPending = true;
    vi.spyOn(internals.pdfReader, "getPageNaturalSize").mockResolvedValue({ width: 200, height: 100 });
    const render = vi.spyOn(internals.pdfReader, "renderPageWithTransform").mockResolvedValue(true);

    internals.onPage(1, { scale: 1.25, rotation: 0, devicePixelRatio: 1 });
    await expect(session.renderCurrentView()).resolves.toBe(false);
    expect(internals.pdfReader.getPageNaturalSize).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(internals.openingFitRenderPending).toBe(true);

    await session.deactivate();
    internals.options.canvasHost.clientWidth = 200;
    internals.options.canvasHost.clientHeight = 100;
    await session.activate();

    expect(render).toHaveBeenCalledWith(1, { scale: 1, rotation: 0, devicePixelRatio: 1 }, expect.any(Function));
    expect(internals.openingFitRenderPending).toBe(false);
  });
  it.each([
    { action: { type: "page.next" } as const, committedPage: 2, committedScale: 1 },
    { action: { type: "view.zoom", factor: 1.1 } as const, committedPage: 1, committedScale: 1.1 },
  ])("does not let a delayed opening fit reset the viewport after newer $action.type intent", async ({ action, committedPage, committedScale }) => {
    const session = createSession();
    const internals = session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      openingFitRenderPending: boolean;
      openingFitRenderInFlight: boolean;
      options: { canvasHost: { clientWidth: number; clientHeight: number; scrollTop: number } };
    };
    session.reader.mountDocument(3);
    await session.activate();
    internals.openingFitRenderPending = true;
    vi.spyOn(internals.pdfReader, "getPageNaturalSize").mockResolvedValue({ width: 200, height: 100 });
    const entered = deferred<void>();
    const release = deferred<void>();
    let openingGuard!: () => boolean;
    const opening = vi.mocked(internals.pdfReader.setOpeningPresentationAtTop).mockImplementation(async (_topology, _page, _transform, guard) => {
      openingGuard = guard;
      entered.resolve();
      await release.promise;
      if (!guard()) return false;
      internals.options.canvasHost.scrollTop = 0;
      return true;
    });

    internals.options.canvasHost.scrollTop = 0;
    internals.onPage(1, { scale: 1.25, rotation: 0, devicePixelRatio: 1 });
    await entered.promise;
    session.apply(action);
    internals.options.canvasHost.scrollTop = 240;
    expect(openingGuard()).toBe(false);
    release.resolve();
    await vi.waitFor(() => expect(internals.openingFitRenderInFlight).toBe(false));
    internals.onPage(committedPage, { scale: committedScale, rotation: 0, devicePixelRatio: 1 });

    expect(opening).toHaveBeenCalledOnce();
    expect(internals.options.canvasHost.scrollTop).toBe(240);
    expect(internals.openingFitRenderPending).toBe(false);
  });
  it("retires a pending opening fit when raw scrolling takes viewport ownership", async () => {
    const session = createSession();
    const internals = session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      openingFitRenderPending: boolean;
      openingFitRenderInFlight: boolean;
      options: { canvasHost: { scrollTop: number } };
    };
    session.reader.mountDocument(1);
    await session.activate();
    internals.openingFitRenderPending = true;
    vi.spyOn(internals.pdfReader, "getPageNaturalSize").mockResolvedValue({ width: 200, height: 100 });
    const entered = deferred<void>();
    const release = deferred<void>();
    vi.mocked(internals.pdfReader.setOpeningPresentationAtTop).mockImplementation(async (_topology, _page, _transform, guard) => {
      entered.resolve();
      await release.promise;
      return guard() && internals.options.canvasHost.scrollTop === 0;
    });

    internals.options.canvasHost.scrollTop = 0;
    internals.onPage(1, { scale: 1.25, rotation: 0, devicePixelRatio: 1 });
    await entered.promise;
    internals.options.canvasHost.scrollTop = 91;
    release.resolve();
    await vi.waitFor(() => expect(internals.openingFitRenderInFlight).toBe(false));

    expect(internals.options.canvasHost.scrollTop).toBe(91);
    expect(internals.openingFitRenderPending).toBe(false);
  });
  it("retains the exact session controller after a rejected unmount and retries it once", async () => {
    const session = createSession();
    const internals = session as unknown as {
      content?: unknown;
      contentBySession: Map<string, { unmount: () => Promise<void> }>;
      disposeContent: (session: { sessionId: string; documentGeneration: number }) => Promise<void>;
    };
    const successor = { unmount: vi.fn(async () => undefined) };
    let attempts = 0;
    const retained = { unmount: vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("unmount once");
    }) };
    internals.contentBySession.set("retained:1", retained);
    internals.contentBySession.set("successor:2", successor);
    internals.content = retained;

    const first = internals.disposeContent({ sessionId: "retained", documentGeneration: 1 });
    const concurrent = internals.disposeContent({ sessionId: "retained", documentGeneration: 1 });
    await expect(first).rejects.toThrow("unmount once");
    await expect(concurrent).rejects.toThrow("unmount once");

    expect(retained.unmount).toHaveBeenCalledOnce();
    expect(internals.contentBySession.get("retained:1")).toBe(retained);
    expect(internals.content).toBe(retained);
    expect(internals.contentBySession.get("successor:2")).toBe(successor);

    await expect(internals.disposeContent({ sessionId: "retained", documentGeneration: 1 })).resolves.toBeUndefined();

    expect(retained.unmount).toHaveBeenCalledTimes(2);
    expect(internals.contentBySession.has("retained:1")).toBe(false);
    expect(internals.content).toBeUndefined();
    expect(successor.unmount).not.toHaveBeenCalled();
  });
  it("uses single-page topology for explicit Fit Page and returns to continuous after custom zoom", async () => {
    const session = createSession();
    const reader = (session as unknown as SessionInternals).pdfReader;
    session.reader.mountDocument(1);
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    await session.activate();
    session.apply({ type: "view.fitPage" });
    await session.renderCurrentView();
    expect(reader.setPresentationTopology).toHaveBeenLastCalledWith("single-page", 1, expect.objectContaining({ scale: 1, rotation: 0 }), expect.any(Function));
    session.apply({ type: "view.rotate", quarterTurns: 1 });
    await session.renderCurrentView();
    expect(reader.setPresentationTopology).toHaveBeenLastCalledWith("single-page", 1, expect.objectContaining({ rotation: 90 }), expect.any(Function));
    session.apply({ type: "view.zoom", factor: 1.1 });
    await session.renderCurrentView();
    expect(reader.setPresentationTopology).toHaveBeenLastCalledWith("continuous", 1, expect.objectContaining({ rotation: 90 }), expect.any(Function));
  });
  it("bounds held adjacent input to an active step and the latest pending direction", async () => {
    const session = createSession();
    session.reader.mountDocument(50);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    let location = { pageIndex: 0, x: 0, y: 0 };
    vi.spyOn(reader, "captureViewportLanding").mockImplementation(() => location);
    const gate = deferred<void>();
    let calls = 0;
    const restore = vi.spyOn(reader, "restoreViewportLanding").mockImplementation(async (target, guard) => {
      if (++calls === 1) await gate.promise;
      if (!guard()) return { kind: "staleOrCancelled" };
      location = target;
      return { kind: "verified", landing: target };
    });
    const first = session.navigateAdjacentPage(1);
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    const pending = Array.from({ length: 29 }, (_unused, index) => session.navigateAdjacentPage(index === 28 ? -1 : 1));
    gate.resolve();
    const outcomes = await Promise.all([first, ...pending]);
    expect(outcomes.filter(result => result.kind === "stale")).toHaveLength(28);
    expect(restore).toHaveBeenCalledTimes(2);
    expect(location.pageIndex).toBe(0);
    await expect(session.navigateAdjacentPage(1)).resolves.toEqual({ kind: "verifiedLanding" });
  });

  it("does not cancel passive rendering on ordinary scroll or let stale renders undo newer zoom", async () => {
    const session = createSession();
    session.reader.mountDocument(3);
    await session.activate();
    const reader = (session as unknown as SessionInternals).pdfReader;
    vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    const entered = deferred<void>();
    const release = deferred<void>();
    let current!: () => boolean;
    vi.spyOn(reader, "renderPageWithTransform").mockImplementation(async (_page, _transform, guard) => {
      current = guard; entered.resolve(); await release.promise; return guard();
    });
    const rendering = session.renderPage(1);
    await entered.promise;
    session.apply({ type: "scroll.byViewport", factor: 0.8 });
    expect(current()).toBe(true);
    session.apply({ type: "view.zoom", factor: 1.1 });
    const intendedScale = session.snapshot.reader.customScale;
    expect(current()).toBe(false);
    release.resolve();
    await expect(rendering).resolves.toBe(false);
    expect(session.snapshot.reader.customScale).toBe(intendedScale);
  });
  it("decodes fractional host wheel input and converts client coordinates once", async () => {
    const session = createSession();
    const internals = session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      options: { canvasHost: EventTarget & { clientLeft: number; clientTop: number; getBoundingClientRect: () => { left: number; top: number } } };
    };
    session.reader.mountDocument(1);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    Object.assign(internals.options.canvasHost, {
      clientLeft: 2,
      clientTop: 3,
      getBoundingClientRect: () => ({ left: 10, top: 20 }),
    });
    const zoom = vi.spyOn(internals.pdfReader, "setViewTransformAtPointer").mockResolvedValue(true);

    await expect(session.handleWheelInput({ ctrlKey: true, deltaX: 0, deltaY: -25, deltaMode: 0, timeStamp: 1, clientX: 40, clientY: 60 })).resolves.toBe(false);
    await expect(session.handleWheelInput({ ctrlKey: true, deltaX: 0, deltaY: -75, deltaMode: 0, timeStamp: 2, clientX: 40, clientY: 60 })).resolves.toBe(true);
    expect(zoom).toHaveBeenCalledWith(expect.objectContaining({ scale: 1.1 }), { x: 28, y: 37 }, expect.any(Function));
  });
  it("commits Ctrl-wheel steps from the actual fit scale through the pointer-anchor API", async () => {
    const session = createSession();
    const internals = session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
    };
    session.reader.mountDocument(2);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    const zoom = vi.spyOn(internals.pdfReader, "setViewTransformAtPointer").mockResolvedValue(true);

    await expect(session.zoomAt(1, { x: 24, y: 32 })).resolves.toBe(true);

    expect(zoom).toHaveBeenCalledWith(expect.objectContaining({ scale: 1.1 }), { x: 24, y: 32 }, expect.any(Function));
    expect(session.snapshot.reader.zoomMode).toBe("custom");
    expect(session.snapshot.reader.customScale).toBeCloseTo(1.1);
  });

  it("rolls a pending wheel transform back to the committed Fit Page reference on cancellation", async () => {
    const session = createSession();
    const internals = session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
    };
    session.reader.mountDocument(2);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    const pending = deferred<boolean>();
    vi.spyOn(internals.pdfReader, "setViewTransformAtPointer").mockImplementation(() => {
      internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
      return pending.promise;
    });
    const zoom = session.zoomAt(1, { x: 12, y: 18 });
    const successor = session.zoomAt(1, { x: 14, y: 20 });
    session.cancelWheelZoom();
    pending.resolve(true);

    await expect(zoom).resolves.toBe(false);
    await expect(successor).resolves.toBe(false);
    expect(session.snapshot.reader.zoomMode).toBe("continuous-fit");
    expect(session.snapshot.reader.fitPageReference).toBe(1);
    expect(session.snapshot.reader.customScale).toBe(1);
  });
  it("keeps the fit reference across mixed-size pages, resize and rotation until explicitly reapplied", async () => {
    const session = createSession();
    const internals = session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      options: { canvasHost: { clientWidth: number; clientHeight: number } };
    };
    session.reader.mountDocument(3);
    await session.activate();
    const sizes = vi.spyOn(internals.pdfReader, "getPageNaturalSize").mockImplementation(async (page, rotation) => {
      const size = page === 1 ? { width: 100, height: 200 } : { width: 500, height: 50 };
      return rotation % 180 === 0 ? size : { width: size.height, height: size.width };
    });
    vi.spyOn(internals.pdfReader, "synchronizeViewport").mockResolvedValue(true);
    vi.spyOn(internals.pdfReader, "renderPageWithTransform").mockImplementation(async (page, transform, guard) => {
      if (!guard()) return false;
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    });
    await expect(session.renderPage(1)).resolves.toBe(true);
    expect(session.snapshot.reader.customScale).toBe(0.5);
    await expect(session.renderPage(2)).resolves.toBe(true);
    expect(session.snapshot.reader).toMatchObject({ page: 2, fitPageReference: 1, customScale: 0.5 });
    expect(sizes.mock.calls.at(-1)?.slice(0, 2)).toEqual([1, 0]);
    session.apply({ type: "view.rotate", quarterTurns: 1 });
    await expect(session.renderCurrentView()).resolves.toBe(true);
    expect(session.snapshot.reader).toMatchObject({ page: 2, fitPageReference: 1, customScale: 1 });
    expect(sizes.mock.calls.at(-1)?.slice(0, 2)).toEqual([1, 90]);
    internals.options.canvasHost.clientWidth = 100;
    internals.options.canvasHost.clientHeight = 60;
    session.invalidateViewportSynchronization();
    await expect(session.renderCurrentView()).resolves.toBe(true);
    expect(session.snapshot.reader).toMatchObject({ page: 2, fitPageReference: 1, customScale: 0.5 });
    session.apply({ type: "view.fitPage" });
    await expect(session.renderCurrentView()).resolves.toBe(true);
    expect(session.snapshot.reader).toMatchObject({ page: 2, fitPageReference: 2, customScale: 0.25 });
  });
  it.each(["fit-width", "continuous-fit"] as const)("keeps passive %s scale stable when the active page changes size", async zoomMode => {
    const session = createSession();
    const internals = (session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
    });
    const reader = internals.pdfReader;
    session.reader.mountDocument(2);
    await session.activate();
    if (zoomMode === "fit-width") session.apply({ type: "view.fitWidth" });
    internals.onPage(1, { scale: 2, rotation: 0, devicePixelRatio: 1 });
    const sizes = vi.spyOn(reader, "getPageNaturalSize").mockResolvedValue({ width: 400, height: 100 });
    const render = vi.spyOn(reader, "renderPageWithTransform").mockImplementation(async (page, transform, guard) => {
      if (!guard()) return false;
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    });
    vi.spyOn(reader, "synchronizeViewport").mockImplementation(async (_scrollTop, _clientHeight, guard) => {
      if (!guard()) return false;
      internals.onPage(2, { scale: 2, rotation: 0, devicePixelRatio: 1 });
      return true;
    });

    await expect(session.synchronizeViewport(160, 100)).resolves.toBe(true);

    expect(sizes).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(session.snapshot.reader).toMatchObject({ page: 2, zoomMode, customScale: 2 });
  });
  it.each([
    { geometryChanged: true, pageWidth: 150, pageHeight: 300, expectedRenders: 2, expectedScale: 1 / 3, finalHeight: 100 },
    { geometryChanged: false, pageWidth: 150, pageHeight: 300, expectedRenders: 1, expectedScale: 17 / 60, finalHeight: 85 },
    { geometryChanged: true, pageWidth: 1_000, pageHeight: 1_000, expectedRenders: 1, expectedScale: 0.25, finalHeight: 100 },
  ] as const)("settles Fit Page against final single-page geometry: changed=%s", async ({ geometryChanged, pageWidth, pageHeight, expectedRenders, expectedScale, finalHeight }) => {
    const session = createSession();
    const internals = (session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      options: { canvasHost: { clientWidth: number; clientHeight: number } };
    });
    const reader = internals.pdfReader;
    const host = internals.options.canvasHost;
    let topology: "continuous" | "single-page" = "continuous";
    Object.defineProperty(reader, "presentationTopology", { configurable: true, get: () => topology });
    session.reader.mountDocument(2);
    await session.activate();
    vi.spyOn(reader, "getPageNaturalSize").mockImplementation(async page => page === 1
      ? { width: 100, height: 100 }
      : { width: pageWidth, height: pageHeight });
    let renderCalls = 0;
    const renderTransforms: unknown[] = [];
    const renderPageWithTransform = async (page: number, transform: unknown, guard: () => boolean): Promise<boolean> => {
      if (!guard()) return false;
      renderCalls += 1;
      renderTransforms.push(transform);
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    };
    vi.spyOn(reader, "renderPageWithTransform").mockImplementation(renderPageWithTransform);
    vi.spyOn(reader, "synchronizeViewport").mockResolvedValue(true);
    vi.spyOn(reader, "setPresentationTopology").mockImplementation(async (nextTopology, page, transform, guard) => {
      topology = nextTopology;
      const committed = await renderPageWithTransform(page, transform, guard);
      if (committed && nextTopology === "single-page" && geometryChanged) host.clientHeight = 100;
      return committed;
    });

    session.apply({ type: "view.fitWidth" });
    await expect(session.renderCurrentView()).resolves.toBe(true);
    internals.onPage(2, { scale: 2, rotation: 0, devicePixelRatio: 1 });
    host.clientHeight = 85;
    session.apply({ type: "view.fitPage" });
    const beforeFitPage = renderCalls;

    await expect(session.renderCurrentView()).resolves.toBe(true);

    expect(renderCalls - beforeFitPage).toBe(expectedRenders);
    expect(host.clientHeight).toBe(finalHeight);
    expect(renderTransforms.at(-1)).toMatchObject({ scale: expectedScale, rotation: 0 });
  });
  it.each(["failure", "stale"] as const)("guards corrective Fit Page settlement on %s ownership", async outcome => {
    const session = createSession();
    const internals = (session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      options: { canvasHost: { clientWidth: number; clientHeight: number } };
    });
    const reader = internals.pdfReader;
    const host = internals.options.canvasHost;
    let topology: "continuous" | "single-page" = "continuous";
    let singlePageRenders = 0;
    let renderCalls = 0;
    const entered = deferred<void>();
    const release = deferred<void>();
    const anchor = { pageNumber: 1, pagePoint: { x: 10, y: 20 }, viewportOffset: { x: 30, y: 40 } };
    Object.defineProperty(reader, "presentationTopology", { configurable: true, get: () => topology });
    vi.spyOn(reader as unknown as { captureScrollAnchor: () => typeof anchor }, "captureScrollAnchor").mockReturnValue(anchor);
    session.reader.mountDocument(2);
    await session.activate();
    vi.spyOn(reader, "getPageNaturalSize").mockImplementation(async page => page === 1
      ? { width: 100, height: 100 }
      : { width: 150, height: 300 });
    const renderPageWithTransform = async (
      page: number,
      transform: unknown,
      guard: () => boolean,
      presentationTopology?: "continuous" | "single-page",
    ): Promise<boolean> => {
      if (!guard()) return false;
      renderCalls += 1;
      if ((presentationTopology ?? topology) === "single-page") {
        singlePageRenders += 1;
        if (singlePageRenders === 2) {
          if (outcome === "failure") throw new Error("fit-page corrective render failed");
          entered.resolve();
          await release.promise;
          if (!guard()) return false;
        }
      }
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    };
    vi.spyOn(reader, "renderPageWithTransform").mockImplementation(renderPageWithTransform);
    vi.spyOn(reader, "synchronizeViewport").mockResolvedValue(true);
    vi.spyOn(reader, "setPresentationTopology").mockImplementation(async (nextTopology, page, transform, guard) => {
      topology = nextTopology;
      const committed = await renderPageWithTransform(page, transform, guard);
      if (committed && nextTopology === "single-page") host.clientHeight = 100;
      return committed;
    });

    session.apply({ type: "view.fitWidth" });
    await expect(session.renderCurrentView()).resolves.toBe(true);
    internals.onPage(2, { scale: 2, rotation: 0, devicePixelRatio: 1 });
    host.clientHeight = 85;
    session.apply({ type: "view.fitPage" });
    if (outcome === "stale") {
      const settling = session.renderCurrentView();
      await entered.promise;
      session.apply({ type: "view.zoom", factor: 1.1 });
      release.resolve();
      await expect(settling).resolves.toBe(false);
      expect(session.snapshot.reader.zoomMode).toBe("custom");
      expect(singlePageRenders).toBe(2);
    } else {
      await expect(session.renderCurrentView()).rejects.toThrow("fit-page corrective render failed");
      expect(session.snapshot.reader.zoomMode).toBe("fit-width");
      expect(singlePageRenders).toBe(2);
    }
    expect(renderCalls).toBeGreaterThan(0);
  });
  it("does not replace newer status when missing fit metadata rollback becomes stale", async () => {
    const session = createSession();
    const internals = session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      options: { canvasHost: { clientHeight: number } };
    };
    const reader = internals.pdfReader;
    let topology: "continuous" | "single-page" = "continuous";
    Object.defineProperty(reader, "presentationTopology", { configurable: true, get: () => topology });
    const anchor = { pageNumber: 1, pagePoint: { x: 10, y: 20 }, viewportOffset: { x: 30, y: 40 } };
    vi.spyOn(reader as unknown as { captureScrollAnchor: () => typeof anchor }, "captureScrollAnchor").mockReturnValue(anchor);
    session.reader.mountDocument(2);
    await session.activate();
    let metadataCalls = 0;
    vi.spyOn(reader, "getPageNaturalSize").mockImplementation(async () => ++metadataCalls === 3 ? undefined : { width: 100, height: 300 });
    vi.spyOn(reader, "synchronizeViewport").mockResolvedValue(true);
    vi.spyOn(reader, "setPresentationTopology").mockImplementation(async (nextTopology, page, transform, guard) => {
      if (!guard()) return false;
      topology = nextTopology;
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      if (nextTopology === "single-page") internals.options.canvasHost.clientHeight = 100;
      return true;
    });
    const rollback = vi.spyOn(reader, "renderPageWithTransform").mockImplementation(async () => {
      session.apply({ type: "view.zoom", factor: 1.1 });
      session.reader.setStatus("Newer presentation status");
      return false;
    });
    session.apply({ type: "view.fitWidth" });
    await expect(session.renderCurrentView()).resolves.toBe(true);
    internals.options.canvasHost.clientHeight = 85;
    session.apply({ type: "view.fitPage" });
    await expect(session.renderCurrentView()).resolves.toBe(false);
    expect(rollback).toHaveBeenCalledOnce();
    expect(session.snapshot.reader.zoomMode).toBe("custom");
    expect(session.snapshot.reader.status).toBe("Newer presentation status");
  });
  it("reports bounded Fit Page geometry exhaustion after a second layout change", async () => {
    const session = createSession();
    const internals = (session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      options: { canvasHost: { clientWidth: number; clientHeight: number } };
    });
    const reader = internals.pdfReader;
    const host = internals.options.canvasHost;
    let topology: "continuous" | "single-page" = "continuous";
    let singlePageRenders = 0;
    let renderCalls = 0;
    const renderTransforms: unknown[] = [];
    const anchor = { pageNumber: 1, pagePoint: { x: 10, y: 20 }, viewportOffset: { x: 30, y: 40 } };
    Object.defineProperty(reader, "presentationTopology", { configurable: true, get: () => topology });
    vi.spyOn(reader as unknown as { captureScrollAnchor: () => typeof anchor }, "captureScrollAnchor").mockReturnValue(anchor);
    session.reader.mountDocument(2);
    await session.activate();
    vi.spyOn(reader, "getPageNaturalSize").mockImplementation(async page => page === 1
      ? { width: 100, height: 100 }
      : { width: 150, height: 300 });
    const renderPageWithTransform = async (
      page: number,
      transform: unknown,
      guard: () => boolean,
      presentationTopology?: "continuous" | "single-page",
    ): Promise<boolean> => {
      if (!guard()) return false;
      renderCalls += 1;
      renderTransforms.push(transform);
      if ((presentationTopology ?? topology) === "single-page") singlePageRenders += 1;
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    };
    vi.spyOn(reader, "renderPageWithTransform").mockImplementation(renderPageWithTransform);
    vi.spyOn(reader, "synchronizeViewport").mockResolvedValue(true);
    vi.spyOn(reader, "setPresentationTopology").mockImplementation(async (nextTopology, page, transform, guard) => {
      topology = nextTopology;
      const committed = await renderPageWithTransform(page, transform, guard);
      if (committed && nextTopology === "single-page") host.clientHeight = singlePageRenders === 1 ? 100 : 95;
      return committed;
    });

    session.apply({ type: "view.fitWidth" });
    await expect(session.renderCurrentView()).resolves.toBe(true);
    internals.onPage(2, { scale: 2, rotation: 0, devicePixelRatio: 1 });
    host.clientHeight = 85;
    session.apply({ type: "view.fitPage" });

    await expect(session.renderCurrentView()).resolves.toBe(false);

    expect(singlePageRenders).toBe(2);
    expect(renderTransforms.at(-2)).toMatchObject({ scale: 1 / 3, rotation: 0 });
    expect(session.snapshot.reader.zoomMode).toBe("fit-width");
    expect(session.snapshot.status).toBe("PDF presentation could not be updated.");
  });
  it.each([false, "exception", "after-commit"] as const)("clears a failed wheel target and restores its reference: %s", async (failure) => {
    const session = createSession();
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    session.reader.mountDocument(2);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    const zoom = vi.spyOn(internals.pdfReader, "setViewTransformAtPointer").mockImplementationOnce(async (transform) => {
      if (failure === "exception") throw new Error("raster failed");
      if (failure === "after-commit") internals.onPage(1, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return false;
    }).mockImplementation(async (transform) => { internals.onPage(1, transform as { scale: number; rotation: number; devicePixelRatio: number }); return true; });
    await expect(session.zoomAt(1, { x: 20, y: 30 })).rejects.toThrow(failure === "exception" ? "raster failed" : "PDF_WHEEL_ZOOM_FAILED");
    expect(session.snapshot.reader).toMatchObject({ zoomMode: "continuous-fit", customScale: 1, fitPageReference: 1 });
    await expect(session.zoomAt(1, { x: 20, y: 30 })).resolves.toBe(true);
    expect(zoom.mock.calls[1]?.[0]).toMatchObject({ scale: 1.1 });
  });

  it.each([{ scale: 4, steps: 1 }, { scale: 0.25, steps: -1 }])("switches fit mode at $scale without scheduling a boundary raster", async ({ scale, steps }) => {
    const session = createSession();
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    session.reader.mountDocument(1);
    await session.activate();
    internals.onPage(1, { scale, rotation: 0, devicePixelRatio: 1 });
    const render = vi.spyOn(internals.pdfReader, "setViewTransformAtPointer");
    await expect(session.zoomAt(steps, { x: 20, y: 30 })).resolves.toBe(true);
    expect(session.snapshot.reader).toMatchObject({ zoomMode: "custom", customScale: scale, fitPageReference: undefined });
    await expect(session.zoomAt(steps, { x: 20, y: 30 })).resolves.toBe(false);
    expect(render).not.toHaveBeenCalled();
  });

  it.each(["metadata", "render"] as const)("fences a normal fitted render when viewport changes during %s", async (stage) => {
    const session = createSession();
    const internals = session as unknown as SessionInternals & { options: { canvasHost: { clientWidth: number; clientHeight: number } } };
    session.reader.mountDocument(1);
    vi.spyOn((session as unknown as SessionInternals).pdfReader, "synchronizeViewport").mockResolvedValue(true);
    await session.activate();
    const entered = deferred<void>();
    const release = deferred<void>();
    const sizes = vi.spyOn(internals.pdfReader, "getPageNaturalSize").mockImplementation(async () => {
      if (stage === "metadata") { entered.resolve(); await release.promise; }
      return { width: 100, height: 100 };
    });
    const render = vi.spyOn(internals.pdfReader, "renderPageWithTransform").mockImplementation(async (_page, _transform, guard) => {
      if (stage === "render") { entered.resolve(); await release.promise; }
      return guard();
    });
    const pending = session.renderCurrentView();
    await entered.promise;
    internals.options.canvasHost.clientWidth = 100;
    internals.options.canvasHost.clientHeight = 50;
    session.invalidateViewportSynchronization();
    release.resolve();
    await expect(pending).resolves.toBe(false);
    if (stage === "metadata") expect(render).not.toHaveBeenCalled();
    sizes.mockResolvedValue({ width: 100, height: 100 });
    render.mockImplementation(async (_page, _transform, guard) => guard());
    await expect(session.renderCurrentView()).resolves.toBe(true);
    expect(render.mock.calls.at(-1)?.[1]).toMatchObject({ scale: 0.5 });
  });
  it("does not carry empty-document wheel fractions into a newly mounted PDF", async () => {
    const session = createSession();
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    await session.activate();
    const input = { ctrlKey: true, deltaX: 0, deltaMode: 0, timeStamp: 1, clientX: 20, clientY: 30 };
    await expect(session.handleWheelInput({ ...input, deltaY: -25 })).resolves.toBe(false);
    session.reader.mountDocument(1);
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    const zoom = vi.spyOn(internals.pdfReader, "setViewTransformAtPointer").mockResolvedValue(true);
    await expect(session.handleWheelInput({ ...input, deltaY: -75, timeStamp: 2 })).resolves.toBe(false);
    expect(zoom).not.toHaveBeenCalled();
    await expect(session.handleWheelInput({ ...input, deltaY: -25, timeStamp: 3 })).resolves.toBe(true);
    expect(zoom).toHaveBeenCalledOnce();
  });
  it.each([true, false])("reports the required viewport settlement after keyboard rendering: %s", async settled => {
    const session = createSession();
    session.reader.mountDocument(2);
    await session.activate();
    vi.spyOn(session, "renderPage").mockResolvedValue(true);
    const synchronize = vi.spyOn((session as unknown as SessionInternals).pdfReader, "synchronizeViewport").mockResolvedValue(settled);
    await expect(session.renderCurrentView()).resolves.toBe(settled);
    expect(synchronize).toHaveBeenCalledOnce();
  });
  it.each(["restored", "failed", "stale"] as const)("settles failed keyboard viewport publication without masking %s", async outcome => {
    const session = createSession();
    const internals = session as unknown as { pdfReader: PdfReaderController; onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    session.reader.mountDocument(2);
    await session.activate();
    session.reader.apply({ type: "view.zoom", factor: 1 });
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    const anchor = { pageNumber: 1, pagePoint: { x: 10, y: 20 }, viewportOffset: { x: 100, y: 50 } };
    vi.spyOn(internals.pdfReader, "captureScrollAnchor").mockReturnValue(anchor);
    vi.spyOn(session, "renderPage").mockImplementation(async () => {
      internals.onPage(1, { scale: 1.1, rotation: 0, devicePixelRatio: 1 });
      return true;
    });
    const synchronize = vi.spyOn((session as unknown as SessionInternals).pdfReader, "synchronizeViewport").mockImplementationOnce(async () => {
      session.reader.setStatus("This PDF exceeds reader resource limits.");
      if (outcome === "stale") session.apply({ type: "view.zoom", factor: 2 });
      return false;
    }).mockResolvedValue(true);
    const restore = vi.spyOn(internals.pdfReader, "renderPageWithTransform").mockResolvedValue(outcome !== "failed");
    session.apply({ type: "view.zoom", factor: 1.1 });
    if (outcome === "failed") {
      await expect(session.renderCurrentView()).rejects.toThrow("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
      expect(session.snapshot.reader.status).toBe("PDF viewport rollback failed after keyboard zoom.");
    } else {
      await expect(session.renderCurrentView()).resolves.toBe(false);
      if (outcome === "stale") {
        expect(restore).not.toHaveBeenCalled();
        expect(session.snapshot.reader.customScale).toBe(2.2);
      } else {
        expect(restore).toHaveBeenCalledWith(1, { scale: 1, rotation: 0, devicePixelRatio: 1 }, expect.any(Function), "continuous", anchor);
        expect(synchronize).toHaveBeenCalledTimes(2);
        expect(session.snapshot.reader.customScale).toBe(1);
        expect(session.snapshot.reader.status).toBe("This PDF exceeds reader resource limits.");
      }
    }
  });
  it.each(["current", "inactive", "replacement", "rejected"] as const)("replays one deferred passive viewport using live geometry: %s", async outcome => {
    const session = createSession();
    const reader = (session as unknown as SessionInternals).pdfReader;
    const host = (session as unknown as { options: { canvasHost: { scrollTop: number; clientHeight: number } } }).options.canvasHost;
    session.reader.mountDocument(2);
    await session.activate();
    session.apply({ type: "view.zoom", factor: 1.1 });
    vi.spyOn(session, "renderPage").mockResolvedValue(true);
    const entered = deferred<void>();
    const release = deferred<boolean>();
    const synchronize = vi.spyOn(reader, "synchronizeViewport").mockImplementationOnce(() => {
      entered.resolve(); return release.promise;
    }).mockResolvedValue(true);
    if (outcome === "rejected") synchronize.mockRejectedValueOnce(new Error("passive failed"));
    const rendering = session.renderCurrentView();
    await entered.promise;
    const replay = Promise.allSettled([session.synchronizeViewport(10, 100), session.synchronizeViewport(20, 100)]);
    expect(synchronize).toHaveBeenCalledOnce();
    host.scrollTop = 777;
    host.clientHeight = 120;
    if (outcome === "inactive") await session.deactivate();
    if (outcome === "replacement") session.reader.mountDocument(3);
    release.resolve(true);
    await rendering;
    const outcomes = await replay;
    if (outcome === "inactive" || outcome === "replacement") {
      expect(synchronize).toHaveBeenCalledOnce();
      expect(outcomes).toEqual([{ status: "fulfilled", value: false }, { status: "fulfilled", value: false }]);
    } else {
      expect(synchronize).toHaveBeenCalledTimes(2);
      expect(synchronize).toHaveBeenLastCalledWith(777, 120, expect.any(Function));
      if (outcome === "rejected") {
        expect(outcomes.every(result => result.status === "rejected" && result.reason.message === "passive failed")).toBe(true);
      } else expect(outcomes).toEqual([{ status: "fulfilled", value: true }, { status: "fulfilled", value: true }]);
    }
  });
  it.each([false, true])("reports opening-fit failure only while its viewport owner is current: resized=%s", async resized => {
    const session = createSession();
    session.reader.mountDocument(1);
    await session.activate();
    const internals = session as unknown as {
      openingFitRenderPending: boolean;
      renderOpeningFitPage: () => Promise<boolean>;
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
    };
    const fit = deferred<boolean>();
    vi.spyOn(internals, "renderOpeningFitPage").mockReturnValue(fit.promise);
    internals.openingFitRenderPending = true;
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    if (resized) session.invalidateViewportSynchronization();
    fit.resolve(false);
    await fit.promise;
    await Promise.resolve();
    expect(session.snapshot.reader.status === "PDF presentation could not be updated.").toBe(!resized);
  });
});

describe("explicit continuous fit geometry ownership", () => {
  it("refits the fixed reference for an explicit presentation owner after geometry changes", async () => {
    const session = createSession();
    const internals = session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
      options: { canvasHost: { clientHeight: number } };
    };
    session.reader.mountDocument(2);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    const sizes = vi.spyOn(internals.pdfReader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    const render = vi.spyOn(internals.pdfReader, "renderPageWithTransform").mockImplementation(async (page, transform, guard) => {
      if (!guard()) return false;
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    });
    vi.spyOn(internals.pdfReader, "synchronizeViewport").mockImplementation(async () => {
      internals.options.canvasHost.clientHeight = 85;
      return true;
    });
    await expect(session.renderCurrentView()).resolves.toBe(true);
    expect(render.mock.calls.at(-1)?.[1]).toMatchObject({ scale: 0.85 });
    expect(sizes.mock.calls.every(([page]) => page === 1)).toBe(true);
    expect(session.snapshot.reader).toMatchObject({ zoomMode: "continuous-fit", fitPageReference: 1, customScale: 0.85 });
  });
});
describe("bounded keyboard view ownership", () => {
  async function harness(scale = 2) {
    const session = createSession();
    const internals = session as unknown as SessionInternals & {
      onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void;
    };
    session.reader.mountDocument(3);
    await session.activate();
    session.reader.restoreView({ zoomMode: "custom", customScale: scale, fitPageReference: undefined, rotationQuarterTurns: 0 });
    internals.onPage(1, { scale, rotation: 0, devicePixelRatio: 1 });
    let topology: "single-page" | "continuous" = "continuous";
    Object.defineProperty(internals.pdfReader, "presentationTopology", { configurable: true, get: () => topology });
    vi.spyOn(internals.pdfReader, "getPageNaturalSize").mockResolvedValue({ width: 100, height: 100 });
    vi.spyOn(internals.pdfReader, "synchronizeViewport").mockResolvedValue(true);
    const holds: ReturnType<typeof deferred<void>>[] = [];
    const render = vi.mocked(internals.pdfReader.setPresentationTopology).mockImplementation(async (next, page, transform, guard) => {
      const hold = holds.shift();
      if (hold !== undefined) await hold.promise;
      if (!guard()) return false;
      topology = next;
      internals.onPage(page, transform as { scale: number; rotation: number; devicePixelRatio: number });
      return true;
    });
    return { session, internals, render, holds, setTopology: (next: typeof topology) => { topology = next; }, topology: () => topology };
  }

  it.each(["view.fitWidth", "view.fitPage"] as const)("composes queued minus from resolved %s, not pre-fit zoom", async type => {
    const h = await harness(3);
    const first = deferred<void>(); h.holds.push(first);
    const fitting = h.session.requestKeyboardView({ type });
    const minus = h.session.requestKeyboardView({ type: "view.zoom", factor: 1 / 1.1 });
    expect(minus).toBe(fitting);
    await vi.waitFor(() => expect(h.render).toHaveBeenCalledOnce());
    expect(h.render.mock.calls[0]![3]()).toBe(true);
    expect(h.session.committedPresentation?.customScale).toBe(3);
    first.resolve();
    await expect(minus).resolves.toBe(true);
    expect(h.render).toHaveBeenCalledTimes(2);
    expect(h.session.committedPresentation?.customScale).toBeCloseTo((type === "view.fitWidth" ? 2 : 1) / 1.1, 12);
  });

  it("lets active raster commit while more zoom input waits in one bounded summary", async () => {
    const h = await harness(2);
    const first = deferred<void>(), second = deferred<void>(); h.holds.push(first, second);
    const work = h.session.requestKeyboardView({ type: "view.zoom", factor: 1 / 1.1 });
    await vi.waitFor(() => expect(h.render).toHaveBeenCalledOnce());
    for (let index = 0; index < 1_000; index += 1) expect(h.session.requestKeyboardView({ type: "view.zoom", factor: 1 / 1.1 })).toBe(work);
    expect(h.render.mock.calls[0]![3]()).toBe(true);
    first.resolve();
    await vi.waitFor(() => expect(h.render).toHaveBeenCalledTimes(2));
    expect(h.session.committedPresentation?.customScale).toBeCloseTo(2 / 1.1, 12);
    expect(h.session.requestKeyboardView({ type: "view.zoom", factor: 1.1 })).toBe(work);
    const owner = (h.session as unknown as { keyboardViewOwner: { pendingZoom: unknown } }).keyboardViewOwner;
    expect(Object.keys(owner.pendingZoom as object).sort()).toEqual(["factor", "lower", "upper"]);
    second.resolve();
    await expect(work).resolves.toBe(true);
    expect(h.render).toHaveBeenCalledTimes(3);
    expect(h.session.committedPresentation?.customScale).toBeCloseTo(0.275, 12);
  });

  it.each(["navigation", "deactivate", "close", "replacement", "resize"] as const)("fences queued work on %s and leaves no delayed zoom", async reason => {
    const h = await harness(2);
    const first = deferred<void>(); h.holds.push(first);
    const work = h.session.requestKeyboardView({ type: "view.zoom", factor: 1 / 1.1 });
    expect(h.session.requestKeyboardView({ type: "view.zoom", factor: 1 / 1.1 })).toBe(work);
    await vi.waitFor(() => expect(h.render).toHaveBeenCalledOnce());
    if (reason === "navigation") h.session.apply({ type: "page.goTo", page: 2 });
    else if (reason === "deactivate") await h.session.deactivate();
    else if (reason === "close") await h.session.close();
    else if (reason === "resize") h.session.invalidateViewportSynchronization();
    else (h.internals.pdfReader as unknown as { options: { onCommitted: (count: number, name: string) => void } }).options.onCommitted(5, "replacement.pdf");
    await expect(work).resolves.toBe(false);
    expect(h.render.mock.calls[0]![3]()).toBe(false);
    first.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.render).toHaveBeenCalledOnce();
    if (reason === "navigation" || reason === "resize") expect(h.session.snapshot.reader.customScale).toBe(2);
    if (reason === "replacement") expect(h.session.snapshot.reader.pageCount).toBe(5);
  });

  it("supersedes an active fit and its queued zoom with a newer fit command", async () => {
    const h = await harness(3);
    const first = deferred<void>(); h.holds.push(first);
    const old = h.session.requestKeyboardView({ type: "view.fitWidth" });
    h.session.requestKeyboardView({ type: "view.zoom", factor: 1.1 });
    await vi.waitFor(() => expect(h.render).toHaveBeenCalledOnce());
    const current = h.session.requestKeyboardView({ type: "view.fitPage" });
    await expect(old).resolves.toBe(false);
    await expect(current).resolves.toBe(true);
    first.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.render).toHaveBeenCalledTimes(2);
    expect(h.session.committedPresentation).toMatchObject({ zoomMode: "fit-page", customScale: 1 });
  });

  it("rejects current render failure without draining queued input or hiding its cause", async () => {
    const h = await harness(2);
    const failure = new Error("controlled raster failure");
    h.render.mockRejectedValueOnce(failure);
    const work = h.session.requestKeyboardView({ type: "view.fitWidth" });
    expect(h.session.requestKeyboardView({ type: "view.zoom", factor: 1.1 })).toBe(work);
    await expect(work).rejects.toBe(failure);
    expect(h.render).toHaveBeenCalledOnce();
    expect(h.session.committedPresentation?.customScale).toBe(2);
    await expect(h.session.requestKeyboardView({ type: "view.actualSize" })).resolves.toBe(true);
  });

  it("converts clamped Fit Page to continuous custom topology instead of relabeling the canvas", async () => {
    const h = await harness(0.25);
    h.session.reader.restoreView({ zoomMode: "fit-page", customScale: 0.25, fitPageReference: 1, rotationQuarterTurns: 0 });
    h.internals.onPage(1, { scale: 0.25, rotation: 0, devicePixelRatio: 1 }); h.setTopology("single-page");
    await expect(h.session.requestKeyboardView({ type: "view.zoom", factor: 1 / 1.1 })).resolves.toBe(true);
    expect(h.render).toHaveBeenCalledOnce();
    expect(h.topology()).toBe("continuous");
    expect(h.session.committedPresentation).toMatchObject({ zoomMode: "custom", customScale: 0.25 });
  });

  it("ignores invalid factors independently and keeps clamped custom fast path raster-free", async () => {
    const h = await harness(4);
    await expect(h.session.requestKeyboardView({ type: "view.zoom", factor: 1.1 })).resolves.toBe(false);
    expect(h.render).not.toHaveBeenCalled();
    const first = deferred<void>(); h.holds.push(first);
    const work = h.session.requestKeyboardView({ type: "view.zoom", factor: 1 / 1.1 });
    await expect(h.session.requestKeyboardView({ type: "view.zoom", factor: NaN })).resolves.toBe(false);
    first.resolve(); await expect(work).resolves.toBe(true);
    expect(h.render).toHaveBeenCalledOnce();
  });
});
