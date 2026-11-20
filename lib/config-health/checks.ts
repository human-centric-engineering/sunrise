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
import { confidentialModelProblem } from '@/lib/orchestration/llm/confidential-route';
import { classifyProvidersByCredential } from '@/lib/orchestration/llm/provider-credentials';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { retiringModelsInUse } from '@/lib/orchestration/model-lifecycle/uses';
import { isSealedSecretKeyConfigured } from '@/lib/security/sealed-secrets';
import { isMultiTenant } from '@/lib/tenancy/context';
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
      'Under Admin → Orchestration → Providers, make sure a provider is active and has its key ' +
      '(its API-key env var, or your credential resolver), or add a local one.',
    docsPath: '.context/admin/orchestration-providers.md',
    detect: async (): Promise<boolean> => {
      // Only ACTIVE providers count — a disabled provider throws `provider_disabled` at runtime, so
      // a keyed-but-inactive row must not read as "usable". Reachable is core's own rule: a key
      // through the credential seam, or a local provider, which needs none.
      const providers = await prisma.aiProviderConfig.findMany({
        where: { isActive: true },
        // Only what the credential seam reads.
        select: {
          id: true,
          slug: true,
          name: true,
          providerType: true,
          apiKeyEnvVar: true,
          isLocal: true,
        },
      });
      const { reachable, unavailable } = await classifyProvidersByCredential(providers);
      if (reachable.length > 0) return true;
      // Nothing reachable because the resolver failed is not a missing key: the
      // check could not tell, so it throws and the runner reports it as failed.
      if (unavailable.length > 0) {
        throw new Error(`credential resolver failed for ${unavailable.length} active provider(s)`);
      }
      return false;
    },
  },
  {
    key: 'confidential_model',
    label: 'Model for confidential messages',
    severity: 'warning',
    description:
      'A confidential-content policy sends some messages only to local or trusted providers, and ' +
      'no usable model for confidential messages is set, so such a message is refused on an agent ' +
      'whose provider is neither, rather than answered.',
    remediation:
      'Under Admin → Orchestration → Settings → LLM privacy, choose a model for confidential ' +
      'messages: a chat model on a local provider, or on one ticked "Trusted with confidential ' +
      'content". Leave it unset only if refusing those messages is what you want.',
    docsPath: '.context/privacy/llm-privacy-layer.md',
    // Satisfied unless a policy that moves conversations is in force, here or
    // on an agent, and the model it would move them to is missing or unusable
    // (§130 t-1038). An agent already on a local or trusted provider never
    // moves, but the policy says confidential content may arrive, so the
    // check asks about the policy rather than each agent's provider.
    detect: async (): Promise<boolean> => {
      const moving = ['approved_only', 'local_only'];
      const settings = await getOrchestrationSettings();
      const strict =
        moving.includes(settings.privacyConfidentialPersonal) ||
        moving.includes(settings.privacyConfidentialCommercial) ||
        (await prisma.aiAgent.findFirst({
          // A deactivated agent answers nothing, so needs no model.
          where: {
            isActive: true,
            OR: [
              { privacyConfidentialPersonal: { in: moving } },
              { privacyConfidentialCommercial: { in: moving } },
            ],
          },
          select: { id: true },
        })) !== null;
      if (!strict) return true;
      return (
        settings.confidentialModel !== null &&
        (await confidentialModelProblem(settings.confidentialModel)) === null
      );
    },
  },
  {
    key: 'org_provider_keys_master_key',
    label: "Master key for organisations' own AI keys",
    severity: 'critical',
    // Only multi reads orgs' keys: at single the one org's key is the install's.
    applicable: () => isMultiTenant(),
    description:
      "Organisations' own AI keys are switched on, and no master key to open them is configured, " +
      'so every AI call from an organisation that has saved its own key is refused.',
    remediation:
      'Configure SEALED_SECRET_KEYS and SEALED_SECRET_ACTIVE_KEY with the master key the saved ' +
      'keys were sealed under. If it is lost, those organisations must save their keys again.',
    docsPath: '.context/security/sealed-secrets.md',
    // §137 t-1044. Satisfied while the switch is off: then nothing needs it.
    detect: async (): Promise<boolean> => {
      const settings = await getOrchestrationSettings();
      return !settings.orgProviderKeysEnabled || isSealedSecretKeyConfigured();
    },
  },
  {
    key: 'retired_model_in_use',
    label: 'Retired AI model still in use',
    severity: 'critical',
    description:
      'A model its provider has retired is still used by an agent, a workflow, a default ' +
      "setting or the app's own code, so calls to it fail.",
    remediation:
      'Under Admin → Orchestration → Providers → Models, open each model marked Retired: it lists ' +
      'what still uses it. Move those to its replacement, or to another model. A default shown as ' +
      "the system's suggestion is fixed by saving a default under Settings.",
    docsPath: '.context/orchestration/llm-providers.md',
    // §136 t-1065. Counts every org's agents and workflows: the catalogue is
    // shared, so a retired model one org still uses is the operator's to see.
    // And the app's own uses (§136 t-1067); a failed report of them makes
    // this check unable to run, never an alert.
    detect: async (): Promise<boolean> => (await retiringModelsInUse()).retired === 0,
  },
  {
    key: 'retiring_model_in_use',
    label: 'Retiring AI model in use',
    severity: 'warning',
    description:
      'A model its provider is about to retire is still used by an agent, a workflow, a default ' +
      "setting or the app's own code. It works until its retirement day, then calls to it fail.",
    remediation:
      'Under Admin → Orchestration → Providers → Models, open each model marked Retiring: it lists ' +
      'what uses it and its replacement. Move those before the day.',
    docsPath: '.context/orchestration/llm-providers.md',
    detect: async (): Promise<boolean> => (await retiringModelsInUse()).retiring === 0,
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
