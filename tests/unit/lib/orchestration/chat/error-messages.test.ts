import { describe, it, expect } from 'vitest';

import { getUserFacingError } from '@/lib/orchestration/chat/error-messages';

describe('getUserFacingError', () => {
  const KNOWN_CODES = [
    'budget_exceeded',
    'all_providers_exhausted',
    'agent_not_found',
    'conversation_not_found',
    'tool_loop_cap',
    'internal_error',
    'stream_error',
    'rate_limited',
  ];

  it.each(KNOWN_CODES)('returns structured error for "%s"', (code) => {
    const result = getUserFacingError(code);
    expect(result.title).toBeTruthy();
    expect(result.message).toBeTruthy();
    expect(typeof result.title).toBe('string');
    expect(typeof result.message).toBe('string');
  });

  it('returns action string for budget_exceeded', () => {
    const result = getUserFacingError('budget_exceeded');
    expect(result.action).toBeTruthy();
    expect(result.action).toContain('admin');
  });

  it('returns action string for all_providers_exhausted', () => {
    const result = getUserFacingError('all_providers_exhausted');
    expect(result.action).toBeTruthy();
  });

  it('falls back to internal_error for unknown codes', () => {
    const result = getUserFacingError('some_weird_code');
    const internal = getUserFacingError('internal_error');
    expect(result).toEqual(internal);
  });

  it('falls back to internal_error for empty string', () => {
    const result = getUserFacingError('');
    const internal = getUserFacingError('internal_error');
    expect(result).toEqual(internal);
  });

  it('never returns empty title or message', () => {
    for (const code of KNOWN_CODES) {
      const result = getUserFacingError(code);
      expect(result.title.length).toBeGreaterThan(0);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});
