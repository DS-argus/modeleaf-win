import { describe, expect, it } from "vitest";
import { OPEN_ERROR_CODES, nativeOpenError } from "../../../src/domain/navigation/OpenError";

describe("OpenError", () => {
  it("freezes the exact six golden outcomes without path payloads", () => {
    expect(OPEN_ERROR_CODES).toEqual(["unsupportedLocation", "missingFile", "unreadableFile", "malformedDocument", "lockedDocument", "emptyDocument"]);
    expect(Object.isFrozen(OPEN_ERROR_CODES)).toBe(true);
  });

  it.each([
    ["PATH_REJECTED", "unsupportedLocation"],
    ["MISSING_FILE", "missingFile"], ["FILE_UNREADABLE", "unreadableFile"],
    ["PDF_INVALID", "malformedDocument"], ["DOCUMENT_TOO_LARGE", "malformedDocument"],
    ["SESSION_CAPACITY", undefined], ["future", undefined],
  ] as const)("maps native outcome %s to %s", (tag, expected) => expect(nativeOpenError(tag)).toBe(expected));
});
