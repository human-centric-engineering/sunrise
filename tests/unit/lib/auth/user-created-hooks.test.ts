/**
 * Tests for `lib/auth/user-created-hooks.ts` (#464).
 *
 * The seam's whole value is that a fork can react to a new account without
 * editing `lib/auth/config.ts`. Its whole risk is that a fork's hook breaks
 * signup — so most of what matters here is containment, not happy path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const initAppUserCreatedHooks = vi.hoisted(() => vi.fn());
vi.mock('@/lib/app/user-created', () => ({ initAppUserCreatedHooks }));

// Mocked so the two `err instanceof Error ? err.message : String(err)` fallbacks
// can be asserted on what they actually produce. A fork throwing a bare string
// is the case those exist for, and "it didn't crash" would not distinguish a
// readable log line from an unreadable one.
const loggerError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging', () => ({
  logger: { error: loggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  registerUserCreatedHook,
  dispatchUserCreated,
  __resetUserCreatedHooksForTests,
  type UserCreatedContext,
} from '@/lib/auth/user-created-hooks';

const ctx: UserCreatedContext = {
  userId: 'user-1',
  email: 'new@example.com',
  name: 'New User',
  signupMethod: 'email',
  viaInvitation: false,
};

beforeEach(() => {
  __resetUserCreatedHooksForTests();
  initAppUserCreatedHooks.mockReset().mockImplementation(() => {});
  loggerError.mockClear();
});

afterEach(() => {
  __resetUserCreatedHooksForTests();
});

describe('dispatchUserCreated', () => {
  it('runs a registered hook with the full context', async () => {
    const hook = vi.fn();
    initAppUserCreatedHooks.mockImplementation(() => registerUserCreatedHook('app:profile', hook));

    await dispatchUserCreated(ctx);

    expect(hook).toHaveBeenCalledWith(ctx);
  });

  it('does nothing when no hook is registered', async () => {
    // Vanilla Sunrise: the seam must cost nothing and must not throw.
    await expect(dispatchUserCreated(ctx)).resolves.toBeUndefined();
  });

  it('swallows a rejecting hook so signup still succeeds', async () => {
    // The user row already exists by the time this runs. A throwing app hook
    // must not turn a completed signup into an error for the caller.
    const boom = vi.fn().mockRejectedValue(new Error('CRM down'));
    initAppUserCreatedHooks.mockImplementation(() => registerUserCreatedHook('app:crm', boom));

    await expect(dispatchUserCreated(ctx)).resolves.toBeUndefined();
    expect(boom).toHaveBeenCalled();
  });

  it('swallows a hook that throws synchronously', async () => {
    initAppUserCreatedHooks.mockImplementation(() =>
      registerUserCreatedHook('app:sync-throw', () => {
        throw new Error('sync boom');
      })
    );

    await expect(dispatchUserCreated(ctx)).resolves.toBeUndefined();
  });

  it('runs the remaining hooks when one fails', async () => {
    // Independence: hooks are unrelated app concerns, so one failing must not
    // silently skip the others.
    const failing = vi.fn().mockRejectedValue(new Error('nope'));
    const healthy = vi.fn();
    initAppUserCreatedHooks.mockImplementation(() => {
      registerUserCreatedHook('app:a', failing);
      registerUserCreatedHook('app:b', healthy);
    });

    await dispatchUserCreated(ctx);

    expect(failing).toHaveBeenCalled();
    expect(healthy).toHaveBeenCalled();
  });

  it('survives a throwing init and degrades to no hooks', async () => {
    // A fork's init itself blowing up must not fail every signup forever.
    initAppUserCreatedHooks.mockImplementation(() => {
      throw new Error('bad init');
    });

    await expect(dispatchUserCreated(ctx)).resolves.toBeUndefined();
  });

  it('logs a readable message when a hook throws a non-Error', async () => {
    // Nothing stops a fork throwing a string, and `err.message` on one is
    // undefined — the log line would name the hook and then say nothing about
    // why it failed.
    initAppUserCreatedHooks.mockImplementation(() =>
      registerUserCreatedHook('app:string-throw', () => {
        // Throwing a non-Error is exactly the case under test; a fork can and will.
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- see above
        throw 'CRM returned 503';
      })
    );

    await expect(dispatchUserCreated(ctx)).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      'user-created hook failed',
      expect.objectContaining({
        hook: 'app:string-throw',
        userId: ctx.userId,
        error: 'CRM returned 503',
      })
    );
  });

  it('logs a readable message when the app init throws a non-Error', async () => {
    initAppUserCreatedHooks.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- see above
      throw 'missing STRIPE_SECRET_KEY';
    });

    await expect(dispatchUserCreated(ctx)).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      'user-created: initAppUserCreatedHooks threw — app hooks rolled back and disabled',
      expect.objectContaining({ error: 'missing STRIPE_SECRET_KEY' })
    );
  });

  it('runs the app init exactly once across many dispatches', async () => {
    const hook = vi.fn();
    initAppUserCreatedHooks.mockImplementation(() => registerUserCreatedHook('app:once', hook));

    await dispatchUserCreated(ctx);
    await dispatchUserCreated(ctx);
    await dispatchUserCreated(ctx);

    expect(initAppUserCreatedHooks).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledTimes(3);
  });

  it('does not retry a throwing init on every signup', async () => {
    initAppUserCreatedHooks.mockImplementation(() => {
      throw new Error('bad init');
    });

    await dispatchUserCreated(ctx);
    await dispatchUserCreated(ctx);

    // Latched before running, so the failure is not re-paid per signup.
    expect(initAppUserCreatedHooks).toHaveBeenCalledTimes(1);
  });

  it('rolls back a PARTIAL init rather than running half a fork signup flow', async () => {
    const orphan = vi.fn();
    initAppUserCreatedHooks.mockImplementation(() => {
      registerUserCreatedHook('app:registered-first', orphan);
      throw new Error('bad init on the second');
    });

    await dispatchUserCreated(ctx);

    // Signup side effects are the least reversible thing a seam can do — a hook
    // left live by a partial init provisions, emails or bills every new account
    // from a config the log says is off.
    expect(orphan).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      'user-created: initAppUserCreatedHooks threw — app hooks rolled back and disabled',
      expect.objectContaining({ error: 'bad init on the second' })
    );
  });
});

describe('registerUserCreatedHook', () => {
  it('replaces a hook registered under the same key', async () => {
    // Idempotence under HMR / repeated module imports.
    const first = vi.fn();
    const second = vi.fn();
    initAppUserCreatedHooks.mockImplementation(() => {
      registerUserCreatedHook('app:dup', first);
      registerUserCreatedHook('app:dup', second);
    });

    await dispatchUserCreated(ctx);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
