/**
 * Unit Tests: whether billing is on, and building the provider (§139 t-1094)
 *
 * The matrix of `BILLING_PROVIDER`, tenancy and keys; an app's own provider;
 * and the promise that the `stripe` package is loaded only when billing is on
 * with Stripe chosen. That last is checked twice: at run time (a mock of the
 * package records whether it was ever evaluated), and in the tree (nothing
 * but the adapter imports the package, and nothing imports the adapter but
 * the one dynamic `import()`), since a static import anywhere would load it
 * on every install.
 *
 * @see lib/billing/config.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  TENANCY_MODE: 'multi',
  BILLING_PROVIDER: undefined as string | undefined,
  STRIPE_SECRET_KEY: undefined as string | undefined,
  STRIPE_WEBHOOK_SECRET: undefined as string | undefined,
}));
vi.mock('@/lib/env', () => ({ env: mockEnv }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const loaded = vi.hoisted(() => ({ stripe: false }));
vi.mock('stripe', () => {
  loaded.stripe = true;
  class Stripe {
    static errors = {
      StripeInvalidRequestError: class extends Error {},
      StripeSignatureVerificationError: class extends Error {},
    };
  }
  return { default: Stripe };
});

const appBilling = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('@/lib/app/billing', () => ({ initAppBilling: () => appBilling.init() }));
vi.mock('@/lib/app/entitlements', () => ({ initAppEntitlements: vi.fn() }));

import {
  __resetBillingProviderForTests,
  billingEnabled,
  billingProvider,
  billingProviderState,
} from '@/lib/billing/config';
import { __resetBillingPlansForTests } from '@/lib/billing/plans';
import { registerBillingProvider, type BillingProvider } from '@/lib/billing/provider';

function setEnv(values: Partial<typeof mockEnv>): void {
  Object.assign(mockEnv, {
    TENANCY_MODE: 'multi',
    BILLING_PROVIDER: undefined,
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
    ...values,
  });
}

const STRIPE_ON = {
  BILLING_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
};

function fakeProvider(key: string): BillingProvider {
  return { key } as unknown as BillingProvider;
}

beforeEach(() => {
  setEnv({});
  appBilling.init.mockReset();
  __resetBillingPlansForTests();
  __resetBillingProviderForTests();
});

describe('billingProviderState', () => {
  it.each([
    ['unset', {}, { on: false, reason: 'unset', providerKey: null }],
    [
      'set at single',
      { ...STRIPE_ON, TENANCY_MODE: 'single' },
      { on: false, reason: 'single_tenant', providerKey: 'stripe' },
    ],
    [
      'stripe with no keys',
      { BILLING_PROVIDER: 'stripe' },
      { on: false, reason: 'not_configured', providerKey: 'stripe' },
    ],
    [
      'stripe with only the secret key',
      { BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_x' },
      { on: false, reason: 'not_configured', providerKey: 'stripe' },
    ],
    ['stripe with both keys', STRIPE_ON, { on: true, providerKey: 'stripe' }],
    [
      'a provider nothing registers',
      { BILLING_PROVIDER: 'paddle' },
      { on: false, reason: 'unknown_provider', providerKey: 'paddle' },
    ],
  ])('%s', (_name, values, expected) => {
    setEnv(values);
    expect(billingProviderState()).toEqual(expected);
    expect(billingEnabled()).toBe(expected.on);
  });

  it('turns on a provider the app registers, once its own keys are set', () => {
    let keysSet = false;
    appBilling.init.mockImplementation(() => {
      registerBillingProvider({
        key: 'paddle',
        create: () => fakeProvider('paddle'),
        configured: () => keysSet,
      });
    });
    setEnv({ BILLING_PROVIDER: 'paddle' });

    expect(billingProviderState()).toMatchObject({ on: false, reason: 'not_configured' });
    keysSet = true;
    expect(billingProviderState()).toEqual({ on: true, providerKey: 'paddle' });
  });

  it('says registration failed, and stays off, when the app’s init threw after registering', () => {
    appBilling.init.mockImplementation(() => {
      registerBillingProvider({ key: 'paddle', create: () => fakeProvider('paddle') });
      throw new Error('a later plan was wrong');
    });
    setEnv({ BILLING_PROVIDER: 'paddle' });

    // Rolled back with the plans: no half-registered provider is selectable.
    expect(billingProviderState()).toEqual({
      on: false,
      reason: 'registration_failed',
      providerKey: 'paddle',
    });
  });
});

describe('registerBillingProvider', () => {
  it.each([
    ['core’s own key', { key: 'stripe', create: () => fakeProvider('stripe') }],
    ['a key that is not a key', { key: 'Pad dle', create: () => fakeProvider('x') }],
    ['no create()', { key: 'paddle' }],
  ])('refuses %s', (_name, registration) => {
    expect(() =>
      registerBillingProvider(registration as Parameters<typeof registerBillingProvider>[0])
    ).toThrow();
  });
});

describe('billingProvider', () => {
  it('is null, and never loads the stripe package, while billing is off', async () => {
    loaded.stripe = false;
    for (const values of [
      {},
      { BILLING_PROVIDER: 'stripe' },
      { ...STRIPE_ON, TENANCY_MODE: 'single' },
    ]) {
      setEnv(values);
      expect(await billingProvider()).toBeNull();
    }
    expect(loaded.stripe).toBe(false);
  });

  it('loads the stripe package once Stripe is chosen and configured, and builds it once', async () => {
    loaded.stripe = false;
    setEnv(STRIPE_ON);

    const first = await billingProvider();
    const second = await billingProvider();

    expect(loaded.stripe).toBe(true);
    expect(first?.key).toBe('stripe');
    expect(second).toBe(first);
  });

  it('builds an app’s provider from its create(), and refuses one that reports another key', async () => {
    appBilling.init.mockImplementation(() => {
      registerBillingProvider({ key: 'paddle', create: () => fakeProvider('paddle') });
      registerBillingProvider({ key: 'liar', create: () => fakeProvider('paddle') });
    });
    setEnv({ BILLING_PROVIDER: 'paddle' });
    expect((await billingProvider())?.key).toBe('paddle');

    __resetBillingProviderForTests();
    setEnv({ BILLING_PROVIDER: 'liar' });
    await expect(billingProvider()).rejects.toThrow(/reports its key/);
  });

  it('tries again after a build that threw', async () => {
    let attempts = 0;
    appBilling.init.mockImplementation(() => {
      registerBillingProvider({
        key: 'flaky',
        create: () => {
          attempts += 1;
          if (attempts === 1) throw new Error('not yet');
          return fakeProvider('flaky');
        },
      });
    });
    setEnv({ BILLING_PROVIDER: 'flaky' });

    await expect(billingProvider()).rejects.toThrow('not yet');
    expect((await billingProvider())?.key).toBe('flaky');
  });
});

describe('the stripe package is reachable only through the dynamic import', () => {
  const root = process.cwd();
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }
  const files = ['lib', 'app', 'components', 'proxy.ts']
    .map((p) => join(root, p))
    .flatMap((p) => (statSync(p).isDirectory() ? sources(p) : [p]));

  it('nothing but the adapter imports the stripe package', () => {
    const importers = files
      .filter((file) =>
        /from ['"]stripe['"]|import\(['"]stripe['"]\)|require\(['"]stripe['"]\)/.test(
          readFileSync(file, 'utf8')
        )
      )
      .map((file) => relative(root, file));
    expect(importers).toEqual(['lib/billing/providers/stripe.ts']);
  });

  it('nothing imports the adapter statically; config.ts loads it with import()', () => {
    const statically = files
      .filter((file) =>
        /from ['"]@\/lib\/billing\/providers\/stripe['"]/.test(readFileSync(file, 'utf8'))
      )
      .map((file) => relative(root, file));
    expect(statically).toEqual([]);
    expect(readFileSync(join(root, 'lib/billing/config.ts'), 'utf8')).toMatch(
      /await import\('@\/lib\/billing\/providers\/stripe'\)/
    );
  });
});
