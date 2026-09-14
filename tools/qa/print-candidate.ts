import { AnnotationMode, getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import { printPdfDocument, type PdfPrintDocument, type PdfPrintNative, type PdfPrintSnapshot } from "../../src/pdf/PdfPrintService";
import { ResourceReservationManager } from "../../src/pdf/ResourceBudget";
import "../../src/styles/app.css";

// Real PDF.js/canvas/binary-page preparation, but an explicitly NON-NATIVE
// consumer. This never opens a dialog or prints. Native output is a separate gate.
GlobalWorkerOptions.workerSrc = "/node_modules/pdfjs-dist/build/pdf.worker.mjs";
const allowed = new Set(["fixture-B-blank.pdf", "fixture-F-raster-12.pdf", "fixture-L-text-300.pdf"]);

export async function measure(fixture: string) {
  if (!allowed.has(fixture)) throw new Error("Only committed print fixtures are allowed");
  const response = await fetch(`/fixtures/pdf/${fixture}`);
  if (!response.ok) throw new Error(`Fixture fetch failed: ${response.status}`);
  const loading = getDocument({ data: new Uint8Array(await response.arrayBuffer()),
    cMapUrl: "/node_modules/pdfjs-dist/cmaps/", cMapPacked: true,
    standardFontDataUrl: "/node_modules/pdfjs-dist/standard_fonts/", wasmUrl: "/node_modules/pdfjs-dist/wasm/" });
  const pdf = await loading.promise;
  const runs = [];
  try {
    for (let repetition = 0; repetition < 3; repetition += 1) {
      const start = performance.now();
      const stages: { page: number; stage: string; startMs: number; durationMs: number }[] = [];
      const resources = new ResourceReservationManager(() => undefined);
      const ownerships = new Set<Promise<void>>();
      const canvases: HTMLCanvasElement[] = [];
      const deliveredPages: number[] = [];
      let firstProgressCallbackMs: number | null = null;
      let startCallbackMs: number | null = null;
      let firstPageLoadMs: number | null = null;
      let peakReservedCanvasBytes = 0;
      let peakPagePayloadBytes = 0;
      let activeRenders = 0;
      let peakActiveRenders = 0;
      let released = false;
      let snapshot: PdfPrintSnapshot = { jobId: "a".repeat(64), phase: "dialog", pageCount: pdf.numPages,
        pageRanges: [], submittedPages: 0, error: null };
      const native: PdfPrintNative = {
        start: async () => { startCallbackMs = performance.now() - start; return snapshot; },
        poll: async () => {
          if (snapshot.phase === "dialog") snapshot = { ...snapshot, phase: "ready", pageRanges: [{ from: 1, to: pdf.numPages }] };
          return snapshot;
        },
        submit: async (_jobId, payload) => {
          const header = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
          if (header.getUint32(0, true) !== 0x3152504D) throw new Error("PRINT_HEADER_INVALID");
          const page = header.getUint32(4, true);
          if (page !== deliveredPages.length + 1) throw new Error("PRINT_PAGE_ORDER_INVALID");
          if (payload.byteLength !== 32 + header.getUint32(8, true) * header.getUint32(12, true) * 4) throw new Error("PRINT_LENGTH_INVALID");
          deliveredPages.push(page);
          peakPagePayloadBytes = Math.max(peakPagePayloadBytes, payload.byteLength);
          peakReservedCanvasBytes = Math.max(peakReservedCanvasBytes, resources.snapshot().totals["canvas-bytes"]);
          snapshot = { ...snapshot, phase: "printing", submittedPages: deliveredPages.length };
          return snapshot;
        },
        finish: async () => { snapshot = { ...snapshot, phase: "submitted" }; return snapshot; },
        cancel: async () => { snapshot = { ...snapshot, phase: "cancelled" }; return snapshot; },
        release: async () => { released = true; },
      };
      const source: PdfPrintDocument = {
        getPage: async (pageNumber) => {
          firstPageLoadMs ??= performance.now() - start;
          const at = performance.now();
          const page = await pdf.getPage(pageNumber);
          stages.push({ page: pageNumber, stage: "load", startMs: at - start, durationMs: performance.now() - at });
          return {
            rotate: page.rotate,
            getViewport: (options) => page.getViewport(options),
            render: (options) => {
              canvases.push(options.canvas);
              const at = performance.now();
              activeRenders += 1;
              peakActiveRenders = Math.max(peakActiveRenders, activeRenders);
              const task = page.render({ ...options, viewport: page.getViewport({ scale: 300 / 72, rotation: page.rotate }) });
              return { cancel: () => task.cancel(), promise: task.promise.finally(() => {
                activeRenders -= 1;
                stages.push({ page: pageNumber, stage: "render", startMs: at - start, durationMs: performance.now() - at });
              }) };
            },
          };
        },
      };
      const outcome = await printPdfDocument({ document: source, native, pageCount: pdf.numPages,
        annotationMode: AnnotationMode.DISABLE, resources, sessionId: "print-candidate",
        onOwnershipSettlement: (raw) => { ownerships.add(raw); },
        onProgress: (progress) => {
          firstProgressCallbackMs ??= performance.now() - start;
          Object.assign(window, { printCandidateProgress: { fixture, repetition, phase: progress.phase, preparedPages: progress.preparedPages } });
        } });
      await Promise.all([...ownerships]);
      resources.assertEmpty();
      if (!released || canvases.some((canvas) => canvas.width || canvas.height)) throw new Error("PRINT_CLEANUP_LEAK");
      if (outcome.kind !== "submitted" || deliveredPages.length !== pdf.numPages) throw new Error("PRINT_COVERAGE_FAILED");
      runs.push({ repetition, cache: repetition === 0 ? "fresh-document-pages-not-OS-cold" : "same-document-warm",
        firstProgressCallbackMs, startCallbackMs, firstPageLoadMs, consumerFinishedMs: performance.now() - start,
        stages, outcome, deliveredPages, peakActiveRenders, peakPagePayloadBytes, peakReservedCanvasBytes,
        nativeDialogShownMs: null, nativeOutput: null, nativeMemoryBytes: null });
    }
    return { fixture, pageCount: pdf.numPages, runs };
  } finally { await loading.destroy(); }
}
