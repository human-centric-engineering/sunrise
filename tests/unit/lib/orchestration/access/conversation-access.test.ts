/**
 * Tests for `lib/orchestration/access/conversation-access.ts`.
 *
 * The helper is the single point at which "can this admin view this
 * conversation?" is decided. Getting it wrong has direct privacy
 * implications, so we test every combination of (owner / non-owner) ×
 * (no share / active share / expired share / revoked share) plus the
 * missing-conversation path.
 *
 * **Every case below predates t-686 and every expectation is unchanged.** The
 * only edit was the second argument: the helper takes the session now, because
 * the `'system'` arm asks the authorization policy. `sessionFor(id)` defaults
 * to a policy that permits unattributed reads, which is what a default install
 * does — so these cases assert exactly what they asserted before.
 *
 * What is new sits below them: the narrowed-policy branch, and
 * `conversationVisibilityWhere`, which did not exist. The two faces are pinned
 * against each other here because nothing mechanical catches a list and a
 * detail route disagreeing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: {
      findUnique: vi.fn(),
    },
  },
}));

const { prisma } = await import('@/lib/db/client');
const { adminCanViewConversation, conversationVisibilityWhere, isShareActive } =
  await import('@/lib/orchestration/access/conversation-access');
type AuthenticatedSession = import('@/lib/auth/guards').AuthenticatedSession;

const findUnique = prisma.aiConversation.findUnique as ReturnType<typeof vi.fn>;

const ADMIN_ID = 'admin-1';
const OWNER_ID = 'user-1';
const CONV_ID = 'conv-1';

/**
 * Enough of an `AuthenticatedSession` for this module.
 *
 * `unattributedReads.conversation` is the policy's answer, resolved by the
 * guard before the handler ran. Defaulted to `true` so the pre-existing cases
 * describe a default install unchanged; the narrowed branch passes `false`.
 */
function sessionFor(userId: string, mayReadUnowned = true): AuthenticatedSession {
  return {
    user: { id: userId, role: 'ADMIN' },
    principal: { userId, role: 'ADMIN', credential: 'session' },
    unattributedReads: {
      conversation: mayReadUnowned,
      dataset: mayReadUnowned,
      execution: mayReadUnowned,
      experiment: mayReadUnowned,
    },
  } as unknown as AuthenticatedSession;
}

/** A platform admin on a default install. */
const admin = sessionFor(ADMIN_ID);
/** The same admin under a fork whose policy refuses unattributed reads. */
const narrowedAdmin = sessionFor(ADMIN_ID, false);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('adminCanViewConversation', () => {
  it('returns ok=true with basis=owner when caller owns the conversation', async () => {
    findUnique.mockResolvedValue({ userId: ADMIN_ID, share: null });

    const result = await adminCanViewConversation(CONV_ID, admin);

    expect(result).toEqual({ ok: true, basis: 'owner', ownerId: ADMIN_ID });
  });

  it('returns ok=true with basis=system when nobody owns the conversation', async () => {
    // Inbound threads (SMS / WhatsApp / email / Slack) carry `userId: null`
    // since #502 — the messages are a third party's, not any account
    // holder's. Without this basis an admin could not read, rename or
    // delete one, including on the sender's own erasure request.
    findUnique.mockResolvedValue({ userId: null, share: null });

    const result = await adminCanViewConversation(CONV_ID, admin);

    expect(result).toEqual({ ok: true, basis: 'system', ownerId: null });
  });

  it('reports basis=system, never owner, for an unowned conversation', async () => {
    // Guards the ordering inside the helper: were the owner comparison to
    // run first, a caller whose id was somehow nullish would be reported as
    // the owner of every unowned row, and the access would skip its audit
    // row (owner accesses are deliberately not logged).
    findUnique.mockResolvedValue({ userId: null, share: null });

    const result = await adminCanViewConversation(CONV_ID, sessionFor(''));

    expect(result.basis).toBe('system');
    expect(result.ownerId).toBeNull();
  });

  it('returns ok=true with basis=shared when an active share exists', async () => {
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    findUnique.mockResolvedValue({
      userId: OWNER_ID,
      share: { revokedAt: null, expiresAt: futureExpiry },
    });

    const result = await adminCanViewConversation(CONV_ID, admin);

    expect(result).toEqual({ ok: true, basis: 'shared', ownerId: OWNER_ID });
  });

  it('returns ok=true with basis=shared for a never-expiring active share', async () => {
    findUnique.mockResolvedValue({
      userId: OWNER_ID,
      share: { revokedAt: null, expiresAt: null }, // no expiry
    });

    const result = await adminCanViewConversation(CONV_ID, admin);

    expect(result.ok).toBe(true);
    expect(result.basis).toBe('shared');
  });

  it('denies (basis=null, ownerId=null) when no share exists and caller is not owner', async () => {
    // Returning null for ownerId on deny avoids leaking owner identity
    // on a 404 — preventing a user-enumeration vector.
    findUnique.mockResolvedValue({ userId: OWNER_ID, share: null });

    const result = await adminCanViewConversation(CONV_ID, admin);

    expect(result).toEqual({ ok: false, basis: null, ownerId: null });
  });

  it('denies when the share has been revoked', async () => {
    findUnique.mockResolvedValue({
      userId: OWNER_ID,
      share: { revokedAt: new Date(), expiresAt: null },
    });

    const result = await adminCanViewConversation(CONV_ID, admin);

    expect(result.ok).toBe(false);
    expect(result.basis).toBeNull();
  });

  it('denies when the share has expired', async () => {
    const pastExpiry = new Date(Date.now() - 60 * 60 * 1000);
    findUnique.mockResolvedValue({
      userId: OWNER_ID,
      share: { revokedAt: null, expiresAt: pastExpiry },
    });

    const result = await adminCanViewConversation(CONV_ID, admin);

    expect(result.ok).toBe(false);
    expect(result.basis).toBeNull();
  });

  it('denies (and treats as missing) when the conversation does not exist', async () => {
    findUnique.mockResolvedValue(null);

    const result = await adminCanViewConversation(CONV_ID, admin);

    expect(result).toEqual({ ok: false, basis: null, ownerId: null });
  });

  it('passes the conversation id through to findUnique unchanged', async () => {
    findUnique.mockResolvedValue({ userId: ADMIN_ID, share: null });

    await adminCanViewConversation(CONV_ID, admin);

    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: CONV_ID } }));
  });

  it('owner check takes precedence over a share record (defense in depth)', async () => {
    // If the caller is the owner AND a share happens to exist (e.g.
    // they shared their own conversation with their own admin
    // account), basis should report 'owner' — not 'shared' — so the
    // audit log doesn't spuriously record their own access as a
    // cross-user event.
    findUnique.mockResolvedValue({
      userId: ADMIN_ID,
      share: { revokedAt: null, expiresAt: null },
    });

    const result = await adminCanViewConversation(CONV_ID, admin);

    expect(result.basis).toBe('owner');
  });
});

