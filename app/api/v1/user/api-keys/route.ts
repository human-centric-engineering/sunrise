/**
 * User API Keys — List + Create
 *
 * GET  /api/v1/user/api-keys — List the current user's API keys
 * POST /api/v1/user/api-keys — Generate a new API key
 *
 * Self-service key management. Keys are scoped — `chat`, `analytics`,
 * `knowledge`, `webhook`, `admin`, plus whatever a fork declared in
 * `lib/app/api-key-scopes.ts` — and the raw key is returned only once at
 * creation. `GET` also reports the scopes this install can mint, so a caller
 * does not have to guess from a 400.
 */

import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ForbiddenError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { createApiKeySchema } from '@/lib/validations/orchestration';
import {
  generateApiKey,
  hashApiKey,
  keyPrefix,
  isApiKeySession,
  listValidApiKeyScopes,
} from '@/lib/auth/api-keys';
import { getRouteLogger } from '@/lib/api/context';
import { isPlatformAdmin } from '@/lib/auth/roles';

export const GET = withAuth(async (_request, session) => {
  const keys = await prisma.aiApiKey.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      scopes: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });

  return successResponse({ keys, availableScopes: listValidApiKeyScopes() });
});

export const POST = withAuth(async (request, session) => {
  // Minting a credential over a credential is privilege laundering: a key
  // scoped to one narrow job could mint a `chat` key and reach every
  // authenticated route as its owner, so the narrow scope it was issued with
  // would bound nothing. Least privilege that can self-escalate is not least
  // privilege — which is the whole argument of #542, so it is fixed alongside
  // the seam rather than after it.
  //
  // Same refusal, and the same reasoning, as `PATCH /api/v1/users/me` (email)
  // and `GET /api/v1/users/me/export`. Browser session required.
  if (isApiKeySession(session)) {
    const log = await getRouteLogger(request);
    log.warn('Rejected API-key attempt to mint another API key', { userId: session.user.id });
    throw new ForbiddenError('Creating an API key requires a browser session');
  }

  const body = await validateRequestBody(request, createApiKeySchema);

  // PLATFORM standing, deliberately NOT the authorization policy.
  //
  // An `admin`-scoped key satisfies every scope and bypasses the role check in
  // `withAdminAuth` entirely — the scope IS the capability there. That makes it
  // cross-tenant by construction, which is why the design record pins it as
  // platform-only (Q6, `.context/architecture/multi-tenancy-design.md`).
  //
  // So this asks `isPlatformAdmin` rather than `canAdminister`. A fork whose
  // policy lets an org admin administer their own org must not thereby let them
  // mint a credential that reaches every org's admin routes — routing this
  // through the seam would do exactly that, quietly, the day the fork widened
  // its policy for an unrelated reason.
  //
  // What is NOT enforced here, because it cannot be yet: keys carry no org, so
  // "an org-bound key can never hold `admin`" arrives with the org axis (§106),
  // not with this line.
  if (body.scopes.includes('admin') && !isPlatformAdmin(session.user)) {
    throw new ForbiddenError('Admin scope requires admin role');
  }

  const rawKey = generateApiKey();
  const hash = hashApiKey(rawKey);
  const prefix = keyPrefix(rawKey);

  const apiKey = await prisma.aiApiKey.create({
    data: {
      userId: session.user.id,
      name: body.name,
      keyHash: hash,
      keyPrefix: prefix,
      scopes: body.scopes,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      scopes: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  // Return the raw key exactly once — it cannot be retrieved again
  return successResponse(
    {
      key: {
        ...apiKey,
        rawKey,
      },
    },
    undefined,
    { status: 201 }
  );
});
