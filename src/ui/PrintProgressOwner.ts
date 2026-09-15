import type { PdfPrintProgress } from "../pdf/PdfPrintService";

export interface PrintProgressSession {
  readonly printProgress: PdfPrintProgress | undefined;
  cancelPrint(): void;
}

/** Keeps the single process-wide print operation visible while its tab is inactive. */
export class PrintProgressOwner<T extends PrintProgressSession> {
  private owner: T | undefined;

  public begin(session: T): void {
    this.owner ??= session;
  }

  public report(session: T, progress: PdfPrintProgress | undefined): void {
    if (progress !== undefined) {
      this.owner = session;
    } else if (this.owner === session) {
      this.owner = undefined;
    }
  }

  public get progress(): PdfPrintProgress | undefined {
    return this.owner?.printProgress;
  }

  public cancel(): void {
    this.owner?.cancelPrint();
  }

  public owns(session: T): boolean {
    return this.owner === session;
  }
}
