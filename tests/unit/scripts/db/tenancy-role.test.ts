/**
 * Tests: scripts/db/tenancy-role.ts — the restricted app role (§107 t-707).
 *
 * Pins the statements the script issues, in order, through a mocked `pg`
 * Client: `--create` makes a `LOGIN NOBYPASSRLS` role (or resets an existing
 * one) with the schema, table, sequence and default-privilege grants; `--drop`
 * revokes the default privileges and every grant BEFORE `DROP ROLE` (Neon
 * refuses `DROP OWNED BY`, and a role holding a grant cannot be dropped
 * anywhere); identifiers and the password are escaped by `pg`, never
 * interpolated raw; the password comes only from the environment; and the
 * argument and environment mistakes exit 2 without connecting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQuery = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() => vi.fn());
const mockEnd = vi.hoisted(() => vi.fn());
vi.mock('pg', () => ({
  Client: vi.fn(function (this: Record<string, unknown>) {
    this.query = mockQuery;
    this.connect = mockConnect;
    this.end = mockEnd;
    this.escapeIdentifier = (s: string) => `"${s.replace(/"/g, '""')}"`;
    this.escapeLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;
  }),
}));

const mockInfo = vi.hoisted(() => vi.fn());
const mockError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging', () => ({
  logger: { info: mockInfo, error: mockError, warn: vi.fn(), debug: vi.fn() },
}));

import { Client } from 'pg';

describe('scripts/db/tenancy-role', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const env = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    originalArgv = [...process.argv];
    process.env.DATABASE_URL = 'postgresql://app:pw@localhost:5432/db';
    process.env.MIGRATE_DATABASE_URL = 'postgresql://owner:pw@localhost:5432/db';
    delete process.env.TENANCY_APP_ROLE;
    delete process.env.TENANCY_APP_ROLE_PASSWORD;
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = { ...env };
    exitSpy.mockRestore();
  });

  type Privilege = Partial<{
    is_self: boolean;
    is_super: boolean;
    bypasses: boolean;
    owns_tables: boolean;
  }>;

  /**
   * Answers: role absent/present per `exists` (and, when present, the
   * privilege flags the guard reads), schema `public`, everything else empty.
   */
  function answer(exists: boolean, privilege: Privilege = {}) {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('AS is_self')) {
        return Promise.resolve({
          rows: exists
            ? [
                {
                  is_self: false,
                  is_super: false,
                  bypasses: false,
                  owns_tables: false,
                  ...privilege,
                },
              ]
            : [],
        });
      }
      if (sql.includes('FROM pg_roles'))
        return Promise.resolve({ rows: [{ n: exists ? '1' : '0' }] });
      if (sql.includes('AS schema')) return Promise.resolve({ rows: [{ schema: 'public' }] });
      if (sql.includes('AS present')) return Promise.resolve({ rows: [{ present: ledger }] });
      return Promise.resolve({ rows: [] });
    });
  }
  let ledger = true;

  /** The statements that change something — the catalog reads filtered out. */
  const statements = () =>
    mockQuery.mock.calls
      .map((c) => c[0] as string)
      .filter(
        (s) => !s.includes('FROM pg_roles') && !s.includes('AS schema') && !s.includes('AS present')
      );

  const SCRAM = /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

  async function run(...args: string[]): Promise<void> {
    process.argv = ['node', 'scripts/db/tenancy-role.ts', ...args];
    await import('@/scripts/db/tenancy-role');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  it('--create: a LOGIN NOBYPASSRLS role with the grants and default privileges, in one transaction', async () => {
    process.env.TENANCY_APP_ROLE_PASSWORD = "s3cret'quote";
    answer(false);
    await run('--create');

    expect(vi.mocked(Client)).toHaveBeenCalledWith({
      connectionString: 'postgresql://owner:pw@localhost:5432/db',
    });
    const [begin, createRole, ...rest] = statements();
    expect(begin).toBe('BEGIN');
    // The password never appears: what is sent is its SCRAM-SHA-256 verifier.
    expect(createRole).toMatch(
      /^CREATE ROLE "sunrise_app" WITH LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '/
    );
    expect(createRole).not.toContain('s3cret');
    expect(createRole.slice(createRole.indexOf("PASSWORD '") + 10, -1)).toMatch(SCRAM);
    expect(rest).toEqual([
      'GRANT USAGE ON SCHEMA "public" TO "sunrise_app"',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "sunrise_app"',
      'REVOKE ALL ON "public"."_prisma_migrations" FROM "sunrise_app"',
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "sunrise_app"',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "sunrise_app"',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT USAGE, SELECT ON SEQUENCES TO "sunrise_app"',
      'COMMIT',
    ]);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('--create on an existing role resets it instead of failing, under the name TENANCY_APP_ROLE gives', async () => {
    process.env.TENANCY_APP_ROLE = 'acme_app';
    process.env.TENANCY_APP_ROLE_PASSWORD = 'pw';
    answer(true);
    await run('--create');
    // No SUPERUSER / BYPASSRLS words on ALTER: mentioning either needs a
    // superuser (a CREATEROLE owner on Neon/RDS is refused), and the guard
    // already proved the role is neither.
    expect(statements()[1]).toMatch(
      /^ALTER ROLE "acme_app" WITH LOGIN NOCREATEDB NOCREATEROLE PASSWORD 'SCRAM-SHA-256\$4096:/
    );
    expect(statements()[1]).not.toMatch(/SUPERUSER|BYPASSRLS/);
    expect(statements().some((s) => s.startsWith('CREATE ROLE'))).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('--create refuses on a database the migrations have not reached (the ledger would be granted later)', async () => {
    process.env.TENANCY_APP_ROLE_PASSWORD = 'pw';
    ledger = false;
    answer(false);
    await run('--create');
    ledger = true;
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('db:migrate:deploy'));
    expect(statements()).not.toContain('COMMIT');
    expect(statements().at(-1)).toBe('ROLLBACK');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('treats a blank MIGRATE_DATABASE_URL as unset rather than handing pg an empty string', async () => {
    process.env.TENANCY_APP_ROLE_PASSWORD = 'pw';
    process.env.MIGRATE_DATABASE_URL = '';
    answer(false);
    await run('--create');
    expect(vi.mocked(Client)).toHaveBeenCalledWith({
      connectionString: 'postgresql://app:pw@localhost:5432/db',
    });
  });

  it('--drop: revokes default privileges and every grant before DROP ROLE', async () => {
    answer(true);
    await run('--drop');
    expect(statements()).toEqual([
      'BEGIN',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL ON TABLES FROM "sunrise_app"',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "sunrise_app"',
      'REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM "sunrise_app"',
      'REVOKE ALL ON ALL SEQUENCES IN SCHEMA "public" FROM "sunrise_app"',
      'REVOKE ALL ON SCHEMA "public" FROM "sunrise_app"',
      'DROP ROLE "sunrise_app"',
      'COMMIT',
    ]);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('--drop on an absent role is a no-op that still exits 0', async () => {
    answer(false);
    await run('--drop');
    expect(statements()).toEqual(['BEGIN', 'COMMIT']);
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('absent'));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 2 without connecting for a missing password, both flags, neither flag, or a bad role name', async () => {
    for (const [args, envPatch, message] of [
      [['--create'], {}, 'TENANCY_APP_ROLE_PASSWORD'],
      [['--create', '--drop'], { TENANCY_APP_ROLE_PASSWORD: 'x' }, 'exactly one'],
      [[], {}, 'exactly one'],
      [
        ['--create'],
        { TENANCY_APP_ROLE_PASSWORD: 'x', TENANCY_APP_ROLE: 'Drop Table;' },
        'must match',
      ],
    ] as const) {
      vi.resetModules();
      exitSpy.mockClear();
      mockError.mockClear();
      Object.assign(process.env, envPatch);
      await run(...args);
      expect(mockConnect).not.toHaveBeenCalled();
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining(message));
      expect(exitSpy).toHaveBeenCalledWith(2);
    }
  });

  it('refuses to touch the connecting role, a superuser, a BYPASSRLS role or a table owner', async () => {
    for (const [privilege, why] of [
      [{ is_self: true }, 'the role running this script'],
      [{ is_super: true }, 'a superuser'],
      [{ bypasses: true }, 'BYPASSRLS'],
      [{ owns_tables: true }, 'owns tables'],
    ] as const) {
      for (const action of ['--create', '--drop'] as const) {
        vi.resetModules();
        vi.clearAllMocks();
        mockConnect.mockResolvedValue(undefined);
        mockEnd.mockResolvedValue(undefined);
        process.env.TENANCY_APP_ROLE_PASSWORD = 'pw';
        answer(true, privilege);
        await run(action);
        expect(mockError).toHaveBeenCalledWith(expect.stringContaining(why));
        expect(statements()).toEqual(['BEGIN', 'ROLLBACK']);
        expect(exitSpy).toHaveBeenCalledWith(2);
      }
    }
  });

  it('rolls back and exits 2 when a statement fails', async () => {
    process.env.TENANCY_APP_ROLE_PASSWORD = 'pw';
    answer(false);
    const base = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation((sql: string) =>
      sql.startsWith('CREATE ROLE') ? Promise.reject(new Error('permission denied')) : base(sql)
    );
    await run('--create');
    expect(mockQuery.mock.calls.map((c) => c[0])).toContain('ROLLBACK');
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
