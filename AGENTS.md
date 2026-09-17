# Repository Agent Guide

This is the repository-wide entry point for coding agents.

Keep it short and stable. Put detailed project architecture, commands, and conventions under `docs/engineering/`.

## Read Order

Before substantial implementation:

1. Read this file
2. Read any applicable nested `AGENTS.md`
3. Read only the project documentation relevant to the task
4. Read the current GitHub Issue and local handoff, when provided
5. Inspect the relevant code, tests, and configuration

Consult `docs/engineering/agent/workflow.md` when creating, splitting, prioritizing, coordinating, integrating, or cleaning up work items, or when a lifecycle or scope question arises.

Also consult it for a new substantial request that is not already assigned to an active Issue and worktree. A worktree agent with a complete Issue and handoff does not need to reread the full workflow for ordinary implementation.

Read `docs/engineering/agent/bootstrap.md` only when initializing, adopting, auditing, or substantially refreshing the repository's agent and engineering documentation.

## Sources of Truth

Use information in this order:

1. Current explicit user instruction
2. Applicable `AGENTS.md`
3. Current code and machine-verifiable configuration
4. Tracked project documentation
5. GitHub Issues and PRs
6. Local `.agent/` material

Inspect the repository before making assumptions. When documentation conflicts with verified code or configuration, investigate and update the stale source.

## Project Guidance

Modeleaf is a keyboard-first, read-only local PDF reader for Windows 11 x64, built with Tauri 2, Rust, TypeScript/Vite, and PDF.js in WebView2.

- Never modify source PDFs or expose PDF.js's generic viewer/editor/download/save surfaces. Rust owns filesystem, shell, window, registry, and durable I/O authority; the renderer uses opaque identifiers and narrow DTOs. Pure TypeScript domains do not import DOM, Tauri, or PDF.js.
- Only selected theme and recent files are active `state.json` fields. Reader view, tabs, and sessions remain non-durable; preserve unknown siblings during native atomic merges.
- Never change the user's chosen default PDF application, write `UserChoice`, or alter another application's registration. Report native, persistence, cleanup, printing, and release failures truthfully.
- Canonical local gate: `npm run gate:w01`. Manual app QA uses `npm run preview:worktree`, not a directly launched `src-tauri/target/debug/modeleaf.exe`. Build only in the assigned worktree and never overlap native builds.
- Product/infrastructure changes require an Issue and dedicated worktree unless the owner explicitly requests direct implementation. Signing, merging, tagging, publication, and release require explicit owner authorization. Releases bind reviewed source, ZIP SHA-256, and Scoop manifest hash; verify public bytes before bucket promotion.
- Current owner direction and Windows code are product authority, not macOS parity targets, local backlog entries, or retired manuals. [README](README.md) remains user-facing guidance; [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md) remains attribution authority.

See [architecture](docs/engineering/architecture/overview.md), [verification](docs/engineering/verification.md), and [conventions](docs/engineering/conventions.md) for detailed guidance and starter maintenance.

## Planning and Delegation

Treat a new substantial feature, fix, investigation, or refactor as planning input before creating Issues, handoffs, or worktrees.

The control agent should plan from the current user request, `.agent/BACKLOG.md`, open Issues, accepted plans, dependencies, priorities, and repository state.

It should:

- group or split work into independently mergeable units
- prioritize and sequence those units
- identify parallel work and coordination constraints
- define outcomes, scope, acceptance criteria, dependencies, and locked decisions

Do not create one worktree per backlog item automatically.

If the user asks to save an idea for later, record it in `.agent/BACKLOG.md` without creating an Issue or worktree.

If the request belongs to an active Issue and worktree, continue there unless it materially expands scope.

The worktree agent should inspect the code and resolve implementation details autonomously within the accepted contract. Do not over-specify implementation before that inspection.

Escalate decisions that would materially change user-visible behavior, architecture or state ownership, persistence, public interfaces, dependencies, security boundaries, or another active work item's contract.

## Worktrees and Scope

Keep substantial implementation inside the assigned worktree. Do not modify unrelated worktrees, discard another agent's changes, or use the primary checkout as an implementation workspace.

Keep each active worktree in a separate terminal or session context. When using tmux, prefer one window per worktree and include the Issue number in the window name.

The primary checkout should remain the control lane for planning, coordination, integration, and main synchronization.

Implement the accepted Issue contract, prefer the smallest complete change, and avoid unrelated cleanup, redesign, or speculative abstraction.

Create follow-up Issues for independently mergeable work. Report blockers or material scope expansion instead of silently changing the contract.

## Verification

Use `docs/engineering/verification.md`.

Distinguish automated tests, static checks, builds, simulated or headless verification, native or packaged verification, manual verification, and release verification.

Never report an unexecuted or stale check as passed. Record candidate identity when runtime or manual verification depends on a specific build.

## Documentation

Durable knowledge belongs in tracked documentation or tests. Temporary task context belongs under `.agent/`.

Use:

- architecture and ownership → `docs/engineering/architecture/`
- verification commands → `docs/engineering/verification.md`
- repository conventions → `docs/engineering/conventions.md`
- important decisions and rationale → `docs/engineering/decisions/`
- regression behavior → automated tests
- implementation result → PR
- future work → GitHub Issue

Store accepted ADRs under `docs/engineering/decisions/` using `templates/ADR.md`.

## Delivery Boundaries

Unless explicitly authorized, agents may inspect and edit the assigned worktree, run verification, commit, push the assigned branch, and create or update a Draft PR.

Merge, tag, release, deployment, artifact publication, production credentials, repository visibility changes, destructive user-data operations, and unrelated worktree changes require explicit authorization.

Authorization for one operation does not imply authorization for another.

## Definition of Done

A work item is complete when:

- the accepted scope is implemented
- relevant regression coverage exists
- required verification is complete or honestly reported
- the PR reflects the current head
- durable knowledge is stored in the correct place
- follow-up work is recorded separately
- no unrelated changes remain
