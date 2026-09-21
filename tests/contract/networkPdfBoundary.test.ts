import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(path, "utf8");
const section = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
};

describe("network PDF native dispatch boundaries (static, not SMB QA)", () => {
  const native = source("src-tauri/src/lib.rs");

  it("admits network work before scheduling rather than inside an unbounded worker queue", () => {
    const ingress = section(native, "fn emit_open_request", "enum NativeDialogFailureReason");
    const recent = section(native, "async fn open_recent", "fn prepare_external_links");
    const protocol = section(native, '.register_asynchronous_uri_scheme_protocol("modeleaf-pdf"', ".manage(second_instance_ingress)");
    for (const implementation of [ingress, recent, protocol]) {
      expect(implementation.indexOf(".try_acquire()")).toBeGreaterThanOrEqual(0);
      expect(implementation.indexOf(".try_acquire()")).toBeLessThan(implementation.indexOf("spawn_blocking"));
      expect(implementation).toContain("let _permit = permit;");
    }
    expect(ingress.indexOf("reserve_open")).toBeLessThan(ingress.indexOf("spawn_blocking"));
    expect(ingress).toContain("ingest_failure_owned(&owner");
  });

  it("uses a native recent path snapshot and positively proves local absence before pruning", () => {
    const recent = section(native, "async fn open_recent", "fn prepare_external_links");
    expect(recent).toContain("store.path_for_open(&recent_id)");
    expect(recent).not.toContain("store.resolve_for_open");
    expect(recent).toContain("confirmed_local_missing(&path)");
    expect(recent).toContain("RecentOpenOutcome::TransientFailure");
  });

  it("offloads retained-handle metadata for both recents and path shortcuts", () => {
    const record = section(native, "async fn record_recent", "fn clear_recent_documents");
    const shortcut = section(source("src-tauri/src/path_shortcuts.rs"), "pub async fn path_shortcut", "fn copy_clipboard");
    for (const implementation of [record, shortcut]) {
      expect(implementation).toMatch(/metadata\s*\.try_acquire\(\)/);
      expect(implementation).toContain("spawn_blocking");
      expect(implementation).toContain("let _permit = permit;");
    }
  });

  it("invalidates owner authority without waiting on network work and checks physical settlement on quit", () => {
    const lifecycle = section(native, "pub fn drain_owner_for_lifecycle", "fn drain_app_owners");
    expect(lifecycle).toContain("target_lost_for_lifecycle(owner)");
    expect(lifecycle).toContain("destroy_window(owner)");
    expect(lifecycle.indexOf("destroy_window(owner)")).toBeLessThan(lifecycle.indexOf("target_lost_for_lifecycle(owner)"));
    expect(lifecycle).toContain("defer_owned(owner)");
    expect(lifecycle).not.toContain("drain_owned(owner)");
    const quit = section(native, "fn complete_quit_application", "fn timeout_quit_application");
    expect(quit.indexOf("spawn_blocking")).toBeLessThan(quit.indexOf("drain_app_owners"));
    expect(quit).toContain(".assert_empty()");
    expect(quit).toContain("NativeIo::global().unsettled() == 0");
  });
  it("does not teach users to copy network PDFs locally or retain obsolete rejection DTOs", () => {
    for (const path of ["src/main.ts", "src/pdf/PdfReaderController.ts", "src/platform/OpenRequestClient.ts", "src/platform/tauri-commands.ts"]) {
      const text = source(path);
      expect(text).not.toContain("REMOTE_PATH");
      expect(text).not.toContain("Copy the PDF to a local drive");
    }
  });
  it("keeps native evidence behind renderer provenance validation and off the protocol payload", () => {
    const command = section(native, "fn record_diagnostic(", "const MAX_PENDING_SECOND_INSTANCE_PATHS");
    expect(command.indexOf("validate_renderer_event(&event)?")).toBeGreaterThanOrEqual(0);
    expect(command.indexOf("validate_renderer_event(&event)?")).toBeLessThan(command.indexOf("diagnostics.record(&event)"));
    const protocol = source("src-tauri/src/pdf_protocol.rs");
    expect(protocol).not.toContain("os_code");
    expect(protocol).not.toContain("PdfDiagnosticStage");
    const sessions = source("src-tauri/src/pdf_session.rs");
    expect(sessions).not.toContain(".record(");
    expect(sessions).not.toContain("DiagnosticLog");
    const open = section(sessions, "fn open_local_with_identity", "pub fn trusted_recent_identity");
    expect(open.indexOf("PdfFailureObservation::new")).toBeLessThan(open.indexOf("self.admit_open"));
    const range = section(sessions, "fn read_range_limited", "fn file_snapshot");
    expect(range.indexOf("PdfFailureObservation::new")).toBeLessThan(range.indexOf("self.admit_file_operation"));
    expect(native).toContain("install_diagnostics(sink)");
  });
});
