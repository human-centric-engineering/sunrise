# Contributing to Sunrise

Thank you for your interest in contributing to Sunrise! This guide will help you get started.

> **Building an app _on_ Sunrise rather than contributing _to_ it?** See
> [`CUSTOMIZATION.md`](./CUSTOMIZATION.md) — the fork/app onboarding guide. It
> covers the extension model, the `package.json` dependency/script policy for
> forks, and how to stay in sync with upstream releases.

## Code of Conduct

Be respectful and constructive. We're all here to build something useful together.

## Getting Started

### Prerequisites

- Node.js 20.19+ (or 22.12+, 24+)
- PostgreSQL 15+ (local, Docker, or hosted)
- Git

### Development Setup

```bash
# Clone the repository
git clone https://github.com/human-centric-engineering/sunrise
cd sunrise

# Install dependencies
npm install

# Set up environment
cp .env.example .env.local
# Edit .env.local with your DATABASE_URL and BETTER_AUTH_SECRET

# Set up database and seed test data
npm run db:migrate:dev
npm run db:seed

# Start development server
npm run dev
```

**Using Docker instead:**

```bash
docker-compose up                              # Start app + database
docker-compose exec web npx prisma migrate dev # Run migrations
docker-compose exec web npm run db:seed        # Seed test data
```

## How to Contribute

### Reporting Issues

- Search existing issues first to avoid duplicates
- Use a clear, descriptive title
- Include steps to reproduce for bugs
- Specify your environment (Node version, OS, browser)

### Suggesting Features

- Open an issue with the "feature request" label
- Explain the use case and why it would be valuable
- Be open to discussion about implementation approaches

### Submitting Pull Requests

1. **Fork and clone** the repository
2. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/your-feature
   # or
   git checkout -b fix/your-fix
   ```
3. **Make your changes** following our coding standards
4. **Test your changes**:
   ```bash
   npm run test
   npm run validate  # CHANGELOG structure + type-check + lint + format (Prettier + Prisma)
   npm run build     # ensure it builds
   ```
5. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/):
   ```bash
   git commit -m "feat: add new feature"
   git commit -m "fix: resolve issue with X"
   ```
6. **Push** and create a pull request

## Coding Standards

### TypeScript

- No `any` types—use proper typing or `unknown` with type guards
- Validate external data with Zod schemas
- Use `@/` import aliases, not relative paths

### Code Style

- Run `npm run validate` before committing (hooks do this automatically)
- Keep changes focused—don't mix features with unrelated refactoring
- Write tests for new functionality

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add user invitation flow
fix: resolve login redirect issue
docs: update API documentation
test: add validation tests
chore: update dependencies
```

## Pull Request Process

1. Ensure all checks pass (`npm run validate`, `npm run build`, `npm run test`)
2. Update documentation if you're changing behavior
3. Add tests for new functionality
4. Keep PRs focused—one feature or fix per PR
5. Be responsive to review feedback

### What We Look For

- Code follows existing patterns in the codebase
- Tests are included for new functionality
- No unnecessary dependencies added
- Documentation updated where needed
- Commit messages are clear and follow conventions

### Automated checks on every PR

Beyond the local checks above, CI runs supply-chain security scanning on every PR to `main`:

- **CodeQL** — static analysis; findings appear in the repository's Security tab
- **Dependency Review** — blocks a PR that adds a dependency with a known high+ vulnerability (usually fixed by choosing a patched version)
- **Secret Scan (TruffleHog)** — blocks a PR that commits a credential (remove it and rotate the secret)

