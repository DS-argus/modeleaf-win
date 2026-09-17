# Repository Bootstrap

This document is setup and documentation-maintenance guidance.

Do not read or run this process for ordinary feature or bug work.

Use it only when explicitly asked to initialize, adopt, audit, or substantially refresh the repository's agent and engineering documentation.

## Goal

Create a small and reliable set of project-specific instructions that helps future agents understand:

- what the project is
- how the repository is organized
- which boundaries apply across most tasks
- how changes are verified
- where detailed engineering knowledge belongs

Document information that is expensive to rediscover.

Do not attempt to describe the entire repository.

## Principles

- inspect the repository before writing guidance
- prefer current code and machine-verifiable configuration over stale prose
- preserve useful existing documentation
- link to an existing source of truth instead of duplicating it
- keep the root `AGENTS.md` concise
- create documentation only when it has durable value
- record uncertainty instead of inventing facts
- do not implement unrelated product changes during bootstrap

## Inspect First

Inspect relevant repository sources, such as:

- root README
- contribution and development guides
- manifests and lockfiles
- build and test scripts
- CI workflows
- source entry points
- top-level modules
- release configuration
- generated-file configuration
- existing architecture and design documents
- existing ADRs
- current `AGENTS.md` files
- `.gitignore`

Read implementation code when documentation and configuration are insufficient to establish an important fact.

Do not infer architecture from directory names alone.

## Update the Root AGENTS.md

Add a small project-specific section containing only information useful across most development tasks.

Typical content:

- one short project description
- primary languages, frameworks, and platforms
- the canonical verification entry point
- critical repository-wide invariants
- links to detailed project documentation

Keep planning and delegation rules from the starter intact.

Project-specific guidance should not turn the root file into a complete architecture or development manual.

Do not place the following in the root file:

- complete architecture descriptions
- long command lists
- module inventories
- feature-specific implementation plans
- temporary worktree information
- historical development narratives

## Create or Reconcile Project Documentation

Create only documents that provide clear long-term value.

Common outputs may include:

```text
docs/engineering/
├── architecture/
│   └── overview.md
├── verification.md
├── conventions.md
└── decisions/
    └── README.md
```

Equivalent existing documents may remain in their current locations.

Prefer linking and reconciliation over unnecessary relocation.

### Architecture

Document stable project structure:

- major components
- dependency direction
- state and persistence ownership
- native or platform boundaries
- important runtime flows
- critical invariants

Avoid file-by-file descriptions.

### Verification

Record canonical ways to verify changes.

Include only relevant layers, such as:

- focused tests
- full automated gate
- static checks
- build verification
- headless or simulated verification
- native or packaged verification
- manual QA
- release verification

For important layers, explain:

- canonical command
- what it proves
- what it does not prove
- when it is required

Prefer an existing wrapper command over repeatedly listing its internal steps.

### Conventions

Record non-obvious repository-specific rules, such as:

- ownership boundaries
- generated-file policy
- dependency policy
- fixture policy
- error-handling conventions
- state-transition rules
- platform-specific constraints

Do not restate formatter or linter defaults unless agents need them to work safely.

### Decisions

Accepted ADRs should normally be stored under:

```text
docs/engineering/decisions/
```

Use `templates/ADR.md` as the default format.

Create an ADR only when:

- multiple reasonable choices existed
- the selected choice constrains future work
- the rationale is not obvious from code
- changing the choice should require deliberate reconsideration

Create `docs/engineering/decisions/README.md` when useful to document numbering, status values, and supersession rules.

Do not use ADRs as implementation diaries.

## Add Focused Documentation Only When Needed

Add a focused document when the knowledge:

- applies to multiple future tasks
- materially changes implementation decisions
- is not obvious from nearby code
- does not fit cleanly in the core documents

Possible examples:

```text
docs/engineering/native-integration.md
docs/engineering/persistence.md
docs/engineering/rendering.md
docs/engineering/security-boundaries.md
docs/engineering/release-pipeline.md
```

Additional documentation namespaces may be created when the project needs them:

```text
docs/product/
docs/design/
docs/security/
docs/operations/
docs/api/
docs/release/
```

Do not create empty hierarchies for hypothetical future use.

## Evaluate Nested AGENTS.md Files

Create a nested `AGENTS.md` only when a subtree has materially different rules.

Typical reasons:

- separate language or toolchain
- distinct verification commands
- generated-code restrictions
- native or security boundaries
- migration constraints
- platform-specific ownership

A nested file should contain only the local delta from the parent guidance.

Do not repeat the root workflow.

## Reconcile Existing Documentation

When useful documentation already exists:

- preserve established terminology
- retain reliable sources of truth
- remove or correct stale claims
- link related documents
- reduce unnecessary duplication
- avoid mechanical reorganization

Do not reshape the repository merely to match the starter layout.

## Validate the Result

Before completing bootstrap:

- confirm referenced files exist
- confirm documented commands exist
- confirm important claims are supported by code or configuration
- confirm the root `AGENTS.md` remains concise
- confirm planning and delegation rules remain intact
- confirm no speculative empty documentation structure was added
- confirm unrelated product code was not changed

## Completion Report

Report:

- files created
- files updated
- existing documents retained as sources of truth
- project-wide guidance added to `AGENTS.md`
- nested `AGENTS.md` files added
- canonical verification commands discovered
- unresolved questions
- areas intentionally left undocumented
