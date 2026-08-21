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
  /** A tool declaring `projectId` and `query`, as a capability's JSON Schema. */
  const parameters = {
    type: 'object',
    properties: { projectId: { type: 'string' }, query: { type: 'string' } },
  };

  it('fills a declared parameter the caller omitted', () => {
    const result = foldScopeIntoArgs({ query: 'hi' }, { projectId: 'p1' }, parameters);
    expect(result).toEqual({
      ok: true,
      args: { query: 'hi', projectId: 'p1' },
      filled: ['projectId'],
    });
  });

  it.each([[undefined], [null], ['']])('treats %p as absent and fills it', (supplied) => {
    const result = foldScopeIntoArgs({ projectId: supplied }, { projectId: 'p1' }, parameters);
    expect(result.ok && (result.args as Record<string, unknown>).projectId).toBe('p1');
  });

  it('leaves a matching value alone and allocates nothing', () => {
    const args = { projectId: 'p1' };
    const result = foldScopeIntoArgs(args, { projectId: 'p1' }, parameters);
    expect(result).toEqual({ ok: true, args, filled: [] });
    // Same object, not a copy — the common path must not churn.
    expect(result.ok && result.args).toBe(args);
  });

  it('refuses a call that names a different value', () => {
    const result = foldScopeIntoArgs({ projectId: 'other' }, { projectId: 'p1' }, parameters);
    expect(result).toEqual({ ok: false, conflicts: [{ key: 'projectId', expected: 'p1' }] });
  });

  it('refuses the whole call when one key conflicts and another would fill', () => {
    // A partially-scoped dispatch is the shape this exists to prevent.
    const twoKeys = {
      type: 'object',
      properties: { projectId: { type: 'string' }, tenantId: { type: 'string' } },
    };
    const result = foldScopeIntoArgs(
      { projectId: 'other' },
      { projectId: 'p1', tenantId: 't1' },
      twoKeys
    );
    expect(result.ok).toBe(false);
  });

  it('never mutates the caller’s arguments', () => {
    const args = { query: 'hi' };
    foldScopeIntoArgs(args, { projectId: 'p1' }, parameters);
    expect(args).toEqual({ query: 'hi' });
  });

  describe('the "tool declares it" gate', () => {
    it('ignores a scope key the tool does not declare', () => {
      const args = { query: 'hi' };
      const result = foldScopeIntoArgs(args, { tenantId: 't1' }, parameters);
      // Untouched — injecting an undeclared key would break a `.strict()` schema
      // and silently widen tools keyed on some other id.
      expect(result).toEqual({ ok: true, args, filled: [] });
    });

    it('does not treat an inherited Object.prototype key as declared', () => {
      // `properties['toString']` is truthy on every object literal, so a
      // `properties[key] !== undefined` check folds `toString` into the args of
      // every tool in the system. `hasOwnProperty` is the whole difference.
      const result = foldScopeIntoArgs({ query: 'hi' }, { toString: 'gotcha' }, parameters);
      expect(result).toEqual({ ok: true, args: { query: 'hi' }, filled: [] });
    });

    it.each([
      [undefined],
      [null],
      ['not an object'],
      [{ properties: 'nope' }],
      [{ properties: [] }],
    ])('treats a malformed schema (%p) as declaring nothing', (malformed) => {
      const result = foldScopeIntoArgs({ query: 'hi' }, { projectId: 'p1' }, malformed);
      expect(result).toEqual({ ok: true, args: { query: 'hi' }, filled: [] });
    });
  });

  describe('comparison is strict', () => {
    it.each([
      ['a number that stringifies equal', 5, { projectId: '5' }],
      ['a boolean', true, { projectId: 'true' }],
    ])('refuses %s', (_label, supplied, scope) => {
      const result = foldScopeIntoArgs({ projectId: supplied }, scope, parameters);
      expect(result.ok).toBe(false);
    });

    it('refuses an object whose toString() would match', () => {
      // Coercing here would let any caller satisfy a tenant check.
      const evil = { toString: () => 'p1' };
      const result = foldScopeIntoArgs({ projectId: evil }, { projectId: 'p1' }, parameters);
      expect(result.ok).toBe(false);
    });
  });

  describe('shapes that cannot be folded', () => {
    it.each([
      ['a string', 'hello'],
      ['an array', [1, 2]],
      ['null', null],
      ['undefined', undefined],
    ])('passes %s through unchanged rather than inventing an object', (_label, args) => {
      // The capability's own schema rejects it one step later. Building an
      // object here would turn a request that is about to be refused into one
      // that is accepted.
      const result = foldScopeIntoArgs(args, { projectId: 'p1' }, parameters);
      expect(result).toEqual({ ok: true, args, filled: [] });
    });
  });

  it('sets a `__proto__` parameter as an own property, not a prototype', () => {
    // Both fixtures come from `JSON.parse`, because an object LITERAL cannot
    // express this: `{ __proto__: x }` sets the prototype and creates no key,
    // so a literal-built fixture tests nothing (the first version of this test
    // failed for exactly that reason). `JSON.parse` does create an own
    // property, and that is how both values really arrive — the schema from
    // `AiCapability.functionDefinition`, the scope from `McpApiKey.scope`.
    const protoSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}'
    );
    const protoScope = JSON.parse('{"__proto__":"p1"}') as Record<string, string>;
    expect(Object.prototype.hasOwnProperty.call(protoScope, '__proto__')).toBe(true);

    const result = foldScopeIntoArgs({}, protoScope, protoSchema);

    expect(result.ok).toBe(true);
    const args = (result as { args: Record<string, unknown> }).args;
    // `args['__proto__'] = value` would replace the prototype and create no
    // property, dispatching with the scope silently absent — the one outcome
    // this must never produce.
    expect(Object.prototype.hasOwnProperty.call(args, '__proto__')).toBe(true);
    expect(args.__proto__).toBe('p1');
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
  });

  it('is a no-op for an empty scope', () => {
    const args = { query: 'hi' };
    expect(foldScopeIntoArgs(args, {}, parameters)).toEqual({ ok: true, args, filled: [] });
  });
});

