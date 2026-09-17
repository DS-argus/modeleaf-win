# Engineering conventions

## Ownership and state

Follow the boundaries in [architecture](architecture/overview.md). Keep `src/domain` free of DOM, Tauri, PDF.js, UI, platform, and application dependencies. Keep filesystem, Windows shell/registry, window lifecycle, and durable I/O on the Rust side of the Tauri boundary. Renderer-native interaction uses narrow DTOs and opaque session identifiers.

PDFs are read-only: do not add editing, saving, download, or generic PDF.js viewer surfaces. Preserve owner/document-generation checks and cancellation barriers around native PDF resources. Failures from native, persistence, cleanup, printing, or release work must remain visible to callers.

`state.json` owns only `selected_theme` and `recent_files`; use the existing native locking and atomic merge path, preserving unknown root siblings. Never make tabs, sessions, reader view, page, zoom, rotation, or history durable without an explicit product/ownership decision and updated contract coverage.

## Windows and release boundaries

Do not alter `UserChoice` or another application's PDF registration; candidate association support must leave the user's default application intact. Do not treat print submission as proof of physical output or completed Save As output.

Build only in the assigned worktree and serialize native builds. Manual app evidence comes from `npm run preview:worktree`, which binds the isolated candidate to a source/build receipt; do not use `src-tauri/target/debug/modeleaf.exe` directly as standalone QA.

Signing, publishing, merging, tagging, bucket promotion, and release actions require explicit owner authorization. Release candidates bind reviewed source, ZIP SHA-256, and Scoop manifest hash; verify public bytes before bucket promotion.

## Dependencies, generated assets, and fixtures

Use the lockfiles and pinned Node/npm/Rust toolchains. Do not hand-edit copied PDF.js runtime assets under `public/assets/pdfjs-*`; update them through `npm run assets:sync` and reconcile the exact dependency version, adapter behavior, asset manifest, notices, and legal verification.

Keep fixture manifests, generation scripts, snapshots, and contracts synchronized. Do not add generated fixture PDFs, native build output, evidence, or local agent/runtime data to Git unless explicitly required. See [.gitignore](../../.gitignore) and [verification](verification.md) before generating specialized evidence.