If one fails, the Checks tab or PR comment explains why. See [Supply-Chain Security](.context/security/overview.md#supply-chain-security) for the full layer.

## Cutting a release

Sunrise releases are cut **deliberately** — release-on-demand, not on every
merge. A release means _"this batch is worth depending on"_: a dated
`CHANGELOG.md` entry plus a `vX.Y.Z` git tag. Either of the Sunrise
maintainers may cut a release after the standard PR gates. The full
public-surface contract behind the bump decision lives in
[`VERSIONING.md`](./VERSIONING.md).

> The process below is intentionally lightweight. Once the HCE Hub is built it
> will become the system of record for releases + cross-fork tracking; until
> then manual git-tag + CHANGELOG suffices.

**Steps:**

1. **Decide the bump.** MAJOR / MINOR / PATCH per
   [`VERSIONING.md` → SemVer rules](./VERSIONING.md#semver-rules-at-10). During
   `0.x`, MINOR for new public surface, PATCH for fixes — we don't bump MAJOR
   in `0.x` (see the `0.x` semantics section).
2. **Bump the platform version.** Edit
   [`lib/sunrise-version.ts`](./lib/sunrise-version.ts) — change
   `SUNRISE_VERSION` to the new value.
3. **Match the version in `package.json` _and_ the lockfile.** Set
   `package.json.version` to the same value (lint-staged formats the file on
   commit). Then hand-edit the two top-of-file `"version"` keys in
   `package-lock.json` — the root object and `packages[""]` — to match. Edit
   them by hand; do **not** run `npm install` / `npm version` to do it, because
   on macOS that recomputes the tree and strips the `libc` metadata from the
   native Linux packages that Linux CI and production installs rely on.
   Hand-editing `package.json` alone leaves the lockfile root stale (it was
   missed for 0.1.0 and 0.2.0).

   Which packages carry `libc` **moves with the dependency graph**, so list them
   rather than trusting a list in a doc — this one named three families that
   carry none of it today:

   ```bash
   node -e "const l=require('./package-lock.json');console.log(Object.entries(l.packages).filter(([,v])=>v.libc).map(([k])=>k).join('\n'))"
   ```

   **If the release changes dependencies, this step does not apply as written —
   see the subsection below.**

4. **Update the changelog.** Move the entries under `## [Unreleased]` in
   `CHANGELOG.md` to a new dated heading: `## [X.Y.Z] — YYYY-MM-DD`. During
   `0.x`, mark the entry **alpha**. Leave `## [Unreleased]` in place (empty,
   for the next release).

   > **Anchor the insertion on `## [Unreleased]` alone** — never on a block
   > that includes the previous release's heading. Cutting 0.8.1 replaced
   > `## [Unreleased]\n\n## [0.8.0] — 2026-08-04`, never re-added the second
   > line, and 962 lines of 0.8.0 content — its release blockquote, two
   > migrations and two breaking changes — read as part of a patch release. It
   > merged and was tagged before anyone noticed (#544, repaired in #546).
   >
   > `npm run validate` now runs `npm run check:changelog`, which fails on that
   > shape and on the other ways this file can go wrong. CI runs it too, on
   > every PR including docs-only ones.

5. **Run the gates locally.** `npm run validate`, full test suite, then
   `/pre-pr` and `/security-review`.
6. **Open the release PR.** Push the branch, run `/code-review` on the PR,
   then merge.
7. **Tag the merge commit.**
   ```bash
   git checkout main && git pull origin main   # tag the squashed commit on main, not the branch head
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
8. **Publish the GitHub Release.** A pushed tag does **not** create a Release —
   do it explicitly so the version shows on the Releases page, carries the notes,
   and notifies watchers. Mirror the existing releases: title `vX.Y.Z — alpha`
   (during `0.x`), mark it a **pre-release**, and use that version's CHANGELOG
   section as the notes.
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z — alpha" --prerelease --verify-tag \
     --notes-file <the `## [X.Y.Z]` section of CHANGELOG.md>
   ```

The tag is what the eventual HCE Hub will discover; the CHANGELOG entry (and the
mirrored Release notes) is what fork authors will read before merging the upgrade.

### Cutting a release that changes dependencies

Step 3 says never to let npm recompute the tree. For a **dependency fix**,
recomputing it is the entire point, so that rule cannot be followed — 0.8.1 was
exactly this case (a security patch needing `npm update engine.io
socket.io-adapter`) and the steps above offered no path for it.

The problem is real: on macOS the recompute strips `libc` from the native Linux
packages. During the 0.8.1 cut it dropped the key from all five carriers, and
the obvious repair was worse than the damage — a line-scanning script to put it
back ran away and modified **181 packages**, producing a lockfile that looked
plausible and was wrong. It was caught only by diffing package-by-package
against a snapshot taken beforehand.

So the answer is not more care. It is a flow where each step is **verified
rather than trusted**:

1. **Snapshot first.** `cp package-lock.json /tmp/lock.before.json`
2. **Run the update.** `npm update <the specific packages>` — never a bare
   `npm install`.
3. **Prove the writer is faithful before you use it.** A Python round-trip is
   byte-identical to npm's own writer on this lockfile, which is what makes
   JSON-level editing safe. Check it rather than assuming — it is one line, and
   if it ever stops being true this whole approach is invalid:

   ```python
   import json
   raw = open('package-lock.json','rb').read()
   out = (json.dumps(json.load(open('package-lock.json')), indent=2, ensure_ascii=False) + '\n').encode()
   assert out == raw
   ```

4. **Re-insert `libc` at the JSON level**, never with text munging, immediately
   after `cpu` so npm's key order is preserved.
5. **Verify the net diff, not the intent.** Assert both that only the packages
   you meant to move changed, and that the `libc` carrier set is unchanged:

   ```python
   changed = [k for k in set(a) & set(b) if a[k] != b[k]]
   assert {k for k, v in a.items() if 'libc' in v} == {k for k, v in b.items() if 'libc' in v}
   ```

6. **`npm ci --dry-run`** to confirm the lockfile is still coherent.

For 0.8.1 this turned a "221 packages changed" install into a verified **3
changed packages plus one dedupe**, with the carrier set provably untouched.

## Project Structure

See `.context/substrate.md` for full documentation. Key areas:

```
app/           # Next.js App Router pages and API routes
components/    # React components (ui/ for primitives)
lib/           # Core utilities and business logic
prisma/        # Database schema and migrations
.context/      # Project documentation
```

## Questions?

- Check the documentation in `.context/`
- Open a discussion or issue on GitHub

Thank you for contributing!