describe('assertScopeHeld', () => {
  const scope = { tenantId: 'A' };

  it('holds when the key survived validation unchanged', () => {
    expect(assertScopeHeld({ tenantId: 'A', q: 'x' }, scope)).toEqual({ held: true });
  });

  it('holds when the key is absent after validation', () => {
    // Validation dropped it, so `execute` never sees a tenant at all.
    expect(assertScopeHeld({ q: 'x' }, scope)).toEqual({ held: true });
  });

  it('refuses a value a schema transform put back', () => {
    // The bypass this exists for: the fold wrote 'A', a `z.preprocess` merged
    // the caller's 'B' over it, and no conflict was raised at fold time
    // because the top-level key had been absent.
    expect(assertScopeHeld({ tenantId: 'B' }, scope)).toEqual({
      held: false,
      reason: 'conflict',
      keys: ['tenantId'],
    });
  });

  it('refuses a key the capability never declared', () => {
    // Deliberately broader than the fold. A capability whose Zod surface
    // exceeds its published `functionDefinition` — core's own
    // `send_message_to_channel` accepts a `forceProvider` it does not declare —
    // would otherwise pass an unguarded value straight to `execute`.
    expect(assertScopeHeld({ tenantId: 'B' }, { tenantId: 'A' })).toEqual({
      held: false,
      reason: 'conflict',
      keys: ['tenantId'],
    });
  });

  describe('"cannot look" is decided by reachability, not by typeof', () => {
    class GetterArgs {
      readonly #tenantId: string;
      constructor(tenantId: string) {
        this.#tenantId = tenantId;
      }
      get tenantId(): string {
        return this.#tenantId;
      }
    }

    it.each([
      ['an array', [{ tenantId: 'B' }]],
      ['a string', 'hello'],
      ['null', null],
      // Every one of these is `typeof === 'object'` and answers
      // `hasOwnProperty('tenantId')` with FALSE, so the first version read them
      // as "no such key, invariant holds" while `execute` read 'B' out of them.
      ['a Map', new Map([['tenantId', 'B']])],
      ['a URLSearchParams', new URLSearchParams({ tenantId: 'B' })],
      ['a class instance behind a getter', new GetterArgs('B')],
      [
        'a plain object with an accessor',
        Object.defineProperty({}, 'tenantId', { get: () => 'B', enumerable: true }),
      ],
    ])('fails closed on %s, which carries no readable invariant', (_label, validated) => {
      expect(assertScopeHeld(validated, scope)).toEqual({ held: false, reason: 'unenforceable' });
    });

    it('still reads a null-prototype object, which is genuinely readable', () => {
      // `Object.create(null)` has no prototype but its own data properties are
      // right there — refusing it would be fail-closed for no reason.
      const args = Object.assign(Object.create(null) as Record<string, unknown>, {
        tenantId: 'A',
      });
      expect(assertScopeHeld(args, scope)).toEqual({ held: true });
    });
  });

  describe('a key the fold wrote must survive validation', () => {
    it('refuses when validation stripped the pin the fold had written', () => {
      // `z.object()` strips unknown keys by default, and the fold's gate reads
      // the admin-editable `functionDefinition` row — so "declared as a
      // parameter" and "accepted by the schema" are unrelated facts. Without
      // this, `execute` runs with the tenant discriminator ABSENT while the
      // boundary reports success.
      expect(assertScopeHeld({ resourceId: 'r1' }, scope, ['tenantId'])).toEqual({
        held: false,
        reason: 'unenforceable',
      });
    });

    it('holds when the pin survived', () => {
      expect(assertScopeHeld({ resourceId: 'r1', tenantId: 'A' }, scope, ['tenantId'])).toEqual({
        held: true,
      });
    });

    it('holds when nothing was filled and the capability has no such parameter', () => {
      // The absent-is-fine case this must not break: the caller never had a
      // tenant parameter, so there is nothing to hold.
      expect(assertScopeHeld({ resourceId: 'r1' }, scope, [])).toEqual({ held: true });
    });
  });

  it('does not coerce — a number that stringifies equal is still a conflict', () => {
    // Same reasoning as the fold's comparison: coercing here would let a caller
    // satisfy a tenant check with a value of the wrong type.
    expect(assertScopeHeld({ tenantId: 5 }, { tenantId: '5' })).toEqual({
      held: false,
      reason: 'conflict',
      keys: ['tenantId'],
    });
  });

  it('holds for an unscoped caller whatever the args look like', () => {
    // Vanilla Sunrise: no scope, so nothing to assert and nothing refused.
    expect(assertScopeHeld('anything at all', {})).toEqual({ held: true });
  });

  it('does not treat an inherited property as a surviving key', () => {
    expect(assertScopeHeld({ q: 'x' }, { toString: 'A' })).toEqual({ held: true });
  });
});
