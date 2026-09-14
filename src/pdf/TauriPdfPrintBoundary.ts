import { invoke } from "@tauri-apps/api/core";
import type {
  PdfPrintNative,
  PdfPrintSnapshot,
  PdfPrintStartRequest,
} from "./PdfPrintService";

interface PdfPrintSession {
  readonly sessionId: string;
  readonly documentGeneration: number;
}

/** Narrow Tauri adapter for one owner/session-bound native print lease. */
export class TauriPdfPrintBoundary implements PdfPrintNative {
  private readonly sessionId: string;
  private readonly documentGeneration: number;

  public constructor(
    session: PdfPrintSession,
    private readonly ownerGeneration: number,
  ) {
    this.sessionId = session.sessionId;
    this.documentGeneration = session.documentGeneration;
  }

  public start(request: PdfPrintStartRequest): Promise<PdfPrintSnapshot> {
    return invoke<PdfPrintSnapshot>("start_pdf_print", {
      ownerGeneration: this.ownerGeneration,
      sessionId: this.sessionId,
      documentGeneration: this.documentGeneration,
      pageCount: request.pageCount,
      currentPage: request.currentPage,
      title: request.title,
    });
  }

  public poll(jobId: string): Promise<PdfPrintSnapshot> {
    return invoke<PdfPrintSnapshot>("poll_pdf_print", {
      ownerGeneration: this.ownerGeneration,
      jobId,
    });
  }

  public submit(jobId: string, payload: Uint8Array): Promise<PdfPrintSnapshot> {
    return invoke<PdfPrintSnapshot>("submit_pdf_print_page", payload, {
      headers: {
        "x-print-job": jobId,
        "x-print-owner-generation": String(this.ownerGeneration),
      },
    });
  }

  public finish(jobId: string): Promise<PdfPrintSnapshot> {
    return invoke<PdfPrintSnapshot>("finish_pdf_print", {
      ownerGeneration: this.ownerGeneration,
      jobId,
    });
  }

  public cancel(jobId: string): Promise<PdfPrintSnapshot> {
    return invoke<PdfPrintSnapshot>("cancel_pdf_print", {
      ownerGeneration: this.ownerGeneration,
      jobId,
    });
  }

  public release(jobId: string): Promise<void> {
    return invoke<void>("release_pdf_print", {
      ownerGeneration: this.ownerGeneration,
      jobId,
    });
  }
}
