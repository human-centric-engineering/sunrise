/**
 * Tests for `lib/orchestration/scope.ts`.
 *
 * `resolvePersistedScope` is the validate-on-read guard for the persisted
 * `AiWorkflow*.scope` JSON columns. It must:
 *   - return a valid flat string→string map unchanged
 *   - return undefined (never throw) for null/undefined columns
 *   - drop a malformed value to undefined AND log a warning with the caller's
 *     context, so a hand-edited row can never wedge a run
 *
 * `foldScopeIntoArgs` is the other half (#586): it makes the carrier ambient in
 * a capability's arguments — fill a declared parameter the caller omitted,
 * refuse a call that names a different value. Its interesting cases are the
 * ones a plain `properties[key]` / `args[key] = value` implementation gets
 * wrong: inherited `Object.prototype` keys, `__proto__`, and type coercion.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  assertScopeHeld,
  foldScopeIntoArgs,
  resolvePersistedScope,
} from '@/lib/orchestration/scope';
import { logger } from '@/lib/logging';

describe('resolvePersistedScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a valid flat string→string scope unchanged', () => {
    const scope = { projectId: 'proj-42', tenant: 'acme' };
    expect(resolvePersistedScope(scope, { executionId: 'e1' })).toEqual(scope);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns an empty object for an empty (but valid) map', () => {
    // `{}` is a valid string→string map — the caller decides whether an empty
    // scope is meaningful; the helper does not collapse it to undefined.
    expect(resolvePersistedScope({}, { executionId: 'e1' })).toEqual({});
  });

  it('returns undefined for a null column without logging', () => {
    expect(resolvePersistedScope(null, { scheduleId: 's1' })).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns undefined for an undefined column without logging', () => {
    expect(resolvePersistedScope(undefined, { scheduleId: 's1' })).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('drops a scope with non-string values and warns with the caller context', () => {
    const result = resolvePersistedScope({ projectId: 42 }, { triggerId: 't1' });
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'Dropped malformed persisted workflow scope',
      expect.objectContaining({ triggerId: 't1', issues: expect.any(Number) })
    );
  });

  it('drops a non-object scope value (array / primitive) and warns', () => {
    expect(resolvePersistedScope(['a', 'b'], { executionId: 'e1' })).toBeUndefined();
    expect(resolvePersistedScope('nope', { executionId: 'e1' })).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('warns via the supplied logger (preserving its bound context), not the default', () => {
    // The engine passes a context-bound baseLogger (workflowId/userId) so the
    // malformed-drop warning keeps correlation; verify the override is honoured.
    const customLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = resolvePersistedScope(
      { projectId: 42 },
      { executionId: 'e1' },
      customLogger as never
    );

    expect(result).toBeUndefined();
    expect(customLogger.warn).toHaveBeenCalledWith(
      'Dropped malformed persisted workflow scope',
      expect.objectContaining({ executionId: 'e1' })
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('foldScopeIntoArgs', () => {
  const scopedBy = ['projectId'];

  it('fills a bound parameter the caller omitted', () => {
    expect(foldScopeIntoArgs({ query: 'hi' }, { projectId: 'p1' }, scopedBy)).toEqual({
      ok: true,
      args: { query: 'hi', projectId: 'p1' },
      filled: ['projectId'],
      unpinned: [],
    });
  });

  it.each([[undefined], [null], ['']])('treats %p as absent and fills it', (supplied) => {
    const result = foldScopeIntoArgs({ projectId: supplied }, { projectId: 'p1' }, scopedBy);
    expect(result.ok && (result.args as Record<string, unknown>).projectId).toBe('p1');
  });

  it('leaves a matching value alone and allocates nothing', () => {
    const args = { projectId: 'p1' };
    const result = foldScopeIntoArgs(args, { projectId: 'p1' }, scopedBy);
    expect(result).toEqual({ ok: true, args, filled: [], unpinned: [] });
    // Same object, not a copy — the common path must not churn.
    expect(result.ok && result.args).toBe(args);
  });

  it('refuses a call that names a different value', () => {
    expect(foldScopeIntoArgs({ projectId: 'other' }, { projectId: 'p1' }, scopedBy)).toEqual({
      ok: false,
      conflicts: [{ key: 'projectId', expected: 'p1' }],
    });
  });

  it('refuses the whole call when one key conflicts and another would fill', () => {
    // A partially-scoped dispatch is the shape this exists to prevent.
    const result = foldScopeIntoArgs({ projectId: 'other' }, { projectId: 'p1', tenantId: 't1' }, [
      'projectId',
      'tenantId',
    ]);
    expect(result.ok).toBe(false);
  });

  it('never mutates the caller’s arguments', () => {
    const args = { query: 'hi' };
    foldScopeIntoArgs(args, { projectId: 'p1' }, scopedBy);
    expect(args).toEqual({ query: 'hi' });
  });

  describe('the binding is what applies, not the shape of the scope map', () => {
    it('ignores a scope key the capability did not declare', () => {
      const args = { query: 'hi' };
      // The whole point of the rewrite: an undeclared key is not this
      // capability's business, however the caller got it into their scope.
      expect(foldScopeIntoArgs(args, { tenantId: 't1' }, scopedBy)).toEqual({
        ok: true,
        args,
        filled: [],
        unpinned: ['projectId'],
      });
    });

    it('reports a declared key the caller’s scope does not pin', () => {
      // An unscoped service key is a deliberate configuration
      // (`McpApiKey.scope = NULL` means system-wide), so this is reported for
      // the dispatcher to log rather than refused here.
      const result = foldScopeIntoArgs({ query: 'hi' }, {}, scopedBy);
      expect(result).toEqual({
        ok: true,
        args: { query: 'hi' },
        filled: [],
        unpinned: ['projectId'],
      });
    });

    it('does not treat an inherited Object.prototype key as pinned', () => {
      // `scope['toString']` is truthy on every object literal.
      const result = foldScopeIntoArgs({ query: 'hi' }, {}, ['toString']);
      expect(result).toEqual({
        ok: true,
        args: { query: 'hi' },
        filled: [],
        unpinned: ['toString'],
      });
    });
  });

  describe('comparison is strict', () => {
    it.each([
      ['a number that stringifies equal', 5, { projectId: '5' }],
      ['a boolean', true, { projectId: 'true' }],
    ])('refuses %s', (_label, supplied, scope) => {
      expect(foldScopeIntoArgs({ projectId: supplied }, scope, scopedBy).ok).toBe(false);
    });

    it('refuses an object whose toString() would match', () => {
      // Coercing here would let any caller satisfy a tenant check.
      const evil = { toString: () => 'p1' };
      expect(foldScopeIntoArgs({ projectId: evil }, { projectId: 'p1' }, scopedBy).ok).toBe(false);
    });
  });

  it.each([
    ['a string', 'hello'],
    ['an array', [1, 2]],
    ['null', null],
    ['undefined', undefined],
  ])('passes %s through unchanged rather than inventing an object', (_label, args) => {
    // `assertScopeHeld` refuses it after validation; building an object here
    // would turn a request the schema might refuse into one it accepts.
    expect(foldScopeIntoArgs(args, { projectId: 'p1' }, scopedBy)).toEqual({
      ok: true,
      args,
      filled: [],
      unpinned: [],
    });
  });

  it('sets a `__proto__` binding as an own property, not a prototype', () => {
    // Both fixtures come from `JSON.parse`, because an object LITERAL cannot
    // express this: `{ __proto__: x }` sets the prototype and creates no key.
    // `JSON.parse` does create an own property, and that is how the scope
    // really arrives — out of `McpApiKey.scope`.
    const protoScope = JSON.parse('{"__proto__":"p1"}') as Record<string, string>;
    expect(Object.prototype.hasOwnProperty.call(protoScope, '__proto__')).toBe(true);

    const result = foldScopeIntoArgs({}, protoScope, ['__proto__']);

    expect(result.ok).toBe(true);
    const args = (result as { args: Record<string, unknown> }).args;
    expect(Object.prototype.hasOwnProperty.call(args, '__proto__')).toBe(true);
    expect(args.__proto__).toBe('p1');
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
  });

  it('is a no-op for a capability that declared no binding', () => {
    const args = { query: 'hi' };
    expect(foldScopeIntoArgs(args, { projectId: 'p1' }, [])).toEqual({
      ok: true,
      args,
      filled: [],
      unpinned: [],
    });
  });
});

describe('assertScopeHeld', () => {
  const scope = { projectId: 'A' };
  const scopedBy = ['projectId'];

  it('holds when the bound key survived validation unchanged', () => {
    expect(assertScopeHeld({ projectId: 'A', q: 'x' }, scope, scopedBy)).toEqual({ held: true });
  });

  it('refuses a value a schema transform put back', () => {
    // The bypass this exists for: the fold wrote 'A', a `z.preprocess` merged
    // the caller's 'B' over it, and no conflict was raised at fold time
    // because the top-level key had been absent.
    expect(assertScopeHeld({ projectId: 'B' }, scope, scopedBy)).toEqual({
      held: false,
      reason: 'conflict',
      keys: ['projectId'],
    });
  });

  it('refuses when validation stripped the bound key entirely', () => {
    // `z.object()` strips unknown keys. A capability that DECLARES a binding
    // its schema does not accept would otherwise dispatch with the
    // discriminator gone — a list capability returning every project's rows,
    // under a boundary reporting success. Demanding presence is only possible
    // because the binding was declared; the inferred design could not know.
    expect(assertScopeHeld({ q: 'x' }, scope, scopedBy)).toEqual({
      held: false,
      reason: 'unenforceable',
    });
  });

  it('does not coerce — a number that stringifies equal is still a conflict', () => {
    expect(assertScopeHeld({ projectId: 5 }, { projectId: '5' }, scopedBy)).toEqual({
      held: false,
      reason: 'conflict',
      keys: ['projectId'],
    });
  });

  it('holds when the caller’s scope pins nothing this capability is bound by', () => {
    // An unscoped service key: nothing to assert.
    expect(assertScopeHeld({ q: 'x' }, {}, scopedBy)).toEqual({ held: true });
  });

  it('holds for a capability that declared no binding', () => {
    expect(assertScopeHeld('anything at all', scope, [])).toEqual({ held: true });
  });

  describe('"cannot look" is decided by reachability, not by typeof', () => {
    class GetterArgs {
      readonly #projectId: string;
      constructor(projectId: string) {
        this.#projectId = projectId;
      }
      get projectId(): string {
        return this.#projectId;
      }
    }

    it.each([
      ['an array', [{ projectId: 'B' }]],
      ['a string', 'hello'],
      ['null', null],
      // Every one of these is `typeof === 'object'` and answers
      // `hasOwnProperty('projectId')` with FALSE, so a typeof-gated check read
      // them as "no such key, invariant holds" while `execute` read 'B'.
      ['a Map', new Map([['projectId', 'B']])],
      ['a URLSearchParams', new URLSearchParams({ projectId: 'B' })],
      ['a class instance behind a getter', new GetterArgs('B')],
      [
        'a plain object with an accessor',
        Object.defineProperty({}, 'projectId', { get: () => 'B', enumerable: true }),
      ],
    ])('fails closed on %s', (_label, validated) => {
      expect(assertScopeHeld(validated, scope, scopedBy)).toEqual({
        held: false,
        reason: 'unenforceable',
      });
    });

    it('still reads a null-prototype object, which is genuinely readable', () => {
      const args = Object.assign(Object.create(null) as Record<string, unknown>, {
        projectId: 'A',
      });
      expect(assertScopeHeld(args, scope, scopedBy)).toEqual({ held: true });
    });
  });
});
