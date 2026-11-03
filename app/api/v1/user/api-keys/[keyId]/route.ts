/**
 * User API Key — Revoke
 *
 * DELETE /api/v1/user/api-keys/:keyId
 *
 * Revokes an API key by setting `revokedAt`. The key record is
 * preserved for audit. Users can only revoke their own keys, and only from a
 * browser session — see the refusal below.
 */

import { withAuth } from '@/lib/auth/guards';
import type { AuthSession } from '@/lib/auth/guards';
import { revokeUserApiKey } from '@/lib/auth/user-api-keys';
import { successResponse } from '@/lib/api/responses';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { cuidSchema } from '@/lib/validations/common';

type Params = { keyId: string };

export const DELETE = withAuth<Params>(
  async (request, session: AuthSession, { params }) => {
    // A narrow credential must not manage credentials — the same rule the sibling
    // POST enforces (#542). Guarding minting and leaving revocation open would be
    // half a rule: `GET /api/v1/user/api-keys` returns every key's id, so a
    // leaked `chat`-scoped key could list its owner's keys and revoke all of them,
    // including their `admin` one. That is destructive rather than escalating, and
    // the owner can re-mint from a browser — but it is the same surface, one file
    // away, and a rule that holds on one verb is the kind nobody remembers.
    //
    // No legitimate flow breaks: a headless rotate-and-revoke script needs POST
    // too, which already requires a browser session.
    if (isApiKeySession(session)) {
      const log = await getRouteLogger(request);
      log.warn('Rejected API-key attempt to revoke an API key', { userId: session.user.id });
      throw new ForbiddenError('Revoking an API key requires a browser session');
    }

    const { keyId: rawKeyId } = await params;
    const parsed = cuidSchema.safeParse(rawKeyId);
    if (!parsed.success)
      throw new ValidationError('Invalid key id', { keyId: ['Must be a valid CUID'] });

    // The caller's own key, bound to this org or a platform key of theirs,
    // which lives in no org and is revoked outside it (#1132).
    const outcome = await revokeUserApiKey(session.user.id, parsed.data);
    if (outcome === 'not-found') throw new NotFoundError('API key not found');
    if (outcome === 'already-revoked') {
      return successResponse({ message: 'API key already revoked' });
    }

    return successResponse({ message: 'API key revoked' });
  },
  {
    // Ownership: this route is self-scoped by construction — see RouteOwnership in lib/auth/guards.ts.
    ownership: {
      decidedBy: 'self',
      because:
        'The revoke is one conditional write filtered by `{ id, userId: session.user.id }` (lib/auth/user-api-keys.ts); a platform key, from a browser session in the install org, is revoked under `runAsSystem`, where that filter, with `orgId: null`, is the only fence.',
    },
  }
);
