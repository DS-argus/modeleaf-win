import { describe, expect, it } from "vitest";
import {
  openFailureAccessibilityError,
  openFailurePhase,
  openFailureStatus,
} from "../../../src/domain/navigation/OpenFailureIdentifier";

describe("open failure identifiers", () => {
  it.each([
    ["picker-service", "Could not open PDF. [OPEN_PICKER_SERVICE]"],
    ["request-admission", "Could not open PDF. [OPEN_REQUEST_ADMISSION]"],
    ["adoption", "Could not open PDF. [OPEN_ADOPTION]"],
    ["presentation", "Could not open PDF. [OPEN_PRESENTATION]"],
    ["ownership-capacity", "Could not open PDF. [OPEN_OWNERSHIP_CAPACITY]"],
    ["unknown", "Could not open PDF. [OPEN_UNKNOWN]"],
  ] as const)("renders the stable %s identifier", (phase, status) => {
    expect(openFailureStatus(phase)).toBe(status);
    expect(openFailureAccessibilityError(phase)).toMatch(/^open-/);
  });

  it("maps only native-safe DTO phases", () => {
    expect(openFailurePhase({ tag: "DIALOG_FAILED", reason: "PICKER_FAILED" })).toBe("picker-service");
    expect(openFailurePhase({ tag: "SELECTION_REJECTED", reason: "OPEN_REQUEST_NOT_FOUND" })).toBe("request-admission");
    expect(openFailurePhase({ tag: "SELECTION_REJECTED", reason: "OPEN_REQUEST_CAPACITY" })).toBe("ownership-capacity");
    expect(openFailurePhase({ tag: "SELECTION_REJECTED", reason: "C:\\secret.pdf" })).toBe("request-admission");
    expect(openFailurePhase(new Error("C:\\secret.pdf"))).toBeUndefined();
  });
});
