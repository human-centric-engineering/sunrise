---
allowed-tools: Read, Glob, Grep, Task
description: Audit documentation against codebase to detect drift and gaps
---

Audit documentation for the specified domain to detect drift from the actual codebase.

**Domain argument:** $ARGUMENTS

This specifies which documentation domain to audit. Supported domains and their mappings:

| Domain         | Documentation            | Code Locations                                                               |
| -------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `auth`         | `.context/auth/`         | `app/(auth)/`, `app/api/auth/`, `lib/auth/`, `components/auth/`              |
| `api`          | `.context/api/`          | `app/api/`, `lib/api/`, `lib/validations/`                                   |
| `database`     | `.context/database/`     | `prisma/`, `lib/db/`, `types/`                                               |
| `security`     | `.context/security/`     | `lib/security/`, `middleware.ts`, `lib/env.ts`                               |
| `admin`        | `.context/admin/`        | `app/admin/`, `app/api/v1/admin/`, `components/admin/`, `lib/admin/`         |
| `errors`       | `.context/errors/`       | `lib/errors/`, `lib/logging/`, `app/error.tsx`, `app/global-error.tsx`       |
| `analytics`    | `.context/analytics/`    | `lib/analytics/`, `lib/consent/`, `components/analytics/`                    |
| `email`        | `.context/email/`        | `emails/`, `lib/email/`                                                      |
| `storage`      | `.context/storage/`      | `lib/storage/`, `lib/validations/storage.ts`                                 |
| `environment`  | `.context/environment/`  | `.env.example`, `lib/env.ts`, `docker-compose*.yml`                          |
| `testing`      | `.context/testing/`      | `tests/`, `vitest.config.ts`, test utilities                                 |
| `architecture` | `.context/architecture/` | Project structure, `app/`, `lib/`, `components/`                             |
| `deployment`   | `.context/deployment/`   | `Dockerfile`, `docker-compose*.yml`                                          |
| `monitoring`   | `.context/monitoring/`   | `lib/monitoring/`, Sentry config, health endpoints                           |
| `ui`           | `.context/ui/`           | `components/ui/`, `components/layouts/`, `app/(public)/`, `app/(protected)/` |
| `privacy`      | `.context/privacy/`      | Cookie consent, privacy-related components                                   |
| `seo`          | `.context/seo/`          | Metadata, `app/sitemap.ts`, SEO utilities                                    |
| `types`        | `.context/types/`        | `types/`, Prisma types, API types                                            |
| `guidelines`   | `.context/guidelines.md` | CLAUDE.md, project conventions                                               |
| `substrate`    | `.context/substrate.md`  | All `.context/` structure and navigation                                     |

## Goal

Identify documentation that no longer matches the codebase:

- **Outdated patterns**: Documented code that has been refactored
- **Missing features**: New code not reflected in docs
- **Wrong references**: Library names, file paths, function signatures that changed
- **Incomplete coverage**: Undocumented utilities, exports, or patterns

## Steps

### Step 1: Gather documentation

Read ALL documentation files in the target domain:

- For directory domains: Read all `.md` files in `.context/{domain}/`
- For file domains (guidelines, substrate): Read the single file

Create a summary of what the documentation claims:

- Libraries/frameworks mentioned
- File paths referenced
- Function/component names
- Patterns described
- Code examples shown

### Step 2: Gather actual code

Using Glob and Grep on the corresponding code locations:

- List all source files (`.ts`, `.tsx`)
- Identify exported functions, components, types
- Note actual library imports used
- Find actual file structure

### Step 3: Launch 3 parallel comparison agents

Launch 3 parallel **Sonnet** agents using the Task tool. Pass each agent:

- The documentation summary from Step 1
- The code file list from Step 2
- Their specific comparison focus

**Agent 1: Reference Accuracy**
Check that all documented references are accurate:

- File paths mentioned in docs exist
- Function/component names match actual exports
- Library names match actual imports (e.g., "NextAuth.js" vs "better-auth")
- Version numbers are current
- Configuration options are valid
- Code examples compile and match current patterns

Report each inaccuracy with:

- Documentation file and line
- What docs say vs what code shows
- Severity: Critical (wrong library/API) | Major (wrong path/name) | Minor (outdated example)

**Agent 2: Coverage Analysis**
Check that all significant code is documented:

- Exported functions have corresponding documentation
- Public components are described
- API endpoints are documented
- Utilities that other files import are explained
- Configuration options are covered

Report each gap with:

- Code file and export name
- What it does (brief inspection)
- Severity: Critical (core feature) | Major (utility used in multiple places) | Minor (internal helper)

**Agent 3: Pattern Consistency**
Check that documented patterns match actual implementations:

- Error handling patterns
- Authentication patterns
- Validation patterns
- Naming conventions
- File organization

Report each inconsistency with:

- Pattern documented vs pattern used
- Where the mismatch occurs
- Severity: Critical (security/auth) | Major (common pattern) | Minor (edge case)

### Step 4: Synthesize and prioritize findings

Collect all agent findings and:

1. Remove duplicates
2. Group by severity
3. Order by impact (auth/security issues first)

### Step 5: Write audit report

Write the audit report to `.reviews/docs-{domain}-audit.md`:

```markdown
# Documentation Audit: {Domain}

**Audited:** {date}
**Documentation files:** {count}
**Code files checked:** {count}

## Critical Issues

Issues that make documentation misleading or dangerous to follow.

### 1. {Brief description}

**Doc:** `.context/{domain}/{file}.md:{line}`
**Code:** `{relevant code path}`
**Issue:** {What docs say vs reality}
**Action:** {Specific fix needed}

---

## Major Issues

Missing coverage or significant inaccuracies.

### 1. {Brief description}

...

## Minor Issues

Outdated examples, typos, or minor gaps.

### 1. {Brief description}

...

## Recommendations

### Updates Needed

- [ ] {Specific update task}
- [ ] {Specific update task}

### Consider Splitting (if applicable)

{Only if file > 500 lines with distinct sections}

- Current: `{file}` ({line count} lines)
- Suggested: Split into `{new files}` because {reason}

## Summary

{2-3 sentences on overall documentation health and priority actions}
```

If no issues found:

```markdown
# Documentation Audit: {Domain}

**Audited:** {date}
**Documentation files:** {count}
**Code files checked:** {count}

Documentation accurately reflects codebase. No drift detected.
```

## Common Drift Patterns

When auditing, pay special attention to these known drift patterns:

1. **Auth library changes**: NextAuth.js → better-auth migration artifacts
2. **New utilities**: Functions added during remediation may be undocumented
3. **Renamed files**: Refactoring that changed file paths
4. **Deprecated patterns**: Old patterns still documented but replaced
5. **Version bumps**: Library versions that changed APIs
6. **Environment variables**: New vars added but not documented
