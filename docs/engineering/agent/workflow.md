# Agent Development Workflow

This document defines the common lifecycle for agent-driven development

It is a lifecycle reference, not required reading for every implementation task

Project-specific architecture, commands, and constraints belong elsewhere under `docs/engineering/`

## Lifecycle

```text
User direction and backlog
→ Control-agent planning
→ Issue
→ Handoff
→ Worktree
→ Implementation
→ Verification
→ Draft PR
→ Human review when required
→ Merge
→ Main synchronization
→ Knowledge promotion
→ Cleanup
```

Default mapping

```text
one implementation Issue
→ one branch
→ one worktree
→ one handoff
→ one PR
```

Use the GitHub Issue number as the shared identifier

```text
Issue        #123
Branch       feat/123-wheel-zoom
Worktree     .worktrees/123-wheel-zoom
Handoff      .agent/handoffs/123-wheel-zoom.md
tmux window  123-wheel-zoom
PR           Closes #123
```

Use parent Issues with independently mergeable child Issues for large initiatives

## Planning and Backlog

The control agent decides implementation units before creating worktrees

Plan from current user direction, `.agent/BACKLOG.md`, open Issues, accepted plans, dependencies, priorities, conflicts, and repository state

For each development batch

1. identify current priorities
2. review related backlog items and Issues
3. group work that belongs in one review and merge
4. split work with independent test or merge value
5. determine dependency and integration order
6. choose parallel tasks
7. create or refine Issues
8. create worktrees only for the selected batch

Prefer one worktree per independently mergeable unit

Combine items when they form one coherent outcome or share the same implementation and verification boundary

Split items when they have different dependencies, risks, ownership boundaries, or independent merge value

Unless the user directs otherwise, prioritize explicit current direction, blocking prerequisites, correctness fixes, accepted plans, then remaining backlog order

Explain non-obvious grouping, ordering, or parallelization choices

### Backlog Operation

Treat `.agent/BACKLOG.md` as a local intake and planning buffer, not permanent history

For later ideas, preserve only the short description, relevant context or constraints, and date or source when useful

Do not require estimates or implementation details at intake time

For work requested now, plan directly without forcing it through the backlog first

Refine only realistic candidates with coarse metadata such as priority, size, risk, affected area, dependencies, and why now

After promotion to a GitHub Issue, the Issue becomes the source of truth and the backlog item should normally be removed

Remove completed or obsolete items

Park an item only with a clear reason and revisit condition

## Issue, Handoff, and Delegation

An Issue defines the problem, outcome, acceptance criteria, scope, verification expectations, dependencies, and constraints

Keep local execution details and speculative implementation plans out of the Issue

A handoff provides task-specific execution context

```text
.agent/handoffs/<issue>-<slug>.md
```

It may include the mission, references, planning context, locked and open decisions, ownership boundaries, verification commands, escalation conditions, and deliverables

Do not duplicate the full Issue inside the handoff

The control agent defines the contract and decisions that must remain fixed

The worktree agent inspects the code and resolves implementation details within that contract

Use

- **Locked decisions** for product, architecture, or coordination choices that must be preserved
- **Open decisions** for implementation details the worktree agent should resolve autonomously

Escalate changes to user-visible behavior, Issue scope, architecture or state ownership, persistence, public interfaces, dependencies, security boundaries, or another active work item's contract

## Worktree and Session Setup

Recommended naming

```text
Issue or PR   <type>(<scope>): <observable outcome>
Branch        <type>/<issue>-<slug>
Worktree      .worktrees/<issue>-<slug>
```

Before implementation

- fetch and confirm the intended base
- confirm the worktree is clean
- identify shared files and exclusive resources
- note overlap with parallel work

Keep each active worktree in a separate terminal or session context

When using tmux

```text
primary checkout   → control
.worktrees/123-*   → 123-<short-slug>
```

The primary checkout remains the control lane

Substantial implementation happens in dedicated worktrees

tmux is recommended, not required

## Implementation

Before editing, inspect relevant code, nearby tests, applicable project documentation, and current behavior

During implementation

- make the smallest complete change
- preserve ownership and architectural boundaries
- add relevant regression coverage
- avoid unrelated cleanup or redesign
- use existing abstractions when appropriate

Classify discovered work as

- **Required** — necessary and tightly coupled
- **Follow-up** — independently mergeable
- **Decision point** — requires a material product or architecture choice

Include required work within the accepted contract, create follow-up Issues for independent work, and escalate decision points

## Verification and Pull Requests

Project-specific verification belongs in `docs/engineering/verification.md`

Run focused checks during development and the required full gate before final review

Distinguish automated, static, build, simulated, native, manual, and release verification

Use `PASS`, `FAIL`, `NOT RUN`, `BLOCKED`, `N/A`, or `STALE` when useful

Record candidate identity when runtime or manual verification depends on a specific build

Open a Draft PR when the implementation is coherent enough to review

The PR body should describe the current head, not development chronology

Include summary, actual changes, verification, review focus, and unverified or follow-up work

Use `Closes #123` only when the PR completes the Issue

Use `Refs #123` for partial or supporting work

For manual QA

1. build from the assigned worktree
2. identify and launch the tested candidate
3. record only observed results
4. apply feedback in the same worktree
5. invalidate stale QA after material changes

## Parallel Work

Run tasks in parallel only when they can be integrated independently

Check dependencies, shared files, schemas, interfaces, generated artifacts, lockfiles, build outputs, runtime state, and exclusive devices, ports, processes, or signing resources

```text
A ∥ B   independent
A → B   dependent
```

Record meaningful overlap in the handoff

Worktree isolation does not isolate external resources

Serialize shared external resources when necessary

## Merge and Cleanup

Creating a PR does not imply merge authority

Before merge, confirm required checks, final PR accuracy, resolved blocking feedback, honest manual QA status, and recorded follow-up work

Keep merge, release, and deployment authority separate

After merge

1. synchronize local `main`
2. confirm Issue and PR state
3. create follow-up Issues
4. promote durable knowledge
5. update the backlog
6. remove the handoff and worktree when safe
7. prune obsolete local branches when appropriate

Promote durable knowledge as follows

```text
Implementation result          → PR
Regression behavior            → automated test
Architectural invariant        → architecture documentation
Important decision and reason  → ADR under docs/engineering/decisions/
Recurring repository rule      → conventions or applicable AGENTS.md
Future work                    → GitHub Issue or backlog
```

Trivial corrections may skip parts of this workflow

Use the normal process for changes affecting product behavior, architecture, persistence, public APIs, native integration, release behavior, manual QA, or parallel work
