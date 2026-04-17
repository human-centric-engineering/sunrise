---
allowed-tools: Bash, Glob, Grep, Read, Agent
description: Execute a test plan by spawning test-engineer subagents to create, add, and rewrite tests
---

Execute a test plan by spawning test-engineer subagents. This command is a **plan executor** — it expects a plan from `/test-plan` (or generates a minimal one inline for trivially small scopes).

For each file in the plan, the agent handles whichever combination is needed:

- **Create**: No test file exists → write from scratch
- **Add**: Test file exists but missing test cases → add new cases
- **Rewrite**: Test file exists with quality issues → rewrite weak tests while preserving good ones

**Important:** This command spawns test-engineer agents in the **foreground** (never background) — they need Write/Edit tool access.

## Input

$ARGUMENTS — controls what to execute:

- **`plan`** → execute the most recent `/test-plan` from the conversation (Sprint 1 by default)
- **`plan sprint N`** → execute a specific sprint from the most recent plan
- **`plan all`** → execute all sprints sequentially from the most recent plan
- **File paths (1-2 files only)** → generate a minimal inline plan and execute it immediately (skip `/test-plan` for trivial scope)
- **No arguments** → look for a plan in the conversation; if none exists, prompt the user to run `/test-plan` first

**Selecting prior context:** When multiple `/test-plan` outputs exist in the conversation, use the **most recent** one. Ignore older plans.

## Steps

### Step 1: Resolve the plan

**If `plan` keyword is present:**

- Extract the most recent `/test-plan` output from the conversation
- If `sprint N` is specified, extract only that sprint's batches
- If `all` is specified, execute all sprints in order
- If neither, default to Sprint 1
- If no plan exists in the conversation, report: "No test plan found. Run `/test-plan` first to create one." and stop.

**If 1-2 file paths are provided (no `plan` keyword):**

- This is a trivially small scope — generate a minimal plan inline:
  - Read each source file
  - Check for existing test files and read them if present
  - Classify each existing test as keep/rewrite, identify missing tests
  - Determine mocking requirements
  - Create a single-batch plan
- Confirm with the user before executing

**If 3+ file paths are provided:**

- Report: "For 3+ files, run `/test-plan {paths}` first to create a structured plan, then `/test-write plan` to execute it." and stop.

**If no arguments and no plan in conversation:**

- Report: "No plan found. Run one of these first:" and list:
  - `/test-plan` — plan tests for branch changes
  - `/test-plan {folder}` — plan tests for a specific folder
  - `/test-plan coverage` — plan from coverage analysis
  - `/test-plan review` — plan from quality review findings

### Step 2: Present execution summary and confirm

Before spawning any agents, show the user what will happen:

```
## Execution Plan

**Sprint**: {sprint number and name}
**Files**: {count}
**Agent batches**: {count}
**Estimated agents to spawn**: {count}

| Batch | Files | Action | Agent Scope |
|-------|-------|--------|-------------|
| 1.1 | 3 | CREATE (2), UPDATE (1) | Validation schemas — simple, no mocking |
| 1.2 | 1 | UPDATE | Auth guards — complex, auth + db mocking |

Proceed? (Y/n)
```

Wait for user confirmation before spawning agents. If the user wants to adjust, they should modify the plan and re-run.

### Step 3: Execute agent batches sequentially

For each batch in the sprint, spawn a **foreground** test-engineer agent. The prompt must include:

1. **The per-file work instructions** from the plan (keep/rewrite/add details for each file)

2. **Test quality guidance:**

> **Test quality requirements:**
>
> - Every test must follow AAA (Arrange-Act-Assert) pattern
> - Test the code's INTENT and CONTRACT, not just its current output
> - For **Keep** tests: do not modify these — they are already good
> - For **Rewrite** tests: preserve the scenario being tested but fix the assertions/approach. The rewritten test should fail if the code's behavior regresses.
> - For **Add** tests: write new test cases for the listed scenarios. Each should test ONE specific behavior.
> - Use shared mock factories from `tests/types/mocks.ts`
> - Use type-safe assertions from `tests/helpers/assertions.ts`
> - When a test fails: determine if the code or the test is wrong before fixing (see "When Tests Fail" in agent definition)
> - Read `.claude/skills/testing/gotchas.md` before writing any tests

3. **Validation requirements:**

> After completing all changes:
>
> 1. Run `npm test -- {test file paths}` — all must pass
> 2. Run `npm run lint` — no new errors
> 3. Run `npm run type-check` — no new errors
>    Do NOT mark complete until all three pass.

### Step 4: Report batch results

After each agent completes, report:

```
### Batch {N} Results

| File | Test File | Action | Kept | Rewritten | Added | Total | Pass | Status |
|------|-----------|--------|------|-----------|-------|-------|------|--------|
| `lib/auth/guards.ts` | `tests/unit/lib/auth/guards.test.ts` | UPDATE | 4 | 2 | 3 | 9 | 9/9 | DONE |
| `lib/api/client.ts` | `tests/unit/lib/api/client.test.ts` | CREATE | — | — | 12 | 12 | 12/12 | DONE |

{Any issues encountered or suspected code bugs discovered}
```

If an agent reports a **suspected code bug** (test fails because the source code appears wrong):

- Flag it clearly — do NOT modify the source code without user approval
- Report: file path, line number, expected vs actual behavior, evidence

### Step 5: Sprint summary

After all batches in the sprint complete:

```
## Sprint {N} Complete: {name}

**Files processed**: {count}
- Created: {count} new test files
- Updated: {count} existing test files ({rewritten} tests rewritten, {added} tests added, {kept} tests kept)
**Total tests**: {count}
**All passing**: Yes / No

### Coverage Impact
| File | Before | After | Target | Status |
|------|--------|-------|--------|--------|
{per-file coverage changes — run `npm run test:coverage` to get updated numbers}

### Suspected Code Bugs
{List any cases where the test was written to the correct contract but fails against the current code}
{Or "None found"}

### Next Steps
{If more sprints remain in the plan:}
- `/test-write plan sprint {N+1}` — execute the next sprint ({name})
- `/test-review` — audit quality of what was just written before proceeding
{If this was the last sprint:}
- `/test-review` — audit quality of all tests written
- `/test-coverage branch` — verify coverage meets thresholds
- `/pre-pr` — final validation before opening a pull request
```
