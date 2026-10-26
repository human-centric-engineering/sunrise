/**
 * Tests for BaseCapability's validate / success / error helpers.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  BaseCapability,
  CapabilityValidationError,
} from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

const schema = z.object({ n: z.number().int().min(1) });
type Args = z.infer<typeof schema>;
interface Data {
  doubled: number;
}

class WithSchema extends BaseCapability<Args, Data> {
  readonly slug = 'with_schema';
  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'with_schema',
    description: '',
    parameters: {},
  };
  protected readonly schema = schema;

  async execute(args: Args, _context: CapabilityContext): Promise<CapabilityResult<Data>> {
    return this.success({ doubled: args.n * 2 });
  }

  // Expose protected helpers for assertions.
  publicSuccess(data: Data, opts?: { skipFollowup?: boolean }) {
    return this.success(data, opts);
  }
  publicError(message: string, code?: string) {
    return this.error(message, code);
  }
}

class PassthroughSchema extends BaseCapability<unknown, { echoed: unknown }> {
  readonly slug = 'passthrough_schema';
  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'passthrough_schema',
    description: '',
    parameters: {},
  };
  // Explicit opt-in to accepting arbitrary args — proves that even
  // "anything goes" capabilities must declare a schema.
  protected readonly schema = z.unknown();

  async execute(args: unknown) {
    return this.success({ echoed: args });
  }
}

describe('BaseCapability.validate', () => {
  it('returns typed args on valid input', () => {
    const cap = new WithSchema();
    const result = cap.validate({ n: 5 });
    expect(result).toEqual({ n: 5 });
  });

  it('throws CapabilityValidationError with issues on invalid input', () => {
    const cap = new WithSchema();
    expect(() => cap.validate({ n: 'not-a-number' })).toThrow(CapabilityValidationError);
    try {
      cap.validate({ n: 0 });
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityValidationError);
      expect((err as CapabilityValidationError).issues.length).toBeGreaterThan(0);
    }
  });

  it('accepts arbitrary args when the schema is z.unknown()', () => {
    const cap = new PassthroughSchema();
    const raw = { anything: 123 };
    expect(cap.validate(raw)).toEqual(raw);
  });
});

describe('BaseCapability helpers', () => {
  it('success() returns success shape without skipFollowup by default', () => {
    const cap = new WithSchema();
    const result = cap.publicSuccess({ doubled: 4 });
    expect(result).toEqual({ success: true, data: { doubled: 4 } });
    expect(result).not.toHaveProperty('skipFollowup');
  });

  it('success() preserves skipFollowup when supplied', () => {
    const cap = new WithSchema();
    const result = cap.publicSuccess({ doubled: 4 }, { skipFollowup: true });
    expect(result).toEqual({ success: true, data: { doubled: 4 }, skipFollowup: true });
  });

  it('error() returns an error shape with default code', () => {
    const cap = new WithSchema();
    const result = cap.publicError('broken');
    expect(result).toEqual({
      success: false,
      error: { code: 'capability_error', message: 'broken' },
    });
  });

  it('error() accepts a custom code', () => {
    const cap = new WithSchema();
    const result = cap.publicError('not found', 'not_found');
    expect(result.error?.code).toBe('not_found');
  });
});

describe('BaseCapability.processesPii and redactProvenance defaults', () => {
  it('defaults processesPii to false', () => {
    const cap = new WithSchema();
    expect(cap.processesPii).toBe(false);
  });

  it('redactProvenance returns args verbatim by default', () => {
    const cap = new WithSchema();
    const args: Args = { n: 7 };
    const result: CapabilityResult<Data> = { success: true, data: { doubled: 14 } };
    const redacted = cap.redactProvenance(args, result);
    expect(redacted.args).toEqual({ n: 7 });
  });

  it('redactProvenance produces a JSON-stringified result preview by default', () => {
    const cap = new WithSchema();
    const result: CapabilityResult<Data> = { success: true, data: { doubled: 14 } };
    const redacted = cap.redactProvenance({ n: 7 }, result);
    expect(redacted.resultPreview).toBe('{"success":true,"data":{"doubled":14}}');
  });

  it('redactProvenance truncates oversized previews with an ellipsis', () => {
    const cap = new PassthroughSchema();
    const huge = 'x'.repeat(5000);
    const result: CapabilityResult<{ echoed: unknown }> = {
      success: true,
      data: { echoed: huge },
    };
    const redacted = cap.redactProvenance({ anything: 'whatever' }, result);
    expect(redacted.resultPreview.length).toBe(480);
    expect(redacted.resultPreview.endsWith('…')).toBe(true);
  });

  it('redactProvenance falls back gracefully on non-serialisable results', () => {
    const cap = new WithSchema();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // The default implementation should not throw on a cyclic input —
    // it falls back to String(result), which produces "[object Object]".
    expect(() =>
      cap.redactProvenance({ n: 1 }, cyclic as unknown as CapabilityResult<Data>)
    ).not.toThrow();
  });
});

describe('CapabilityValidationError instanceof', () => {
  it('rejects an ordinary error that carries an issues array', () => {
    const lookalike = Object.assign(new Error('Capability argument validation failed'), {
      issues: [],
    });
    expect(lookalike instanceof CapabilityValidationError).toBe(false);
    const nothing: unknown = null;
    expect(nothing instanceof CapabilityValidationError).toBe(false);
  });

  it('rejects a plain-object copy of a real one', () => {
    const copy: unknown = { ...new CapabilityValidationError([]) };
    expect(copy instanceof CapabilityValidationError).toBe(false);
  });

  it('keeps the prototype check for a subclass, so a sibling error is not one', () => {
    class NarrowerError extends CapabilityValidationError {}
    expect(new NarrowerError([]) instanceof NarrowerError).toBe(true);
    expect(new NarrowerError([]) instanceof CapabilityValidationError).toBe(true);
    expect(new CapabilityValidationError([]) instanceof NarrowerError).toBe(false);
  });
});
