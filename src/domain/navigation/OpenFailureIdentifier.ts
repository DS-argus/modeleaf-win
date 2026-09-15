export const OPEN_FAILURE_PHASES = Object.freeze([
  "picker-service",
  "request-admission",
  "adoption",
  "presentation",
  "ownership-capacity",
  "unknown",
] as const);

export type OpenFailurePhase = (typeof OPEN_FAILURE_PHASES)[number];

const IDENTIFIERS: Readonly<Record<OpenFailurePhase, string>> = {
  "picker-service": "OPEN_PICKER_SERVICE",
  "request-admission": "OPEN_REQUEST_ADMISSION",
  adoption: "OPEN_ADOPTION",
  presentation: "OPEN_PRESENTATION",
  "ownership-capacity": "OPEN_OWNERSHIP_CAPACITY",
  unknown: "OPEN_UNKNOWN",
};

const ACCESSIBILITY_ERRORS: Readonly<Record<OpenFailurePhase, OpenFailureAccessibilityError>> = {
  "picker-service": "open-picker-service",
  "request-admission": "open-request-admission",
  adoption: "open-adoption",
  presentation: "open-presentation",
  "ownership-capacity": "open-ownership-capacity",
  unknown: "open-unknown",
};

export type OpenFailureAccessibilityError =
  | "open-picker-service"
  | "open-request-admission"
  | "open-adoption"
  | "open-presentation"
  | "open-ownership-capacity"
  | "open-unknown";

export function openFailureStatus(phase: OpenFailurePhase): string {
  return `Could not open PDF. [${IDENTIFIERS[phase]}]`;
}

export function openFailureAccessibilityError(phase: OpenFailurePhase): OpenFailureAccessibilityError {
  return ACCESSIBILITY_ERRORS[phase];
}

export function openFailurePhase(value: unknown): OpenFailurePhase | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("tag" in value)) return undefined;
  const tagged = value as { readonly tag?: unknown; readonly reason?: unknown };
  if (tagged.tag === "DIALOG_FAILED") return "picker-service";
  if (tagged.tag !== "SELECTION_REJECTED" || typeof tagged.reason !== "string") return undefined;
  if (tagged.reason === "OPEN_REQUEST_CAPACITY") return "ownership-capacity";
  return "request-admission";
}
