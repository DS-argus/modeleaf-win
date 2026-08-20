import { describe, expect, it, vi } from "vitest";
import { PdfTabSession } from "../../../src/pdf/PdfTabSession";
import type { PdfSearchResult } from "../../../src/pdf/PdfContentController";
import { ResourceReservationManager } from "../../../src/pdf/ResourceBudget";
function createSession(onStatus?: (status: string) => void): PdfTabSession {
  const session = new PdfTabSession({
    native: {} as never,
    pdf: {} as never,
    resources: new ResourceReservationManager(),
    canvasHost: { clientWidth: 200, clientHeight: 100 } as HTMLElement,
    ...(onStatus === undefined ? {} : { onStatus }),
    createContentOptions: () => ({}) as never,
  });
  const reader = (session as unknown as SessionInternals).pdfReader;
  vi.spyOn(reader, "getPageTopLanding").mockImplementation(async (page) => ({ pageIndex: page - 1, x: 0, y: 0 }));
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
    handleHintKey: (key: string) => boolean;
    suspend: () => void;
    resumeInteractions: () => void;
    restoreEvictedSearch: () => Promise<void>;
    queueDestination: (page: number, destination: readonly unknown[]) => number | undefined;
    cancelDestination: (intentId?: number) => void;
    synchronizeResidentPages: (pages: readonly number[]) => Promise<void>;
    activateResidentPage: (page: number) => boolean;
    activateVisiblePages: (pages: readonly number[]) => number;
    clearVisibleLinkAuthority: () => void;
    dismissLinkDecorations: () => void;
  };
  pdfReader: {
    evictInactiveCanvas: () => boolean;
    adopt: () => Promise<true>;
    getPageTopLanding: (page: number, transform: unknown, guard: () => boolean) => Promise<{ pageIndex: number; x: number; y: number } | undefined>;
    getPageNaturalSize: (page: number, rotation: number, guard: () => boolean) => Promise<{ width: number; height: number } | undefined>;
    suspend: () => Promise<void>;
    captureViewportLanding: () => { pageIndex: number; x: number; y: number } | undefined;
    restoreViewportLanding: (target: { pageIndex: number; x: number; y: number }, guard: () => boolean, transform?: unknown, placement?: "center" | "page-top") => Promise<
      | { kind: "verified" | "constrainedEdgeVerified"; landing: { pageIndex: number; x: number; y: number } }
      | { kind: "preflightRejected" | "staleOrCancelled" }
      | { kind: "failed"; landing?: { pageIndex: number; x: number; y: number } }
    >;
    renderPageWithTransform: (page: number, transform: unknown, guard: () => boolean) => Promise<boolean>;
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
    nextMatch: vi.fn(),
    search: vi.fn(async () => undefined),
    handleHintKey: vi.fn(() => false),
    suspend: vi.fn(),
    resumeInteractions: vi.fn(),
    restoreEvictedSearch: vi.fn(async () => undefined),
    queueDestination: vi.fn(() => 1),
    cancelDestination: vi.fn(),
    takeDestinationLanding: vi.fn<(intentId: number) => { pageIndex: number; x: number; y: number } | undefined>(() => undefined),
    synchronizeResidentPages: vi.fn(async () => undefined),
    activateResidentPage: vi.fn(() => true),
    activateVisiblePages: vi.fn(() => 0),
    clearVisibleLinkAuthority: vi.fn(),
    dismissLinkDecorations: vi.fn(),
  };
  (session as unknown as SessionInternals).content = content;
  return content;
}

