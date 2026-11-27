// @vitest-environment node
/**
 * Tests: the billing variables in `lib/env.ts` (§139 t-1094)
 *
 * All three are optional, so an install that does not bill boots with none.
 * A value that is set but is not the shape it claims fails the boot naming
 * the variable, never printing the value: a mistyped secret key is still a
 * secret. Missing keys while BILLING_PROVIDER is set are not a boot failure;
 * config health reports them (`billing-checks.test.ts`).
 *
 * @see lib/env.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BASE: Record<string, string> = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/mydb',
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NODE_ENV: 'test',
};
const MANAGED = [
  ...Object.keys(BASE),
  'BILLING_PROVIDER',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
];

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
});
afterEach(() => {
  for (const key of MANAGED) delete process.env[key];
  Object.assign(process.env, saved);
  vi.restoreAllMocks();
  vi.resetModules();
});

async function boot(vars: Record<string, string>) {
  for (const key of MANAGED) delete process.env[key];
  Object.assign(process.env, BASE, vars);
  vi.resetModules();
  return (await import('@/lib/env')).env;
}

describe('the billing variables', () => {
  it('boots with none of them: billing off', async () => {
    const env = await boot({});
    expect(env.BILLING_PROVIDER).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it('boots with BILLING_PROVIDER set and the keys missing', async () => {
    const env = await boot({ BILLING_PROVIDER: 'stripe' });
    expect(env.BILLING_PROVIDER).toBe('stripe');
  });

  it('reads all three when set', async () => {
    const env = await boot({
      BILLING_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: 'sk_test_abc',
      STRIPE_WEBHOOK_SECRET: 'whsec_abc',
    });
    expect(env.STRIPE_SECRET_KEY).toBe('sk_test_abc');
    expect(env.STRIPE_WEBHOOK_SECRET).toBe('whsec_abc');
  });

  it.each([
    ['BILLING_PROVIDER', 'Stripe'],
    ['STRIPE_SECRET_KEY', 'pk_test_publishable_not_secret_value_9f8e'],
    ['STRIPE_WEBHOOK_SECRET', 'not-a-signing-secret-value-9f8e'],
  ])('refuses %s of the wrong shape, naming it and not printing the value', async (name, value) => {
    const printed: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });

    await expect(boot({ [name]: value })).rejects.toThrow(/Environment validation failed/);

    const output = printed.join('\n');
    expect(output).toContain(name);
    expect(output).not.toContain(value);
  });
});
