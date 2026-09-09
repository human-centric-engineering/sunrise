/**
 * Tests: what a missing ownership decision does in production
 *
 * Its own file because `OWNERSHIP_GAP_ACTION` is decided once, at module scope,
 * from `env.NODE_ENV` — so making it `'log'` needs a hoisted module mock, and a
 * mock that applies to every test in a file is not something the main ownership
 * suite can share.
 *
 * The property under test is a trade, and it is the one part of this mechanism
 * that is not "fail closed". Everywhere else in this seam a failure denies:
 * a throwing policy denies, a resolver that names nothing denies, a broken
 * registration closes the admin console. Here it deliberately does not, and the
 * reason is what the two failures actually cost. A forgotten annotation is a
 * route that MIGHT return more rows than it should — and on the detail read
 * `canRead` is still narrowing it. Refusing instead turns that into a certain
 * outage for every caller of the route, at the moment a fork upgrades. So
 * production logs, development and test refuse, and the signal lands where it
 * can still be acted on cheaply.
 *
 * A fork that would rather refuse everywhere flips the constant; this file is
 * what proves the two branches are both real.
 *
 * @see lib/auth/guards.ts — `OWNERSHIP_GAP_ACTION`
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/env', () => ({
  env: { NODE_ENV: 'production' },
  isProduction: () => true,
  isDevelopment: () => false,
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
import { withAuth } from '@/lib/auth/guards';

const request = () => new NextRequest('http://localhost:3000/api/v1/widgets');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(headers).mockResolvedValue(new Headers());
  vi.mocked(resolveApiKey).mockResolvedValue(null);
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: {
      id: 'session_1',
      userId: 'user_1',
      token: 'tok',
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id: 'user_1',
      name: 'Test User',
      email: 'test@example.com',
      emailVerified: true,
      image: null,
      role: 'USER',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
});

describe('in production, a missing ownership decision', () => {
  it('is logged and the request still succeeds', async () => {
    const handler = vi.fn(() => Response.json({ success: true }));

    const response = await withAuth(handler)(request());

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalled();
    // Third argument, not second: `error(message, error?, meta?)`. Passed
    // second, this object would be JSON-stringified into `entry.error.message`
    // under `name: 'UnknownError'` and `entry.meta` would be empty — so the
    // fields this branch exists to give an operator would not be fields.
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'authorization: a route made no ownership decision',
      undefined,
      expect.objectContaining({ action: 'log', path: '/api/v1/widgets' })
    );
  });

  it('records the action it took, so the log says which branch ran', async () => {
    // Without `action`, the same line means "we refused this" in one deployment
    // and "we let it through" in another, and an operator reading it cannot tell
    // which — the exact ambiguity that made a rolled-back seam look like a
    // disabled feature in #633.
    await withAuth(() => Response.json({ success: true }))(request());

    const context = vi.mocked(logger.error).mock.calls[0]?.[2] as { action: string };
    expect(context.action).toBe('log');
  });
});