describe("PdfTabSession CP4 pressure and search ownership", () => {
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
  it("uses concrete content synchronization and dismissal methods during navigation", async () => {
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
    expect(content.dismissLinkDecorations).toHaveBeenCalledOnce();
    session.clearVisibleLinkAuthority();
    expect(content.clearVisibleLinkAuthority).toHaveBeenCalledOnce();
  });
  it("commits verified history, traverses directionally, and preserves stacks on compensated failure", async () => {
    const session = createSession();
    session.reader.mountDocument(3);
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

  it("cycles completed results but restarts every prompt query including the same query", async () => {
    const session = createSession();
    await session.activate();
    const content = installContent(session, { query: "match", results: [SEARCH_RESULT], searchPending: false, searchIncomplete: false });

    expect(session.cycleSearch(true)).toEqual({ kind: "cycle", reverse: true });
    expect(content.nextMatch).toHaveBeenCalledWith(true);
    expect(content.search).not.toHaveBeenCalled();

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
    session.reader.restoreView({ zoomMode: "custom", customScale: 1, rotationQuarterTurns: 0 });
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
  it("forwards active hint keys but ignores inactive tabs", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    expect(session.handleHintKey("A")).toBe(false);
    session.activate();
    content.handleHintKey.mockReturnValue(true);
    expect(session.handleHintKey("A")).toBe(true);
    expect(content.handleHintKey).toHaveBeenCalledWith("A");
    await session.deactivate();
    expect(session.handleHintKey("S")).toBe(false);
    expect(content.synchronizeResidentPages).toHaveBeenLastCalledWith([]);
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

  it("compensates a false physical restore and permits a truthful retry", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { presentationDirty: boolean };
    internals.presentationDirty = true;
    vi.spyOn(internals.pdfReader, "suspend").mockResolvedValue();
    vi.spyOn(session, "renderCurrentView").mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(session.activate()).rejects.toThrow("PDF_PRESENTATION_RESTORE_FAILED");
    expect(session.snapshot.active).toBe(false);
    expect(content.synchronizeResidentPages).toHaveBeenLastCalledWith([]);

    await session.activate();
    expect(session.snapshot.active).toBe(true);
    expect(content.resumeInteractions).toHaveBeenCalledOnce();
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
    session.reader.restoreView({ zoomMode: "custom", customScale: 1, rotationQuarterTurns: 0 });
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
    session.reader.restoreView({ zoomMode: "custom", customScale: 1, rotationQuarterTurns: 0 });
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
  it("commits one verified point destination and records its origin for Back", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    session.reader.mountDocument(3);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    internals.pdfReader.getPageNaturalSize = vi.fn(async () => ({ width: 200, height: 100 }));
    vi.spyOn(internals.pdfReader, "captureViewportLanding")
      .mockReturnValueOnce({ pageIndex: 0, x: 5, y: 6 })
      .mockReturnValue({ pageIndex: 1, x: 20, y: 30 });
    vi.spyOn(session, "renderPage").mockResolvedValue(true);
    content.takeDestinationLanding.mockReturnValue({ pageIndex: 1, x: 20, y: 30 });

    await expect(session.navigateToDestination(2, [null, { name: "XYZ" }, 20, 30, null], "link-hint")).resolves.toEqual({
      kind: "verified", point: { pageNumber: 2, x: 20, y: 30 },
    });
    expect(content.queueDestination).toHaveBeenCalledOnce();
    expect(session.canHistoryBack).toBe(true);
    expect(session.canHistoryForward).toBe(false);
  });
  it("compensates an in-render link activation superseded outside session navigation", async () => {
    const session = createSession();
    installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    session.reader.mountDocument(2);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    internals.pdfReader.getPageNaturalSize = vi.fn(async () => ({ width: 200, height: 100 }));
    const origin = { pageIndex: 0, x: 5, y: 6 };
    vi.spyOn(internals.pdfReader, "captureViewportLanding").mockReturnValue(origin);
    const restore = vi.spyOn(internals.pdfReader, "restoreViewportLanding").mockResolvedValue({ kind: "verified", landing: origin });
    const rendering = deferred<boolean>();
    const render = vi.spyOn(session, "renderPage").mockReturnValue(rendering.promise);
    let activationCurrent = true;
    const navigation = session.navigateToDestination(2, [null, { name: "XYZ" }, 20, 30, null], "internal-link", () => activationCurrent);
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    activationCurrent = false;
    rendering.resolve(true);

    await expect(navigation).resolves.toEqual({ kind: "stale" });
    expect(restore).toHaveBeenCalledWith(origin, expect.any(Function), expect.any(Object), "center");
    expect(session.canHistoryBack).toBe(false);
  });
  it("compensates a committed destination when its independent target is unavailable", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    session.reader.mountDocument(2);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    internals.pdfReader.getPageNaturalSize = vi.fn(async () => ({ width: 200, height: 100 }));
    const origin = { pageIndex: 0, x: 5, y: 6 };
    vi.spyOn(internals.pdfReader, "captureViewportLanding").mockReturnValueOnce(origin).mockReturnValue({ pageIndex: 1, x: 20, y: 30 });
    const restore = vi.spyOn(internals.pdfReader, "restoreViewportLanding").mockResolvedValue({ kind: "verified", landing: origin });
    vi.spyOn(session, "renderPage").mockResolvedValue(true);
    content.takeDestinationLanding.mockReturnValue(undefined);

    await expect(session.navigateToDestination(2, [null, { name: "XYZ" }, 20, 30, null])).resolves.toEqual({ kind: "failed" });
    expect(restore).toHaveBeenCalledWith(origin, expect.any(Function), expect.any(Object), "center");
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
    expect(onStatus).not.toHaveBeenCalled();

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
    await vi.waitFor(() => expect(internals.pdfReader.getPageNaturalSize).toHaveBeenCalledOnce());
    expect(render).not.toHaveBeenCalled();
    expect(internals.openingFitRenderPending).toBe(true);

    await session.deactivate();
    internals.options.canvasHost.clientWidth = 200;
    internals.options.canvasHost.clientHeight = 100;
    await session.activate();

    expect(render).toHaveBeenCalledWith(1, { scale: 1, rotation: 0, devicePixelRatio: 1 }, expect.any(Function));
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
});
