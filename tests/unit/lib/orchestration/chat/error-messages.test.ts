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
    'input_blocked',
    'output_blocked',
    'conversation_length_cap_reached',
    'conversation_cap_reached',
    'provider_not_found',
    'provider_disabled',
    'missing_api_key',
    'missing_base_url',
    'unknown_provider_type',
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

  it('returns distinct messages for input_blocked vs output_blocked', () => {
    const input = getUserFacingError('input_blocked');
    const output = getUserFacingError('output_blocked');
    expect(input.title).not.toBe(output.title);
  });

  it('returns actionable provider setup messages', () => {
    const notFound = getUserFacingError('provider_not_found');
    expect(notFound.title).toContain('No Provider');
    expect(notFound.action).toContain('Providers');

    const disabled = getUserFacingError('provider_disabled');
    expect(disabled.title).toContain('Disabled');

    const missingKey = getUserFacingError('missing_api_key');
    expect(missingKey.title).toContain('API Key');
    expect(missingKey.action).toContain('API key');
  });

  it('returns conversation-specific messages for cap errors', () => {
    const lengthCap = getUserFacingError('conversation_length_cap_reached');
    const convCap = getUserFacingError('conversation_cap_reached');
    expect(lengthCap.message).toContain('maximum number of messages');
    expect(convCap.message).toContain('maximum number of conversations');
  });

  it('never returns empty title or message', () => {
    for (const code of KNOWN_CODES) {
      const result = getUserFacingError(code);
      expect(result.title.length).toBeGreaterThan(0);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});
