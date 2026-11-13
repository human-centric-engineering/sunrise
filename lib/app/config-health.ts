/**
 * App config-health checks.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its value).
 *
 * Auto-wired: `lib/config-health/run.ts` adds these after Sunrise's own checks
 * (`lib/config-health/checks.ts`: LLM provider key, email, a pooled database on
 * serverless). The report drives the config-health card on the admin overview
 * and the critical-only banner on every admin page, for platform admins.
 *
 * List the settings your app needs that the env schema leaves optional, so the
 * app boots without them but a feature quietly stops. For example:
 *
 *   export const appConfigHealthChecks: ConfigHealthCheck[] = [
 *     { key: 'STRIPE_SECRET_KEY', label: 'Stripe', severity: 'critical',
 *       description: 'Billing is off without it.', remediation: 'Set STRIPE_SECRET_KEY.',
 *       detect: () => !!process.env.STRIPE_SECRET_KEY },
 *   ];
 *
 * `detect` reports presence only, never a value: the report goes to the
 * browser. Server-only.
 *
 * Full guide: .context/admin/config-health.md · CUSTOMIZATION.md §4
 */
import type { ConfigHealthCheck } from '@/lib/config-health/types';

export const appConfigHealthChecks: ConfigHealthCheck[] = [];
