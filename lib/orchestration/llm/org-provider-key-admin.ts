/**
 * What the org-tier routes over an org's own AI keys share (§137 t-1045):
 * who may act, which provider rows take a key, the test call, and the view
 * the page is drawn from.
 *
 * ## Who may act
 *
 * The authorization policy decides, as its own resource kind
 * ({@link PROVIDER_KEYS_RESOURCE_KIND}): every route hands the guard
 * `{ kind: 'org.providerKeys', id, orgId }`, and Sunrise's default policy
 * admits the org's OWNER and ADMIN while they act in it, as it does for the
 * members routes. A fork with roles of its own (a billing admin, say) answers
 * that kind in its policy, and these routes follow without being touched.
 *
 * Three rules sit on top of the policy, because no policy should be able to
 * widen them:
 *
 * - **Acting in the org.** The caller must be acting in the org the URL
 *   names. The default policy admits a platform admin to every org; here that
 *   admits them to their own org's keys only. Platform staff reach a
 *   customer's keys through a support session, which enters the org.
 * - **A browser session.** No API-key scope means "manage the org's keys".
 * - **Support sessions see, and do not save.** A support session may read
 *   the keys' state, test a saved key and remove one, but cannot save or
 *   replace a key: the vendor's staff do not handle a customer's secret.
 *
 * The install org is refused: its calls run on the install's own keys, which
 * are set where the providers are configured. So is every verb at `single`,
 * where no org's key is ever used.
 *
 * ## The key never leaves the server
 *
 * No response or log line carries it. The vendor's error from a failed test
 * can repeat it, so the browser is told only that the test failed, and the
 * log has the whole key cut out; a vendor's own masked echo (a prefix and the
 * last four) is left, which is no more than the hint shows.
 *
 * @see lib/orchestration/llm/org-provider-keys.ts — the store and the call path
 * @see .context/orchestration/llm-providers.md — Organisations' own keys
 */

