/**
 * One provider's key, in an org's own AI keys (§137 t-1045)
 *
 * PUT    /api/v1/orgs/[id]/provider-keys/[providerId] — save a key, or replace
 *        the saved one: `{ apiKey }`. The key is tested first with one cheap
 *        vendor call, and a key that fails is not stored (422
 *        `KEY_TEST_FAILED`). Refused, before any vendor call, while
 *        organisations' own keys are switched off or no master key is
 *        configured, for a provider the org is not approved for, and from a
 *        support session.
 * DELETE /api/v1/orgs/[id]/provider-keys/[providerId] — remove the saved key.
 *        The org's calls on the provider go back to the platform's key, if it
 *        is approved for the provider.
 *
 * Who may call these: see `../route.ts`. Every save, replacement, failed test
 * and removal is audited with the provider and the key's hint, never the key;
 * no response or log line carries it.
 */

import { withAuth } from '@/lib/auth/guards';
import { getRouteLogger } from '@/lib/api/context';
import { APIError, NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  assertActsForOrgKeys,
  assertMaySaveKeys,
  assertKeysCanBeSaved,
  keyStoreFailure,
  loadKeyProvider,
  resolveProviderKeysResource,
  runKeyTest,
} from '@/lib/orchestration/llm/org-provider-key-admin';
import {
  ORG_PROVIDER_KEY_SUMMARY_SELECT,
  orgProviderKeyHint,
  removeOrgProviderKey,
  saveOrgProviderKey,
} from '@/lib/orchestration/llm/org-provider-keys';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse, providerKeyTestLimiter } from '@/lib/security/rate-limit';
import { providerKeyParamsSchema, saveProviderKeySchema } from '@/lib/validations/tenancy';

type Params = { id: string; providerId: string };

const RESOURCE = {
  resource: async (_request: unknown, context?: { params: Promise<Params> }) =>
    resolveProviderKeysResource(await context?.params),
  ownership: {
    decidedBy: 'resource',
    because:
      'The policy admitted the caller to the keys of the org the URL names, and the handler writes that org’s key only, in its own scope.',
  },
} as const;

export const PUT = withAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id, providerId } = validateQueryParams(
    new URLSearchParams(await params),
    providerKeyParamsSchema
  );
  assertActsForOrgKeys(session, id);
  assertMaySaveKeys();
  const { apiKey } = await validateRequestBody(request, saveProviderKeySchema);
  await assertKeysCanBeSaved();
  const config = await loadKeyProvider(providerId);

  const limit = providerKeyTestLimiter.check(`provider-key-test:org:${id}`);
  if (!limit.success) {
    log.warn('Org AI key save rate-limited', { orgId: id, userId: session.user.id });
    return createRateLimitResponse(limit);
  }

  const clientIp = getClientIP(request);
  const hint = orgProviderKeyHint(apiKey);
  const passed = await runKeyTest(config, apiKey, {
    orgId: id,
    userId: session.user.id,
    during: 'save',
  });
  if (!passed) {
    logAdminAction({
      userId: session.user.id,
      action: 'org_provider_key.test',
      entityType: 'org_provider_key',
      entityId: null,
      entityName: config.name,
      metadata: { orgId: id, provider: config.slug, hint, result: 'test_failed', stored: false },
      clientIp,
    });
    throw new APIError(
      `${config.name} did not accept this key, or could not be reached. It has not been saved. Check that the key is right and is for ${config.name}.`,
      'KEY_TEST_FAILED',
      422,
      { reason: 'test_failed' }
    );
  }

  let saved;
  try {
    saved = await saveOrgProviderKey({
      providerConfigId: providerId,
      apiKey,
      savedById: session.user.id,
    });
  } catch (err) {
    throw keyStoreFailure(err, 'save', {
      orgId: id,
      provider: config.slug,
      userId: session.user.id,
    });
  }

  // A replaced key keeps its row and its version rises; a first key is version 1.
  const replaced = saved.version > 1;
  logAdminAction({
    userId: session.user.id,
    action: replaced ? 'org_provider_key.rotate' : 'org_provider_key.save',
    entityType: 'org_provider_key',
    entityId: saved.id,
    entityName: config.name,
    metadata: {
      orgId: id,
      provider: config.slug,
      hint: saved.hint,
      version: saved.version,
      result: 'passed',
    },
    clientIp,
  });
  log.info(replaced ? 'Org AI key replaced' : 'Org AI key saved', {
    orgId: id,
    provider: config.slug,
    keyId: saved.id,
    version: saved.version,
    userId: session.user.id,
  });

  return successResponse(
    {
      providerConfigId: providerId,
      replaced,
      key: { hint: saved.hint, version: saved.version, savedAt: saved.savedAt },
    },
    undefined,
    { status: replaced ? 200 : 201 }
  );
}, RESOURCE);

export const DELETE = withAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id, providerId } = validateQueryParams(
    new URLSearchParams(await params),
    providerKeyParamsSchema
  );
  assertActsForOrgKeys(session, id);

  let existing;
  let removed: boolean;
  try {
    existing = await prisma.aiOrgProviderKey.findUnique({
      where: { orgId_providerConfigId: { orgId: id, providerConfigId: providerId } },
      select: {
        ...ORG_PROVIDER_KEY_SUMMARY_SELECT,
        providerConfig: { select: { name: true, slug: true } },
      },
    });
    removed = existing ? await removeOrgProviderKey(providerId) : false;
  } catch (err) {
    throw keyStoreFailure(err, 'remove', {
      orgId: id,
      providerConfigId: providerId,
      userId: session.user.id,
    });
  }
  if (!existing || !removed)
    throw new NotFoundError('This organisation has no key saved for that provider');

  logAdminAction({
    userId: session.user.id,
    action: 'org_provider_key.remove',
    entityType: 'org_provider_key',
    entityId: existing.id,
    entityName: existing.providerConfig.name,
    metadata: {
      orgId: id,
      provider: existing.providerConfig.slug,
      hint: existing.hint,
      version: existing.version,
    },
    clientIp: getClientIP(request),
  });
  log.info('Org AI key removed', {
    orgId: id,
    provider: existing.providerConfig.slug,
    keyId: existing.id,
    userId: session.user.id,
  });

  return successResponse({ providerConfigId: providerId, removed: true });
}, RESOURCE);
