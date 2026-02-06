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

### 3. Pre-PR Validation

After your final functional commit, run these checks **before** creating the PR:

```bash
# 1. Verify test coverage
npm run test:coverage

# 2. Run all validation (type-check + lint + format)
npm run validate

# 3. Ensure production build succeeds
npm run build
```

Then run the automated review commands:

```bash
# 4. Pre-PR checks (custom command)
/pre-pr

# 5. Security review
/security-review
```

**Fix any issues that come up before proceeding.**

### 4. Create PR

```bash
git push -u origin feature/my-feature
# Create PR via GitHub (or use `gh pr create`)
```

### 5. Post-PR Review

After the PR is created:

1. **Run code review:** `/code-review` (Anthropic plugin) — adds comments to PR
2. **Wait for CI:** Ensure all checks pass
3. **Address feedback:** Fix any issues raised

### 6. Merge

Once CI passes and review is complete:

- **Squash and merge** (recommended) — clean history
- Delete branch after merge

## Pre-PR Checklist (Quick Reference)

```
□ Final commit made
□ npm run test:coverage — coverage acceptable
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

# Before PR (after final commit)
npm run test:coverage && npm run validate && npm run build
# Then run: /pre-pr and /security-review

# Create and review PR
git push -u origin feature/name
# Create PR, then run /code-review
```
