import { decideUpdateNotice, type UpdateDecision, type UpdateMetadataOutcome } from "../domain/update/SemanticVersion";

/**
 * Notify-only update surface.
 *
 * ADR 0001 forbids an updater install API, background installation, forced
 * restart, and self-update. This model therefore projects only two things:
 * whether a banner is visible, and which release page a user-initiated click
 * should open. It never produces an install action.
 */

export interface UpdateNoticeState {
  readonly visible: boolean;
  readonly latestVersion?: string;
  readonly message: string;
  readonly decision: UpdateDecision | "silent-offline";
}

export const HIDDEN_UPDATE_NOTICE: UpdateNoticeState = Object.freeze({
  visible: false,
  message: "",
  decision: "same-or-older",
});

/**
 * Projects a notice from a metadata outcome.
 *
 * Every failure mode — offline, malformed metadata, a prerelease, a
 * non-Windows release — resolves to a hidden banner. `feature-spec.md` §15
 * requires update checking to fail silently rather than surfacing an error the
 * user cannot act on.
 */
export function projectUpdateNotice(current: string, outcome: UpdateMetadataOutcome): UpdateNoticeState {
  const decision = decideUpdateNotice(current, outcome);
  if (decision !== "update-available") {
    return Object.freeze({ visible: false, message: "", decision });
  }
  const latestVersion = outcome.kind === "offline" ? undefined : outcome.latest;
  return Object.freeze({
    visible: true,
    ...(latestVersion === undefined ? {} : { latestVersion }),
    message: latestVersion === undefined
      ? "A newer version is available."
      : `Version ${latestVersion} is available.`,
    decision,
  });
}

/** True only when the user may open the release page. */
export function canOpenReleasePage(state: UpdateNoticeState): boolean {
  return state.visible && state.latestVersion !== undefined;
}

/**
 * Builds the release URL for a visible notice.
 *
 * Returns `undefined` when no update is available, so the opener cannot be
 * invoked from a hidden banner. The scheme is always `https`, which the Rust
 * opener allowlist requires.
 */
export function releasePageUrl(state: UpdateNoticeState, repository: string): string | undefined {
  if (!canOpenReleasePage(state)) return undefined;
  // Each segment must contain a word character and cannot be a dot segment,
  // otherwise a slug such as "../evil" would escape the releases path.
  const segments = repository.split("/");
  if (segments.length !== 2) return undefined;
  if (!segments.every((segment) => /^[\w.-]+$/u.test(segment) && /\w/u.test(segment) && segment !== "." && segment !== "..")) return undefined;
  return `https://github.com/${repository}/releases/tag/v${state.latestVersion!}`;
}
