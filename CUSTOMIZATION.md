# Building on Sunrise

The canonical guide for building your own application **on top of** Sunrise —
whether you forked the repository on GitHub or copied it as a project starter.

Audience: external forkers and app teams. If instead you want to contribute a
change **back to Sunrise itself**, see [`CONTRIBUTING.md`](./CONTRIBUTING.md).
For deep reference on any subsystem, see the [`.context/`](./.context/) docs.

---

## The app/platform model

Sunrise is two tiers of code living in one repository:

| Tier         | What it is                                                                                                                         | How you treat it                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Platform** | Sunrise itself — auth, API conventions, `lib/` utilities, orchestration, the security/rate-limit middleware, the migration tooling | An upgradable dependency. Prefer to extend it, not edit it. |
| **Your app** | The product you build — your routes, components, models, capabilities, business logic                                              | Freely yours. Add it in new files alongside the platform.   |

Two principles keep an upgrade from upstream a clean merge instead of a fight:

1. **Extend through the seams, don't fork-and-edit.** Sunrise exposes
   designed extension points — add OAuth providers in `lib/auth/config.ts`, add
   models to the Prisma schema, drop new routes under `app/api/v1/` (they
   inherit rate limiting automatically), add pages to a route group, register
   capabilities/agents/workflows in the orchestration layer, declare your env
   vars in `lib/app/env.ts`, register app-scoped rate-limit tiers/rules, swap
   email/storage/analytics providers via their adapters ([§4](#4-configuration--environment--the-libapp-surface)).
   The fewer existing Sunrise files you modify, the smaller every future merge conflict.

2. **Depend on the public surface, not internals.** Build against Sunrise's
   stable helpers rather than reaching into their implementations:
   - `@/` import alias everywhere (never relative paths) — survives upstream file moves
   - API envelope: `successResponse()` / `errorResponse()` (`lib/api/responses.ts`)
   - Auth guards: `withAuth()` / `withAdminAuth()` (`lib/auth/guards.ts`)
   - The utilities in the **Key Utilities** table of [`CLAUDE.md`](./CLAUDE.md)
   - The documented contracts in [`.context/`](./.context/)

   These are the parts intended to stay stable across releases. Internals
   behind them can be refactored upstream; code that only touches the public
   surface rides those refactors for free.

**Where your code goes:**

| Your code                  | Put it in                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Pages                      | a route group under `app/` (`(public)`, `(protected)`)                                                              |
| API endpoints              | `app/api/v1/<resource>/`                                                                                            |
| React components           | `components/`                                                                                                       |
| Business logic / utilities | `lib/`                                                                                                              |
| Database models            | the Prisma schema + a migration                                                                                     |
| Agent tools                | a capability in the orchestration layer                                                                             |
| Environment variables      | `lib/app/env.ts` (`appEnvSchema`) — see [§4](#4-configuration--environment--the-libapp-surface)                     |
| App rate-limit tier / rule | `registerRateLimitTier()` / `registerRateLimitRule()` — see [§4](#4-configuration--environment--the-libapp-surface) |
| Dependencies & scripts     | `package.json` — see [§7](#7-adding-dependencies--scripts)                                                          |
| Your own documentation     | `.context/app/` — the fork-owned docs folder (see below)                                                            |

**Where your documentation goes — the `.context/app/` convention.** Sunrise's
platform docs live under `.context/<domain>/` (e.g. `.context/auth/`,
`.context/orchestration/`); those are Sunrise-owned and merge from upstream, so
don't edit them. Put **your fork's own documentation in `.context/app/`** —
Sunrise never creates or writes to that folder, so, like your other new files,
nothing you add there ever conflicts on an upstream merge. Treat `.context/app/`
as the fork-owned mirror of the platform substrate: add
`.context/app/<feature>.md` files and, if you like, a `.context/app/README.md`
index. (This convention is used across Sunrise forks; adopting it keeps app docs
findable in the same place in every fork.)

**Two reserved fork tiers — `/app` (leaf) and `/framework`.** The `/app` surface
above is the **leaf-fork** tier: fork Sunrise directly and build your product in
`lib/app/**`, `.context/app/`, and `prisma/schema/app.prisma`. Some forks instead build a reusable
**framework layer** that sits _between_ Sunrise and their own leaf forks (e.g.
Daybreak). For those, Sunrise reserves a second tier one level up —
`lib/framework/`, `.context/framework/`, `prisma/schema/framework-*.prisma`, and
the `framework_` table prefix. **Sunrise core never creates files or tables
under either tier**, so both merge cleanly on upgrade. A framework fork owns
`/framework` and re-exposes `/app` to _its_ leaf forks; boot both through the
`lib/app/bootstrap.ts` seam ([§4](#4-configuration--environment--the-libapp-surface)).

---

## 1. First steps

**Initial setup:**

- [ ] Fork or clone this repository
- [ ] Update `package.json`:
  - `name`: your-project-name
  - `description`: Your project description
  - `version`: 0.1.0 (or your initial version)
  - `author`: Your name/organization
  - `repository`: Your repository URL
- [ ] Update `README.md`:
  - Replace "Sunrise" with your project name
  - Update description and features list
  - Update repository URLs
- [ ] Copy `.env.example` to `.env.local`
- [ ] Configure required environment variables (see `.env.example`)
- [ ] Generate auth secret: `openssl rand -base64 32`
- [ ] Set `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` in `.env.local`
- [ ] **Change `PORT` in `.env.development`** — see below; Sunrise ships `3010`
      and your fork should not keep it
- [ ] Run: `npm install`
- [ ] Initialize database: `npm run db:migrate:dev`
- [ ] Start dev server: `npm run dev`
- [ ] Test at `http://localhost:<your port>`

### Claiming your own dev port

Sunrise commits a `.env.development` holding one line:

```bash
PORT=3010
```

`npm run dev` reads it (via `scripts/dev-server.mjs`) and binds that port, so a
checkout needs no `-p` flag and no per-developer setup. **Your fork inherits
3010 on the first merge — change it.** Two apps derived from Sunrise that both
keep the default will fight over the port the moment they run together, and the
second one to start fails with `EADDRINUSE`.

```bash
# your-app/.env.development — committed, contains no secrets
PORT=3021
```

Pick a port per app and commit it. Every clone of your fork then agrees, and
nobody has to remember which app owns which number.

**This file is committed on purpose.** `.gitignore` blocks `.env`, `.env.local`
and every `.env*.local`, but deliberately leaves `.env.development` alone — it
is the one place for non-secret settings that should travel with the repo.
Never put a secret in it; those belong in `.env.local`, which is ignored.

**Serving it on a hostname.** The port is independent of the URL. Behind a local
reverse proxy (nginx, Caddy, Herd, Traefik) pointing `myapp.test` at the
loopback port, bind the port here and set the URLs in `.env.local`:

```bash
# .env.local — ignored, per-developer
BETTER_AUTH_URL="https://myapp.test"
NEXT_PUBLIC_APP_URL="https://myapp.test"
```

Both must change together (`lib/env.ts` expects them to match), and
`NEXT_PUBLIC_APP_URL` is inlined at compile time — **restart the dev server**
after editing, or the browser keeps calling the old origin. better-auth derives
its trusted origin from `BETTER_AUTH_URL`, so nothing else needs allow-listing.

Hot reload follows automatically: `next.config.js` derives `allowedDevOrigins`
from those two URLs, so the proxied hostname can reach Next's dev endpoints
without you editing the config. (Next allows only `localhost` by default —
without this you would get a page that renders but never hot-reloads, logging
_"Blocked cross-origin request to Next.js dev resource"_.) For hosts the URLs
don't cover — a LAN IP for testing on a phone, or `*.myapp.test` if you serve
tenants on subdomains — add them to `ALLOWED_DEV_ORIGINS` in `.env.local`.

**Deployment is unaffected**, by design:

| Target                       | What happens                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Docker (prod)                | The runtime image never receives `.env.development` — it copies only the standalone build. `ENV PORT=3000` stands. |
| Docker (dev / compose)       | `ENV PORT=3000` is a real environment variable, which outranks any env file.                                       |
| Vercel                       | Builds with `next build` (untouched) and never runs `npm start`. Port is the platform's.                           |
| Any PaaS running `npm start` | Production mode reads `.env.production*` / `.env` — never `.env.development`.                                      |

The rule underneath: a real environment variable always beats a file, and
`.env.development` is only ever read in development. See
[`environment/services-env.md`](./.context/environment/services-env.md#port).

---

## 2. Branding & theming

**App name (the brand seam):**

- Set **`NEXT_PUBLIC_APP_NAME`** in your `.env` — this renames the app across
  page-title metadata (all layouts + auth pages), the settings and knowledge-base
  **tab titles** (written straight to `document.title`, so they would otherwise
  override the layout template), the legal/contact pages' metadata
  (`privacy`, `terms`, `contact`), the **header/footer brand**, and the email
  templates in one place, no file edits. Defaults to `"Sunrise"` when unset.
  Consumed via `lib/brand.ts` (`BRAND.name`); import that constant if you add new
  brand-bearing surfaces. Marketing-page **body copy** (`app/(public)/*`,
  including `about/`'s description of the template itself) is not driven by this
  seam — re-skin it with the thin-shim pattern in
  [§6](#6-landing-page--routes) so your content stays sync-safe.

**Legal entity / copyright holder (`BRAND.legalName`):**

- Set **`NEXT_PUBLIC_LEGAL_NAME`** when the copyright is held by a company whose
  name differs from the product — the public footer copyright (`© YEAR …`)
  attributes to this value, not the product name. Defaults to
  `NEXT_PUBLIC_APP_NAME` (then `"Sunrise"`), so a fork that only sets the app
  name keeps today's output. Consumed via `lib/brand.ts` (`BRAND.legalName`);
  it's deliberately broader than "copyright holder" so it can later drive other
  legal surfaces (Terms/Privacy boilerplate, email footers). Example: product
  `"ConQuest"` with `NEXT_PUBLIC_LEGAL_NAME="All Too Human Ltd"` →
  `© 2026 All Too Human Ltd. All rights reserved.`

**Header / footer brand — the `<BrandMark>` slot:**

- A header brand is a **render** concern (image vs. styled wordmark vs. text,
  sizing, `alt`, dark/light variants) that an env string can't express, so the
  seam is a component: **`components/brand/brand-mark.tsx`** — a fork-owned
  scaffold. Its default body renders `BRAND.name` as text; replace only that
  file's body to render a logo, e.g. `<Image src="/logo.svg" alt={BRAND.name} …/>`
  (with `dark:` classes for dark/light variants) or a styled wordmark. Keep
  `BRAND.name` as the `alt` / `aria-label` even when a logo renders. `AppHeader`
  renders `<BrandMark/>` automatically; the footer copyright uses `BRAND.legalName`
  (see above).
  (It lives in `components/`, not `lib/app/`, because the `lib/app/**` boundary
  bans runtime `next/*` imports and a logo commonly needs `next/image`.)

**Public nav & footer links — replace-with-fallback:**

- Forks **own** the marketing nav (remove/rename/reorder), so the model is
  _replacement_, not append. Edit only **`lib/app/public-nav.ts`** (a fork-owned
  scaffold): set `publicNavItems` (header nav), `footerNavItems` (footer links),
  and/or `footerLegalItems` (footer legal links) to a `PublicNavItem[]`. Each
  defaults to `null` = use the platform default; a non-null array **replaces**
  that default wholesale. Items are `{ href, label, icon?, exact? }` (string +
  `lucide-react`; set `exact` so a parent link like `/docs` doesn't highlight on
  `/docs/intro`); the `next/link` / active-state glue stays in the platform
  components (`components/layouts/public-nav.tsx`, `public-footer.tsx`).
- **Replaceable content vs. non-negotiable platform control:** the footer's
  **Cookie Preferences** button is **always rendered** by the platform in the
  legal cluster, regardless of your `footerLegalItems` override. The override
  governs _links_; the consent control is not overridable (it's a legal
  requirement in many jurisdictions). This principle recurs for any surface that
  mixes fork copy with required platform behavior.

**Authenticated nav & where users land — the pair that makes an app reachable:**

- The nav a signed-in user sees is **`lib/app/protected-nav.ts`**: set
  `protectedNavItems` to a `ProtectedNavItem[]` and it **replaces**
  `DEFAULT_PROTECTED_NAV` wholesale, same replace-with-fallback model as the
  public nav. Items are `{ href, label, icon?, exact?, adminOnly? }`; the
  `next/link`, active-state and admin-filtering glue stays in
  `components/layouts/protected-nav.tsx`, so `adminOnly: true` works on your own
  items too. To add a link while keeping the platform ones, spread
  `DEFAULT_PROTECTED_NAV` — accepting that the spread pins that list as it stood
  at upgrade time.
- Where a user _lands_ is **`lib/app/auth-landing.ts`**: `appAuthLandingRoute`
  (default `/dashboard`) and `appAuthLandingLabel` (default `Dashboard`). One
  edit covers login, OAuth, signup, invite acceptance, email verification, the
  header brand link, the admin "Back to …" links, the error-page escape hatches
  and the proxy's redirect of a signed-in user off an auth page — all of which
  hardcoded `/dashboard` before. The label follows the route so the copy on those
  buttons doesn't keep saying "Dashboard" after you've moved.
- **Set both, or you build a dead end.** A landing route with no nav link leaves
  users somewhere the header never returns them to; a nav link with no landing
  change drops them on the stock dashboard first. If your route is outside
  `/dashboard`, `/settings` and `/profile`, also add its prefix to
  `lib/app/protected-routes.ts` so the proxy bounces signed-out visitors to
  login.
- The landing route must be **root-relative** (`/app`, not `https://…` or
  `//host`). It reaches `safeCallbackUrl()` as the _fallback_, and that helper
  only sanitises the untrusted URL — so a non-relative value throws at module
  load instead of quietly becoming an off-site redirect.

**Closing the front door — `SIGNUP_MODE`:**

- If your product is invite-gated, closed-beta or B2B-provisioned, set
  `SIGNUP_MODE=invite_only`. It closes `POST /api/auth/sign-up/email`, every
  other un-invited account creation (OAuth included), and the `/signup` page —
  the invitation system Sunrise already ships becomes the only way in. `open` is
  the default.
- **Hiding the signup link is not enough**, which is why this is config rather
  than a copy edit: `POST /api/auth/sign-up/email` is reachable whatever your
  nav renders, so a fork that only drops the link still accumulates accounts.
- The first human on an empty database may still sign up and becomes ADMIN —
  otherwise there is no operator to send invitations. Sign up first, then
  invite. See [`.context/auth/signup-modes.md`](./.context/auth/signup-modes.md).

**Auth email copy — the email resolver:**

- Every auth email (`welcome`, `verifyEmail`, `resetPassword`, `invitation`, …)
  resolves through `lib/email/registry.ts`, so you override copy without editing
  platform call sites. Copy the platform default from `emails/<kind>.tsx` into
  `components/app/emails/<kind>.tsx`, adapt it, and register it in
  **`lib/app/emails.ts`** keyed by its `EmailKind`. Unset kinds keep the
  platform default (which Sunrise keeps improving for cross-client
  deliverability). Your override must accept that kind's props — the platform
  publishes a stable typed `EmailPropsMap` contract per kind in
  `lib/email/registry.ts`; changing a kind's props is a versioned public-surface
  change.

**Other project metadata:**

- `package.json` → `name`, `description`
- `app/layout.tsx` → `metadata.description` (the title brand comes from the seam above)
- `README.md` → main heading, description

**Colors & styling:**

- `tailwind.config.ts` → `theme.extend.colors`, `theme.extend.fontFamily`
- `app/globals.css` → CSS variables for light/dark themes (`:root`, `.dark`)
- Update primary, secondary, accent colors as needed

**Logo & favicon:**

- Replace `public/favicon.ico`
- Add logo images to `public/`
- Update `app/layout.tsx` → `metadata.icons`
- Update the landing page hero via the thin-shim ([§6](#6-landing-page--routes)),
  not by editing `app/(public)/page.tsx` in place

**Fonts:**

- Import fonts in `app/layout.tsx` (currently uses Inter)
- Update font family in `tailwind.config.ts`

---

## 3. Authentication

**Remove OAuth providers:**

- Edit `lib/auth/config.ts` → delete provider from `socialProviders` object
- Remove corresponding env vars from `.env.local` and `.env.example`
- Update login UI if needed: `app/(auth)/login/page.tsx`

**Add OAuth providers:**

- Add provider to `lib/auth/config.ts` (follow Google OAuth pattern)
- Add credentials to `.env.local`:
  - `<PROVIDER>_CLIENT_ID`
  - `<PROVIDER>_CLIENT_SECRET`
- Update `.env.example` with placeholder values
- Add provider button to `app/(auth)/login/page.tsx`

**Email-only authentication:**

- Remove `socialProviders` section from `lib/auth/config.ts`
- Remove OAuth buttons from `app/(auth)/login/page.tsx`
- Remove OAuth env vars from `.env.example`

---

## 4. Configuration & environment — the `lib/app/` surface

`lib/app/` is the **auto-wired extension surface**. Each file is imported by the
Sunrise core consumer that lives in the right runtime, so your registrations
take effect with **zero wiring** — you fill in the file, you never hunt for a
startup hook to call it from.

**These files are fork-owned scaffold.** They ship as empty no-ops, and Sunrise
does **not** change them after shipping them, so the edits you make merge cleanly
when you pull an upstream release. (Contrast the marketing pages, which Sunrise
_does_ keep improving — those stay sync-safe via the thin-shim in
[§6](#6-landing-page--routes), not by editing the platform file in place.) The stable
contract the platform depends on is each file's _export_ — the symbol named in
the table below, which the core imports — **not** the body, which is yours. Keep
the export name and signature; everything inside is free to change. (Detailed
examples live here in this guide, not in the files, precisely so the files stay
small and conflict-free.)

| Edit this file                             | To register                                        | Auto-wired by (runtime)                                               |
| ------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------- |
| `lib/app/env.ts`                           | server env vars (`appEnvSchema`)                   | `lib/env.ts` startup parse (server)                                   |
| `lib/app/rate-limit.ts`                    | rate-limit tiers / rules                           | rate-limit middleware (middleware runtime)                            |
| `lib/app/protected-routes.ts`              | extra authed route prefixes (append)               | `proxy.ts` edge redirect-to-login (proxy runtime)                     |
| `lib/app/capabilities.ts`                  | agent capabilities (tools)                         | the capability registry (server route-handler)                        |
| `lib/app/context-contributors.ts`          | prompt-context loaders (`buildContext` types)      | the chat context builder (server route-handler)                       |
| `lib/app/admin-nav.ts`                     | admin sidebar sections                             | `admin-sidebar.tsx` (client)                                          |
| `lib/app/db-drift.ts`                      | Prisma-unmodelled DB objects                       | `scripts/db/check-drift.ts` (CI / `/pre-pr`)                          |
| `lib/app/public-nav.ts`                    | public nav / footer link lists                     | `public-nav.tsx`, `public-footer.tsx` (client)                        |
| `lib/app/protected-nav.ts`                 | authenticated nav link list                        | `protected-nav.tsx` (client)                                          |
| `lib/app/auth-landing.ts`                  | where a signed-in user lands, and its label        | `lib/auth-landing/route.ts` → a dozen sites (proxy + server + client) |
| `lib/app/emails.ts`                        | auth email template overrides                      | `lib/email/registry.ts` (server)                                      |
| `lib/app/bootstrap.ts`                     | one-time server boot work (`initApp`)              | `instrumentation.ts` `register()` (server, all envs)                  |
| `lib/app/user-created.ts`                  | react to a new account (`initAppUserCreatedHooks`) | better-auth `user.create.after` (server)                              |
| `lib/app/jobs.ts`                          | recurring background work (`initAppJobs`)          | the maintenance tick (server)                                         |
| `lib/app/eslint.config.mjs`                | ESLint import-boundary blocks (fork tiers)         | root `eslint.config.mjs` spread (lint)                                |
| `lib/app/knowledge-access-contributors.ts` | extra docs for a restricted agent                  | `resolveAgentDocumentAccess()` (server route-handler)                 |
| `lib/app/guard-floor-contributors.ts`      | per-turn minimum for inline chat guards            | the chat handler's `collectGuardFloors()` (server route-handler)      |
| `lib/app/guard-event-contributors.ts`      | observe an inline chat guard firing                | the chat handler's `emitGuardEvent()` (server route-handler)          |
| `lib/app/csp.ts`                           | extra CSP `frame-src` origins                      | `lib/security/headers.ts` → `proxy.ts` (middleware runtime)           |
| `lib/app/agent-fields.ts`                  | extra `AiAgent` config fields                      | the agent field registry (server + agent form)                        |
| `lib/app/surface.ts`                       | which URLs count as `admin` vs `consumer`          | `proxy.ts` classification + `<SurfaceSync>` (proxy + client)          |
| `lib/app/data-export.ts`                   | app tables in a subject-access export              | `exportUserData()` (server route-handler)                             |

> **Filling a seam is expected to fail one row of a core test.**
> `tests/unit/lib/app/defaults.test.ts` asserts every seam ships empty — that
> contract is what stops a stray default from applying to every install. When you
> fill a seam, **pin the new value** in that file's `SEAM_DEFAULTS` table rather
> than deleting the row (`expect(appEslintConfig).toEqual(myTierConfig)`, not a
> deletion). Pinning keeps the protection for the seams you have _not_ filled.
> One row per seam, so your diff stays a line — see the FORK NOTE at the top of
> that file.

**Why one file per concern and not one bootstrap call?** Next.js bundles middleware,
server route-handlers, and the client as three separate module realms — a
registration only takes effect in the realm where it runs. So each concern lives
in its own file, imported by the consumer in the matching realm. (It also keeps
the lean middleware bundle free of capability/Prisma code.) An ESLint boundary
keeps `lib/app/` portable: no runtime `next/*` imports (type-only is fine), `@/`
alias only; framework glue goes in `app/` or `lib/app/<name>/server/`. See
[`.context/architecture/lint-toolchain.md`](./.context/architecture/lint-toolchain.md#app-boundary--libapp).

**Server boot work — `lib/app/bootstrap.ts`.** For one-time startup work (warm a
cache, register a background worker, boot a framework tier), fill the empty
`initApp()`. `instrumentation.ts` `register()` calls it once per server process
in **every** environment (it sits above the dev-only maintenance-ticker guards),
isolated in a try/catch so a boot error is logged but never crashes
instrumentation. **Import your framework tier _dynamically_** from here
(`await import('@/lib/framework')`) — a _static_ framework specifier is resolved
at `next build` and breaks the build in vanilla Sunrise or any fork without that
folder, which is exactly why core references only `@/lib/app/bootstrap` and
carries zero framework vocabulary. A **framework-layer fork** (see the two-tier
model below) boots its tier in `bootstrap.ts` and then delegates to a fresh
reserved leaf hook (e.g. `lib/app/leaf-bootstrap.ts`), so a leaf-on-framework
fork can still hook boot without colliding on `bootstrap.ts`.

**Reacting to a new account — `lib/app/user-created.ts`.** To provision a
profile row, seed a default workspace, start an onboarding sequence or push to a
CRM when someone signs up, fill the empty `initAppUserCreatedHooks()`:

```typescript
// lib/app/user-created.ts — yours to edit
import { registerUserCreatedHook } from '@/lib/auth/user-created-hooks';

export function initAppUserCreatedHooks(): void {
  registerUserCreatedHook('app:seed-workspace', async ({ userId, email, signupMethod }) => {
    await prisma.appWorkspace.create({ data: { ownerId: userId, name: email } });
  });
}
```

better-auth's `user.create.after` hook calls the initializer once, then
dispatches every registered hook. The context is
`{ userId, email, name, signupMethod, viaInvitation }` — `signupMethod`
distinguishes OAuth (address already verified) from email/password (not yet),
and `viaInvitation` tells you the address was already proven.

Hooks run **after** the user row exists, so one **cannot reject a signup**: a
throw is logged and ignored rather than failing account creation, because the
account is already there. Pre-creation rejection happens in `userCreateBeforeHook`
(`lib/auth/config.ts`, better-auth's `databaseHooks.user.create.before`), which
throws an `APIError` — that is where the reserved-address and
OAuth-invitation-mismatch refusals live. There is no fork seam for it today; a
fork that needs one edits that hook. Hooks are dispatched together, so a slow one delays the
others — hand long work to a queue rather than awaiting it here. The `key` is
for logging and for replacing a registration; register the same key twice and
the second wins.

**Recurring background work — `lib/app/jobs.ts`.** To run periodic work on the
existing maintenance tick instead of standing up a second scheduler, fill the
empty `initAppJobs()`:

```typescript
// lib/app/jobs.ts — yours to edit
import { registerAppJob } from '@/lib/orchestration/maintenance/app-jobs';

export function initAppJobs(): void {
  registerAppJob({
    name: 'app:prune-draft-invoices',
    intervalMs: 6 * 60 * 60 * 1000, // 6 hours
    run: async () => {
      const { count } = await prisma.appInvoice.deleteMany({/* … */});
      return { pruned: count }; // folded into the tick's log line
    },
  });
}
```

`intervalMs` is a **minimum gap, not a guarantee**, and last-run times live in
process memory. So a multi-instance deployment runs each job roughly once per
instance per interval, and a restart re-arms everything. **Write jobs to be
idempotent.** If a job must run exactly once cluster-wide it needs its own
lease — see `execution-reaper` for that pattern.

Three behaviours worth knowing:

- **A slow job never stacks up.** A job still running from an earlier tick is
  skipped, however long ago it became due — so a 5-minute job on a 1-minute
  interval does not accumulate concurrent runs.
- **A non-positive or `NaN` `intervalMs` is refused at registration**, loudly,
  rather than defaulted. A job silently running every tick is worse than a
  visible refusal.
- **Failures are contained.** Jobs run in parallel; one throwing is logged, its
  error folded into the tick's summary, and the others are unaffected. Whatever
  `run()` returns is folded into the tick's log line, so return a small count
  object rather than logging yourself.

**ESLint boundary rules + CI checks — `lib/app/eslint.config.mjs`.** To enforce
your tier's own import boundary (e.g. a `framework ↔ core` rule), add flat-config
blocks to `lib/app/eslint.config.mjs` (ships `export default []`) instead of
editing the root config. The root `eslint.config.mjs` spreads your array **last**
— after every Sunrise block — so a block of yours **wins for its own `files`**.
Two things to know: (1) a framework-tier fork spreads its
`lib/framework/eslint.config.mjs` first and keeps this leaf seam last; (2)
flat-config **`no-restricted-imports` replaces, it does not merge** — a block
that restricts imports for a glob must **restate the base `@/`-alias ban** for
that glob or relative-import enforcement silently drops there (see
[`.context/architecture/lint-toolchain.md`](./.context/architecture/lint-toolchain.md#app-boundary--libapp)
for the worked example). For **CI**, add an `app:ci-checks` script to
`package.json` (a boundary check, migration-hygiene lint, etc.) — Sunrise's
`lint` job already runs `npm run app:ci-checks --if-present`, so it executes with
**no `ci.yml` edit** (and no-ops in vanilla Sunrise, which ships no such script).

**Environment variables — `lib/app/env.ts`.** Declare your own server-side env
vars in `appEnvSchema`; the core validator merges them into the **same fail-fast
startup parse** as the platform vars, and exposes them typed on `env`:

```typescript
// lib/app/env.ts — yours to edit (don't touch the closed schema in lib/env.ts)
import { z } from 'zod';

export const appEnvSchema = z.object({
  STRIPE_SECRET_KEY: z.string().min(1),
});
```

A missing/invalid app var aborts boot like a missing `DATABASE_URL` would. Scope is
server-side only — for client values use a `NEXT_PUBLIC_*` var read via `process.env`.
Full guide: [`.context/environment/overview.md`](./.context/environment/overview.md#app-defined-variables-forks).

**Rate-limit tiers & rules — `lib/app/rate-limit.ts`.** Give your own `/api/v1/**`
paths a custom section cap. Fill in the auto-wired `registerAppRateLimits()`:

```typescript
// lib/app/rate-limit.ts — called once by the rate-limit middleware at load
import { createRateLimiter, registerRateLimitTier } from '@/lib/security/rate-limit';
import { registerRateLimitRule } from '@/lib/security/rate-limit-policy';
import { SECURITY_CONSTANTS } from '@/lib/security/constants';

export function registerAppRateLimits(): void {
  registerRateLimitTier(
    'billing',
    createRateLimiter({
      interval: SECURITY_CONSTANTS.RATE_LIMIT.DEFAULT_INTERVAL,
      maxRequests: 40,
      uniqueTokenPerInterval: SECURITY_CONSTANTS.RATE_LIMIT.MAX_UNIQUE_TOKENS,
    })
  );
  registerRateLimitRule({ match: /^\/api\/v1\/billing\//, tier: 'billing', key: 'session-user' });
}
```

App rules are spliced in after every built-in Sunrise rule and before the
`/api/v1/` catch-all, so they govern your namespace only. Registration **throws**
if a rule could match a Sunrise-protected surface (`/api/v1/admin/**`,
`/api/auth/**`, `/api/v1/auth/**`, `/api/v1/mcp/**`) or if a tier name collides with
a built-in — you can't accidentally loosen the auth/admin caps, and the failure
aborts boot rather than passing silently. The section tiers and per-flow caps are
also env-tunable via `RATE_LIMIT_*` overrides. Full reference:
[`.context/security/rate-limiting.md`](./.context/security/rate-limiting.md#app--fork-extension).

> Most apps never need a custom tier — every new `/api/v1/**` route already inherits
> the 100/min `api` cap automatically. Reach for this only when a route needs a
> genuinely different cap or keying.

**Protected route prefixes — `lib/app/protected-routes.ts`.** When your fork adds
a new authenticated top-level section (its own route group under a fresh path,
e.g. `/projects`), list the prefix here to get the cheap edge redirect-to-login
for signed-out visitors — without editing `proxy.ts`:

```typescript
// lib/app/protected-routes.ts — yours to edit (ships empty)
export const appProtectedRoutes: string[] = ['/projects'];
```

The proxy **merges** these with the core prefixes (`/dashboard`, `/settings`,
`/profile`) — the model is _append_, not replacement. This is only the
"is-logged-in-at-all" edge gate; per-resource ownership/membership checks stay in
the `withAuth` / `withAdminAuth` guards. Malformed entries (anything not starting
with `/`, including an empty string that would otherwise match every path) are
dropped, so a typo can't lock the whole app behind the login redirect.

**Agent capabilities — `lib/app/capabilities.ts`.** Fill in the auto-wired
`initAppCapabilities()` with `registerAppCapability(new YourTool())` calls (your
tools extend `BaseCapability`). The capability registry runs it once before the
first agent dispatch. See
[`.context/orchestration/capabilities.md`](./.context/orchestration/capabilities.md).

**Prompt-context loaders — `lib/app/context-contributors.ts`.** Fill in the
auto-wired `initAppContextContributors()` with
`registerContextContributor(type, loader)` calls to inject your own
`LOCKED CONTEXT` block per chat turn for a given `contextType`, without editing
the core `buildContext` switch. The chat context builder runs it once before its
first lookup; built-in types (e.g. `pattern`) take precedence. See
[`.context/orchestration/chat.md`](./.context/orchestration/chat.md).

**Knowledge access contributors — `lib/app/knowledge-access-contributors.ts`.**
To widen a **restricted** agent's searchable document set from a relationship
your layer owns (module membership, team ACL, per-tenant grant), fill in the
auto-wired `initAppKnowledgeAccessContributors()` with
`registerAgentAccessContributor(key, contributor)` calls. Your contributor
`(agentId) => Promise<{ documentIds?, tagIds? }>` is composed **live** at resolve
time and its docs/tags are **unioned** into the agent's set (contributed `tagIds`
expand to their documents like a tag grant) — so you never materialise derived
grants onto the per-agent pivot (which has no provenance column, making any
copy-down scheme clobber-or-leak). Rules: it runs **only** for `restricted`
agents (a `full` agent is untouched) and can only **widen** access; a contributor
that throws is logged and ignored; and when the data it reads changes you must
call `invalidateAgentAccess(agentId)` for the affected agents (the same contract
direct grants follow) so the cached decision re-composes. See
[`.context/orchestration/knowledge.md`](./.context/orchestration/knowledge.md).

**Admin sidebar sections — `lib/app/admin-nav.ts`.** Fill in the auto-wired
`initAppNav()` with `registerNavSection({ … })` calls; the admin sidebar renders
your sections after the core ones. Keep this file client-safe (registrar + icon
imports only — no server code). Use a `title` distinct from the core sections.
To render your own brand lockup as the section header instead of the default
uppercase label, pass `titleNode` (any `ReactNode`); `title` stays required and
remains the React key, the registry's dedupe key, and the heading's accessible
name, so a wordmark image can't cost you the label.

**Third-party iframes — `lib/app/csp.ts`.** `frame-src` is `'self'` in both the
dev and prod CSP. If your app embeds a third-party iframe (an onboarding or
marketing video is the usual case), list the hosts in `appFrameSrc` rather than
editing `lib/security/headers.ts`; the platform folds them into the global CSP.
Only exact `https://` origins are accepted (a left-most wildcard and a port are
fine) — anything else is dropped and logged at warn, because these values are
spliced into a response header. Keep the list exactly as broad as the feature:
build iframe `src`s only on these hosts from a **validated id**, never from an
admin's raw input, so a hostile stored value yields no iframe at all. See
[`.context/security/overview.md`](./.context/security/overview.md#third-party-iframes--the-frame-src-seam).

**Database drift probes — `lib/app/db-drift.ts`.** Register the Prisma-_unmodelled_
DB objects your app adds — hand-written FK constraints, custom indexes (GIN/HNSW),
CHECK constraints — so `npm run db:drift-check` (run in CI and by `/pre-pr`) probes
them alongside Sunrise's own. Prisma can't see these objects, so without a probe a
future `migrate dev` can silently `DROP` one and nothing notices. Fill in the
auto-wired `registerAppDriftProbes()` with `registerAppDriftProbe({ … })` calls
using the probe factories from `@/lib/db/drift-probes` (`indexExists`,
`constraintExists`, `columnExists`). The single most common case is the satellite
`User`-table FK below in §5. Full reference:
[`.context/database/prisma-unmodelled-objects.md`](./.context/database/prisma-unmodelled-objects.md#forks-registering-your-own-unmodelled-objects).

---

## 5. Database schema

**Modifying the schema:**

- Edit the schema in `prisma/schema/` — Sunrise's models are split into domain
  files there; **put your own app models in `prisma/schema/app.prisma`**, which
  Sunrise ships **empty** and never adds models to (the platform's own
  app-domain models live in `platform.prisma`). It is fork-reserved in the same
  way `lib/app/**` and `.context/app/` are, so your models there merge cleanly
  on every upstream sync
- Add/modify models as needed
- Create + apply a migration: `npm run db:migrate:dev` (dev) /
  `npm run db:migrate:deploy` (prod / CI)
- Update seed data under `prisma/seeds/` (see
  [`.context/database/seeding.md`](./.context/database/seeding.md))
- Regenerate the Prisma client: `npm run db:generate`

> `prisma db push` is intentionally not available as a script — it skips
> migration history and lets dev/prod diverge silently. Every schema change is
> a versioned, reviewable migration. See
> [`.context/database/migrations.md`](./.context/database/migrations.md).

**Adding user-related data — use a satellite table, don't edit `User`:**

Resist adding columns to the core `User` model. It's the most central, most
merge-prone platform model (better-auth and Sunrise both evolve it) — editing it
is exactly the fork-and-edit trap that turns every upstream merge into a fight.
Keep app-specific user data in **its own satellite table** in
`prisma/schema/app.prisma`, linked by a plain `String` FK to `User.id`:

```prisma
// prisma/schema/app.prisma
model AppUserProfile {
  id     String @id @default(cuid())
  userId String @unique // FK to User.id — no @relation (that needs a field ON User)
  // …your app fields…

  @@index([userId])
}
```

Because there is no Prisma `@relation`, you **must** add the foreign key — with
an explicit `ON DELETE` — by hand in the generated migration:

```sql
ALTER TABLE "AppUserProfile"
  ADD CONSTRAINT "AppUserProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE; -- personal data; SET NULL (nullable FK) for retained config/audit
```

> ⚠️ **The schema-level `onDelete` guard does not catch a plain-scalar FK** — it
> only reviews `@relation onDelete`, and your table has none. Skip the migration
> FK and `prisma.user.delete()` either orphans your rows (a silent GDPR retention
> violation) or throws `P2003` (erasure breaks for every user). For residual-PII
> scrub or external cleanup the cascade can't reach, register a hook with
> `lib/privacy/erasure-hooks.ts`. Full pattern:
> [`.context/privacy/data-erasure.md`](./.context/privacy/data-erasure.md#app--fork-tables-relating-to-user).

That hand-written FK is a **Prisma-unmodelled object**: Prisma computes desired
state from the schema (which has no `@relation` for it), so a future `migrate dev`
will emit a `DROP` for it. **Register a drift probe so CI catches that** — and so
the FK's `ON DELETE` policy, which otherwise lives only in un-reviewed SQL, gets
asserted on every run:

```typescript
// lib/app/db-drift.ts — the auto-wired §4 seam
import { registerAppDriftProbe, constraintExists } from '@/lib/db/drift-probes';

export function registerAppDriftProbes(): void {
  registerAppDriftProbe({
    name: 'AppUserProfile_userId_fkey (hand-written FK → User)',
    kind: 'FK constraint',
    table: 'AppUserProfile',
    probe: constraintExists('AppUserProfile_userId_fkey', 'ON DELETE CASCADE'),
  });
}
```

`npm run db:drift-check` (CI + `/pre-pr`) now fails if the FK is dropped **or** if
its `ON DELETE` action drifts from `CASCADE`. See
[`.context/database/prisma-unmodelled-objects.md`](./.context/database/prisma-unmodelled-objects.md#forks-registering-your-own-unmodelled-objects).

Then surface the table through its own API endpoint (`app/api/v1/<resource>/`)
and types — don't widen `User`'s public shape for app-only fields.

---

## 6. Landing page & routes

### Marketing pages — the thin-shim pattern

The marketing pages ship with Sunrise's own copy:

- **Landing page:** `app/(public)/page.tsx`
- **About page:** `app/(public)/about/page.tsx`
- **Contact page:** `app/(public)/contact/page.tsx`

Editing these files in place is the worst case for upstream sync: they're large,
Sunrise keeps improving them, and your rewrite collides with every upstream
change — a full-file, line-by-line conflict each release.

**The fix is the thin-shim: reduce each platform route file to a one-line
re-export, and keep all your real content in new, app-owned files.** New files
never conflict on sync, and the route file shrinks to a single line that
conflicts trivially ("keep mine").

```tsx
// app/(public)/page.tsx — Sunrise-tracked; reduce to a re-export of YOUR content
// app:shim — replaced by app-owned content; keep this line on upstream merges
export { default, metadata } from '@/components/app/marketing/home-page';
```

```
components/app/marketing/   ← all NEW files; upstream never touches them
├── home-page.tsx           ← your landing page (default export + `metadata`)
├── about-page.tsx
└── contact-page.tsx        ← renders Sunrise's <ContactForm>; behavior unchanged
```

Each content module just exports what the route needs — a `default` component
and a `const metadata` (the exact names the route file re-exports). Move the
body of the original page into it and rewrite the copy freely.

**The honest constraint:** the App Router resolves a URL from the file at its
canonical path, and won't let a second file own `/` — so the route file at
`app/(public)/page.tsx` (etc.) **must** be touched either way. The shim doesn't
make the conflict disappear; it shrinks it from a whole-file merge to a
one-line, deterministic "keep mine". Label the shim with an `app:shim` region
comment (as above) so the intent is obvious at merge time.

**Contact page — behavior is untouched.** Only the displayed copy moves. Your
`contact-page.tsx` keeps rendering Sunrise's `<ContactForm>`
(`@/components/forms/contact-form.tsx`), which posts to `/api/v1/contact` — Zod
validation, honeypot, rate limit, DB write, and the admin email notification all
stay exactly as the platform ships them. You're re-skinning the page, not
re-implementing the form.

> **Deferred:** a full upstream _content seam_ (a `lib/app/marketing.ts` override
> resolving against a typed default-content module) is intentionally **not**
> shipped — it's only worth maintaining once multiple forks sync these pages
> often. The thin-shim needs no platform abstraction and composes forward into
> that seam later if it's ever justified.

### Other pages

Functional app pages have no platform copy to conflict with — edit them directly:

- **Dashboard:** `app/(protected)/dashboard/page.tsx`
- **Settings:** `app/(protected)/settings/page.tsx`
- **Profile:** `app/(protected)/profile/page.tsx`

**Adding new pages:**

- **Public page:** Create `app/(public)/pricing/page.tsx` (uses public layout)
- **Protected page:** Create `app/(protected)/analytics/page.tsx` (uses protected
  layout) **and** register its prefix in `lib/app/protected-routes.ts`
  (`appProtectedRoutes`) so the proxy edge-redirects signed-out visitors — see
  [§4](#4-configuration--environment--the-libapp-surface). The `(protected)`
  folder supplies the chrome; the registered prefix supplies the auth gate. (Route
  groups like `(protected)` are invisible to the URL and to the proxy, so the
  folder alone does not gate auth.)
- **Different layout:** Create a new route group, e.g. `app/(marketing)/layout.tsx`

**Navigation:**

- Update layouts in route groups: `app/(public)/layout.tsx`, `app/(protected)/layout.tsx`
- Update navigation components as needed

### Removing default public pages

Sunrise ships public pages a given fork may not want: `/about`, `/contact`,
`/privacy`, `/terms` (alongside the `/` landing). Because the App Router derives
routes from the folder tree, you remove one by **deleting its folder** under
`app/(public)/` and dropping its link from the fork-owned nav lists in
`lib/app/public-nav.ts` (`footerNavItems` / `footerLegalItems` — see
[§4](#4-configuration--environment--the-libapp-surface)). Adding a public page is
the same in reverse — create `app/(public)/pricing/page.tsx`. Deleting a leaf page
folder is a clean, Next-native operation; the only upstream-sync cost is the same
as for any removed core file — if Sunrise later edits that exact page you get a
routine delete/modify conflict, resolved with "keep mine (deleted)".

**Legal-page caveat.** Two of these pages are linked from surfaces that always
render, beyond the footer: the cookie-consent banner links `/privacy`, and the
error pages (`app/error.tsx`, `app/global-error.tsx`) link `/contact`. The
footer's legal links are overridable via `public-nav.ts`'s `footerLegalItems`, but
if you remove `/privacy` or `/contact` outright, repoint (or keep) the banner /
error link so it doesn't 404 — point it at your own equivalent, or leave the page
in place.

### Making it an auth-only app

For an internal tool where **every** route requires a login, you don't need a
proxy change or a config flag — it's folder placement plus the existing seams:

- **New authenticated sections** go under `app/(protected)/` (for the shared
  chrome) **and** get their prefix registered in `lib/app/protected-routes.ts`, as
  above. Protected pages also self-guard server-side with `getServerSession()` (as
  `app/(protected)/dashboard/page.tsx` does) for defense-in-depth.
- **The homepage `/`** is the one route the proxy can't prefix-protect (a `/`
  prefix would match every path, including `/login`). Two clean options:
  - **Redirect it to the app** — reduce `app/(public)/page.tsx` to
    `export default function Page() { redirect('/dashboard'); }`. `/dashboard` is
    already proxy-protected, so a signed-out visitor to `/` bounces root →
    dashboard → login. Simplest when there's no distinct public homepage.
  - **Move it into the protected side** — `git mv app/(public)/page.tsx
app/(protected)/page.tsx` and self-guard it (`getServerSession()` →
    `redirect('/login')` when there's no session), when you want `/` to be an
    authenticated landing with the protected chrome. The move is a delete-plus-add,
    so its upstream-sync cost is the same as removing any core page.

Either way there's no core proxy edit: the built-in `protectedRoutes` list stays
as Sunrise ships it, and you extend behaviour through `lib/app/protected-routes.ts`
and folder placement.

---

## 7. Adding dependencies & scripts

`package.json` is shared between the platform and your app, and an upstream
upgrade is a three-way merge. Keep your additions in regions Sunrise never
touches so that merge stays clean.

**Dependencies:**

- ✅ **Add your own freely** — `npm install <your-package>`. New entries don't
  collide with Sunrise's.
- ❌ **Don't change the version of a dependency Sunrise already declares.**
  Bumping or pinning a Sunrise-owned dependency yourself creates merge
  conflicts on every upgrade and can break platform code that relies on a
  specific version. Dependency versions are the platform's to manage — you
  receive them through upstream merges.
- If you genuinely need a newer version of a Sunrise-owned dependency, raise it
  upstream rather than overriding it locally.

**Scripts:**

- Sunrise owns the **unprefixed** script names (`dev`, `build`, `test`,
  `validate`, `db:*`, `smoke:*`, `email:*`, …).
- ✅ **Add your app's scripts under an `app:*` namespace** — e.g.
  `app:import`, `app:report`, `app:backfill`. Namespacing guarantees they never
  collide with a script a future Sunrise release adds.
- ✅ **A framework-tier fork uses `framework:*`** — if you sit _between_ Sunrise
  and your own leaf forks (see the two reserved tiers in
  [The app/platform model](#the-appplatform-model)), take `framework:*` and leave
  `app:*` free for the forks downstream of you. Same rule, one tier up.
- ❌ **Never edit or remove an existing Sunrise script.** Wrap it from an
  `app:*` (or `framework:*`) script if you need to extend its behavior.

```jsonc
{
  "scripts": {
    "dev": "next dev", // ← Sunrise-owned: leave untouched
    "app:import": "tsx scripts/app/import.ts", // ← leaf fork: app:* namespace
    "app:report": "tsx scripts/app/report.ts",
    "framework:sync": "tsx scripts/framework/sync.ts", // ← framework tier
  },
}
```

The same split applies to the `scripts/` directory itself: `scripts/app/` is
leaf-fork-owned, `scripts/framework/` is framework-tier-owned, and everything
else under `scripts/` is Sunrise's. Neither subdirectory exists upstream — that
is what lets a fork create one without a merge conflict.

Two script names are **called by CI if they exist** and are otherwise a no-op:
`app:ci-checks` and `framework:ci-checks` (see the `lint` job in
`.github/workflows/ci.yml`). Define one to run your own boundary checks or
migration-hygiene lint on every PR without editing the workflow.

Following this convention means `package.json` merges cleanly on every upgrade:
your dependencies and namespaced scripts sit in regions upstream never edits.

---

## 8. Tracking your Sunrise version

Your fork has **two versions**, deliberately separate. Understanding the split
costs five minutes and saves the recurring "which Sunrise is this app on?"
question forever.

### The two-version model

| Version           | Source of truth                                      | Typed import (server-side)            | Yours or Sunrise's?                                                     |
| ----------------- | ---------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| `version`         | [`package.json`](./package.json)                     | [`APP_VERSION`](./lib/app-version.ts) | **Yours** — your app's version. Bump on your own release cadence.       |
| `SUNRISE_VERSION` | [`lib/sunrise-version.ts`](./lib/sunrise-version.ts) | (the file itself)                     | **Sunrise's** — which release of the upstream platform you're built on. |

You already set the first one in [§1 First steps](#1-first-steps) by editing
`package.json.version`. Server-side code reads it through the typed
[`APP_VERSION`](./lib/app-version.ts) constant — a thin file that imports
`package.json` directly at module load (deliberately not via
`process.env.npm_package_version`, which is unset under common production
launchers like `node`-direct Docker entrypoints and Next.js standalone
builds). The second version is set for you by whichever Sunrise release you
forked from, and updates automatically when you merge in a new upstream
release.

### Why not just use `package.json.version`?

Because **you** edit `package.json.version` to track your own app. If
Sunrise's version were derived from it, the upstream version number would
silently follow your fork's — and nobody could ask a running deployment
_"which Sunrise are you on?"_ without you also publishing a mapping table.

The two version files are deliberate siblings in `lib/`:

- `lib/app-version.ts` re-exports your `package.json.version` as a typed
  `APP_VERSION` string. This file is **part of the platform** — Sunrise ships
  it, forks don't edit it (the indirection through `package.json` is the
  whole point — you edit `package.json`, not this file).
- `lib/sunrise-version.ts` exports `SUNRISE_VERSION` directly. **Sunrise**
  maintainers bump the constant on each upstream release; you don't touch
  the file. The header comments in both files restate this so anyone
  scanning the source spots it immediately.

> **Don't:** edit `lib/sunrise-version.ts` in your fork. The only way you'd
> hit a merge conflict on this file is if you've edited it; resolving the
> conflict in your favour permanently desyncs your reported version from
> reality.
>
> **Do:** let upstream merges update it. Treat the file as read-only from
> the fork's perspective.

### Where Sunrise surfaces it

Sunrise's `/api/health` endpoint already includes both versions in its
response:

```json
{
  "status": "ok",
  "version": "1.2.3", // your app
  "sunrise": "0.5.0", // the platform release you're on
  "uptime": 1234,
  "timestamp": "2026-…"
}
```

If you keep the `/api/health` route in your fork (most do), you inherit this
for free.

### Where you might surface it in your fork

Optional, not required — surface it wherever it's useful for your operators.
Import the constants from their canonical locations:

```ts
import { APP_VERSION } from '@/lib/app-version';
import { SUNRISE_VERSION } from '@/lib/sunrise-version';
```

Common surfaces:

- **Your own health endpoint**, if you replaced Sunrise's. Add
  `sunrise: SUNRISE_VERSION` (and optionally `version: APP_VERSION`) to the
  payload.
- **An admin "About" panel or sidebar footer** — one line, useful when
  triaging issues that might be release-specific.
- **Your structured-logger base context** — include both in every log
  line so support tickets carry the version pair implicitly.

### What to do when you upgrade

When you pull a new Sunrise release into your fork:

1. **Read [`CHANGELOG.md`](./CHANGELOG.md)** for the range of versions you're
   crossing — start at your previous `SUNRISE_VERSION` and read forward.
2. **Pay particular attention to MAJOR bumps** — breaking changes to the
   public surface (see [`VERSIONING.md` → SemVer rules](./VERSIONING.md#semver-rules-at-10)).
   They're rare during `0.x` and don't force a MAJOR bump even when they
   occur, but a real `1.x → 2.x` MAJOR is a deliberate signal that real merge
   work is coming.
3. **During `0.x`, expect real merge work between any two releases** — the
   surface is still settling. See
   [`VERSIONING.md` → `0.x` semantics](./VERSIONING.md#0x-alpha-semantics--loose-by-design).

The mechanical merge steps (migrations, schema, `package.json`) are in the
next section.

For the full version contract and how Sunrise releases are produced, see
[`VERSIONING.md`](./VERSIONING.md) and
[`CONTRIBUTING.md` → "Cutting a release"](./CONTRIBUTING.md#cutting-a-release).

---

## 9. Staying in sync with upstream Sunrise

When you pull a new Sunrise release into your fork, the biggest moving part is
the database migration history — your app's migrations and Sunrise's share one
directory.

**What does _not_ conflict.** Your own new files (routes, components, `lib/`
modules, and your docs under `.context/app/`) are invisible to upstream, so they
never conflict. `prisma/schema/app.prisma` is fork-reserved the same way —
Sunrise ships it empty and adds no models to it, so the models you put there
survive every sync untouched. The `lib/app/` bootstrap files ([§4](#4-configuration--environment--the-libapp-surface))
are **fork-owned scaffold**: Sunrise ships them empty and doesn't re-edit them,
so the registrations you add there merge cleanly too — no special handling. The
files that _can_ conflict are the ones both you and upstream edit (the migration
directory above, the marketing-page route shims ([§6](#6-landing-page--routes)) —
a one-line "keep mine" when your content lives in app-owned files — branding, and
`package.json` — see [§7](#7-adding-dependencies--scripts)); resolve those keeping
your version, and add a follow-up rather than rewriting Sunrise's.

- **One shared history.** App and Sunrise migrations both live in
  `prisma/migrations/` and are applied in timestamp order. On an upstream
  merge, new Sunrise migration folders **interleave with yours by timestamp**.
- **Name your migrations distinctly.** Prefix app migrations so you can tell at
  a glance which are yours when they interleave — e.g.
  `db:migrate:dev -- --name app_add_orders`. Prisma applies migrations by
  folder name in lexicographic (timestamp) order regardless of the label, so
  the prefix is purely for human triage.
- **After merging a release:** run `npm run db:migrate:status` to see what's
  pending, then `npm run db:migrate:dev` (dev) / `npm run db:migrate:deploy`
  (prod / CI) to apply the newly-merged Sunrise migrations.
- **Never edit Sunrise's migration SQL.** If you need to adjust the result, add
  your own follow-up migration. Editing an applied migration desyncs every
  environment.
- **Reading a release's migration set:** the migrations a release added are the
  new folders under `prisma/migrations/` — diff against your last-synced point
  with `git diff <last-sync>..<release> -- prisma/migrations/`.

The full reconciliation recipe — including `prisma migrate resolve --applied` /
`--rolled-back` for baselining or recovering a migration, the pgvector
extension requirement, and zero-downtime patterns — lives in
[`.context/database/migrations.md`](./.context/database/migrations.md).

---

## 10. Removing features

**Testing framework:**

- [ ] Delete `tests/` directory
- [ ] Delete `vitest.config.ts`
- [ ] Remove test scripts from `package.json` (`test`, `test:watch`, `test:coverage`)
- [ ] Uninstall: `npm uninstall vitest @vitest/ui happy-dom @testing-library/react @testing-library/user-event`

**Docker:**

- [ ] Delete `Dockerfile`, `Dockerfile.dev`
- [ ] Delete `docker-compose.yml`, `docker-compose.prod.yml`
- [ ] Delete `.dockerignore`
- [ ] Delete `DOCKER-TESTING.md`
- [ ] Remove Docker references from `README.md`

**OAuth providers:**

- [ ] Remove provider configs from `lib/auth/config.ts`
- [ ] Remove env vars from `.env.local` and `.env.example`
- [ ] Remove provider buttons from login page

**Specific pages/features:**

- [ ] Delete route folders you don't need (e.g., `app/(protected)/profile/`)
- [ ] Remove corresponding API endpoints: `app/api/v1/[resource]/`
- [ ] Clean up navigation references
- [ ] For the default **public** pages (marketing / legal) and making an
      **auth-only** app, see [§6](#6-landing-page--routes) — it covers the
      cookie-banner/error legal-link caveat and protecting the homepage.

---

## 11. Reference documentation

**Detailed guides:**

- [Architecture Overview](./.context/architecture/overview.md) — System design, component structure
- [Authentication](./.context/auth/overview.md) — better-auth integration, OAuth flows
- [API Endpoints](./.context/api/endpoints.md) — REST API reference, request/response formats
- [Database Schema](./.context/database/schema.md) — Prisma models, relationships
- [Database Migrations](./.context/database/migrations.md) — Migration workflow, upstream sync
- [Environment Variables](./.context/environment/reference.md) — Complete variable reference, app env extension
- [Rate Limiting](./.context/security/rate-limiting.md) — Tiers, policy table, app-scoped tiers/rules
- [Lint Toolchain](./.context/architecture/lint-toolchain.md) — ESLint config, the `lib/app/**` boundary

**Quick references:**

- Commands: [`.context/commands.md`](./.context/commands.md)
- Substrate (full docs index): [`.context/substrate.md`](./.context/substrate.md)
- Testing: [`.context/testing/overview.md`](./.context/testing/overview.md)
- Deployment: [`.context/deployment/overview.md`](./.context/deployment/overview.md)
  </content>
