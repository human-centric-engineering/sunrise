/**
 * Test an org's saved AI key (§137 t-1045)
 *
 * POST /api/v1/orgs/[id]/provider-keys/[providerId]/test — re-check the saved
 *      key with one cheap vendor call. Answers `{ ok, reason? }` with 200
 *      whether the key passed or not: `test_failed` (the vendor refused it or
 *      could not be reached) or `will_not_open` (the stored key cannot be
 *      opened, so it must be saved again). 404 when no key is saved; refused,
 *      as a save is, for a provider the org is not approved for.
 *
 * Runs whether or not organisations' own keys are switched on, so an admin
 * can check a key before the switch is turned back on. A support session may
 * test (a READ_ONLY grant refuses it, as every write). Who may call it: see
 * `../../route.ts`. Audited with the result, the provider and the key's hint.
 */

import { withAuth } from '@/lib/auth/guards';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  assertActsForOrgKeys,
  keyStoreFailure,
  loadKeyProvider,
  providerKeysGuard,
  runKeyTest,
} from '@/lib/orchestration/llm/org-provider-key-admin';
import { openOrgProviderKey } from '@/lib/orchestration/llm/org-provider-keys';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse, providerKeyTestLimiter } from '@/lib/security/rate-limit';
import { providerKeyParamsSchema } from '@/lib/validations/tenancy';

type Params = { id: string; providerId: string };

const RESOURCE = providerKeysGuard<Params>(
  'The policy admitted the caller to the keys of the org the URL names, and the handler opens that org’s key only, in its own scope.'
);

export const POST = withAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id, providerId } = validateQueryParams(
    new URLSearchParams(await params),
    providerKeyParamsSchema
  );
  assertActsForOrgKeys(session, id);
  const config = await loadKeyProvider(providerId);

  const limit = providerKeyTestLimiter.check(`provider-key-test:org:${id}`);
  if (!limit.success) {
    log.warn('Org AI key test rate-limited', { orgId: id, userId: session.user.id });
    return createRateLimitResponse(limit);
  }

  let opened;
  try {
    opened = await openOrgProviderKey(providerId);
  } catch (err) {
    throw keyStoreFailure(err, 'test', {
      orgId: id,
      provider: config.slug,
      userId: session.user.id,
    });
  }
  if (!opened) throw new NotFoundError('This organisation has no key saved for that provider');

  const ok =
    opened.apiKey !== null &&
    (await runKeyTest(config, opened.apiKey, {
      orgId: id,
      userId: session.user.id,
      during: 'test',
    }));
  const reason = ok ? undefined : opened.apiKey === null ? 'will_not_open' : 'test_failed';

  logAdminAction({
    userId: session.user.id,
    action: 'org_provider_key.test',
    entityType: 'org_provider_key',
    entityId: opened.summary.id,
    entityName: config.name,
    metadata: {
      orgId: id,
      provider: config.slug,
      hint: opened.summary.hint,
      version: opened.summary.version,
      result: ok ? 'passed' : reason,
    },
    clientIp: getClientIP(request),
  });
  log.info('Org AI key tested', {
    orgId: id,
    provider: config.slug,
    ok,
    reason,
    userId: session.user.id,
  });

  return successResponse({ providerConfigId: providerId, ok, ...(reason ? { reason } : {}) });
}, RESOURCE);
