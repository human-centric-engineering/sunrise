# Codebase Test Triage & Quality Plan

**Objective:** Systematically raise the floor of test quality across the entire Sunrise codebase using `/test-triage` for cheap grading, then targeted fixes. Identify areas needing deeper ceiling passes (full `/test-coverage` → `/test-plan` → `/test-write` → `/test-review` cycles).

**Created:** 2026-04-22
**Status:** In progress (Step 1a complete, Step 3b next)
**Ledger:** `.claude/testing/remediation-ledger.md` (13 files already triaged from earlier dogfood runs)

---

## How to Use This Plan

**Starting a new session:** Open this file. Find the first phase/step not marked DONE. Run the commands listed. Update status here when complete.

**Per-step workflow:**

```
/test-triage scan <target>       # Grade files (fast, cheap)
/test-triage worklist            # See prioritized queue (Rotten first)
# For Minor/Bad with clear findings:
/test-fix from-rescan <file>     # Path A: fast fix from ledger NOTES
# For Rotten or vague findings:
/test-review <file> → /test-fix  # Path B: full audit then fix
/test-triage rescan <file>       # Verify fix, update ledger
```

**Session sizing:** ~15-25 test files per session. One sub-step per session is a good pace.

**Commit cadence:** Commit after completing each sub-step (e.g., 1a, 1b). Don't batch across sub-steps.

**Ceiling passes** are called out explicitly where needed — these use the heavier `/test-coverage` → `/test-plan coverage` → `/test-write plan` → `/test-review` chain to fill coverage gaps, not just fix quality.

---

## Inventory

| Area                              | Source Files | Test Files                      | Notes                                              |
| --------------------------------- | ------------ | ------------------------------- | -------------------------------------------------- |
| `lib/orchestration/`              | 114          | 109                             | Biggest domain — engine, LLM, MCP, knowledge, chat |
| `lib/` (non-orchestration)        | 98           | 79                              | auth, security, api, analytics, storage, etc.      |
| `components/admin/orchestration/` | ~135 source  | 135                             | Large UI surface — workflow builder, costs, forms  |
| `components/` (non-admin-orch)    | ~87          | 41                              | forms, auth, dashboard, settings, ui               |
| `app/api/`                        | 150          | 65 unit + 98 integration        | API routes — significant unit gap                  |
| `app/` pages (non-api)            | ~84          | 13                              | Page-level tests sparse                            |
| `tests/integration/`              | —            | 120                             | 98 API + 22 app integration tests                  |
| **Totals**                        | **~670**     | **~552 unit + 120 integration** |                                                    |

---

## Phase 1: Security & Auth Foundation

**Why first:** Highest-risk areas. Quality problems here have the worst consequences.
**Estimated effort:** 1-2 sessions

> **Note:** `lib/auth/` was partially triaged during dogfood runs (7 files in ledger). Check ledger state before re-scanning — only rescan files that moved since last grade.

### Step 1a — `lib/security/` (9 test files)

