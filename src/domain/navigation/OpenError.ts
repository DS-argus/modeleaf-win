export const OPEN_ERROR_CODES = Object.freeze([
  "unsupportedLocation",
  "missingFile",
  "unreadableFile",
  "malformedDocument",
  "lockedDocument",
  "emptyDocument",
] as const);

export type OpenErrorCode = (typeof OPEN_ERROR_CODES)[number];

export function nativeOpenError(tag: string): OpenErrorCode | undefined {
  switch (tag) {
    case "PATH_REJECTED": return "unsupportedLocation";
    case "MISSING_FILE": return "missingFile";
    case "FILE_UNREADABLE": return "unreadableFile";
    case "PDF_INVALID": case "DOCUMENT_TOO_LARGE": return "malformedDocument";
    default: return undefined;
  }
}
