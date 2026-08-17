import { describe, expect, it, vi } from "vitest";
import { PdfTabSession, decidePdfTabSearch } from "../../../src/pdf/PdfTabSession";
import type { PdfSearchResult } from "../../../src/pdf/PdfContentController";
import { ResourceReservationManager } from "../../../src/pdf/ResourceBudget";

function createSession(onStatus?: (status: string) => void): PdfTabSession {
  return new PdfTabSession({
    native: {} as never,
    pdf: {} as never,
    resources: new ResourceReservationManager(),
    canvasHost: { clientWidth: 200, clientHeight: 100 } as HTMLElement,
    ...(onStatus === undefined ? {} : { onStatus }),
    createContentOptions: () => ({}) as never,
  });
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
    restoreEvictedSearch: () => Promise<void>;
    queueDestination: (page: number, destination: readonly unknown[]) => number | undefined;
    cancelDestination: (intentId?: number) => void;
    synchronizeResidentPages: (pages: readonly number[]) => Promise<void>;
    activateResidentPage: (page: number) => boolean;
  };
  pdfReader: {
    evictInactiveCanvas: () => boolean;
    adopt: () => Promise<true>;
    getPageNaturalSize: (page: number, rotation: number, guard: () => boolean) => Promise<{ width: number; height: number } | undefined>;
    suspend: () => Promise<void>;
    renderPageWithTransform: (page: number, transform: unknown, guard: () => boolean) => Promise<boolean>;
  };
};

const SEARCH_RESULT: PdfSearchResult = { pageNumber: 1, index: 0, length: 1 };

function installContent(session: PdfTabSession, snapshot: SearchSnapshot) {
  const content = {
    snapshot,
    nextMatch: vi.fn(),
    search: vi.fn(async () => undefined),
    handleHintKey: vi.fn(() => false),
    suspend: vi.fn(),
    restoreEvictedSearch: vi.fn(async () => undefined),
    queueDestination: vi.fn(() => 1),
    cancelDestination: vi.fn(),
    synchronizeResidentPages: vi.fn(async () => undefined),
    activateResidentPage: vi.fn(() => true),
  };
  (session as unknown as SessionInternals).content = content;
  return content;
}

describe("PdfTabSession CP4 pressure and search ownership", () => {
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

  it("cycles a completed same-query result set, but searches normalized new queries from their first result", () => {
    const session = createSession();
    session.activate();
    const content = installContent(session, { query: "match", results: [SEARCH_RESULT], searchPending: false, searchIncomplete: false });

    expect(session.submitSearch("  MATCH  ", true)).toEqual({ kind: "cycle", reverse: true });
    expect(content.nextMatch).toHaveBeenCalledWith(true);
    expect(content.search).not.toHaveBeenCalled();

    expect(session.submitSearch("Different")).toEqual({ kind: "search", query: "different" });
    expect(content.search).toHaveBeenCalledWith("different");
  });

  it("does not cycle partial results while an interrupted search is waiting to restore", () => {
    expect(decidePdfTabSearch({ query: "match", results: [SEARCH_RESULT], searchPending: false, searchIncomplete: true }, "MATCH"))
      .toEqual({ kind: "ignore" });
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

    await session.activate();
    expect(session.snapshot.active).toBe(true);
    content.synchronizeResidentPages.mockRejectedValueOnce(new Error("deactivate registry failed"));
    await expect(session.deactivate()).rejects.toThrow("deactivate registry failed");
    expect(session.snapshot.active).toBe(true);
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
    vi.spyOn(session, "renderCurrentView").mockRejectedValueOnce(new Error("restore failed"));

    const activation = session.activate();
    await vi.waitFor(() => expect(content.synchronizeResidentPages).toHaveBeenCalledTimes(2));
    expect(session.snapshot.active).toBe(true);
    await expect(session.activate()).resolves.toBeUndefined();
    expect(session.submitSearch("blocked")).toEqual({ kind: "ignore" });
    releaseSuspend();
    releaseRevoke();
    await expect(activation).rejects.toThrow("restore failed");
    expect(session.snapshot.active).toBe(false);
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
  });
  it("cancels a queued destination when its presentation rejects", async () => {
    const session = createSession();
    const content = installContent(session, { query: "", results: [], searchPending: false, searchIncomplete: false });
    const internals = session as unknown as SessionInternals & { onPage: (page: number, transform: { scale: number; rotation: number; devicePixelRatio: number }) => void };
    session.reader.mountDocument(3);
    await session.activate();
    internals.onPage(1, { scale: 1, rotation: 0, devicePixelRatio: 1 });
    internals.pdfReader.getPageNaturalSize = vi.fn(async () => ({ width: 200, height: 100 }));
    internals.pdfReader.renderPageWithTransform = vi.fn(async () => { throw new Error("PDF_RESIDENT_AUTHORITY_INCOMPLETE"); });
    Object.defineProperty(internals.pdfReader, "activePageNumber", { configurable: true, get: () => 1 });

    await expect(session.navigateToDestination(2, [null, { name: "Fit" }])).rejects.toThrow("PDF_RESIDENT_AUTHORITY_INCOMPLETE");
    expect(content.cancelDestination).toHaveBeenCalledWith(1);
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
    const session = createSession();
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

    internals.onPage(1, { scale: 1.25, rotation: 0, devicePixelRatio: 1 });
    await vi.waitFor(() => expect(internals.pdfReader.renderPageWithTransform).toHaveBeenCalledWith(1, { scale: 1, rotation: 0, devicePixelRatio: 1 }, expect.any(Function)));

    expect(internals.pendingRenderRollback).toMatchObject({ page: 1, devicePixelRatio: 1 });
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
