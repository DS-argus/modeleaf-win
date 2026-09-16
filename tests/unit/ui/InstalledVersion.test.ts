import { afterEach, describe, expect, it, vi } from "vitest";
import { getVersion } from "@tauri-apps/api/app";
import { loadInstalledVersion } from "../../../src/platform/InstalledVersion";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

describe("installed package version", () => {
  it("uses runtime metadata rather than the source package version", async () => {
    vi.mocked(getVersion).mockResolvedValue(" 9.8.7-preview.2 ");
    expect(await loadInstalledVersion()).toBe("9.8.7-preview.2");
  });
  it.each(["rejected", "empty"])("omits unknown metadata on %s without a fabricated fallback", async (failure) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    if (failure === "rejected") vi.mocked(getVersion).mockRejectedValue(new Error("permission denied"));
    else vi.mocked(getVersion).mockResolvedValue(" ");
    expect(await loadInstalledVersion()).toBeUndefined();
    expect(warning).toHaveBeenCalledWith("Installed Modeleaf version is unavailable.", expect.any(Error));
  });
});
