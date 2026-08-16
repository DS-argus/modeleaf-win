export interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
}

export type SemanticVersionParseResult =
  | { readonly ok: true; readonly value: SemanticVersion }
  | { readonly ok: false; readonly error: "VERSION_MALFORMED" | "VERSION_OVERFLOW" };
export type UpdateDecision =
  | "update-available"
  | "same-or-older"
  | "prerelease-ignored"
  | "non-windows-release"
  | "malformed";

export type UpdateMetadataOutcome =
  | { readonly kind: "offline" }
  | { readonly kind: "release"; readonly latest: string; readonly windowsRelease: boolean };

const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function parseSemanticVersion(source: string): SemanticVersionParseResult {
  const match = VERSION.exec(source);
  if (match === null) return { ok: false, error: "VERSION_MALFORMED" };
  const numbers = match.slice(1, 4).map(Number);
  if (!numbers.every(Number.isSafeInteger)) return { ok: false, error: "VERSION_OVERFLOW" };
  const prerelease: (string | number)[] = [];
  for (const identifier of match[4]?.split(".") ?? []) {
    if (/^\d+$/u.test(identifier)) {
      if (identifier.length > 1 && identifier.startsWith("0")) return { ok: false, error: "VERSION_MALFORMED" };
      const numeric = Number(identifier);
      if (!Number.isSafeInteger(numeric)) return { ok: false, error: "VERSION_OVERFLOW" };
      prerelease.push(numeric);
    } else prerelease.push(identifier);
  }
  return {
    ok: true,
    value: Object.freeze({
      major: numbers[0]!, minor: numbers[1]!, patch: numbers[2]!,
      prerelease: Object.freeze(prerelease),
    }),
  };
}

export function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion): -1 | 0 | 1 {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "string") return -1;
    if (typeof a === "string" && typeof b === "number") return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function decideWindowsUpdate(current: string, latest: string, windowsRelease: boolean): UpdateDecision {
  if (!windowsRelease) return "non-windows-release";
  const currentVersion = parseSemanticVersion(current);
  const latestVersion = parseSemanticVersion(latest);
  if (!currentVersion.ok || !latestVersion.ok) return "malformed";
  if (latestVersion.value.prerelease.length > 0) return "prerelease-ignored";
  return compareSemanticVersions(currentVersion.value, latestVersion.value) < 0 ? "update-available" : "same-or-older";
}

export function decideUpdateNotice(current: string, outcome: UpdateMetadataOutcome): UpdateDecision | "silent-offline" {
  return outcome.kind === "offline"
    ? "silent-offline"
    : decideWindowsUpdate(current, outcome.latest, outcome.windowsRelease);
}