describe('isShareActive', () => {
  it('returns true for a fresh share with no expiry', () => {
    expect(isShareActive({ revokedAt: null, expiresAt: null })).toBe(true);
  });

  it('returns true for a share with a future expiry', () => {
    const future = new Date(Date.now() + 60_000);
    expect(isShareActive({ revokedAt: null, expiresAt: future })).toBe(true);
  });

  it('returns false for a revoked share', () => {
    expect(isShareActive({ revokedAt: new Date(), expiresAt: null })).toBe(false);
  });

  it('returns false for an expired share', () => {
    const past = new Date(Date.now() - 60_000);
    expect(isShareActive({ revokedAt: null, expiresAt: past })).toBe(false);
  });

  it('returns false when both revoked and expired (revoke wins or expiry wins; result is the same)', () => {
    expect(isShareActive({ revokedAt: new Date(), expiresAt: new Date(Date.now() - 60_000) })).toBe(
      false
    );
  });
});

// ─── What t-686 added ─────────────────────────────────────────────────────────

describe('adminCanViewConversation under a narrowing policy', () => {
  it('refuses an inbound thread when the policy denies unattributed reads', async () => {
    // The capability this task delivers. A customer-tier fork stops one
    // tenant's admin reading another tenant's customers' messages, by
    // registering a policy and editing no route.
    findUnique.mockResolvedValue({ userId: null, share: null });

    const result = await adminCanViewConversation(CONV_ID, narrowedAdmin);

    // DENY, not a distinguishable refusal: the caller cannot tell "no such
    // thread" from "not yours", which is the posture the stranger case has
    // always had.
    expect(result).toEqual({ ok: false, basis: null, ownerId: null });
  });

  it('leaves the owner arm alone', async () => {
    // The policy answers one question. Denying ownerless reads must not cost
    // a caller their own conversations.
    findUnique.mockResolvedValue({ userId: ADMIN_ID, share: null });

    await expect(adminCanViewConversation(CONV_ID, narrowedAdmin)).resolves.toEqual({
      ok: true,
      basis: 'owner',
      ownerId: ADMIN_ID,
    });
  });

  it('leaves the share arm alone, including its expiry', async () => {
    // The delicate half of this task. A share is consent given by the owner
    // about one row; the policy is a rule about a class of rows. Narrowing
    // the second must not touch the first — nor revive an expired share.
    findUnique.mockResolvedValue({
      userId: OWNER_ID,
      share: { revokedAt: null, expiresAt: new Date(Date.now() + 60_000) },
    });
    await expect(adminCanViewConversation(CONV_ID, narrowedAdmin)).resolves.toEqual({
      ok: true,
      basis: 'shared',
      ownerId: OWNER_ID,
    });

    findUnique.mockResolvedValue({
      userId: OWNER_ID,
      share: { revokedAt: null, expiresAt: new Date(Date.now() - 60_000) },
    });
    await expect(adminCanViewConversation(CONV_ID, narrowedAdmin)).resolves.toEqual({
      ok: false,
      basis: null,
      ownerId: null,
    });
  });

  it('never admits a stranger, whatever the policy says about unowned rows', async () => {
    // No policy value may widen this. "Nobody owns this" and "someone else
    // owns this" are different questions, and conflating them is the
    // divergence #741 closed.
    findUnique.mockResolvedValue({ userId: OWNER_ID, share: null });

    for (const session of [admin, narrowedAdmin]) {
      await expect(adminCanViewConversation(CONV_ID, session)).resolves.toEqual({
        ok: false,
        basis: null,
        ownerId: null,
      });
    }
  });
});

