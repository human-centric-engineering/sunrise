/**
 * Unit Test: interpolatePrompt
 *
 * Direct coverage for the template engine. The module is also exercised
 * transitively through `llm-runner`, `executors/guard`, `executors/agent-call`,
 * and the admin trace viewer's prompt-replay surface, but those tests
 * pin behaviour through wide integration paths — this file exists to
 * lock down each documented branch (`{{input}}`, `{{input.key}}`,
 * `{{previous.output}}`, `{{<stepId>.output}}`, `{{vars.path}}`, and
 * the flat `{{#if vars.path}}body{{/if}}` conditional) plus the two
 * stringification modes (`plain` and `markdown`).
 *
 * @see lib/orchestration/engine/interpolate-prompt.ts
 */

import { describe, it, expect } from 'vitest';
import {
  interpolatePrompt,
  type InterpolationContext,
} from '@/lib/orchestration/engine/interpolate-prompt';

function makeCtx(overrides: Partial<InterpolationContext> = {}): InterpolationContext {
  return {
    inputData: {},
    stepOutputs: {},
    variables: {},
    ...overrides,
  };
}

describe('interpolatePrompt', () => {
  describe('{{input}}', () => {
    it('inlines a primitive string input verbatim (no JSON quoting)', () => {
      const ctx = makeCtx({ inputData: 'hello world' as unknown as Record<string, unknown> });
      expect(interpolatePrompt('say: {{input}}', ctx)).toBe('say: hello world');
    });

    it('JSON-stringifies an object input', () => {
      const ctx = makeCtx({ inputData: { q: 'cats', n: 3 } });
      expect(interpolatePrompt('{{input}}', ctx)).toBe('{"q":"cats","n":3}');
    });

    it('resolves a top-level key via {{input.key}}', () => {
      const ctx = makeCtx({ inputData: { question: 'why?' } });
      expect(interpolatePrompt('Q: {{input.question}}', ctx)).toBe('Q: why?');
    });

    it('stringifies a nested object value at {{input.key}}', () => {
      const ctx = makeCtx({ inputData: { meta: { id: 1 } } });
      expect(interpolatePrompt('{{input.meta}}', ctx)).toBe('{"id":1}');
    });

    it('expands to empty string when {{input.key}} is missing', () => {
      const ctx = makeCtx({ inputData: { a: 1 } });
      expect(interpolatePrompt('[{{input.missing}}]', ctx)).toBe('[]');
    });
  });

  describe('{{previous.output}} and {{<stepId>.output}}', () => {
    it('resolves {{previous.output}} when previousStepId is provided', () => {
      const ctx = makeCtx({ stepOutputs: { step_a: 'first answer' } });
      expect(interpolatePrompt('prev: {{previous.output}}', ctx, 'step_a')).toBe(
        'prev: first answer'
      );
    });

    it('expands {{previous.output}} to empty string when previousStepId is undefined', () => {
      const ctx = makeCtx({ stepOutputs: { step_a: 'unused' } });
      expect(interpolatePrompt('[{{previous.output}}]', ctx)).toBe('[]');
    });

    it('resolves {{<stepId>.output}} for any step in stepOutputs', () => {
      const ctx = makeCtx({ stepOutputs: { lookup: 'found', other: 'X' } });
      expect(interpolatePrompt('R: {{lookup.output}}', ctx)).toBe('R: found');
    });

    it('JSON-stringifies a non-string step output', () => {
      const ctx = makeCtx({ stepOutputs: { plan: { steps: ['a', 'b'] } } });
      expect(interpolatePrompt('{{plan.output}}', ctx)).toBe('{"steps":["a","b"]}');
    });

    it('expands to empty string when the referenced stepId has no output', () => {
      const ctx = makeCtx({ stepOutputs: {} });
      expect(interpolatePrompt('[{{ghost.output}}]', ctx)).toBe('[]');
    });
  });

  describe('{{vars.path}}', () => {
    it('resolves a single-level vars reference', () => {
      const ctx = makeCtx({ variables: { name: 'Alice' } });
      expect(interpolatePrompt('Hi {{vars.name}}', ctx)).toBe('Hi Alice');
    });

    it('walks a multi-level dotted path', () => {
      const ctx = makeCtx({
        variables: { __retryContext: { failureReason: 'schema mismatch', attempt: 2 } },
      });
      expect(interpolatePrompt('reason: {{vars.__retryContext.failureReason}}', ctx)).toBe(
        'reason: schema mismatch'
      );
    });

    it('expands to empty string when the path overshoots a primitive', () => {
      const ctx = makeCtx({ variables: { count: 5 } });
      // `count.field` walks through a number, which the helper short-circuits
      // to undefined; the stringifier emits ''.
      expect(interpolatePrompt('[{{vars.count.field}}]', ctx)).toBe('[]');
    });

    it('expands to empty string when the path is entirely missing', () => {
      const ctx = makeCtx({ variables: {} });
      expect(interpolatePrompt('[{{vars.never.here}}]', ctx)).toBe('[]');
    });
  });

  describe('{{#if vars.path}}body{{/if}}', () => {
    it('includes the body when the value is a non-empty string', () => {
      const ctx = makeCtx({ variables: { flag: 'on' } });
      expect(interpolatePrompt('{{#if vars.flag}}YES{{/if}}', ctx)).toBe('YES');
    });

    it('omits the body when the value is the empty string', () => {
      const ctx = makeCtx({ variables: { flag: '' } });
      expect(interpolatePrompt('[{{#if vars.flag}}YES{{/if}}]', ctx)).toBe('[]');
    });

    it('omits the body when the value is zero', () => {
      const ctx = makeCtx({ variables: { count: 0 } });
      expect(interpolatePrompt('[{{#if vars.count}}YES{{/if}}]', ctx)).toBe('[]');
    });

    it('includes the body for any non-zero number', () => {
      const ctx = makeCtx({ variables: { count: 3 } });
      expect(interpolatePrompt('{{#if vars.count}}n={{vars.count}}{{/if}}', ctx)).toBe('n=3');
    });

    it('includes the body when the value is true', () => {
      const ctx = makeCtx({ variables: { ok: true } });
      expect(interpolatePrompt('{{#if vars.ok}}OK{{/if}}', ctx)).toBe('OK');
    });

    it('omits the body when the value is false', () => {
      const ctx = makeCtx({ variables: { ok: false } });
      expect(interpolatePrompt('[{{#if vars.ok}}OK{{/if}}]', ctx)).toBe('[]');
    });

    it('omits the body when the value is null', () => {
      const ctx = makeCtx({ variables: { x: null } });
      expect(interpolatePrompt('[{{#if vars.x}}YES{{/if}}]', ctx)).toBe('[]');
    });

    it('omits the body when the path resolves to undefined', () => {
      const ctx = makeCtx({ variables: {} });
      expect(interpolatePrompt('[{{#if vars.missing}}YES{{/if}}]', ctx)).toBe('[]');
    });

    it('includes the body when the value is a non-empty array', () => {
      const ctx = makeCtx({ variables: { items: [1, 2] } });
      expect(interpolatePrompt('{{#if vars.items}}HAS{{/if}}', ctx)).toBe('HAS');
    });

    it('omits the body when the value is an empty array', () => {
      const ctx = makeCtx({ variables: { items: [] } });
      expect(interpolatePrompt('[{{#if vars.items}}HAS{{/if}}]', ctx)).toBe('[]');
    });

    it('includes the body when the value is an object with at least one key', () => {
      const ctx = makeCtx({ variables: { obj: { a: 1 } } });
      expect(interpolatePrompt('{{#if vars.obj}}YES{{/if}}', ctx)).toBe('YES');
    });

    it('omits the body when the value is an empty object', () => {
      const ctx = makeCtx({ variables: { obj: {} } });
      expect(interpolatePrompt('[{{#if vars.obj}}YES{{/if}}]', ctx)).toBe('[]');
    });

    it('handles multiple flat conditionals on the same template', () => {
      const ctx = makeCtx({ variables: { a: 'on', b: false, c: 1 } });
      const tpl = '[{{#if vars.a}}A{{/if}}|{{#if vars.b}}B{{/if}}|{{#if vars.c}}C{{/if}}]';
      expect(interpolatePrompt(tpl, ctx)).toBe('[A||C]');
    });

    it('still interpolates references inside an included conditional body', () => {
      const ctx = makeCtx({ variables: { name: 'world', enabled: true } });
      expect(interpolatePrompt('{{#if vars.enabled}}hello {{vars.name}}{{/if}}', ctx)).toBe(
        'hello world'
      );
    });

    it('treats a non-vars expression in the conditional as falsy (omits body)', () => {
      // Conditionals only know how to evaluate `vars.<path>`. Anything
      // else evaluates to undefined → falsy → body omitted. This keeps
      // the conditional surface narrow and predictable.
      const ctx = makeCtx({ stepOutputs: { step_a: 'truthy' } });
      expect(interpolatePrompt('[{{#if step_a.output}}YES{{/if}}]', ctx)).toBe('[]');
    });
  });

  describe('unknown expression', () => {
    it('expands to empty string for an unrecognised expression', () => {
      const ctx = makeCtx();
      expect(interpolatePrompt('[{{nonsense}}]', ctx)).toBe('[]');
    });
  });

  describe('plain stringifier (default)', () => {
    it('emits numbers and booleans as their string form', () => {
      const ctx = makeCtx({ stepOutputs: { n: 42, b: true } });
      expect(interpolatePrompt('{{n.output}} / {{b.output}}', ctx)).toBe('42 / true');
    });

    it('returns "[unserializable]" for values JSON.stringify cannot handle', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const ctx = makeCtx({ stepOutputs: { loop: circular } });
      expect(interpolatePrompt('{{loop.output}}', ctx)).toBe('[unserializable]');
    });

    it('emits the empty string for null and undefined step outputs', () => {
      const ctx = makeCtx({ stepOutputs: { gone: undefined, also: null } });
      expect(interpolatePrompt('[{{gone.output}}][{{also.output}}]', ctx)).toBe('[][]');
    });
  });

  describe('markdown stringifier', () => {
    it('wraps an object value in a fenced ```json``` block', () => {
      const ctx = makeCtx({ stepOutputs: { plan: { steps: ['a', 'b'] } } });
      const out = interpolatePrompt('{{plan.output}}', ctx, undefined, { format: 'markdown' });
      expect(out).toContain('```json');
      expect(out).toContain('"steps"');
      expect(out).toContain('"a"');
      expect(out).toContain('```\n');
    });

    it('passes a primitive string through verbatim', () => {
      const ctx = makeCtx({ stepOutputs: { greet: 'hello' } });
      expect(interpolatePrompt('{{greet.output}}', ctx, undefined, { format: 'markdown' })).toBe(
        'hello'
      );
    });

    it('unwraps a string that is itself JSON-encoded structured data and renders it as JSON', () => {
      // Mirrors the reflect step's `finalDraft` pattern — the upstream
      // value is a JSON-stringified object; without the unwrap the
      // approval-queue markdown render would show escaped quotes.
      const encoded = JSON.stringify({ ok: true, items: ['x'] });
      const ctx = makeCtx({ stepOutputs: { reflect: encoded } });
      const out = interpolatePrompt('{{reflect.output}}', ctx, undefined, { format: 'markdown' });
      expect(out).toContain('```json');
      expect(out).toContain('"ok": true');
      expect(out).toContain('"items"');
    });

    it('leaves a non-JSON string starting with { as-is (parse failure path)', () => {
      // The leading `{` triggers a JSON.parse attempt; on failure the
      // helper falls through to the raw-string path. Important: the
      // operator's plain-text values that happen to start with `{` must
      // not vanish.
      const ctx = makeCtx({ stepOutputs: { note: '{not valid json' } });
      expect(interpolatePrompt('{{note.output}}', ctx, undefined, { format: 'markdown' })).toBe(
        '{not valid json'
      );
    });

    it('emits numbers and booleans as their string form in markdown mode too', () => {
      const ctx = makeCtx({ stepOutputs: { n: 7, flag: false } });
      const out = interpolatePrompt('{{n.output}}/{{flag.output}}', ctx, undefined, {
        format: 'markdown',
      });
      expect(out).toBe('7/false');
    });

    it('returns "[unserializable]" for values whose JSON.stringify throws in markdown mode', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const ctx = makeCtx({ stepOutputs: { loop: circular } });
      expect(interpolatePrompt('{{loop.output}}', ctx, undefined, { format: 'markdown' })).toBe(
        '[unserializable]'
      );
    });
  });
});
