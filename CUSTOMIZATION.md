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
- [ ] Run: `npm install`
- [ ] Initialize database: `npm run db:migrate:dev`
- [ ] Start dev server: `npm run dev`
- [ ] Test at `http://localhost:3000`

---

## 2. Branding & theming

**App name (the brand seam):**

- Set **`NEXT_PUBLIC_APP_NAME`** in your `.env` — this renames the app across
  page-title metadata (all layouts + auth pages), the **header/footer brand**,
  and the email templates in one place, no file edits. Defaults to `"Sunrise"`
  when unset. Consumed via `lib/brand.ts` (`BRAND.name`); import that constant
  if you add new brand-bearing surfaces. Marketing-page **body copy**
  (`app/(public)/*`) is not driven by this seam — re-skin it with the thin-shim
  pattern in [§6](#6-landing-page--routes) so your content stays sync-safe.

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
contract the platform depends on is each file's _export_ (`appEnvSchema`,
`registerAppRateLimits`, `initAppCapabilities`, `initAppNav`,
`registerAppDriftProbes`, the `publicNavItems` / `footerNavItems` /
`footerLegalItems` lists, `emailOverrides`) — which the core imports — **not**
the body, which is yours. Keep the export name and signature;
everything inside is free to change. (Detailed examples live here in this guide,
not in the files, precisely so the files stay small and conflict-free.)

| Edit this file            | To register                      | Auto-wired by (runtime)                        |
| ------------------------- | -------------------------------- | ---------------------------------------------- |
| `lib/app/env.ts`          | server env vars (`appEnvSchema`) | `lib/env.ts` startup parse (server)            |
| `lib/app/rate-limit.ts`   | rate-limit tiers / rules         | rate-limit middleware (middleware runtime)     |
| `lib/app/capabilities.ts` | agent capabilities (tools)       | the capability registry (server route-handler) |
| `lib/app/admin-nav.ts`    | admin sidebar sections           | `admin-sidebar.tsx` (client)                   |
| `lib/app/db-drift.ts`     | Prisma-unmodelled DB objects     | `scripts/db/check-drift.ts` (CI / `/pre-pr`)   |
| `lib/app/public-nav.ts`   | public nav / footer link lists   | `public-nav.tsx`, `public-footer.tsx` (client) |
| `lib/app/emails.ts`       | auth email template overrides    | `lib/email/registry.ts` (server)               |

**Why four files and not one bootstrap call?** Next.js bundles middleware,
server route-handlers, and the client as three separate module realms — a
registration only takes effect in the realm where it runs. So each concern lives
in its own file, imported by the consumer in the matching realm. (It also keeps
the lean middleware bundle free of capability/Prisma code.) An ESLint boundary
keeps `lib/app/` portable: no runtime `next/*` imports (type-only is fine), `@/`
alias only; framework glue goes in `app/` or `lib/app/<name>/server/`. See
[`.context/architecture/lint-toolchain.md`](./.context/architecture/lint-toolchain.md#app-boundary--libapp).

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

**Agent capabilities — `lib/app/capabilities.ts`.** Fill in the auto-wired
`initAppCapabilities()` with `registerAppCapability(new YourTool())` calls (your
tools extend `BaseCapability`). The capability registry runs it once before the
first agent dispatch. See
[`.context/orchestration/capabilities.md`](./.context/orchestration/capabilities.md).

**Admin sidebar sections — `lib/app/admin-nav.ts`.** Fill in the auto-wired
`initAppNav()` with `registerNavSection({ … })` calls; the admin sidebar renders
your sections after the core ones. Keep this file client-safe (registrar + icon
imports only — no server code). Use a `title` distinct from the core sections.

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
  files there; **put your own app models in `prisma/schema/app.prisma`** to keep
  them clearly separate from the platform's
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
- **Protected page:** Create `app/(protected)/analytics/page.tsx` (uses protected layout)
- **Different layout:** Create a new route group, e.g. `app/(marketing)/layout.tsx`

**Navigation:**

- Update layouts in route groups: `app/(public)/layout.tsx`, `app/(protected)/layout.tsx`
- Update navigation components as needed

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
- ❌ **Never edit or remove an existing Sunrise script.** Wrap it from an
  `app:*` script if you need to extend its behavior.

```jsonc
{
  "scripts": {
    "dev": "next dev", // ← Sunrise-owned: leave untouched
    "app:import": "tsx scripts/app/import.ts", // ← yours: app:* namespace
    "app:report": "tsx scripts/app/report.ts",
  },
}
```

Following this convention means `package.json` merges cleanly on every upgrade:
your dependencies and `app:*` scripts sit in regions upstream never edits.

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
modules, `prisma/schema/app.prisma`) are invisible to upstream, so they never
conflict. The `lib/app/` bootstrap files ([§4](#4-configuration--environment--the-libapp-surface))
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