describe('conversationVisibilityWhere', () => {
  /** The share arm as the fragment spells it. */
  const SHARE_ARM = {
    share: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] },
  };

  it('emits all three arms for a platform admin on a default install', () => {
    expect(conversationVisibilityWhere(admin)).toEqual({
      OR: [{ userId: ADMIN_ID }, { userId: null }, SHARE_ARM],
    });
  });

  it('drops only the ownerless arm when the policy refuses it', () => {
    // Two arms, in the same order, with the middle one gone. Asserted as a
    // whole rather than "does not contain null", because an extra arm here is
    // a cross-tenant read across every list and search at once.
    expect(conversationVisibilityWhere(narrowedAdmin)).toEqual({
      OR: [{ userId: ADMIN_ID }, SHARE_ARM],
    });
  });

  it('drops the share arm on request, and that is independent of the policy', () => {
    // `excludeShared` is a counting concern, not a security one — it only
    // narrows. It must compose with either policy answer.
    expect(conversationVisibilityWhere(admin, { excludeShared: true })).toEqual({
      OR: [{ userId: ADMIN_ID }, { userId: null }],
    });
    expect(conversationVisibilityWhere(narrowedAdmin, { excludeShared: true })).toEqual({
      OR: [{ userId: ADMIN_ID }],
    });
  });

  it('always carries the owner arm with a usable id', () => {
    // The narrowest result is still a filter. If any combination produced
    // `{ OR: [] }` or an arm with `userId: undefined`, Prisma would return
    // every conversation in the deployment — for exactly the fork that asked
    // to be narrowed.
    for (const session of [admin, narrowedAdmin]) {
      for (const options of [{}, { excludeShared: true }]) {
        const arms = (conversationVisibilityWhere(session, options) as { OR: unknown[] }).OR;
        expect(arms.length).toBeGreaterThan(0);
        expect(arms[0]).toEqual({ userId: ADMIN_ID });
      }
    }
  });
});

describe('the share rule exists twice, and the copies must agree', () => {
  // `isShareActive` decides for a row already fetched; the fragment's arm
  // decides for rows not fetched yet. Prisma takes data rather than a
  // function, so the duplication is structural and cannot be refactored away
  // — which makes this the only thing keeping them in step.
  const arm = () =>
    (conversationVisibilityWhere(admin) as { OR: { share?: Record<string, unknown> }[] }).OR.find(
      (a) => a.share
    )!.share!;

  it('both refuse a revoked share', () => {
    expect(isShareActive({ revokedAt: new Date(), expiresAt: null })).toBe(false);
    // The fragment expresses "not revoked" as an exact null match, which is
    // the only shape that excludes every revoked row.
    expect(arm().revokedAt).toBeNull();
  });

  it('both treat a null expiry as no expiry, and a past one as expired', () => {
    expect(isShareActive({ revokedAt: null, expiresAt: null })).toBe(true);
    expect(isShareActive({ revokedAt: null, expiresAt: new Date(Date.now() - 1000) })).toBe(false);

    const alternatives = arm().OR as { expiresAt: unknown }[];
    // Exactly two: "no expiry" and "expiry in the future". A third would be a
    // widening, and dropping either narrows real shares out of every list.
    expect(alternatives).toHaveLength(2);
    expect(alternatives[0]).toEqual({ expiresAt: null });
    expect(alternatives[1]).toEqual({ expiresAt: { gt: expect.any(Date) } });
  });

  it('uses a strictly-greater comparison, matching the helper on the boundary', () => {
    // `isShareActive` returns false when `expiresAt <= now`, so the fragment
    // must use `gt` and not `gte`: `gte` would admit a share expiring exactly
    // now that the detail route refuses, which is the list/detail divergence
    // in miniature.
    const now = new Date();
    expect(isShareActive({ revokedAt: null, expiresAt: now })).toBe(false);
    expect(Object.keys((arm().OR as { expiresAt: object }[])[1].expiresAt)).toEqual(['gt']);
  });
});
