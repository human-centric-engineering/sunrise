/**
 * Tests: `activeOrgId` is a session field only the server writes
 *
 * The `config-role-input.test.ts` shape, one table over. better-auth's public
 * `POST /api/auth/update-session` runs every declared session
 * `additionalField` through `parseSessionInput(…, 'update')` and writes what
 * survives to the caller's own row — no membership check, because the
 * library has no idea what the field means. So without `input: false` any
 * signed-in user could act in any org by naming it. This runs the library's
 * OWN parser over the REAL options, with a control that removes the one line
 * and watches the escalation come back.
 *
 * It also pins the two things the field's existence depends on and nothing
 * else asserts: the Prisma column the field maps to (t-669's migration —
 * a declared field with no column fails every session insert), and that the
 * server session type in `lib/auth/utils.ts`, which is inferred from these
 * options, now carries it — so `session.session.activeOrgId` type-checks in
 * a Server Component without a cast.
 *
 * @see lib/auth/config.ts — the `session.additionalFields.activeOrgId` declaration
 * @see app/api/v1/orgs/switch/route.ts — the one writer, and why it writes with Prisma
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { parseSessionInput } from 'better-auth/db';
import { getAuthTables } from '@better-auth/core/db';

vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'test',
    BETTER_AUTH_URL: 'http://localhost:3000',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    EMAIL_FROM: 'test@example.com',
    SIGNUP_MODE: 'open',
  },
  isProduction: () => false,
  isDevelopment: () => false,
  isTest: () => true,
}));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/email/client', () => ({ validateEmailConfig: vi.fn() }));

const { auth } = await import('@/lib/auth/config');

/**
 * What `POST /api/auth/update-session` would carry from a hostile client.
 * `parseSessionInput` is typed on the core session shape, which is exactly the
 * point — an additional field arrives from the wire, not from the type.
 */
type SessionInput = Parameters<typeof parseSessionInput>[1];
const VICTIM_ORG = 'cmorg0000000000000victim';
const hostileBody = { activeOrgId: VICTIM_ORG } as unknown as SessionInput;
const activeOrgOf = (parsed: unknown): unknown => (parsed as Record<string, unknown>).activeOrgId;

describe('activeOrgId on the session', () => {
  it('declares the field as not client-settable', () => {
    expect(auth.options.session?.additionalFields?.activeOrgId).toMatchObject({
      type: 'string',
      required: false,
      input: false,
    });
  });

  it("refuses the field on update — the public /update-session path, better-auth's own parser", () => {
    expect(() => parseSessionInput(auth.options, hostileBody, 'update')).toThrow(
      /activeOrgId is not allowed to be set/
    );
  });

  it('refuses the field on create as well — no defaultValue, so no silent replacement', () => {
    // On `user.role` a `defaultValue` turns a hostile create body into the
    // default; here there is none, and better-auth refuses outright. The
    // session hook, which runs after the parse, is what fills the field in.
    expect(() => parseSessionInput(auth.options, hostileBody, 'create')).toThrow(
      /activeOrgId is not allowed to be set/
    );
  });

  it('control: with input: false removed, the same parser hands the body its org', () => {
    // The assertions above are only evidence if this one is red.
    const { input: _removed, ...fieldWithoutGuard } =
      auth.options.session.additionalFields.activeOrgId;
    const weakened = {
      ...auth.options,
      session: { ...auth.options.session, additionalFields: { activeOrgId: fieldWithoutGuard } },
    };
    expect(activeOrgOf(parseSessionInput(weakened, hostileBody, 'update'))).toBe(VICTIM_ORG);
    expect(activeOrgOf(parseSessionInput(weakened, hostileBody, 'create'))).toBe(VICTIM_ORG);
  });

  it('is returned to callers, so the guards and the client can read it', () => {
    expect(auth.options.session?.additionalFields?.activeOrgId).not.toMatchObject({
      returned: false,
    });
  });

  it('maps to a column t-669 already put on Session (no migration in this task)', () => {
    // The field better-auth will write, and the Prisma column it lands in.
    const field = getAuthTables(auth.options).session.fields.activeOrgId;
    expect(field).toBeDefined();
    const column = field?.fieldName ?? 'activeOrgId';

    const schema = readFileSync(path.join(process.cwd(), 'prisma/schema/auth.prisma'), 'utf8');
    const session = /^model\s+Session\s*\{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? '';
    expect(session).toMatch(new RegExp(`^\\s*${column}\\s+String\\?`, 'm'));
  });

  it('reaches the inferred server session type for free (lib/auth/utils.ts)', () => {
    type ServerSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
    expectTypeOf<ServerSession['session']>().toHaveProperty('activeOrgId');
    expectTypeOf<ServerSession['session']['activeOrgId']>().toEqualTypeOf<
      string | null | undefined
    >();
  });
});
