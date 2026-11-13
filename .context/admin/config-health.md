# Admin config health

Some settings are optional in the env schema, so the app boots without them,
but a feature quietly stops working when they are missing: no LLM provider key,
no email, a serverless database with no connection pooler. Before this, the only
sign was a log line or a user reporting it. Config health names them in the
admin area (#865).

## What it checks

Sunrise's checks, in `lib/config-health/checks.ts`:

| Key            | Severity | Applies     | Passes when                                                                                                                                                 |
| -------------- | -------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm_provider` | critical | always      | an **active** provider can be reached: a key through the credential seam, or a local provider (`filterProvidersWithCredential`)                             |
| `email`        | warning  | always      | `isEmailEnabled()` (Resend is configured)                                                                                                                   |
| `db_pooler`    | warning  | Vercel only | `DATABASE_URL` looks pooled: Neon `-pooler`, Supabase `.pooler.` or `:6543`, `pgbouncer=true`/`1`, or Prisma Accelerate (`prisma://`, `prisma+postgres://`) |

Required settings (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
`NEXT_PUBLIC_APP_URL`) are not checked: the app does not start without them.

**`CRON_SECRET` is deliberately not a core check.** The maintenance tick accepts
either it or an admin API key (`app/api/v1/admin/orchestration/maintenance/tick/route.ts`),
so an install driving the tick with a key would be told something is missing
when nothing is. A fork whose cron needs the secret adds the check itself
(ConQuest does).

## Presence only, never values

Every `detect()` returns a boolean. The report carries each check's key, label,
severity, description, remediation, optional docs path, and `present` /
`applicable` flags, and nothing read from the environment. The route logs the
summary counts only. `tests/unit/lib/config-health/run.test.ts` asserts a
secret set in the environment never appears in the report.

## How it is shown

`runConfigHealthChecks()` (`lib/config-health/run.ts`) runs Sunrise's checks,
then the fork's. A `productionOnly` check, and one whose `applicable()` returns
false, is reported `applicable: false, present: true`, so it is never flagged.
`summary` counts the unmet applicable checks by severity, met ones as `ok`, and
checks that could not run as `failed` only, never under a severity.

- **API:** `GET /api/v1/admin/config-health` (`API.ADMIN.CONFIG_HEALTH`),
  `withAdminAuth` with no tier, so platform admins only.
- **Overview card:** `/admin/overview` loads the report on the server and
  renders `<ConfigHealthBanner variant="card" />`, listing every unmet check
  with its fix. Nothing when all pass, or when the load fails (an org admin
  cannot read the route; the page treats their 403 as expected, so it is not
  logged).
- **Banner on every admin page:** `<ConfigHealthGlobalBanner />` in
  `app/admin/layout.tsx`, mounted for platform reach only. It shows a one-line
  strip when a **critical** check fails. It loads the report on navigation, but
  reuses one under a minute old: once only would leave a provider fixed in the
  admin flagged until a reload, and every click would spend the `admin`
  rate-limit budget the pages themselves need. A failed load clears the strip.
  It shows nothing on the overview, where the card already lists the same
  thing.

**A check that throws** (a database read failing, a bug in a fork's check) does
not take the report down. It is logged as `Config health check failed` and
reported `present: false, failed: true`. The card shows it as a check that could
not run; the strip leaves it out, because the setting is not known to be missing.
The provider check counts here too when the credential resolver fails for every
active provider: the keys may well be set, so it is not reported as missing.

## Adding a check

- **Sunrise:** add a `ConfigHealthCheck` to `CONFIG_HEALTH_CHECKS` in
  `lib/config-health/checks.ts`.
- **A fork:** add it to `appConfigHealthChecks` in `lib/app/config-health.ts`
  (fork-owned scaffold, ships empty). Your checks run after Sunrise's.

```ts
// lib/app/config-health.ts — yours to edit (ships empty)
import type { ConfigHealthCheck } from '@/lib/config-health/types';

export const appConfigHealthChecks: ConfigHealthCheck[] = [
  {
    key: 'STRIPE_SECRET_KEY',
    label: 'Stripe',
    severity: 'critical',
    description: 'Billing is off without it.',
    remediation: 'Set STRIPE_SECRET_KEY and redeploy.',
    detect: () => !!process.env.STRIPE_SECRET_KEY,
  },
];
```

Fields: `key`, `label`, `severity` (`critical` shows on every page; `warning`
and `info` on the overview card only), `description` (what stops working),
`remediation` (what to set), and optionally `docsPath`, `productionOnly` (for a
setting development handles another way) and `applicable()` (for a check that
only makes sense on some hosts). Keep `detect` to a presence check: the report
goes to the browser.

## Related

- `.context/admin/orchestration-providers.md` — providers and their keys
- `.context/email/overview.md` — email configuration
- `.context/environment/database-env.md` — pooled connection strings
