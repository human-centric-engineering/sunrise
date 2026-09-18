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
 * does not have to guess from a 400. A key is bound to the org the request
 * was made in (§106); an `admin` key is a platform credential and bound to
 * none.
 */

import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ForbiddenError, ValidationError } from '@/lib/api/errors';
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
import { orgForMint } from '@/lib/tenancy/entry';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

export const GET = withAuth(
  async (_request, session) => {
    const keys = await prisma.aiApiKey.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        orgId: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });

    return successResponse({ keys, availableScopes: listValidApiKeyScopes() });
  },
  {
    // Ownership: this route is self-scoped by construction — see RouteOwnership in lib/auth/guards.ts.
    ownership: {
      decidedBy: 'self',
      because:
        'Lists keys by `where.userId = session.user.id`; a caller cannot name another owner.',
    },
  }
);

export const POST = withAuth(
  async (request, session) => {
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
    if (body.scopes.includes('admin') && !isPlatformAdmin(session.user)) {
      throw new ForbiddenError('Admin scope requires admin role');
    }

    // The org axis (§106, t-673). An `admin` key is a platform credential and
    // binds no org — the guards enter none for it — so "an org-bound key can
    // never hold `admin`" is enforced here at mint, and `withAdminAuth` refuses
    // any row that has both. The intent behind the request is the org it was
    // made from: minting an admin key while acting in a customer org would
    // hand back a credential that reaches every org from a screen that says
    // one, so that is a 400 — mint platform keys from the install org. Every
    // other key binds the org the request entered.
    const mintOrgId = orgForMint();
    const platformKey = body.scopes.includes('admin');
    if (platformKey && mintOrgId !== INSTALL_ORG_ID) {
      throw new ValidationError(
        'Admin keys are platform credentials; mint one from the default organisation',
        {
          scopes: ['admin scope cannot be bound to an organisation'],
        }
      );
    }
    const orgId = platformKey ? null : mintOrgId;

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
        orgId,
      },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        orgId: true,
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
  },
  {
    // Ownership: this route is self-scoped by construction — see RouteOwnership in lib/auth/guards.ts.
    ownership: {
      decidedBy: 'self',
      because:
        'Mints a key owned by the caller — `userId` is taken from the session, never from the body.',
    },
  }
);
