# ADR 0002: Windows PDF transport

- **Status:** Accepted
- **Date:** 2026-08-16
- **Baseline:** Modeleaf v0.10.0, `0f7ff0b54c3674c48f6b555261f939397cfbfb88`
- **Authority:** `docs/windows-porting/implementation-phases.md`, W02; ADR 0001.

## Context

PDF.js must read local PDFs without exposing filesystem paths, copying a complete large document through JSON/base64, or weakening Rust's retained read-only handle and cancellation lifecycle. W02 compared the planned custom protocol against the existing binary IPC control path in a packaged Windows WebView2 application.

## Decision

The production transport is the Tauri `modeleaf-pdf` custom protocol backed by `PdfSessionManager`.

The renderer receives only `http://modeleaf-pdf.localhost/<64-hex-session-id>/<document-generation>`. On Windows, WebView2 exposes that mapped HTTP origin while Tauri's protocol callback receives the original fixed `localhost` host. The callback derives `PdfOwner` from the requesting webview label and current workspace generation; the URI token alone never authorizes access.

The protocol supports:

- exact packaged-origin or same-origin packaged Referer validation;
- `OPTIONS`, `HEAD`, bounded full `GET`, and one explicit byte range;
- `Accept-Ranges`, `Content-Length`, `Content-Range`, `Content-Type`, `no-store`, and `nosniff` response contracts;
- non-oracular `404` for wrong owner, stale generation, missing session, or closing session;
- `416` with `Content-Range: bytes */total` for malformed, multi, EOF, overflow, or over-4-MiB ranges;
- `503` for admitted-capacity failures and `500` for retained-handle I/O failures.

Small-document PDF.js URL loading uses an ordinary GET and receives a bounded full `200` response at or below twice the 1-MiB chunk size. Larger documents use `PDFDataRangeTransport`; its first request is the real HTTP range `bytes=0-1048575`, and every later request also carries one explicit `Range` header. `Content-Length` always equals the returned body size while `Content-Range` carries the total document size. PDF.js may coalesce adjacent 1-MiB chunks up to the existing 4-MiB absolute read lane; the normal IPC read lane remains capped at 1 MiB. A partial response is never emitted for a request without `Range`.

`PdfDataRangeAdapter` remains a unit-test control for bounded byte semantics. The production binary range IPC command and renderer callsite were removed; there is no runtime transport fallback.

## Evidence

The schema-valid transport record references `docs/evidence/w02/artifacts/transport.json`. Its checksum is locked by the evidence contract test. The packaged trace covers positive small/large transfer; Rust protocol/session contracts cover HEAD, malformed/multi/EOF/overflow/over-limit `416`, wrong-owner/stale/closing `404`, capacity `503`, I/O `500`, cancellation ownership, and byte-for-byte source invariance.

On the recorded Windows 11 reference workstation, packaged WebView2 produced:

- CORS preflight `204`;
- initial large-document `206`, `Content-Range: bytes 0-1048575/33665980`;
- subsequent explicit range requests including PDF.js-coalesced 2-MiB spans;
- only `204`/`206` responses during the successful 33,665,980-byte raster fixture load;
- first-page commit before complete-file transfer;
- no `416`, JSON/base64 payload, filesystem path, or duplicate native handle registry.

The 1,539-byte small fixture used a bounded full `200` response and rendered successfully. The 2,019-byte links fixture separately supplied packaged geometry evidence. Source SHA-256 is checked before and after evidence runs.

## Consequences

Custom protocol registration and its narrow CSP origin are required for every app window. Every webview sharing the WebView2 user-data folder must retain environment parity. Protocol tests are security tests: route shape, source attribution, CORS, status mapping, range arithmetic, capacity, cancellation, and source invariance must remain covered.

The one-shot binary IPC path is not the production architecture and must not be used as a compatibility fallback. JSON/base64 transport remains prohibited.
