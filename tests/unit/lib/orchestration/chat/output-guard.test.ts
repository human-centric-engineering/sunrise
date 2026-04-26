/**
 * Tests for `lib/orchestration/chat/output-guard.ts`.
 *
 * Covers:
 *   - Topic boundary matching (case-insensitive, multiple matches)
 *   - Built-in PII detection (email, phone, SSN, credit card)
 *   - Clean output produces unflagged result
 *   - Empty boundaries list
 *   - Whitespace-only boundaries are ignored
 */

import { describe, expect, it } from 'vitest';
import { scanOutput } from '@/lib/orchestration/chat/output-guard';

describe('scanOutput', () => {
  it('returns unflagged for clean output with no boundaries', () => {
    const result = scanOutput('Here is a helpful answer about your question.', []);

    expect(result.flagged).toBe(false);
    expect(result.topicMatches).toEqual([]);
    expect(result.builtInMatches).toEqual([]);
  });

  it('detects a forbidden topic keyword', () => {
    const result = scanOutput('Our competitor Acme Corp offers a similar product.', [
      'competitor',
      'pricing strategy',
    ]);

    // test-review:accept tobe_true — boolean field `flagged` on OutputScanResult; structural assertion on scan outcome
    expect(result.flagged).toBe(true);
    expect(result.topicMatches).toContain('competitor');
    expect(result.topicMatches).not.toContain('pricing strategy');
  });

  it('matches topic boundaries case-insensitively', () => {
    const result = scanOutput('Let me tell you about our INTERNAL ROADMAP plans.', [
      'internal roadmap',
    ]);

    // test-review:accept tobe_true — boolean field `flagged` on OutputScanResult; structural assertion on scan outcome
    expect(result.flagged).toBe(true);
    expect(result.topicMatches).toContain('internal roadmap');
  });

  it('detects multiple forbidden topics', () => {
    const result = scanOutput(
      'Our competitor has better pricing than our internal roadmap suggests.',
      ['competitor', 'internal roadmap', 'salary']
    );

    // test-review:accept tobe_true — boolean field `flagged` on OutputScanResult; structural assertion on scan outcome
    expect(result.flagged).toBe(true);
    expect(result.topicMatches).toHaveLength(2);
    expect(result.topicMatches).toContain('competitor');
    expect(result.topicMatches).toContain('internal roadmap');
  });

  it('ignores empty and whitespace-only boundaries', () => {
    const result = scanOutput('Normal helpful response.', ['', '  ', '\t']);

    expect(result.flagged).toBe(false);
    expect(result.topicMatches).toEqual([]);
  });

  it('detects PII email pattern', () => {
    const result = scanOutput('Contact us at john@example.com for more info.', []);

    // test-review:accept tobe_true — boolean field `flagged` on OutputScanResult; structural assertion on scan outcome
    expect(result.flagged).toBe(true);
    expect(result.builtInMatches).toContain('pii_email');
  });

  it('detects PII phone number pattern', () => {
    const result = scanOutput('Call us at (555) 123-4567 for support.', []);

    // test-review:accept tobe_true — boolean field `flagged` on OutputScanResult; structural assertion on scan outcome
    expect(result.flagged).toBe(true);
    expect(result.builtInMatches).toContain('pii_phone');
  });

  it('detects PII SSN pattern', () => {
    const result = scanOutput('Your SSN is 123-45-6789.', []);

    // test-review:accept tobe_true — boolean field `flagged` on OutputScanResult; structural assertion on scan outcome
    expect(result.flagged).toBe(true);
    expect(result.builtInMatches).toContain('pii_ssn');
  });

  it('detects PII credit card pattern', () => {
    const result = scanOutput('Your card number is 4111 1111 1111 1111.', []);

    // test-review:accept tobe_true — boolean field `flagged` on OutputScanResult; structural assertion on scan outcome
    expect(result.flagged).toBe(true);
    expect(result.builtInMatches).toContain('pii_credit_card');
  });

  it('combines topic and built-in matches', () => {
    const result = scanOutput('Our competitor can be reached at info@competitor.com.', [
      'competitor',
    ]);

    // test-review:accept tobe_true — boolean field `flagged` on OutputScanResult; structural assertion on scan outcome
    expect(result.flagged).toBe(true);
    expect(result.topicMatches).toContain('competitor');
    expect(result.builtInMatches).toContain('pii_email');
  });

  it('does not flag clean output even with boundaries defined', () => {
    const result = scanOutput('Our product helps you manage your tasks efficiently.', [
      'competitor',
      'internal roadmap',
      'salary',
    ]);

    expect(result.flagged).toBe(false);
  });
});
