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

- Node.js 24+ (see `.nvmrc`). `package.json` **declares** this via `engines`,
  but `.npmrc` does not set `engine-strict`, so a wrong major produces an
  `EBADENGINE` warning and installs anyway — it will not stop you
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
   npm run validate  # CHANGELOG + Node version + type-check + lint + format (Prettier + Prisma)
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
   under **npm below 11.11.0** any lockfile write strips the `libc` metadata
   from the native Linux packages that Linux CI and production installs rely on
   — on every platform, not just macOS as this step used to claim (#571). Check
   `npm -v`; if you do trip it, `npm run fix:lockfile-libc` puts it back.
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

   **Also trigger the dependency audit**, which is otherwise weekly and so can
   be up to seven days stale at the moment you cut:

   ```bash
   gh workflow run dependency-audit.yml
   # `gh workflow run` returns before the run exists, so `gh run watch` with no
   # id would attach to the previous (scheduled) run. Give it a moment, then
   # watch the newest one by id:
   sleep 10 && gh run watch "$(gh run list --workflow dependency-audit.yml \
     --limit 1 --json databaseId --jq '.[0].databaseId')"
   ```

   Its `lockfile-libc` job is the **absolute** platform-metadata check — it asks
   the registry what each locked version actually declares, so unlike the diff
   check in `/pre-pr` it catches metadata that was already missing before this
   branch. That is precisely the state `main` sat in for two releases (#571).
   The `audit` job reports advisories at the same time. Both depend on
   third-party feeds, so an occasional red here is infrastructural rather than a
   lockfile problem — the message says which.

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

The problem is real, and it is **your npm version, not your operating system**.
`@npmcli/arborist` did not list `libc` among the fields it serialises until
9.4.0, first shipped in **npm 11.11.0**. Below that, every lockfile write
deletes the key — on macOS, Linux and Alpine alike. Measured here: `npm install
--package-lock-only` under npm 11.6.0 is a no-op that still removes 15 lines and
adds none. Newer npm _preserves_ `libc` but never _restores_ it, because once
the field is gone the tree is "up to date" and nothing recomputes the metadata.

That is why the key kept reappearing and vanishing: dependabot's runner uses a
current npm and writes it back; a local `npm install` strips it again. During
the 0.8.1 cut it dropped all five carriers, and the obvious repair was worse
than the damage — a line-scanning script to put it back ran away and modified
**181 packages**, producing a lockfile that looked plausible and was wrong. It
was caught only by diffing package-by-package against a snapshot.

`libc` matters because it is the only field separating a musl build from a glibc
one, and production is `node:24-alpine`. With it missing, a musl install pulls
in **both** variants: measured on this lockfile, 2.4 GB of `node_modules`
against 2.0 GB, including `sharp-linux-x64` and `swc-linux-x64-gnu` landing in a
musl image. Nothing errors, which is why it went unnoticed for a release.

So the answer is not more care. It is a flow where each step is **verified
rather than trusted**:

1. **Check `npm -v` first.** Below 11.11.0, expect the loss and plan on step 4.
2. **Snapshot.** `cp package-lock.json /tmp/lock.before.json`
3. **Run the update.** `npm update <the specific packages>` — never a bare
   `npm install`.
4. **Restore `libc` from the registry:**

   ```bash
   npm run fix:lockfile-libc -- --check   # what is missing
   npm run fix:lockfile-libc              # put it back
   ```

   This reads each package's registry manifest at its exact locked version, so
   it cannot move a version by construction, and it inserts the key where npm's
   serialiser would. It refuses to write if the lockfile does not survive a JSON
   round-trip, or if an existing value disagrees with the registry. Validated by
   strip-and-restore against `d5b913fb^` — the last lockfile a modern npm wrote
   — which comes back byte-identical. Never hand-edit the field; that is the
   181-package mistake.

5. **Verify the net diff, not the intent.** Three assertions, all of which have
   to be assertions — a bare expression that computes a diff and never checks it
   is how a 181-package change looks fine:

   ```python
   import json
   a = json.load(open('/tmp/lock.before.json'))['packages']
   b = json.load(open('package-lock.json'))['packages']

   EXPECTED = {'node_modules/engine.io', 'node_modules/socket.io-adapter', ...}

   # Nothing appeared or vanished that you did not intend.
   assert set(a) ^ set(b) <= EXPECTED, set(a) ^ set(b)

   # Nothing else moved. Step 4's own additions are exempt: if you snapshotted
   # while `libc` was missing — which is the state every fork inherited from
   # 0.8.0 — then restoring it legitimately changes ~100 entries that are not
   # in EXPECTED. Exempt the entries whose ONLY difference is a gained `libc`,
   # so the assertion still catches a version or integrity move on those very
   # same packages rather than waving the whole set through.
   def only_gained_libc(before, after):
       return 'libc' not in before and 'libc' in after \
           and {k: v for k, v in after.items() if k != 'libc'} == before

   changed = {
       k for k in set(a) & set(b)
       if a[k] != b[k] and not only_gained_libc(a[k], b[k])
   }
   assert changed <= EXPECTED, changed - EXPECTED

   # And no carrier was lost. Gaining one is the repair working; losing one is
   # the bug. An equality assertion here would fail the fix and pass the fault.
   carriers = lambda p: {k for k, v in p.items() if 'libc' in v}
   assert carriers(a) - carriers(b) <= EXPECTED, carriers(a) - carriers(b)
   ```

   The symmetric difference matters as much as the intersection: comparing only
   `set(a) & set(b)` cannot see a package that was added or dropped outright.

6. **`npm run check:lockfile`** — the same rules `/pre-pr` runs, against the
   merge base. It gates on lost metadata, a direct downgrade, or an `overrides`
   change, and reports restored metadata without gating.
7. **`npm ci --dry-run`** to confirm the lockfile is still coherent.

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
