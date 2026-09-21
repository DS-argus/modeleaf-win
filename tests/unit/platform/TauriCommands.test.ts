import { describe, expect, it, vi } from "vitest";
import { CANONICAL_DEFAULT_CONFIG_TOML } from "../../../src/domain/config/ConfigFile";
import { clearRecentDocuments, listRecentDocuments, listRecentDisplayAliases, recordRecentDocument, openNativePdfDialog, openRecentDocument, readProductConfig, resetProductConfig, writeDefaultProductConfig, type NativeInvoke } from "../../../src/platform/tauri-commands";

const invoke = (value: unknown): NativeInvoke => vi.fn(async () => value) as unknown as NativeInvoke;

describe("tauri-commands", () => {
  it("decodes and validates loaded config without exposing a generic filesystem call", async () => {
    await expect(readProductConfig(invoke({ tag: "LOADED", text: CANONICAL_DEFAULT_CONFIG_TOML }))).resolves.toMatchObject({ tag: "LOADED", config: { ok: true } });
    await expect(readProductConfig(invoke({ tag: "MISSING" }))).resolves.toEqual({ tag: "MISSING" });
  });

  it.each([null, [], {}, { tag: "OTHER" }, { tag: "LOADED" }, { tag: "MISSING", text: "secret" }])("rejects malformed read payload %# with one redacted error", async (value) => {
    await expect(readProductConfig(invoke(value))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
  });

  it("sends no renderer-controlled bytes for write and reset", async () => {
    const write = vi.fn(async () => ({ tag: "CREATED" })) as NativeInvoke;
    const reset = vi.fn(async () => ({ tag: "REPLACED" })) as NativeInvoke;
    await expect(writeDefaultProductConfig(write)).resolves.toEqual({ tag: "CREATED" });
    await expect(resetProductConfig(reset)).resolves.toEqual({ tag: "REPLACED" });
    expect(write).toHaveBeenCalledWith("write_default_config");
    expect(reset).toHaveBeenCalledWith("reset_config");
  });

  it("decodes revisioned recent display paths without changing open authority", async () => {
    const recentId = `recent-${"a".repeat(32)}`;
    const displayPath = "C:\\자료\\résumé.pdf";
    const entry = { recentId, displayName: "résumé.pdf", displayPath };
    await expect(listRecentDocuments(invoke({ tag: "READY", revision: "2", entries: [entry] }))).resolves.toEqual({
      tag: "READY",
      revision: "2",
      entries: [{ recentId, displayName: "résumé.pdf", displayPath }],
    });

    const openRecent = invoke({ tag: "MISSING_PRUNED", revision: "3", entries: [] });
    await expect(openRecentDocument(openRecent, recentId)).resolves.toEqual({ tag: "MISSING_PRUNED", revision: "3", entries: [] });
    expect(openRecent).toHaveBeenCalledWith("open_recent", { recentId });
    await expect(openNativePdfDialog(invoke({ tag: "ADMITTED", requestId: "b".repeat(64) }))).resolves.toEqual({ tag: "ADMITTED", requestId: "b".repeat(64) });
    await expect(recordRecentDocument(invoke({ tag: "COMMITTED", revision: "4", entries: [entry] }), "c".repeat(64), 1, 7)).resolves.toMatchObject({ tag: "COMMITTED", revision: "4", entries: [{ displayPath }] });
    await expect(recordRecentDocument(invoke({ tag: "STORAGE_FAILED", reason: "STATE_WRITE_FAILED" }), "c".repeat(64), 1, 7)).resolves.toEqual({ tag: "STORAGE_FAILED", reason: "STATE_WRITE_FAILED" });
    await expect(recordRecentDocument(invoke({ tag: "READY", revision: "5", entries: [] }), "c".repeat(64), 1, 7)).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    await expect(recordRecentDocument(invoke({ tag: "COMMITTED", revision: "5", entries: [] }), "c".repeat(64), 1, 0)).rejects.toThrow("NATIVE_CONTRACT_INVALID");
  });

  it("clears recent history through native authority and preserves typed failures", async () => {
    const native = invoke({ tag: "COMMITTED", revision: "6", entries: [] });
    await expect(clearRecentDocuments(native)).resolves.toEqual({ tag: "COMMITTED", revision: "6", entries: [] });
    expect(native).toHaveBeenCalledWith("clear_recent_documents");
    await expect(clearRecentDocuments(invoke({ tag: "STORAGE_FAILED", reason: "STATE_WRITE_FAILED" }))).resolves.toEqual({ tag: "STORAGE_FAILED", reason: "STATE_WRITE_FAILED" });
    await expect(clearRecentDocuments(invoke({ tag: "STATE_UNAVAILABLE", reason: "STATE_INVALID_ROOT" }))).resolves.toEqual({ tag: "STATE_UNAVAILABLE", reason: "STATE_INVALID_ROOT" });
    await expect(clearRecentDocuments(invoke({ tag: "COMMITTED", revision: "6", entries: [], path: "C:/secret" }))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
  });
  it("requires an exact bounded control-free recent display path", async () => {
    const recentId = `recent-${"a".repeat(32)}`;
    const ready = (entry: unknown) => ({ tag: "READY", revision: "1", entries: [entry] });
    const valid = { recentId, displayName: "a.pdf", displayPath: "C:\\safe\\a.pdf" };
    const maximumDisplayPath = `C:\\${"😀".repeat(16_380)}.pdf`;
    const oversizedDisplayPath = `C:\\${"😀".repeat(16_380)}a.pdf`;

    expect(maximumDisplayPath).toHaveLength(32_767);
    expect(oversizedDisplayPath).toHaveLength(32_768);
    await expect(listRecentDocuments(invoke(ready({ ...valid, displayPath: maximumDisplayPath })))).resolves.toMatchObject({ tag: "READY" });
    await expect(listRecentDocuments(invoke(ready({ recentId, displayName: "a.pdf" })))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    await expect(listRecentDocuments(invoke(ready({ ...valid, displayPath: "" })))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    await expect(listRecentDocuments(invoke(ready({ ...valid, displayPath: 42 })))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    await expect(listRecentDocuments(invoke(ready({ ...valid, displayPath: "C:\\bad\nname.pdf" })))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    await expect(listRecentDocuments(invoke(ready({ ...valid, displayPath: oversizedDisplayPath })))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    await expect(listRecentDocuments(invoke(ready({ ...valid, path: "C:\\unsafe\\a.pdf" })))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    await expect(listRecentDocuments(invoke({ tag: "READY", revision: "18446744073709551616", entries: [] }))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    await expect(openRecentDocument(invoke({ tag: "ADMITTED", requestId: "b".repeat(64) }), "bad")).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    await expect(openNativePdfDialog(invoke({ tag: "CANCELLED", reason: "extra" }))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
  });
  it("rejects extra or unknown write outcomes", async () => {
    await expect(writeDefaultProductConfig(invoke({ tag: "CREATED", path: "C:/secret" }))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    await expect(resetProductConfig(invoke({ tag: "UNKNOWN" }))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
  });
});

describe("recent display aliases", () => {
  const alias = { recentId: `recent-${"a".repeat(32)}`, displayPath: "V:\\자료\\report.pdf" };
  it("requests native-owned display aliases without renderer path arguments", async () => {
    const native = invoke({ tag: "READY", revision: "9", aliases: [alias] });
    await expect(listRecentDisplayAliases(native)).resolves.toEqual({ tag: "READY", revision: "9", aliases: [alias] });
    expect(native).toHaveBeenCalledExactlyOnceWith("list_recent_display_aliases");
    await expect(listRecentDisplayAliases(invoke({ tag: "UNAVAILABLE" }))).resolves.toEqual({ tag: "UNAVAILABLE" });
  });
  it.each([
    { tag: "READY", revision: "01", aliases: [] },
    { tag: "READY", revision: "18446744073709551616", aliases: [] },
    { tag: "READY", revision: "1", aliases: [alias, alias] },
    { tag: "READY", revision: "1", aliases: [{ ...alias, recentId: "path-as-authority" }] },
    { tag: "READY", revision: "1", aliases: [{ ...alias, displayPath: "\\\\server\\share\\report.pdf" }] },
    { tag: "READY", revision: "1", aliases: [{ ...alias, displayPath: "V:relative.pdf" }] },
    { tag: "READY", revision: "1", aliases: [{ ...alias, displayPath: "V:\\bad\nname.pdf" }] },
    { tag: "READY", revision: "1", aliases: [{ ...alias, server: "forbidden" }] },
    { tag: "UNAVAILABLE", aliases: [] },
  ])("rejects malformed or excessive authority payload %#", async value => {
    await expect(listRecentDisplayAliases(invoke(value))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
  });
});
