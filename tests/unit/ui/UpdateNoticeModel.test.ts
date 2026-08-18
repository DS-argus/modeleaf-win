import { describe, expect, it } from "vitest";
import {
  canOpenReleasePage,
  projectUpdateNotice,
  releasePageUrl,
  HIDDEN_UPDATE_NOTICE,
} from "../../../src/ui/UpdateNoticeModel";

const online = (latest: string, windowsRelease = true) => ({ kind: "release" as const, latest, windowsRelease });

describe("update notice projection", () => {
  it("shows a banner when a newer Windows release exists", () => {
    const state = projectUpdateNotice("0.1.0", online("0.2.0"));
    expect(state).toMatchObject({ visible: true, latestVersion: "0.2.0", decision: "update-available" });
    expect(state.message).toContain("0.2.0");
  });

  it("stays hidden when the current version is newest", () => {
    expect(projectUpdateNotice("0.2.0", online("0.2.0")).visible).toBe(false);
    expect(projectUpdateNotice("0.3.0", online("0.2.0")).visible).toBe(false);
  });

  it("fails silently when offline", () => {
    // §15 requires silent failure; a network error is not actionable.
    const state = projectUpdateNotice("0.1.0", { kind: "offline" });
    expect(state).toMatchObject({ visible: false, decision: "silent-offline" });
    expect(state.message).toBe("");
  });

  it("fails silently on malformed metadata", () => {
    const state = projectUpdateNotice("0.1.0", online("not-a-version"));
    expect(state.visible).toBe(false);
    expect(state.decision).toBe("malformed");
  });

  it("ignores a prerelease rather than offering it", () => {
    const state = projectUpdateNotice("0.1.0", online("0.2.0-beta.1"));
    expect(state.visible).toBe(false);
    expect(state.decision).toBe("prerelease-ignored");
  });

  it("ignores a release that is not a Windows release", () => {
    const state = projectUpdateNotice("0.1.0", online("0.9.0", false));
    expect(state.visible).toBe(false);
    expect(state.decision).toBe("non-windows-release");
  });

  it("exposes a hidden default state", () => {
    expect(HIDDEN_UPDATE_NOTICE.visible).toBe(false);
    expect(canOpenReleasePage(HIDDEN_UPDATE_NOTICE)).toBe(false);
  });
});

describe("release page opening", () => {
  it("builds an https release URL for a visible notice", () => {
    const state = projectUpdateNotice("0.1.0", online("0.2.0"));
    const url = releasePageUrl(state, "DS-argus/modeleaf-win");
    // https only: the Rust opener allowlist rejects every other scheme.
    expect(url).toBe("https://github.com/DS-argus/modeleaf-win/releases/tag/v0.2.0");
    expect(url?.startsWith("https://")).toBe(true);
  });

  it("refuses to build a URL when no update is available", () => {
    // A hidden banner must not be able to drive the opener.
    expect(releasePageUrl(projectUpdateNotice("0.2.0", online("0.2.0")), "DS-argus/modeleaf-win")).toBeUndefined();
    expect(releasePageUrl(projectUpdateNotice("0.1.0", { kind: "offline" }), "DS-argus/modeleaf-win")).toBeUndefined();
  });

  it("rejects a malformed repository slug instead of building a bad URL", () => {
    const state = projectUpdateNotice("0.1.0", online("0.2.0"));
    for (const slug of ["", "no-slash", "a/b/c", "../evil", "owner/repo?x=1"]) {
      expect(releasePageUrl(state, slug), slug).toBeUndefined();
    }
  });

  it("never produces an install or restart action", () => {
    // The whole surface is notify-only; the model exposes no such affordance.
    const state = projectUpdateNotice("0.1.0", online("0.2.0"));
    expect(Object.keys(state).sort()).toEqual(["decision", "latestVersion", "message", "visible"]);
  });
});
