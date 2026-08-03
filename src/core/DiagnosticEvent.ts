export const DIAGNOSTIC_EVENTS = [
  "APPLICATION",
  "PDF_SESSION",
  "PDF_RENDER",
  "EXTERNAL_LINK",
  "THEME_STATE",
  "QUIT",
] as const;

export const DIAGNOSTIC_OUTCOMES = ["SUCCESS", "REJECTED", "FAILURE", "CANCELLED"] as const;

export const DIAGNOSTIC_TAGS = [
  "NONE",
  "VALIDATION_REJECTED",
  "LOCALITY_REJECTED",
  "CONFLICT",
  "IO_FAILURE",
  "TIMEOUT",
  "REDACTED",
] as const;

export const DIAGNOSTIC_STORAGE_CLASSES = ["LOCAL"] as const;

export type DiagnosticEventName = (typeof DIAGNOSTIC_EVENTS)[number];
export type DiagnosticOutcome = (typeof DIAGNOSTIC_OUTCOMES)[number];
export type DiagnosticTag = (typeof DIAGNOSTIC_TAGS)[number];
export type DiagnosticStorageClass = (typeof DIAGNOSTIC_STORAGE_CLASSES)[number];

export const MAX_DIAGNOSTIC_ID_LENGTH = 32;
export const MAX_DIAGNOSTIC_VERSION_LENGTH = 32;
export const MAX_DIAGNOSTIC_PAGE = 1_000_000;
export const MAX_DIAGNOSTIC_COUNT = 1_000_000;
export const MAX_DIAGNOSTIC_DURATION_MS = 86_400_000;
export const MAX_DIAGNOSTIC_GENERATION = 9_007_199_254_740_991;
export const MAX_DIAGNOSTIC_EPOCH_MS = 9_999_999_999_999;

export interface DiagnosticEvent {
  readonly event: DiagnosticEventName;
  readonly outcome: DiagnosticOutcome;
  readonly tag: DiagnosticTag;
  readonly storageClass: DiagnosticStorageClass;
  readonly epochMs: number;
  readonly appVersion: string;
  readonly runtimeVersion: string;
  readonly traceId?: string;
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly page?: number;
  readonly count?: number;
  readonly durationMs?: number;
  readonly generation?: number;
}

const EVENT_SET = new Set<string>(DIAGNOSTIC_EVENTS);
const OUTCOME_SET = new Set<string>(DIAGNOSTIC_OUTCOMES);
const TAG_SET = new Set<string>(DIAGNOSTIC_TAGS);
const STORAGE_CLASS_SET = new Set<string>(DIAGNOSTIC_STORAGE_CLASSES);
const ID_PATTERN = /^[a-f0-9]{32}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+)?$/;
const KEYS = new Set<keyof DiagnosticEvent>([
  "event", "outcome", "tag", "storageClass", "epochMs", "appVersion", "runtimeVersion",
  "traceId", "requestId", "sessionId", "page", "count", "durationMs", "generation",
]);

/** Returns whether an untrusted value is exactly the finite native diagnostic DTO. */
export function isDiagnosticEvent(value: unknown): value is DiagnosticEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !KEYS.has(key as keyof DiagnosticEvent))) {
    return false;
  }
  if (
    !EVENT_SET.has(candidate.event as string) ||
    !OUTCOME_SET.has(candidate.outcome as string) ||
    !TAG_SET.has(candidate.tag as string) ||
    !STORAGE_CLASS_SET.has(candidate.storageClass as string) ||
    !isBoundedInteger(candidate.epochMs, MAX_DIAGNOSTIC_EPOCH_MS) ||
    !isVersion(candidate.appVersion) ||
    !isVersion(candidate.runtimeVersion)
  ) {
    return false;
  }
  return (
    isOptionalId(candidate.traceId) &&
    isOptionalId(candidate.requestId) &&
    isOptionalId(candidate.sessionId) &&
    isOptionalInteger(candidate.page, MAX_DIAGNOSTIC_PAGE) &&
    isOptionalInteger(candidate.count, MAX_DIAGNOSTIC_COUNT) &&
    isOptionalInteger(candidate.durationMs, MAX_DIAGNOSTIC_DURATION_MS) &&
    isOptionalInteger(candidate.generation, MAX_DIAGNOSTIC_GENERATION)
  );
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_DIAGNOSTIC_VERSION_LENGTH && VERSION_PATTERN.test(value);
}

function isOptionalId(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && ID_PATTERN.test(value));
}

function isOptionalInteger(value: unknown, maximum: number): boolean {
  return value === undefined || isBoundedInteger(value, maximum);
}

function isBoundedInteger(value: unknown, maximum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
