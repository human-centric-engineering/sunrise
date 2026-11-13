/**
 * Platform config-health registry — the known operationally-critical settings.
 *
 * These are settings that are OPTIONAL in the env schema (`lib/env.ts`) — so the app boots without
 * them — yet silently disable features when missing. The startup-enforced vars (`DATABASE_URL`,
 * `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`) are deliberately NOT listed: the
 * process can't start without them, so at runtime they're never missing.
 *
 * Every `detect` reports presence only — never a secret value (reuse `isApiKeyEnvVarSet` /
 * `!!process.env[...]`). Forks add their own via `lib/app/config-health.ts`.
 */

import { isEmailEnabled } from '@/lib/email/client';
import { listProvidersWithStatus } from '@/lib/orchestration/llm/provider-manager';
import type { ConfigHealthCheck } from '@/lib/config-health/types';

/** Substrings that mark a `DATABASE_URL` as a pooled/transaction-pooler endpoint. */
const POOLER_MARKERS = ['-pooler', ':6543', 'pgbouncer=true'];

export const CONFIG_HEALTH_CHECKS: ConfigHealthCheck[] = [
  {
    key: 'llm_provider',
    label: 'LLM provider',
    severity: 'critical',
    description:
      'No configured AI provider has its API key set, so chat, extraction, and report generation ' +
      'will fail.',
    remediation:
      'Configure a provider under Admin → Orchestration → Providers and set its API-key env var, ' +
      'then redeploy.',
    docsPath: '.context/admin/orchestration-providers.md',
    detect: async (): Promise<boolean> => {
      // Only ACTIVE providers count — a disabled provider throws `provider_disabled` at runtime, so
      // a keyed-but-inactive row must not read as "usable".
      const providers = await listProvidersWithStatus({ where: { isActive: true } });
      return providers.some((p) => p.apiKeyPresent);
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
