/**
 * Config-health runner — unit tests.
 *
 * The fork seam (`lib/app/config-health.ts`) is mocked and filled per test with
 * a production-only check, which is what exercises `productionOnly` and the
 * merge. Sunrise ships it empty (pinned in tests/unit/lib/app/defaults.test.ts).
 *
 * @see lib/config-health/run.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// env.NODE_ENV is read by the runner; mutate per test.
const envMock = vi.hoisted(() => ({ env: { NODE_ENV: 'production' } }));
vi.mock('@/lib/env', () => envMock);
vi.mock('@/lib/logging', () => ({ logger: { error: vi.fn() } }));
vi.mock('@/lib/email/client', () => ({ isEmailEnabled: vi.fn(() => true) }));
// The provider rows are faked; the reachability rule is core's real one
// (`filterProvidersWithCredential`), so a local provider counts without a key.
// The real reachability rule, wrapped so one test can make the resolver fail.
vi.mock('@/lib/orchestration/llm/provider-credentials', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/orchestration/llm/provider-credentials')>();
  return { ...actual, classifyProvidersByCredential: vi.fn(actual.classifyProvidersByCredential) };
});
vi.mock('@/lib/db/client', () => ({
  prisma: { aiProviderConfig: { findMany: vi.fn() } },
}));

/** An active provider row as the check reads it. */
function providerRow(overrides: { isLocal?: boolean; apiKeyEnvVar?: string | null } = {}) {
  return {
    id: 'p1',
    slug: 'p1',
    name: 'Provider',
    providerType: 'openai-compatible',
    apiKeyEnvVar: 'TEST_PROVIDER_KEY',
    isLocal: false,
    ...overrides,
  };
}
const appSeam = vi.hoisted(
  (): { appConfigHealthChecks: import('@/lib/config-health/types').ConfigHealthCheck[] } => ({
    appConfigHealthChecks: [],
  })
);
vi.mock('@/lib/app/config-health', () => appSeam);

/** A fork check of the kind ConQuest registers: a secret only production needs. */
const FORK_CRON_CHECK = {
  key: 'CRON_SECRET',
  label: 'Maintenance cron secret',
  severity: 'critical' as const,
  productionOnly: true,
  description: 'Background jobs never run without it.',
  remediation: 'Set CRON_SECRET and redeploy.',
  detect: () => !!process.env.CRON_SECRET,
};

import { runConfigHealthChecks } from '@/lib/config-health/run';
import { isEmailEnabled } from '@/lib/email/client';
import { logger } from '@/lib/logging';
import { prisma } from '@/lib/db/client';
import { classifyProvidersByCredential } from '@/lib/orchestration/llm/provider-credentials';
import type { EvaluatedConfigCheck } from '@/lib/config-health/types';

type Mock = ReturnType<typeof vi.fn>;

function check(checks: EvaluatedConfigCheck[], key: string): EvaluatedConfigCheck {
  const found = checks.find((c) => c.key === key);
  if (!found) throw new Error(`check ${key} not found`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.env.NODE_ENV = 'production';
  appSeam.appConfigHealthChecks = [FORK_CRON_CHECK];
  (isEmailEnabled as Mock).mockReturnValue(true);
  (prisma.aiProviderConfig.findMany as Mock).mockResolvedValue([providerRow()]);
  vi.stubEnv('TEST_PROVIDER_KEY', 'sk-test-not-a-real-key');
  // Healthy defaults; individual tests unset what they exercise.
  vi.stubEnv('CRON_SECRET', 'x'.repeat(40));
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@ep-x-pooler.aws.neon.tech:5432/db');
  vi.stubEnv('VERCEL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runConfigHealthChecks', () => {
  it('runs only the platform checks when the fork registers none', async () => {
    appSeam.appConfigHealthChecks = [];
    const report = await runConfigHealthChecks();
    expect(report.checks.map((c) => c.key)).toEqual(['llm_provider', 'email', 'db_pooler']);
  });

  it('adds the fork’s checks after the platform’s', async () => {
    const report = await runConfigHealthChecks();
    expect(report.checks.map((c) => c.key)).toEqual([
      'llm_provider',
      'email',
      'db_pooler',
      'CRON_SECRET',
    ]);
  });

  it('counts only active providers', async () => {
    await runConfigHealthChecks();
    expect(prisma.aiProviderConfig.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } })
    );
  });

  it('flags a production-only fork check as critical and unmet in production when unset', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const report = await runConfigHealthChecks();
    const cron = check(report.checks, 'CRON_SECRET');
    expect(cron.applicable).toBe(true);
    expect(cron.present).toBe(false);
    expect(cron.severity).toBe('critical');
    expect(report.summary.critical).toBe(1);
  });

  it('does not flag a production-only check in development', async () => {
    envMock.env.NODE_ENV = 'development';
    vi.stubEnv('CRON_SECRET', '');
    const report = await runConfigHealthChecks();
    const cron = check(report.checks, 'CRON_SECRET');
    expect(cron.applicable).toBe(false);
    expect(cron.present).toBe(true); // not applicable → never flagged
    expect(report.summary.critical).toBe(0);
  });

  it('reports a production-only check satisfied when set in production', async () => {
    const report = await runConfigHealthChecks();
    expect(check(report.checks, 'CRON_SECRET').present).toBe(true);
  });

  it('flags the email check when email is not configured', async () => {
    (isEmailEnabled as Mock).mockReturnValue(false);
    const report = await runConfigHealthChecks();
    const email = check(report.checks, 'email');
    expect(email.present).toBe(false);
    expect(email.severity).toBe('warning');
    expect(report.summary.warning).toBeGreaterThanOrEqual(1);
  });

  it('reports the LLM-provider check as failed, not missing, when the credential resolver fails', async () => {
    const row = providerRow();
    vi.mocked(classifyProvidersByCredential).mockResolvedValueOnce({
      reachable: [],
      unavailable: [{ config: row, error: new Error('vault timeout') }],
    });
    const report = await runConfigHealthChecks();
    expect(check(report.checks, 'llm_provider')).toMatchObject({ failed: true });
    expect(report.summary.critical).toBe(0);
    expect(report.summary.failed).toBe(1);
  });

  it('passes the LLM-provider check for a local provider with no key', async () => {
    (prisma.aiProviderConfig.findMany as Mock).mockResolvedValue([
      providerRow({ isLocal: true, apiKeyEnvVar: null }),
    ]);
    const report = await runConfigHealthChecks();
    expect(check(report.checks, 'llm_provider').present).toBe(true);
  });

  it('flags the LLM-provider check (critical) when no provider has its key set', async () => {
    vi.stubEnv('TEST_PROVIDER_KEY', undefined);
    (prisma.aiProviderConfig.findMany as Mock).mockResolvedValue([
      providerRow(),
      providerRow({ apiKeyEnvVar: null }),
    ]);
    const report = await runConfigHealthChecks();
    const provider = check(report.checks, 'llm_provider');
    expect(provider.present).toBe(false);
    expect(provider.severity).toBe('critical');
  });

  it('db_pooler is not applicable off Vercel', async () => {
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db'); // direct, but irrelevant off-serverless
    const report = await runConfigHealthChecks();
    expect(check(report.checks, 'db_pooler').applicable).toBe(false);
    expect(report.platform).toBe('other');
  });

  it('db_pooler flags a direct connection on Vercel and passes a pooled one', async () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@db.example.com:5432/db');
    let report = await runConfigHealthChecks();
    expect(report.platform).toBe('vercel');
    expect(check(report.checks, 'db_pooler').present).toBe(false);

    vi.stubEnv(
      'DATABASE_URL',
      'postgresql://user:pass@host.pooler.supabase.com:6543/db?pgbouncer=true'
    );
    report = await runConfigHealthChecks();
    expect(check(report.checks, 'db_pooler').present).toBe(true);
  });

  it('reports a check that throws as failed, logs it, and still runs the others', async () => {
    (prisma.aiProviderConfig.findMany as Mock).mockRejectedValue(new Error('db down'));
    (isEmailEnabled as Mock).mockReturnValue(false);
    const report = await runConfigHealthChecks();

    const provider = check(report.checks, 'llm_provider');
    expect(provider).toMatchObject({ present: false, applicable: true, failed: true });
    expect(check(report.checks, 'email')).toMatchObject({ present: false });
    expect(check(report.checks, 'email')).not.toHaveProperty('failed');
    // Counted apart: nothing is known to be missing, so no critical.
    expect(report.summary).toMatchObject({ critical: 0, warning: 1, failed: 1 });
    expect(logger.error).toHaveBeenCalledWith('Config health check failed', {
      check: 'llm_provider',
      error: 'db down',
    });
  });

  it('reports a fork check whose applicability test throws as failed', async () => {
    appSeam.appConfigHealthChecks = [
      {
        ...FORK_CRON_CHECK,
        applicable: () => {
          // A non-Error throw, to prove the log still names what was thrown.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'bad gate';
        },
      },
    ];
    const report = await runConfigHealthChecks();
    expect(check(report.checks, 'CRON_SECRET')).toMatchObject({ failed: true });
    expect(logger.error).toHaveBeenCalledWith('Config health check failed', {
      check: 'CRON_SECRET',
      error: 'bad gate',
    });
  });

  it.each([
    ['Supabase session mode', 'postgresql://user:pass@aws-0-eu.pooler.supabase.com:5432/postgres'],
    ['PgBouncer flag as 1', 'postgresql://user:pass@ep-x.neon.tech/db?pgbouncer=1'],
    ['Prisma Accelerate', 'prisma://accelerate.prisma-data.net/?api_key=k'],
    ['Prisma Postgres', 'prisma+postgres://accelerate.prisma-data.net/?api_key=k'],
  ])('db_pooler passes %s on Vercel', async (_label, url) => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('DATABASE_URL', url);
    const report = await runConfigHealthChecks();
    expect(check(report.checks, 'db_pooler').present).toBe(true);
  });

  it('db_pooler flags an unset DATABASE_URL on Vercel', async () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('DATABASE_URL', undefined);
    const report = await runConfigHealthChecks();
    expect(check(report.checks, 'db_pooler').present).toBe(false);
  });

  it('never includes any config VALUE in the report (presence only)', async () => {
    const secret = 'super-secret-cron-value-not-a-boolean';
    vi.stubEnv('CRON_SECRET', secret);
    vi.stubEnv('DATABASE_URL', `postgresql://user:${secret}@ep-x-pooler.neon.tech:5432/db`);
    const report = await runConfigHealthChecks();
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('summarises applicable+unmet by severity and counts ok', async () => {
    vi.stubEnv('CRON_SECRET', ''); // critical
    (isEmailEnabled as Mock).mockReturnValue(false); // warning
    const report = await runConfigHealthChecks();
    expect(report.summary.critical).toBe(1);
    expect(report.summary.warning).toBeGreaterThanOrEqual(1);
    expect(report.summary.ok).toBeGreaterThanOrEqual(1); // llm_provider still satisfied
  });
});
