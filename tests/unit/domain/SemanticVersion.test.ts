import { describe, expect, it } from "vitest";
import {
  compareSemanticVersions,
  decideWindowsUpdate,
  decideUpdateNotice,
  parseSemanticVersion,
} from "../../../src/domain/update/SemanticVersion";

const parsed = (source: string) => {
  const result = parseSemanticVersion(source);
  if (!result.ok) throw new Error(`${source}: ${result.error}`);
  return result.value;
};

describe("SemanticVersion", () => {
  it("parses release tags and ignores build metadata in precedence", () => {
    expect(parsed("v1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(compareSemanticVersions(parsed("1.2.3+one"), parsed("1.2.3+two"))).toBe(0);
  });

  it("implements SemVer release and prerelease ordering", () => {
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let index = 1; index < order.length; index += 1) {
      expect(compareSemanticVersions(parsed(order[index - 1]!), parsed(order[index]!))).toBe(-1);
    }
  });

  it.each(["1.2", "01.2.3", "1.2.3-01", "1.2.3-", "v", "1.2.3.4", "999999999999999999999.0.0"])(
    "rejects malformed or overflowing %s",
    (source) => expect(parseSemanticVersion(source).ok).toBe(false),
  );

  it("keeps offline update checks silent", () => {
    expect(decideUpdateNotice("1.2.3", { kind: "offline" })).toBe("silent-offline");
    expect(decideUpdateNotice("1.2.3", { kind: "release", latest: "1.2.4", windowsRelease: true })).toBe("update-available");
  });
  it("makes silent pure Windows update decisions", () => {
    expect(decideWindowsUpdate("1.2.3", "1.2.4", true)).toBe("update-available");
    expect(decideWindowsUpdate("1.2.3", "1.2.3", true)).toBe("same-or-older");
    expect(decideWindowsUpdate("1.2.3", "1.1.9", true)).toBe("same-or-older");
    expect(decideWindowsUpdate("1.2.3", "1.3.0-beta.1", true)).toBe("prerelease-ignored");
    expect(decideWindowsUpdate("1.2.3", "1.3.0", false)).toBe("non-windows-release");
    expect(decideWindowsUpdate("bad", "1.3.0", true)).toBe("malformed");
  });
});