import { APIError, ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { isSupportEntry } from '@/lib/auth/support-principal';
import type { AuthenticatedSession } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { applyOrgProviderPolicy } from '@/lib/orchestration/llm/org-provider-policy';
import {
  describeError,
  orgProviderKeyStatuses,
  type OrgProviderKeyState,
} from '@/lib/orchestration/llm/org-provider-keys';
import { testProviderKey } from '@/lib/orchestration/llm/provider-manager';
import { buildsLocalClient } from '@/lib/orchestration/llm/provider-locality';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import {
  isSealedSecretKeyConfigured,
  SealedSecretKeyMissingError,
} from '@/lib/security/sealed-secrets';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { getTenantContext, isMultiTenant } from '@/lib/tenancy/context';
import { resolveOrgResource } from '@/lib/tenancy/lifecycle';
import type { AiProviderConfig } from '@/types/prisma';

/** The resource kind the policy is asked about for every route over an org's own keys. */
export const PROVIDER_KEYS_RESOURCE_KIND = 'org.providerKeys';

/** The resource the routes hand the guard: the org the URL names, as its keys. */
export async function resolveProviderKeysResource(
  params: unknown
): Promise<{ kind: typeof PROVIDER_KEYS_RESOURCE_KIND; id: string; orgId: string } | null> {
  const org = await resolveOrgResource(params);
  return org ? { kind: PROVIDER_KEYS_RESOURCE_KIND, id: org.id, orgId: org.orgId } : null;
}

/**
 * The guard options every route over an org's own keys passes: the resource
 * above, and the ownership claim, with the route's own reason.
 */
export function providerKeysGuard<TParams>(because: string): ProviderKeysGuard<TParams> {
  return {
    resource: async (_request, context) => resolveProviderKeysResource(await context?.params),
    ownership: { decidedBy: 'resource', because },
  };
}

/** What {@link providerKeysGuard} returns: `withAuth`'s `resource` and `ownership` options. */
export interface ProviderKeysGuard<TParams> {
  resource: (
    request: unknown,
    context?: { params: Promise<TParams> }
  ) => ReturnType<typeof resolveProviderKeysResource>;
  ownership: { decidedBy: 'resource'; because: string };
}

/** Whether this request runs in a support session (§121). */
export function inSupportSession(): boolean {
  return isSupportEntry(getTenantContext());
}

/**
 * Refuse a caller the policy admitted who may still not act on this org's
 * keys: on an install with one organisation (where no org's key is ever
 * used), an API key, someone not acting in the org, or anyone in the install
 * org. See the module header.
 */
export function assertActsForOrgKeys(session: AuthenticatedSession, orgId: string): void {
  if (!isMultiTenant()) {
    throw new ConflictError(
      'Organisations’ own AI keys are for installs with more than one organisation',
      { reason: 'single_tenant' }
    );
  }
  if (isApiKeySession(session)) {
    throw new ForbiddenError('Managing an organisation’s AI keys requires a browser session');
  }
  if (session.principal.orgId !== orgId) {
    throw new ForbiddenError('Switch to this organisation to manage its AI keys');
  }
  if (orgId === INSTALL_ORG_ID) {
    throw new ConflictError(
      'The install organisation runs on the platform’s own keys, which are set where providers are configured',
      { reason: 'install_org' }
    );
  }
}

/** Refuse a save or a replacement from a support session. */
export function assertMaySaveKeys(): void {
  if (inSupportSession()) {
    throw new ForbiddenError('Support staff cannot save or replace an organisation’s AI keys');
  }
}

/**
 * The provider row a key is for, if an org may hold one for it: active, not
 * local (a local provider takes no key), and approved for the org in scope.
 *
 * @throws NotFoundError for a row that is missing, inactive or local;
 *   ConflictError (`not_approved`) for one the org is not approved for.
 */
export async function loadKeyProvider(providerConfigId: string): Promise<AiProviderConfig> {
  const config = await prisma.aiProviderConfig.findUnique({ where: { id: providerConfigId } });
  if (!config || !config.isActive || buildsLocalClient(config)) {
    throw new NotFoundError('No provider this organisation can hold a key for');
  }
  const permitted = await applyOrgProviderPolicy([config.slug]);
  if (!permitted.includes(config.slug)) {
    throw new ConflictError(
      `This organisation is not approved to use ${config.name}. Platform staff approve providers.`,
      { reason: 'not_approved' }
    );
  }
  return config;
}

/**
 * Refuse a save that could not end in a usable key, before any vendor call:
 * while organisations' own keys are switched off (a key saved then would
 * refuse every one of the org's calls on the provider), and while no master
 * key is configured (it could not be sealed).
 */
export async function assertKeysCanBeSaved(): Promise<void> {
  const settings = await getOrchestrationSettings();
  if (!settings.orgProviderKeysEnabled) {
    throw new ConflictError(
      'Organisations’ own AI keys are switched off on this platform, so a key cannot be saved',
      { reason: 'switched_off' }
    );
  }
  if (!isSealedSecretKeyConfigured()) {
    throw keyStoreFailure(new SealedSecretKeyMissingError(), 'save', {});
  }
}

/**
 * Test `apiKey` against `config` with one cheap vendor call. The vendor's
 * message is never returned. It is logged with the whole key cut out; a
 * vendor's own masked echo of it (a prefix and the last four, say) is left,
 * as the hint already shows the last four.
 */
export async function runKeyTest(
  config: AiProviderConfig,
  apiKey: string,
  context: { orgId: string; userId: string; during: 'save' | 'test' }
): Promise<boolean> {
  let ok: boolean;
  let detail: string | undefined;
  try {
    const result = await testProviderKey(config, apiKey);
    ok = result.ok;
    detail = result.error;
  } catch (err) {
    ok = false;
    detail = err instanceof Error ? err.message : String(err);
  }
  if (!ok) {
    logger.warn('An org’s AI key failed its test call', {
      provider: config.slug,
      orgId: context.orgId,
      userId: context.userId,
      during: context.during,
      ...(detail ? { detail: withoutKey(detail, apiKey) } : {}),
    });
  }
  return ok;
}

/** `text` with every occurrence of `apiKey` replaced. */
export function withoutKey(text: string, apiKey: string): string {
  return apiKey.length === 0 ? text : text.split(apiKey).join('[key]');
}

const PAST = { save: 'saved', remove: 'removed', read: 'read', test: 'tested' } as const;

/**
 * Turn a failed read or write of the key store into the error the route
 * throws, logging the error's name and code only. A database error's message
 * can repeat the query's arguments, the sealed key among them, so it is
 * neither logged nor returned (the API's error handler would do both).
 */
export function keyStoreFailure(
  err: unknown,
  what: keyof typeof PAST,
  context: Record<string, unknown>
): APIError {
  if (err instanceof APIError) return err;
  if (err instanceof SealedSecretKeyMissingError) {
    return new ConflictError(
      'The platform has nowhere to keep AI keys safely yet. Platform staff need to configure it.',
      { reason: 'master_key_missing' }
    );
  }
  logger.error(`Could not ${what} an org’s AI key`, undefined, {
    ...context,
    error: describeError(err),
  });
  return new APIError(`The key could not be ${PAST[what]}. Try again.`, 'INTERNAL_ERROR', 500);
}

/** What the page and the list route show for one provider an org can hold a key for. */
export interface ProviderKeyView {
  providerConfigId: string;
  name: string;
  slug: string;
  /** Whether the org is approved for the provider. A saved key for one it is not is shown as `not_approved`. */
  approved: boolean;
  /**
   * Whether a key can be saved or tested for the row: it is active and not
   * local. False only for a row the org already holds a key for, listed so
   * the key can be seen and removed.
   */
  takesKey: boolean;
  key: {
    hint: string;
    version: number;
    savedAt: Date;
    savedBy: { id: string; name: string } | null;
    state: OrgProviderKeyState;
  } | null;
}

/** Why the viewer cannot save a key here, or `null` when they can. */
export type SaveBlocked = 'switched_off' | 'master_key_missing' | 'support_session' | null;

export interface ProviderKeysView {
  /** Whether organisations' own keys are switched on for the install. */
  switchedOn: boolean;
  saveBlocked: SaveBlocked;
  providers: ProviderKeyView[];
}

/**
 * The org-in-scope's view: every active, non-local provider it is approved
 * for, and every provider it holds a key for whatever has become of the row
 * since (switched off, or now local), so the key can still be seen and
 * removed. Each with the key's state.
 */
export async function providerKeysView(): Promise<ProviderKeysView> {
  const [settings, statuses] = await Promise.all([
    getOrchestrationSettings(),
    orgProviderKeyStatuses(),
  ]);
  const keyed = statuses.map((status) => status.providerConfigId);
  const saverIds = [
    ...new Set(statuses.flatMap((status) => (status.savedById ? [status.savedById] : []))),
  ];
  const [rows, savers] = await Promise.all([
    prisma.aiProviderConfig.findMany({
      where: { OR: [{ isActive: true }, { id: { in: keyed } }] },
      select: {
        id: true,
        name: true,
        slug: true,
        isLocal: true,
        isActive: true,
        providerType: true,
      },
      orderBy: { name: 'asc' },
    }),
    saverIds.length === 0
      ? []
      : prisma.user.findMany({ where: { id: { in: saverIds } }, select: { id: true, name: true } }),
  ]);
  const takesKey = (row: (typeof rows)[number]) => row.isActive && !buildsLocalClient(row);
  const byProvider = new Map(statuses.map((status) => [status.providerConfigId, status]));
  const listed = rows.filter((row) => takesKey(row) || byProvider.has(row.id));
  const approved = new Set(await applyOrgProviderPolicy(listed.map((row) => row.slug)));
  const saverById = new Map(savers.map((user) => [user.id, user]));

  const providers = listed
    .filter((row) => approved.has(row.slug) || byProvider.has(row.id))
    .map((row): ProviderKeyView => {
      const status = byProvider.get(row.id);
      return {
        providerConfigId: row.id,
        name: row.name,
        slug: row.slug,
        approved: approved.has(row.slug),
        takesKey: takesKey(row),
        key: status
          ? {
              hint: status.hint,
              version: status.version,
              savedAt: status.savedAt,
              savedBy: status.savedById ? (saverById.get(status.savedById) ?? null) : null,
              state: status.state,
            }
          : null,
      };
    });

  const saveBlocked: SaveBlocked = !settings.orgProviderKeysEnabled
    ? 'switched_off'
    : !isSealedSecretKeyConfigured()
      ? 'master_key_missing'
      : inSupportSession()
        ? 'support_session'
        : null;

  return { switchedOn: settings.orgProviderKeysEnabled, saveBlocked, providers };
}
