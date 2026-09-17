---
repo:
issue:
status: ready
priority:
batch:
base_branch: main
base_sha:
branch:
worktree:
depends_on: []
conflicts_with: []
shared_files: []
exclusive_resources: []
manual_qa: not_required
---

# Handoff — #<issue> <title>

## Mission

Implement the scoped Issue and deliver a verified Draft PR ready for review

## Read First

- `AGENTS.md`
- GitHub Issue
- Relevant project documentation
- Relevant local references under `.agent/reference/<issue>-<slug>/`

## Planning Context

- Why this work is in the current batch:
- Dependency or ordering notes:
- Parallel work to coordinate with:

## Locked Decisions

<!-- Decisions already made by the user or control lane. Preserve these. -->

-

## Open Decisions

<!-- Implementation details the worktree agent should investigate and resolve autonomously. -->

-

## Execution Boundaries

### Owned Areas

-

### Shared or Coordination-Required Areas

-

### Do Not Modify

-

## Starting Points

- Relevant files, symbols, tests, or existing patterns
- Treat these as orientation, not an exhaustive implementation plan

## Verification

### During Development

-

### Before PR

- Canonical project verification from `docs/engineering/verification.md`

### Manual QA

- `N/A`, or list required scenarios and candidate identity requirements

## Deliverables

- Scoped implementation
- Relevant regression coverage
- Updated Draft PR
- Honest verification status
- Follow-up Issues for independently mergeable work

## Escalate When

- a decision would change user-visible behavior or Issue scope
- architecture or state ownership must change
- persistence, public interfaces, or dependencies must change
- a security boundary would change
- another active work item's contract would be affected
- a destructive or production-affecting action becomes necessary
- the requested behavior cannot be verified at the required layer

## Completion Snapshot

- PR:
- Final head:
- Automated verification:
- Native or packaged verification:
- Manual verification:
- Follow-up Issues:
- Integration notes:
