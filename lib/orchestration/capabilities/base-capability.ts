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

/**
 * Shape returned by `redactProvenance()` — what gets persisted onto
 * `AiMessage.provenance.capabilityCalls[]`. Distinct from the live
 * `CapabilityResult` envelope the dispatcher returns to the LLM:
 * - `args` is the redacted form of the invocation arguments
 * - `resultPreview` is the truncated stringified form of the result
 *
 * The 480-char preview cap matches the historical `buildToolCallTrace`
 * truncation budget so audit rows stay well under the JSON column
 * size limit even when capabilities skip the override.
 */
export interface ProvenanceRedaction {
  args: unknown;
  resultPreview: string;
}

const PROVENANCE_PREVIEW_CAP = 480;

function defaultResultPreview(result: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(result);
  } catch {
    raw = String(result);
  }
  if (raw.length <= PROVENANCE_PREVIEW_CAP) return raw;
  return raw.slice(0, PROVENANCE_PREVIEW_CAP - 1) + '…';
}

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

  /**
   * Declarative flag: does this capability handle PII (emails, phones,
   * customer records, free-text user input, secret tokens) in its
   * arguments or results? When `true`, the registry refuses to register
   * the capability unless `redactProvenance` is overridden — forcing
   * authors to make an explicit decision about what gets persisted
   * onto durable audit rows.
   *
   * Default `false`. Capabilities that don't process PII can leave it
   * unset; setting `false` explicitly in a subclass is encouraged as
   * documentation but not required.
   */
  readonly processesPii: boolean = false;

  /**
   * Declarative flag: does this capability create, change or delete a shared
   * setting — a row of one of the `GLOBAL_CONFIG_MODELS`, which every org
   * reads (§107 t-751)? When `true`, the dispatcher refuses it at `multi`
   * outside the install org, before approval or execution, because any org's
   * workflow can reach a capability through a `tool_call` step.
   * `tests/unit/scripts/ci/shared-settings-writes.test.ts` fails naming a
   * capability class that writes one of those models without declaring it.
   */
  readonly writesSharedSettings: boolean = false;

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

  /**
   * Produce the redacted args + resultPreview that get persisted onto
   * the assistant message's `provenance.capabilityCalls[]` audit row.
   * The LLM still sees the un-redacted result (it needs the raw values
   * to do its job); only the durable audit record uses this output.
   *
   * Default behavior (no override): args are persisted verbatim, the
   * result is JSON-stringified and truncated to 480 chars. This
   * preserves today's behavior for non-PII capabilities.
   *
   * Subclasses with `processesPii = true` MUST override this method
   * — the registry refuses to load them otherwise. The override should
   * use the helpers in `lib/security/redact.ts` to mask domain-specific
   * fields (email, phone, bearer tokens, free-text input).
   *
   * Returning `{ args: redactedString(), resultPreview: redactedString() }`
   * is the nuclear option for capabilities whose inputs and outputs
   * cannot be safely persisted in any form.
   */
  redactProvenance(_args: TArgs, result: CapabilityResult<TData>): ProvenanceRedaction {
    return {
      args: _args,
      resultPreview: defaultResultPreview(result),
    };
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
