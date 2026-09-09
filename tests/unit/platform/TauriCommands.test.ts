import { describe, expect, it, vi } from "vitest";
import { CANONICAL_DEFAULT_CONFIG_TOML } from "../../../src/domain/config/ConfigFile";
import { clearRecentDocuments, commitIndicatorState, listRecentDocuments, recordRecentDocument, openNativePdfDialog, openRecentDocument, readIndicatorState, readProductConfig, resetProductConfig, writeDefaultProductConfig, type NativeInvoke } from "../../../src/platform/tauri-commands";

const invoke = (value: unknown): NativeInvoke => vi.fn(async () => value) as unknown as NativeInvoke;

describe("tauri-commands", () => {
  it("decodes and commits only validated indicator settings", async () => {
    const settings = { style: "beacon" as const, color: "cyan" as const, size: 28.5, durationMilliseconds: 1500 };
    await expect(readIndicatorState(invoke({ style: "beacon", color: "cyan", size: 28.5, duration_ms: 1500 }))).resolves.toEqual(settings);
    await expect(readIndicatorState(invoke(null))).resolves.toBeUndefined();
    const commit = vi.fn(async () => null) as unknown as NativeInvoke;
    await commitIndicatorState(commit, settings);
    expect(commit).toHaveBeenCalledWith("commit_indicator_state", { value: { style: "beacon", color: "cyan", size: 28.5, duration_ms: 1500 } });
  });

  it("rejects malformed indicator payloads without echoing fields", async () => {
    await expect(readIndicatorState(invoke({ style: "bad", color: "cyan", size: 28, duration_ms: 1500 }))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    await expect(readIndicatorState(invoke({ style: "beacon", color: "cyan", size: 28, duration_ms: 1500, path: "C:/secret" }))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
  });
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

  it("decodes path-free revisioned recent and dialog outcomes", async () => {
    const recentId = `recent-${"a".repeat(32)}`;
    await expect(listRecentDocuments(invoke({ tag: "READY", revision: "2", entries: [{ recentId, displayName: "문서.pdf" }] }))).resolves.toMatchObject({ tag: "READY", revision: "2" });
    await expect(openRecentDocument(invoke({ tag: "MISSING_PRUNED", revision: "3", entries: [] }), recentId)).resolves.toEqual({ tag: "MISSING_PRUNED", revision: "3", entries: [] });
    await expect(openNativePdfDialog(invoke({ tag: "ADMITTED", requestId: "b".repeat(64) }))).resolves.toEqual({ tag: "ADMITTED", requestId: "b".repeat(64) });
    await expect(recordRecentDocument(invoke({ tag: "COMMITTED", revision: "4", entries: [{ recentId, displayName: "문서.pdf" }] }), "c".repeat(64), 1, 7)).resolves.toMatchObject({ tag: "COMMITTED", revision: "4" });
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
  it("rejects paths, extra keys, unsafe IDs and overflowing revisions", async () => {
    const recentId = `recent-${"a".repeat(32)}`;
    await expect(listRecentDocuments(invoke({ tag: "READY", revision: "1", entries: [{ recentId, displayName: "a.pdf", path: "C:/secret" }] }))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    await expect(listRecentDocuments(invoke({ tag: "READY", revision: "18446744073709551616", entries: [] }))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    await expect(openRecentDocument(invoke({ tag: "ADMITTED", requestId: "b".repeat(64) }), "bad")).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    await expect(openNativePdfDialog(invoke({ tag: "CANCELLED", reason: "extra" }))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
  });
  it("rejects extra or unknown write outcomes", async () => {
    await expect(writeDefaultProductConfig(invoke({ tag: "CREATED", path: "C:/secret" }))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
    await expect(resetProductConfig(invoke({ tag: "UNKNOWN" }))).rejects.toThrow("NATIVE_CONTRACT_INVALID");
  });
});
