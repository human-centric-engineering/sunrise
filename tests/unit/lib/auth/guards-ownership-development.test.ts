/**
 * Tests: a fork's first boot after adopting an org-admin tier
 *
 * Its own file because `OWNERSHIP_GAP_ACTION` is decided once at module scope
 * from `env.NODE_ENV`, so pinning it to `development` needs a hoisted mock.
 *
 * The scenario is the one that made this branch reverse its enforcement rule,
 * and it is not hypothetical — it is the recipe `lib/auth/authorization.ts`
 * tells a fork to write:
 *
 *     registerAuthorizationPolicy({
 *       ...DEFAULT_AUTHORIZATION_POLICY,
 *       canAdminister: (viewer) => isOrgAdmin(viewer),
 *     })
 *
 * An org admin then passes `canAdminister` while the RETAINED default
 * `subjectScope` answers `{ userId }`, so every one of the 262 `withAdminAuth`
 * handlers owes a declaration at the same moment. If development refused, that
 * fork's entire admin console would 500 the first time they booted after
 * upgrading — for following the documentation correctly. `checkAuthorizationParity`
 * passes clean on that policy, so nothing warns them earlier.
 *
 * So development logs and only **test** refuses: the failing-test list is the
 * instrument the contract asks for, and it enumerates the work instead of
 * withdrawing the application.
 *
 * @see lib/auth/guards.ts — `OWNERSHIP_GAP_ACTION`
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/env', () => ({
  env: { NODE_ENV: 'development' },
  isProduction: () => false,
  isDevelopment: () => true,
  isTest: () => false,
}));

vi.mock('next/headers', () => ({ headers: vi.fn() }));

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock('@/lib/auth/api-keys', () => ({
  resolveApiKey: vi.fn().mockResolvedValue(null),
  hasScope: (scopes: string[], required: string) =>
    scopes.includes(required) || scopes.includes('admin'),
  listValidApiKeyScopes: vi.fn(() => ['chat', 'admin']),
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { resolveApiKey } from '@/lib/auth/api-keys';
import { logger } from '@/lib/logging';
import { withAdminAuth } from '@/lib/auth/guards';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
} from '@/lib/auth/authorization';

const request = (path = '/api/v1/admin/agents') => new NextRequest(`http://localhost:3000${path}`);
const ok = () => Response.json({ success: true });

function ownershipReports(): unknown[] {
  return vi
    .mocked(logger.error)
    .mock.calls.filter(
      (call) => String(call[0]) === 'authorization: a route made no ownership decision'
    );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(headers).mockResolvedValue(new Headers());
  vi.mocked(resolveApiKey).mockResolvedValue(null);
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: {
      id: 'session_1',
      userId: 'org_admin_9',
      token: 'tok',
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id: 'org_admin_9',
      name: 'Org Admin',
      email: 'org@example.com',
      emailVerified: true,
      image: null,
      role: 'USER',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  // The documented one-line override, verbatim in shape: `canAdminister` widened
  // to an org tier, `subjectScope` left at the default — which narrows a USER.
  registerAuthorizationPolicy({
    ...DEFAULT_AUTHORIZATION_POLICY,
    canAdminister: () => Promise.resolve(true),
  });
});

afterEach(() => {
  __resetAuthorizationPolicyForTests();
});

describe('a fork that widened canAdminister and left subjectScope alone', () => {
  it('keeps the admin route working, and says what is wrong', async () => {
    // The claim under test: the console does NOT go down. If this ever asserts
    // 500 again, an upgrading fork loses 262 routes at once.
    const response = await withAdminAuth(() => ok())(request());

    expect(response.status).toBe(200);
    expect(ownershipReports()).toHaveLength(1);
    expect(vi.mocked(logger.error).mock.calls[0]?.[2]).toMatchObject({
      action: 'log',
      guard: 'withAdminAuth',
      declared: '(none)',
    });
  });

  it('says it once per route, not once per request', async () => {
    // Mid-migration every un-annotated route reports on every request. Without
    // the once-per-process memory the signal does not survive its own volume —
    // the same reason the `'unattributed'` arm logs once per kind.
    const route = withAdminAuth(() => ok());
    await route(request());
    await route(request());
    await route(request());

    expect(ownershipReports()).toHaveLength(1);
  });

  it('still reports a different route', async () => {
    // The control for the deduplication: "once per route", not "once, ever".
    // Without this, state that suppressed everything after the first report
    // would look identical to state that works. Two `withAdminAuth` calls are
    // two route modules, so two flags.
    await withAdminAuth(() => ok())(request('/api/v1/admin/agents'));
    await withAdminAuth(() => ok())(request('/api/v1/admin/workflows'));

    expect(ownershipReports()).toHaveLength(2);
  });

  it('says it once for a DYNAMIC route, however many ids are requested', async () => {
    // The reason the flag moved out of a module-level Set keyed on the request
    // path: `nextUrl.pathname` is the concrete path, so every id was its own
    // key. 10k agent views meant 10k log lines — the volume the dedupe exists to
    // prevent — and 10k permanent Set entries in a long-lived process. One
    // closure per route makes it right by construction.
    const route = withAdminAuth(() => ok());
    await route(request('/api/v1/admin/agents/agent-1'));
    await route(request('/api/v1/admin/agents/agent-2'));
    await route(request('/api/v1/admin/agents/agent-3'));

    expect(ownershipReports()).toHaveLength(1);
  });
});
