export const MAX_PAGE_TARGET_DIGITS = 9;

export type PageTargetError =
  | "PAGE_TARGET_EMPTY"
  | "PAGE_TARGET_TOO_LONG"
  | "PAGE_TARGET_OUT_OF_RANGE";

export type PageTargetResult =
  | { readonly ok: true; readonly page: number }
  | { readonly ok: false; readonly error: PageTargetError };

export function appendPageTargetDigit(digits: string, digit: string): string | PageTargetError {
  if (!/^[0-9]$/.test(digit)) {
    throw new TypeError("digit must be one ASCII decimal digit");
  }
  if (digits.length >= MAX_PAGE_TARGET_DIGITS) {
    return "PAGE_TARGET_TOO_LONG";
  }
  return digits + digit;
}

export function validatePageTarget(digits: string, pageCount: number): PageTargetResult {
  if (digits.length === 0) {
    return { ok: false, error: "PAGE_TARGET_EMPTY" };
  }
  const page = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
    return { ok: false, error: "PAGE_TARGET_OUT_OF_RANGE" };
  }
  return { ok: true, page };
}
