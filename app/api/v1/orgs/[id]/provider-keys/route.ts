/**
 * An org's own AI keys (§137 t-1045)
 *
 * GET /api/v1/orgs/[id]/provider-keys — every provider the org can hold a key
 *     for, each with its saved key's hint, when and by whom it was saved, and
 *     its state: in use, switched off, provider not approved, or will not
 *     open. Never the key.
 *
 * Who may call it is the authorization policy's decision, about the resource
 * `{ kind: 'org.providerKeys', id, orgId }`: by default the org's OWNER and
 * ADMIN while they act in it. On top of the policy the caller must be acting
 * in this org, with a browser session, and not in the install org
 * (`lib/orchestration/llm/org-provider-key-admin.ts`). A support session may
 * read it.
 */

import { withAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { orgIdParamSchema } from '@/lib/validations/tenancy';
import {
  assertActsForOrgKeys,
  keyStoreFailure,
  providerKeysView,
  resolveProviderKeysResource,
} from '@/lib/orchestration/llm/org-provider-key-admin';

const RESOURCE = {
  resource: async (_request: unknown, context?: { params: Promise<{ id: string }> }) =>
    resolveProviderKeysResource(await context?.params),
  ownership: {
    decidedBy: 'resource',
    because:
      'The policy admitted the caller to the keys of the org the URL names, and the handler reads that org’s keys only, in its own scope.',
  },
} as const;

export const GET = withAuth<{ id: string }>(async (_request, session, { params }) => {
  const { id } = validateQueryParams(new URLSearchParams(await params), orgIdParamSchema);
  assertActsForOrgKeys(session, id);

  try {
    return successResponse({ orgId: id, ...(await providerKeysView()) });
  } catch (err) {
    throw keyStoreFailure(err, 'read', { orgId: id, userId: session.user.id });
  }
}, RESOURCE);
