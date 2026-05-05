/**
 * Unit tests for attribute key constants.
 *
 * This module guards against typos that silently misalign Sunrise spans
 * from OTEL GenAI semantic conventions. Two test strategies:
 *
 * 1. Regex shape — all GEN_AI_* and SUNRISE_* keys must conform to their
 *    namespace patterns. A typo like `gen-ai.system` or `gen_ai.System`
 *    fails the regex and surfaces immediately.
 *
 * 2. Stable-string snapshot — SPAN_* constants are tested with exact value
 *    assertions. A rename (e.g. SPAN_LLM_CALL → 'llm_call') is caught at
 *    test time before it silently misaligns downstream consumers.
 *
 * No mocking required — pure constant module.
 */

import { describe, expect, it } from 'vitest';

import * as attrs from '@/lib/orchestration/tracing/attributes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract all exported constants whose names match a given prefix. */
function exportedByPrefix(prefix: string): Array<[string, unknown]> {
  return Object.entries(attrs).filter(([key]) => key.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// 1. GEN_AI_* namespace shape
// ---------------------------------------------------------------------------

describe('GEN_AI_* attribute keys', () => {
  // Pattern from the OTEL GenAI semantic convention:
  //   gen_ai.<lower_snake_or_dot_path>
  // - starts with "gen_ai."
  // - followed by at least one lowercase letter
  // - interior chars: lowercase letters, digits, dots, underscores
  // - ends with a lowercase letter or digit (no trailing dot/underscore)
  const GEN_AI_PATTERN = /^gen_ai\.[a-z][a-z0-9_.]*[a-z0-9]$/;

  it('all GEN_AI_* constants match the OTEL GenAI namespace pattern', () => {
    // Arrange
    const genAiEntries = exportedByPrefix('GEN_AI_');
    expect(genAiEntries.length).toBeGreaterThan(0); // sanity: at least one exported

    // Act + Assert — each value must satisfy the regex
    for (const [exportName, value] of genAiEntries) {
      expect(
        typeof value === 'string' && GEN_AI_PATTERN.test(value),
        `${exportName}="${String(value)}" does not match ${GEN_AI_PATTERN}`
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. SUNRISE_* namespace shape
// ---------------------------------------------------------------------------

describe('SUNRISE_* attribute keys', () => {
  // Same structural contract as GEN_AI but with "sunrise." prefix.
  const SUNRISE_PATTERN = /^sunrise\.[a-z][a-z0-9_.]*[a-z0-9]$/;

  it('all SUNRISE_* constants match the Sunrise extension namespace pattern', () => {
    // Arrange
    const sunriseEntries = exportedByPrefix('SUNRISE_');
    expect(sunriseEntries.length).toBeGreaterThan(0); // sanity

    // Act + Assert
    for (const [exportName, value] of sunriseEntries) {
      expect(
        typeof value === 'string' && SUNRISE_PATTERN.test(value),
        `${exportName}="${String(value)}" does not match ${SUNRISE_PATTERN}`
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. SPAN_* stable string snapshots
//    A rename is caught here before it silently misaligns downstream consumers.
// ---------------------------------------------------------------------------

describe('SPAN_* span name constants — stable string values', () => {
  it('SPAN_WORKFLOW_EXECUTE is "workflow.execute"', () => {
    expect(attrs.SPAN_WORKFLOW_EXECUTE).toBe('workflow.execute');
  });

  it('SPAN_WORKFLOW_STEP is "workflow.step"', () => {
    expect(attrs.SPAN_WORKFLOW_STEP).toBe('workflow.step');
  });

  it('SPAN_LLM_CALL is "llm.call"', () => {
    expect(attrs.SPAN_LLM_CALL).toBe('llm.call');
  });

  it('SPAN_AGENT_CALL_TURN is "agent_call.turn"', () => {
    expect(attrs.SPAN_AGENT_CALL_TURN).toBe('agent_call.turn');
  });

  it('SPAN_CAPABILITY_DISPATCH is "capability.dispatch"', () => {
    expect(attrs.SPAN_CAPABILITY_DISPATCH).toBe('capability.dispatch');
  });

  it('SPAN_CHAT_TURN is "chat.turn"', () => {
    expect(attrs.SPAN_CHAT_TURN).toBe('chat.turn');
  });

  it('SPAN_TOOL_LOOP_ITERATION is "chat.tool_loop_iteration"', () => {
    expect(attrs.SPAN_TOOL_LOOP_ITERATION).toBe('chat.tool_loop_iteration');
  });
});

// ---------------------------------------------------------------------------
// 4. MAX_ATTRIBUTE_STRING_LENGTH value
//    The truncateAttribute helper depends on this constant being exactly 1024.
// ---------------------------------------------------------------------------

describe('MAX_ATTRIBUTE_STRING_LENGTH', () => {
  it('is exactly 1024 — the truncateAttribute helper depends on this value', () => {
    expect(attrs.MAX_ATTRIBUTE_STRING_LENGTH).toBe(1024);
  });
});
