---
allowed-tools: Read, Glob, Grep, Task, Write
description: Run a comprehensive code review on a domain/directory of the codebase
---

Run a comprehensive code review on the specified domain of the codebase.

**Domain argument:** $ARGUMENTS

This specifies which part of the codebase to review. Supported domains and their file mappings:

- `auth` - Authentication & sessions: `app/(auth)/`, `app/api/auth/`, `lib/auth/`, `components/auth/`, auth-related form components
- `security` - Security infrastructure: `lib/security/`, `proxy.ts`, `app/api/csp-report/`, `lib/env.ts`
- `api` - API layer: `lib/api/`, `app/api/v1/users/`, `app/api/v1/contact/`, `app/api/v1/invitations/`, `app/api/health/`, `lib/validations/`
- `admin` - Admin panel: `app/admin/`, `app/api/v1/admin/`, `components/admin/`, `lib/admin/`, `lib/feature-flags/`
- `database` - Database & models: `prisma/`, `lib/db/`, `types/`
- `email` - Email system: `emails/`, `lib/email/`
- `storage` - Storage & file upload: `lib/storage/`, avatar-related components, `lib/validations/storage.ts`
- `analytics` - Analytics & consent: `lib/analytics/`, `lib/consent/`, `components/analytics/`, `components/cookie-consent/`
- `observability` - Error handling, logging & monitoring: `lib/errors/`, `lib/logging/`, `lib/monitoring/`, `app/error.tsx`, `app/not-found.tsx`
- `ui` - UI components & pages: `components/ui/`, `components/layouts/`, `components/marketing/`, `app/(public)/`, `app/(protected)/`

Or pass an explicit path like `lib/security` to review that directory.

## Steps

Follow these steps precisely:

### Step 1: Identify files

Use Glob and Grep to collect all `.ts` and `.tsx` source files in the target domain. Create a complete list of file paths. Skip test files, `.test.ts`, `.spec.ts`, and `node_modules`.

### Step 2: Load context

Read the root `CLAUDE.md` file. Also read any relevant `.context/` documentation for this domain (e.g., `.context/auth/overview.md` for the auth domain). This gives you the project's coding standards, patterns, and architectural decisions.

### Step 3: Launch 5 parallel review agents

Launch 5 parallel **Sonnet** agents using the Task tool. Pass each agent:

- The complete list of file paths to review
- A brief summary of relevant CLAUDE.md standards
- Their specific review focus

The 5 agents are:

**Agent 1: CLAUDE.md Compliance**
Review all files for compliance with CLAUDE.md standards:

- Coding patterns (server components by default, `'use client'` only when needed)
- Naming conventions (PascalCase components, kebab-case utilities)
- API response format (`{ success, data }` / `{ success, error }`)
- Use of structured logger instead of `console.log` in production code
- TypeScript strict mode (no `any` types)
- Zod validation on all user input
- File structure matching documented patterns
  Read each file and flag specific violations with file path, line number, and the CLAUDE.md rule violated.

**Agent 2: Bug Scan**
Read each file and scan for:

- Logic errors and off-by-one mistakes
- Race conditions and async/await issues
- Missing error handling (unhandled promise rejections, missing try/catch)
- Null/undefined access without guards
- Incorrect type assertions or unsafe casts
- Memory leaks (uncleaned listeners, intervals, subscriptions)
- Dead code or unreachable branches
  Focus on real bugs that would cause runtime failures. Ignore style issues.

**Agent 3: Security Review**
Read each file and audit for OWASP Top 10 and security issues:

- Input validation gaps (missing Zod validation on user input)
- Authentication/authorization bypass possibilities
- Injection vulnerabilities (SQL, XSS, command injection)
- Sensitive data exposure (secrets in logs, PII leaks, missing sanitization)
- Missing rate limiting on sensitive endpoints
- Insecure direct object references
- CSRF protection gaps
- Missing security headers
  Reference `lib/security/` patterns as the baseline.

**Agent 4: Architecture Review**
Read each file and evaluate:

- Separation of concerns (business logic mixed with presentation)
- Coupling between modules (inappropriate imports, circular dependencies)
- Consistent patterns (do similar things use similar approaches?)
- Error boundary coverage
- Proper use of server vs client components
- API route structure and middleware usage
- State management patterns
  Focus on architectural issues that impact maintainability.

**Agent 5: Type Safety & Validation**
Read each file and check:

- Use of `any` type (should be zero)
- Missing return type annotations on exported functions
- Zod schemas matching actual usage
- Prisma types properly propagated (not re-declared manually)
- Generic type parameters used correctly
- Type assertions (`as`) that could be replaced with proper typing
- Form validation schemas matching API expectations
  Focus on type-level issues that could cause runtime mismatches.

### Step 4: Collect and score results

Each agent returns a list of issues. For each issue, assign a confidence score (0-100):

- **0-25**: Likely false positive or pre-existing issue
- **25-50**: Might be real but could be intentional or a nitpick
- **50-75**: Probably real but low impact or uncommon in practice
- **75-90**: Very likely real, verified by checking the code
- **90-100**: Definitely real, confirmed with evidence

**Examples of false positives to filter out:**

- Issues a linter or type checker would catch (these run in CI)
- Style preferences not mentioned in CLAUDE.md
- Pre-existing patterns used consistently across the codebase (intentional)
- Missing features that aren't part of current requirements
- General "best practice" suggestions not backed by project standards

### Step 5: Filter and write findings

Filter out all issues with confidence score below **80**.

Write findings to `.reviews/{domain}-review.md` using this format:

```markdown
# {Domain} Code Review

**Reviewed:** {date}
**Files reviewed:** {count}
**Issues found:** {count above threshold} (filtered from {total count})

## Critical Issues (90-100 confidence)

### 1. {Brief description}

**File:** `{path}:{line}`
**Category:** {Bug | Security | Architecture | Type Safety | CLAUDE.md}
**Confidence:** {score}

{Description of the issue with code snippet}

**Suggested fix:**
{Brief suggestion}

---

## Important Issues (80-89 confidence)

### 1. {Brief description}

...

## Summary

{2-3 sentence summary of findings and overall code health for this domain}
```

If no issues meet the threshold, write:

```markdown
# {Domain} Code Review

**Reviewed:** {date}
**Files reviewed:** {count}

No issues found above confidence threshold (80). Checked for bugs, security issues, CLAUDE.md compliance, architecture, and type safety.
```
