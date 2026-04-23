/**
 * BaseCapability
 *
 * Abstract parent class for every built-in capability. Provides:
 * - Zod-backed argument validation via `validate()`
 * - Typed `success()` / `error()` helpers so subclasses never build
 *   `CapabilityResult` objects by hand
 *
 * `validate()` *throws* `CapabilityValidationError` rather than
 * returning a discriminated result, so the subclass's `execute()`
 * method can assume args are already typed. The dispatcher catches
 * the error and wraps it in a structured result.
 *
 * Platform-agnostic: no Next.js imports.
 */

import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
  CapabilitySchema,
} from '@/lib/orchestration/capabilities/types';

export abstract class BaseCapability<TArgs = unknown, TData = unknown> {
  abstract readonly slug: string;
  abstract readonly functionDefinition: CapabilityFunctionDefinition;

  /**
   * Required Zod schema. The dispatcher (via `validate`) runs it
   * before calling `execute`. Subclasses that want to accept arbitrary
   * arguments MUST opt in explicitly with `z.record(z.unknown())` or
   * similar — we never hand raw, LLM-supplied args to `execute`
   * unchecked.
   */
  protected abstract readonly schema: CapabilitySchema<TArgs>;

  abstract execute(args: TArgs, context: CapabilityContext): Promise<CapabilityResult<TData>>;

  /**
   * Validate raw args against the Zod schema. Returns typed args on
   * success, throws `CapabilityValidationError` on failure.
   */
  validate(rawArgs: unknown): TArgs {
    const result = this.schema.safeParse(rawArgs);
    if (!result.success) {
      throw new CapabilityValidationError(result.error.issues);
    }
    return result.data;
  }

  protected success<T extends TData>(
    data: T,
    opts?: { skipFollowup?: boolean }
  ): CapabilityResult<T> {
    if (opts?.skipFollowup !== undefined) {
      return { success: true, data, skipFollowup: opts.skipFollowup };
    }
    return { success: true, data };
  }

  protected error(message: string, code = 'capability_error'): CapabilityResult<never> {
    return { success: false, error: { code, message } };
  }
}

/**
 * Thrown by `BaseCapability.validate` when the supplied args don't
 * match the capability's Zod schema. The dispatcher catches this and
 * emits `{ success: false, error: { code: 'invalid_args', ... } }`.
 */
export class CapabilityValidationError extends Error {
  constructor(public readonly issues: unknown[]) {
    super('Capability argument validation failed');
    this.name = 'CapabilityValidationError';
  }
}
