# Git & Development Workflow

Git conventions, branching strategy, and PR process for Sunrise.

## Branching Strategy

```
main              # Production-ready code, always deployable
feature/name      # New features (e.g., feature/user-invitations)
fix/name          # Bug fixes (e.g., fix/login-redirect)
hotfix/name       # Critical production fixes (e.g., hotfix/security-patch)
```

**Branch from:** `main`
**Merge to:** `main` (via PR)

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```bash
feat: add user invitation flow
fix: resolve login redirect issue
docs: update API documentation
refactor: simplify auth utilities
test: add validation tests
chore: update dependencies
```

**Format:** `type: short description`

- Use imperative mood ("add" not "added")
- Keep under 72 characters
- No period at end

**Examples:**

```bash
feat: add password reset flow
fix: correct email validation regex
docs: add API endpoint documentation
test: add unit tests for auth utilities
refactor: extract rate limiting to middleware
chore: bump prisma to 7.1.0
```

## Pull Request Process

### 1. Create Branch

```bash
git checkout main
git pull origin main
git checkout -b feature/my-feature
```

### 2. Make Changes

```bash
# Work on your changes
git add <specific-files>
git commit -m "feat: add my feature"
```

### 3. Test Coverage

After your final functional commit, ensure test coverage is adequate **before** running pre-PR checks.

**Add tests for branch changes** (recommended flow):

```bash
/test-plan              # Analyze branch diff, produce phased test plan
/test-write plan        # Execute Sprint 1 (spawns test-engineer agents)
/test-review            # Audit quality of tests just written
/test-plan review       # Plan fixes if review found issues
/test-write plan        # Execute fixes
/test-coverage branch   # Verify coverage meets thresholds for changed files
```

**Quick quality fix after review** (1–5 files, skips plan step):

```bash
/test-review components/x   # Finds quality issues
/test-fix components/x      # Applies review findings directly
```

Use `/test-fix` after `/test-review` when the scope is small (1–5 files) and the work is quality fixes, not coverage expansion. For 6+ files or coverage-driven work, use the `/test-plan review` → `/test-write plan` path.

**Quick test for 1-2 files** (skips planning step):

```bash
/test-write lib/auth/guards.ts   # Inline plan + execute for small scope
```

All `/test-*` commands default to branch diff mode. Pass folder paths to scope (e.g., `/test-review lib/auth`). See CLAUDE.md "Test Engineering" for full reference.

### 4. Pre-PR Validation

Run these checks **after** test coverage is adequate:

```bash
# 1. Run all validation (type-check + lint + format)
npm run validate

# 2. Ensure production build succeeds
npm run build
```

Then run the automated review commands:

```bash
# 3. Pre-PR checks (custom command)
/pre-pr

# 4. Security review
/security-review
```

**Fix any issues that come up before proceeding.**

### 5. Create PR

```bash
git push -u origin feature/my-feature
# Create PR via GitHub (or use `gh pr create`)
```

### 6. Post-PR Review

After the PR is created:

1. **Run code review:** `/code-review` (Anthropic plugin) — adds comments to PR
2. **Wait for CI:** Ensure all checks pass
3. **Address feedback:** Fix any issues raised

### 7. Merge

Once CI passes and review is complete:

- **Squash and merge** (recommended) — clean history
- Delete branch after merge

## Pre-PR Checklist (Quick Reference)

```
□ Final commit made
□ /test-plan — test plan created for branch changes
□ /test-write plan — tests written and passing
□ /test-review — test quality audited
□ /test-coverage branch — coverage meets thresholds
□ npm run validate — no errors
□ npm run build — builds successfully
□ /pre-pr — no issues
□ /security-review — no vulnerabilities
□ PR created
□ /code-review — feedback addressed
□ CI passes
□ Merged
```

## Pre-commit Hooks

Hooks run automatically (configured via Husky + lint-staged):

**On commit:**

- ESLint fix on staged `.ts/.tsx` files
- Prettier format on staged files

**On push:**

- TypeScript type-check

**Bypass (emergency only):**

```bash
git commit --no-verify -m "emergency fix"
git push --no-verify
```

## Quick Reference

```bash
# Start new feature
git checkout main && git pull && git checkout -b feature/name

# During development
npm run validate                    # Check before committing
git commit -m "feat: description"   # Conventional commit

# Test coverage (after final functional commit)
/test-plan                          # Plan tests for branch changes
/test-write plan                    # Write tests
/test-review                        # Audit test quality
/test-coverage branch               # Verify coverage

# Before PR
npm run validate && npm run build
# Then run: /pre-pr and /security-review

# Create and review PR
git push -u origin feature/name
# Create PR, then run /code-review
```