- **Triage:** `/test-triage scan lib/security`
- **Ceiling pass:** YES — run `/test-coverage lib/security` after triage to find untested security code
- **Status:** DONE (2026-04-24, PR #90)
- **Notes:**
  - Grade distribution: 1 Rotten, 3 Bad, 5 Clean → all 9 Clean after fixes
  - Rotten: rate-limit.test.ts — async surface entirely untested, Date.now() token drift, off-by-one between sync/async semantics (intentional, documented)
  - Bad: cors (mock-proving, missing !allowed path), proxy (12 weak negative assertions), rate-limit-stores (Redis error paths, LRU untested)
  - Path 0 (annotations) effective for structural `toBe(true)` false positives — used on 4 files
  - Path A (3 concurrent worktree agents) validated — ran smoothly on battery, cap subsequently bumped to 5
  - Path B (rate-limit review+fix) caught async/sync off-by-one as source finding S1 — agent attempted fix, reverted when it broke semantics
  - proxy.test.ts imports from `@/proxy` (root), not `lib/security/` — source path mapping friction
  - Ceiling pass still pending — do after triage is further along

### Step 1b — `lib/auth/` (9 test files, 7 already in ledger)

- **Triage:** `/test-triage scan lib/auth` (will skip already-graded files at same HEAD)
- **Ceiling pass:** YES — `/test-coverage lib/auth` after triage
- **Fix remaining:** `guards.test.ts` (Bad), `verification-status.test.ts` (Bad), `utils.test.ts` (Minor) still open from prior runs
- **Status:** PARTIAL — 7/9 graded, 2 Bad + 1 Minor still need fixes
- **Notes:**

### Step 1c — Auth-related API routes (~10 test files)

- **Triage:** `/test-triage scan` targeting auth routes in `tests/unit/app/api/v1/` (auth, users, invitations)
- **Status:** NOT STARTED
- **Notes:**

### Step 1d — `lib/validations/` (8 test files)

- **Triage:** `/test-triage scan lib/validations`
- **Status:** NOT STARTED
- **Notes:**

---

## Phase 2: Core Infrastructure

**Why second:** Shared utilities everything else depends on. Small directories — fast turnaround.
**Estimated effort:** 1-2 sessions

### Step 2a — `lib/api/` (10 test files)

- **Triage:** `/test-triage scan lib/api`
- **Status:** NOT STARTED
- **Notes:**

### Step 2b — `lib/errors/` (2 test files)

- **Triage:** `/test-triage scan lib/errors`
- **Status:** NOT STARTED
- **Notes:**

### Step 2c — `lib/logging/` (2 test files)

- **Triage:** `/test-triage scan lib/logging`
- **Status:** NOT STARTED
- **Notes:**

### Step 2d — `lib/db/` (1 test file)

- **Triage:** `/test-triage scan lib/db`
- **Status:** NOT STARTED
- **Notes:**

### Step 2e — `lib/utils/` (6 test files)

- **Triage:** `/test-triage scan lib/utils`
- **Status:** NOT STARTED
- **Notes:**

### Step 2f — `lib/hooks/` (4 test files)

- **Triage:** `/test-triage scan lib/hooks`
- **Status:** NOT STARTED
- **Notes:**

### Step 2g — `lib/constants/` + `lib/feature-flags/` (2 test files)

- **Triage:** `/test-triage scan lib/constants` then `/test-triage scan lib/feature-flags`
- **Status:** NOT STARTED
- **Notes:**

---

## Phase 3: Orchestration Engine

**The bulk of the work.** 109 test files for 114 source files, broken into sub-domains.
**Estimated effort:** 4-6 sessions

### Step 3a — `engine/` (23 test files)

- **Path:** `tests/unit/lib/orchestration/engine/`
- **Triage:** `/test-triage scan lib/orchestration/engine`
- **Ceiling pass:** YES — critical runtime path
- **Status:** NOT STARTED
- **Notes:**

### Step 3b — `llm/` (20 test files)

- **Path:** `tests/unit/lib/orchestration/llm/`
- **Triage:** `/test-triage scan lib/orchestration/llm`
- **Status:** NOT STARTED
- **Notes:**

### Step 3c — `mcp/` (13 test files)

- **Path:** `tests/unit/lib/orchestration/mcp/`
- **Triage:** `/test-triage scan lib/orchestration/mcp`
- **Status:** NOT STARTED
- **Notes:**

### Step 3d — `knowledge/` (12 test files)

- **Path:** `tests/unit/lib/orchestration/knowledge/`
- **Triage:** `/test-triage scan lib/orchestration/knowledge`
- **Status:** NOT STARTED
- **Notes:**

### Step 3e — `chat/` (10 test files)

- **Path:** `tests/unit/lib/orchestration/chat/`
- **Triage:** `/test-triage scan lib/orchestration/chat`
- **Ceiling pass:** YES — critical user-facing path
- **Status:** NOT STARTED
- **Notes:**

### Step 3f — `capabilities/` (9 test files)

- **Path:** `tests/unit/lib/orchestration/capabilities/`
- **Triage:** `/test-triage scan lib/orchestration/capabilities`
- **Status:** NOT STARTED
- **Notes:**

### Step 3g — `workflows/` (4 test files)

- **Path:** `tests/unit/lib/orchestration/workflows/`
- **Triage:** `/test-triage scan lib/orchestration/workflows`
- **Status:** NOT STARTED
- **Notes:**

### Step 3h — Remaining orchestration (14 test files)

- **Covers:** `evaluations/` (2), `scheduling/` (2), `webhooks/` (1), `hooks/` (2), `analytics/` (3), `utils/` (2), `audit/` (1), `backup/` (3) — note: `audit` was previously uncounted
- **Triage:** Scan each small folder individually
- **Status:** NOT STARTED
- **Notes:**

---

## Phase 4: API Routes

65 unit + 98 integration tests for 150 route files. Significant unit coverage gap by file count.
**Estimated effort:** 3-4 sessions

### Step 4a — Admin orchestration API routes (~45 unit + ~85 integration)

- **Path:** `tests/unit/app/api/v1/admin/orchestration/` + `tests/integration/api/v1/admin/`
- **Triage:** `/test-triage scan` on the unit tests first, then integration
- **After triage:** `/test-coverage app/api/v1/admin` to find routes with zero coverage
- **Status:** NOT STARTED (2 files already in ledger from dogfood: `stats/route.test.ts` unit=Minor, integration=Clean)
- **Notes:**

### Step 4b — Chat/consumer API routes (~15 test files)

- **Path:** `tests/unit/app/api/v1/chat/` + `tests/integration/api/v1/chat/`
- **Triage:** `/test-triage scan` on both
- **Status:** NOT STARTED
- **Notes:**

### Step 4c — Embed API routes (~5 test files)

- **Path:** `tests/unit/app/api/v1/embed/`
- **Triage:** `/test-triage scan`
- **Status:** NOT STARTED
- **Notes:**

### Step 4d — Remaining API routes (contact, users, webhooks, invitations, mcp)

- **Triage:** `/test-triage scan` on each
- **Status:** NOT STARTED (contact `unit=Clean`, `integration=Clean` from dogfood)
- **Notes:**

---

## Phase 5: Orchestration Admin Components

135 test files — the largest single UI test surface. Break by feature area.
**Estimated effort:** 4-5 sessions

### Step 5a — Workflow builder (29 test files)

- **Path:** `tests/unit/components/admin/orchestration/workflow-builder/`
- **Triage:** `/test-triage scan components/admin/orchestration/workflow-builder`
- **Status:** NOT STARTED
- **Notes:**

### Step 5b — Costs/budget (10 test files)

- **Path:** `tests/unit/components/admin/orchestration/costs/`
- **Triage:** `/test-triage scan components/admin/orchestration/costs`
- **Status:** NOT STARTED
- **Notes:**

### Step 5c — Knowledge base UI (10 test files)

- **Path:** `tests/unit/components/admin/orchestration/knowledge/`
- **Triage:** `/test-triage scan components/admin/orchestration/knowledge`
- **Status:** NOT STARTED
- **Notes:**

### Step 5d — Learning UI (9 test files)

- **Path:** `tests/unit/components/admin/orchestration/learn/`
- **Triage:** `/test-triage scan components/admin/orchestration/learn`
- **Status:** NOT STARTED
- **Notes:**

### Step 5e — MCP admin pages (8 test files)

- **Path:** `tests/unit/components/admin/orchestration/mcp/`
- **Triage:** `/test-triage scan components/admin/orchestration/mcp`
- **Status:** NOT STARTED
- **Notes:**

### Step 5f — Remaining admin orchestration components (~67 test files)

- **Covers:** agents, capabilities, providers, evaluations, observability, setup wizard, chat, analytics, audit-log, experiments, workflows
- **Path:** `tests/unit/components/admin/orchestration/` (everything not covered above)
- **Triage:** Scan the remaining subdirectories individually or in small batches
- **Status:** NOT STARTED
- **Notes:**

---

## Phase 6: Other Components & Pages

**Estimated effort:** 2-3 sessions

### Step 6a — `components/forms/` (15 test files)

- **Triage:** `/test-triage scan components/forms`
- **Status:** NOT STARTED
- **Notes:**

### Step 6b — `components/ui/` (9 test files)

- **Triage:** `/test-triage scan components/ui`
- **Status:** NOT STARTED
- **Notes:**

### Step 6c — Remaining components (9 test files)

- **Covers:** `analytics/` (3, all Clean from dogfood), `auth/` (2), `dashboard/` (1), `settings/` (1), `cookie-consent/` (2)
- **Triage:** Scan each
- **Status:** PARTIAL — `analytics/` already Clean (3 files)
- **Notes:**

### Step 6d — App page tests (13 test files)

- **Covers:** `app/(auth)/` (6 tests), `app/admin/` (7 tests)
- **Triage:** `/test-triage scan` on each
- **Status:** NOT STARTED
- **Notes:**

---

## Phase 7: Supporting Areas

**Estimated effort:** 2-3 sessions

### Step 7a — `lib/email/` + email templates (6 test files)

- **Triage:** `/test-triage scan lib/email` + `/test-triage scan emails`
- **Status:** NOT STARTED
- **Notes:**

### Step 7b — `lib/analytics/` (10 test files)

- **Triage:** `/test-triage scan lib/analytics`
- **Status:** NOT STARTED
- **Notes:**

### Step 7c — `lib/consent/` (4 test files)

- **Triage:** `/test-triage scan lib/consent`
- **Status:** NOT STARTED
- **Notes:**

### Step 7d — `lib/storage/` + `lib/monitoring/` + `lib/embed/` (10 test files)

- **Triage:** Scan each (note: `lib/embed/` now has 1 test file — `auth.test.ts`)
- **Status:** NOT STARTED
- **Notes:**

### Step 7e — Integration tests (120 test files)

- **Covers:** `tests/integration/api/` (98) + `tests/integration/app/` (22)
- **Triage:** `/test-triage scan` on integration directories, working through admin (85), chat (2), users (4), then app (22)
- **Status:** NOT STARTED (2 integration files already in ledger from dogfood)
- **Notes:** Integration tests need different attention — mock realism and boundary coverage matter more than assertion quality

---

## Phase 8: Coverage Gap Fill (Parallel Track)

Each phase above will surface files with zero test coverage via `/test-coverage`. Track them here and batch new test creation using `/test-plan` → `/test-write`.

### Priority 1 — Untested API routes (security surface)

- **Status:** NOT STARTED
- **Gaps found:**
- **Notes:**

### Priority 2 — Untested orchestration engine modules

- **Status:** NOT STARTED
- **Gaps found:**
- **Notes:**

### Priority 3 — Untested components and pages

- **Status:** NOT STARTED
- **Gaps found:**
- **Notes:**

---

## Progress Summary

Update this table after completing each step.

| Step | Target                           | Files | Grade Distribution      | Ceiling Pass? | Status      |
| ---- | -------------------------------- | ----- | ----------------------- | ------------- | ----------- |
| 1a   | lib/security                     | 9     | 9C (was 1R, 3B, 5C)     | YES (pending) | DONE        |
| 1b   | lib/auth                         | 9     | 2C, 1M, 2B (from prior) | YES           | PARTIAL     |
| 1c   | Auth API routes                  | ~10   |                         | No            | NOT STARTED |
| 1d   | lib/validations                  | 8     |                         | No            | NOT STARTED |
| 2a   | lib/api                          | 10    |                         | No            | NOT STARTED |
| 2b   | lib/errors                       | 2     |                         | No            | NOT STARTED |
| 2c   | lib/logging                      | 2     |                         | No            | NOT STARTED |
| 2d   | lib/db                           | 1     |                         | No            | NOT STARTED |
| 2e   | lib/utils                        | 6     |                         | No            | NOT STARTED |
| 2f   | lib/hooks                        | 4     |                         | No            | NOT STARTED |
| 2g   | lib/constants + feature-flags    | 2     |                         | No            | NOT STARTED |
| 3a   | orchestration/engine             | 23    |                         | YES           | NOT STARTED |
| 3b   | orchestration/llm                | 20    |                         | No            | NOT STARTED |
| 3c   | orchestration/mcp                | 13    |                         | No            | NOT STARTED |
| 3d   | orchestration/knowledge          | 12    |                         | No            | NOT STARTED |
| 3e   | orchestration/chat               | 10    |                         | YES           | NOT STARTED |
| 3f   | orchestration/capabilities       | 9     |                         | No            | NOT STARTED |
| 3g   | orchestration/workflows          | 4     |                         | No            | NOT STARTED |
| 3h   | orchestration/remaining          | 14    |                         | No            | NOT STARTED |
| 4a   | Admin orch API routes            | ~130  |                         | After triage  | NOT STARTED |
| 4b   | Chat API routes                  | ~15   |                         | No            | NOT STARTED |
| 4c   | Embed API routes                 | ~5    |                         | No            | NOT STARTED |
| 4d   | Remaining API routes             | ~10   |                         | No            | NOT STARTED |
| 5a   | Workflow builder components      | 29    |                         | No            | NOT STARTED |
| 5b   | Costs components                 | 10    |                         | No            | NOT STARTED |
| 5c   | Knowledge components             | 10    |                         | No            | NOT STARTED |
| 5d   | Learn components                 | 9     |                         | No            | NOT STARTED |
| 5e   | MCP components                   | 8     |                         | No            | NOT STARTED |
| 5f   | Remaining admin orch components  | ~67   |                         | No            | NOT STARTED |
| 6a   | forms components                 | 15    |                         | No            | NOT STARTED |
| 6b   | ui components                    | 9     |                         | No            | NOT STARTED |
| 6c   | Remaining components             | 9     |                         | No            | PARTIAL     |
| 6d   | App page tests                   | 13    |                         | No            | NOT STARTED |
| 7a   | email                            | 6     |                         | No            | NOT STARTED |
| 7b   | lib/analytics                    | 10    |                         | No            | NOT STARTED |
| 7c   | lib/consent                      | 4     |                         | No            | NOT STARTED |
| 7d   | lib/storage + monitoring + embed | 10    |                         | No            | NOT STARTED |
| 7e   | Integration tests                | 120   |                         | No            | NOT STARTED |
| 8.1  | Coverage gaps: API routes        | —     |                         | N/A           | NOT STARTED |
| 8.2  | Coverage gaps: orchestration     | —     |                         | N/A           | NOT STARTED |
| 8.3  | Coverage gaps: components/pages  | —     |                         | N/A           | NOT STARTED |

---

## Rough Timeline

| Week | Phases        | Focus                                                                               |
| ---- | ------------- | ----------------------------------------------------------------------------------- |
| 1    | 1 + 2         | Security, auth, core infrastructure                                                 |
| 2    | 3a-3d         | Orchestration: engine, LLM, MCP, knowledge                                          |
| 3    | 3e-3h + 4a-4b | Orchestration: chat, capabilities, workflows + API routes start                     |
| 4    | 4c-4d + 5a-5d | Remaining API routes + admin components (workflow builder, costs, knowledge, learn) |
| 5    | 5e-5f + 6     | Remaining admin components + other components/pages                                 |
| 6    | 7 + 8         | Supporting areas, integration tests, coverage gap fills                             |

Timeline is approximate — actual pace depends on how many Rotten files surface and how complex the fixes are. Phase 3 (orchestration engine) is the most likely to overrun.

---

## Process Improvement

This is the first time these testing workflows (`/test-triage`, `/test-fix from-rescan`, ceiling passes, etc.) are being used at scale across the full codebase. Prior usage was limited to dogfood runs on a handful of files (`lib/auth`, `components/analytics`, `contact/route`).

**Pay attention to:**

- Commands that are awkward, slow, or require too many manual steps — note friction points
- Regex false-positive patterns that keep recurring — candidates for tightening or new signatures
- Grade distributions that don't match intuition (e.g., everything comes back Minor when the tests are clearly bad)
- Session sizing that doesn't work — are 15-25 files too many/few per session?
- Handoffs between triage and fix that lose context or require re-reading
- Anything where you find yourself working around the tool rather than with it
- Patterns that work well and should be documented as the recommended approach

Record observations in the step-level Notes fields as they happen. At the end of each phase, review whether anything warrants changes to the commands, skills, or agent definitions. Update `project-testing-commands.md` with any process decisions or tool changes.

---

## Notes & Lessons Learned

Record anything useful discovered during the triage process that future sessions should know.

- **Step 1a (2026-04-24):** Path 0 (accept annotations) is the cheapest fix for structural `toBe(true)` hits — no test code changes needed. Use it first, then Path A/B for block patterns.
- **Step 1a:** Source finding S1 (async/sync off-by-one) looked like a bug but was intentional. Agent reverted correctly after testing. Lesson: always check if `<=` vs `<` is compensating for increment-before vs increment-after semantics before "fixing" it.
- **Step 1a:** proxy.test.ts imports from `@/proxy` (root-level file), not from `lib/security/`. The source path mapping in `/test-triage` assumes test path mirrors source path — this broke for proxy. Watch for similar mismatches in other areas.
- **Step 1a:** Concurrency cap of 3 worktree agents was too conservative — no resource pressure on battery power. Bumped to 5 (PR #87). Monitor on next larger batch (Step 3b, 20 files).
