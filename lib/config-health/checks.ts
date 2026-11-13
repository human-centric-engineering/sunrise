/**
 * Platform config-health registry — the known operationally-critical settings.
 *
 * These are settings that are OPTIONAL in the env schema (`lib/env.ts`) — so the app boots without
 * them — yet silently disable features when missing. The startup-enforced vars (`DATABASE_URL`,
 * `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`) are deliberately NOT listed: the
 * process can't start without them, so at runtime they're never missing.
 *
 * Every `detect` reports presence only — never a secret value. For a plain env var,
 * `!!process.env[...]`; for anything about a provider row, the credential seam
 * (`hasProviderCredential` / `filterProvidersWithCredential` in
 * `lib/orchestration/llm/provider-credentials.ts`), never `isApiKeyEnvVarSet`: a fork's
 * resolver may leave the env var deliberately empty. Forks add their own checks via
 * `lib/app/config-health.ts`.
 */

import { isEmailEnabled } from '@/lib/email/client';
import { prisma } from '@/lib/db/client';
import { filterProvidersWithCredential } from '@/lib/orchestration/llm/provider-credentials';
import type { ConfigHealthCheck } from '@/lib/config-health/types';

/**
 * Substrings that mark a `DATABASE_URL` as going through a pooler: Neon's
 * `-pooler` host, Supabase's `.pooler.` host (session mode on 5432 as well as
 * transaction mode on 6543), PgBouncer's flag in either spelling, and Prisma
 * Accelerate / Prisma Postgres, which pool on their side.
 */
const POOLER_MARKERS = [
  '-pooler',
  '.pooler.',
  ':6543',
  'pgbouncer=true',
  'pgbouncer=1',
  'prisma://',
  'prisma+postgres://',
];

export const CONFIG_HEALTH_CHECKS: ConfigHealthCheck[] = [
  {
    key: 'llm_provider',
    label: 'LLM provider',
    severity: 'critical',
    description:
      'No active AI provider can be reached (a key set, or a local provider), so chat, ' +
      'extraction, and report generation will fail.',
    remediation:
      'Configure a provider under Admin → Orchestration → Providers and set its API-key env var, ' +
      'then redeploy.',
    docsPath: '.context/admin/orchestration-providers.md',
    detect: async (): Promise<boolean> => {
      // Only ACTIVE providers count — a disabled provider throws `provider_disabled` at runtime, so
      // a keyed-but-inactive row must not read as "usable". Reachable is core's own rule: a key
      // through the credential seam, or a local provider, which needs none.
      const providers = await prisma.aiProviderConfig.findMany({ where: { isActive: true } });
      return (await filterProvidersWithCredential(providers)).length > 0;
    },
  },
  {
    key: 'email',
    label: 'Transactional email',
    severity: 'warning',
    description:
      'Email is not configured, so invitations, email verification, and report-ready ' +
      'notifications will not be sent.',
    remediation: 'Set RESEND_API_KEY and EMAIL_FROM.',
    docsPath: '.context/email/overview.md',
    detect: isEmailEnabled,
  },
  {
    key: 'db_pooler',
    label: 'Pooled database connection (serverless)',
    severity: 'warning',
    // Only meaningful on serverless — a long-running server wants a direct connection.
    applicable: () => !!process.env.VERCEL,
    description:
      'Running on Vercel but DATABASE_URL does not look like a pooled endpoint. A direct connection ' +
      'exhausts Postgres under serverless fan-out.',
    remediation:
      'Point DATABASE_URL at a pooled endpoint (Neon -pooler / Supabase :6543 / Vercel ' +
      'POSTGRES_PRISMA_URL).',
    docsPath: '.context/environment/database-env.md',
    detect: (): boolean => {
      const url = process.env.DATABASE_URL ?? '';
      return POOLER_MARKERS.some((marker) => url.includes(marker));
    },
  },
];
