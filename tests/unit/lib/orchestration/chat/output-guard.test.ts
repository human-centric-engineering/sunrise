/**
 * Tests for `lib/orchestration/chat/output-guard.ts`.
 *
 * Covers:
 *   - Topic boundary matching (case-insensitive, multiple matches)
 *   - Identifiers in the reply, found by the privacy layer's tier A rules
 *     through its registry (§127, t-992), and the ones the conversation
 *     supplied left alone
 *   - Clean output produces unflagged result
 *   - Empty boundaries list
 *   - Whitespace-only boundaries are ignored
 *
 * The privacy registry and its core detectors are real; the app seam is a
 * stand-in a case can fill.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ init: vi.fn<() => void>() }));
vi.mock('@/lib/app/privacy-adapters', () => ({ initAppPrivacyAdapters: () => seam.init() }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import { scanCitations, scanOutput } from '@/lib/orchestration/chat/output-guard';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import {
  __resetPrivacyAdaptersForTests,
  registerPrivacyDetector,
} from '@/lib/privacy/adapters/registry';

beforeEach(() => {
  vi.clearAllMocks();
  __resetPrivacyAdaptersForTests();
  seam.init.mockImplementation(() => undefined);
});

describe('scanOutput', () => {
  it('returns unflagged for clean output with no boundaries', async () => {
    const result = await scanOutput('Here is a helpful answer about your question.', []);

    expect(result.flagged).toBe(false);
    expect(result.topicMatches).toEqual([]);
    expect(result.builtInMatches).toEqual([]);
  });

  it('detects a forbidden topic keyword', async () => {
    const result = await scanOutput('Our competitor Acme Corp offers a similar product.', [
      'competitor',
      'pricing strategy',
    ]);

    // test-review:accept tobe_true — boolean field `flagged` on OutputScanResult; structural assertion on scan outcome
    expect(result.flagged).toBe(true);
    expect(result.topicMatches).toContain('competitor');
    expect(result.topicMatches).not.toContain('pricing strategy');
  });

  it('matches topic boundaries case-insensitively', async () => {
    const result = await scanOutput('Let me tell you about our INTERNAL ROADMAP plans.', [
      'internal roadmap',
    ]);

    // test-review:accept tobe_true — boolean field `flagged` on OutputScanResult; structural assertion on scan outcome
    expect(result.flagged).toBe(true);
    expect(result.topicMatches).toContain('internal roadmap');
  });

  it('detects multiple forbidden topics', async () => {
    const result = await scanOutput(
      'Our competitor has better pricing than our internal roadmap suggests.',
      ['competitor', 'internal roadmap', 'salary']
    );

    // test-review:accept tobe_true — boolean field `flagged` on OutputScanResult; structural assertion on scan outcome
    expect(result.flagged).toBe(true);
    expect(result.topicMatches).toHaveLength(2);
    expect(result.topicMatches).toContain('competitor');
    expect(result.topicMatches).toContain('internal roadmap');
  });

  it('ignores empty and whitespace-only boundaries', async () => {
    const result = await scanOutput('Normal helpful response.', ['', '  ', '\t']);

    expect(result.flagged).toBe(false);
    expect(result.topicMatches).toEqual([]);
  });

  it('flags an email address the conversation did not supply', async () => {
    const result = await scanOutput('Contact john@example.com for more info.', []);

    // test-review:accept tobe_true — boolean field `flagged` on OutputScanResult; structural assertion on scan outcome
    expect(result.flagged).toBe(true);
    expect(result.builtInMatches).toEqual(['pii_email']);
  });

  it('flags UK identifiers by their tier A type', async () => {
    const result = await scanOutput(
      'Call 07911 123456, NI number TJ 33 15 36 A, card 4111 1111 1111 1111.',
      []
    );

    expect(result.builtInMatches).toEqual(
      expect.arrayContaining(['pii_phone', 'pii_uk_nino', 'pii_card_number'])
    );
    expect(result.builtInMatches).toHaveLength(3);
  });

  it('no longer flags a US SSN-shaped number, which the old US-only pattern did', async () => {
    const result = await scanOutput('Reference 123-45-6789 is on the invoice.', []);

    expect(result.builtInMatches).toEqual([]);
  });

  it('ignores identifiers the conversation itself supplied, however they are spaced', async () => {
    const supplied: LlmMessage[] = [
      { role: 'system', content: 'You are a support agent.' },
      { role: 'user', content: 'My email is Priya.Sharma@example.com and my mobile 07911123456.' },
      { role: 'tool', content: '{"office":"0161 496 0000"}', toolCallId: 't1' },
    ];
    const reply =
      'Thanks — I have priya.sharma@example.com, 07911 123 456 and the office on 0161 496 0000.';

    expect(await scanOutput(reply, [], supplied)).toEqual({
      flagged: false,
      topicMatches: [],
      builtInMatches: [],
    });
    // One the conversation did not supply is still a leak.
    const leaked = await scanOutput(`${reply} Or try j.doe@example.org.`, [], supplied);
    expect(leaked.builtInMatches).toEqual(['pii_email']);
  });

  it('flags names no more than before: only the rules detector runs', async () => {
    const result = await scanOutput('Albert Einstein worked at Acme Holdings Ltd.', []);

    expect(result.builtInMatches).toEqual([]);
  });

  it("follows an app's replacement of the rules detector, because it runs through the registry", async () => {
    seam.init.mockImplementation(() =>
      registerPrivacyDetector(
        {
          id: 'app.rules',
          egress: 'in_process',
          entityTypes: ['STAFF_ID'],
          detect: async ({ text }) => {
            const at = text.indexOf('EMP-4471');
            return at === -1 ? [] : [{ type: 'STAFF_ID', start: at, end: at + 8, confidence: 1 }];
          },
        },
        { replace: 'core.rules' }
      )
    );

    const result = await scanOutput('Staff EMP-4471, email john@example.com.', []);

    // The app's rules replaced core's, emails included.
    expect(result.builtInMatches).toEqual(['pii_staff_id']);
  });

  it('leaves alone the types the admin told the privacy layer to ignore', async () => {
    const reply = 'Visit us at SW1A 1AA or email john@example.com.';
    expect((await scanOutput(reply, [])).builtInMatches).toEqual(
      expect.arrayContaining(['pii_postcode', 'pii_email'])
    );
    const result = await scanOutput(reply, [], [], { ignoredEntityTypes: ['POSTCODE'] });
    expect(result.builtInMatches).toEqual(['pii_email']);
  });

  it('says in the log when it could not finish its scan, rather than pass silently', async () => {
    seam.init.mockImplementation(() =>
      registerPrivacyDetector(
        {
          id: 'app.rules',
          egress: 'in_process',
          entityTypes: ['EMAIL'],
          detect: () => Promise.reject(new Error('down')),
        },
        { replace: 'core.rules' }
      )
    );
    const result = await scanOutput('Email john@example.com.', []);
    expect(result.builtInMatches).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('output-guard: identifier scan incomplete', {
      failedAdapters: ['app.rules'],
      reasons: ['threw'],
    });
  });

  it('does not count a value as supplied because its digits sit inside a longer number', async () => {
    const supplied: LlmMessage[] = [
      { role: 'user', content: 'My order ref is 9123456780.' },
      { role: 'tool', content: 'ends 12', toolCallId: 't1' },
      { role: 'tool', content: '3456 starts', toolCallId: 't2' },
    ];
    // A sort code the conversation never gave: inside the order ref, and
    // across the end of one message and the start of the next.
    const result = await scanOutput('Your sort code is 12-34-56.', [], supplied);
    expect(result.builtInMatches).toEqual(['pii_sort_code']);
  });

  it('never posts a reply to an external replacement of the rules detector', async () => {
    const detect = vi.fn(async () => []);
    seam.init.mockImplementation(() =>
      registerPrivacyDetector(
        { id: 'app.hosted', egress: 'external', entityTypes: ['EMAIL'], detect },
        { replace: 'core.rules' }
      )
    );
    const result = await scanOutput('Email john@example.com.', []);
    // The guard runs in every privacy mode, off included: it must not open a
    // flow to a service no setting sent the reply to.
    expect(detect).not.toHaveBeenCalled();
    expect(result.builtInMatches).toEqual([]);
  });

  it('combines topic and built-in matches', async () => {
    const result = await scanOutput('Our competitor can be reached at info@competitor.com.', [
      'competitor',
    ]);

    // test-review:accept tobe_true — boolean field `flagged` on OutputScanResult; structural assertion on scan outcome
    expect(result.flagged).toBe(true);
    expect(result.topicMatches).toContain('competitor');
    expect(result.builtInMatches).toContain('pii_email');
  });

  it('does not flag clean output even with boundaries defined', async () => {
    const result = await scanOutput('Our product helps you manage your tasks efficiently.', [
      'competitor',
      'internal roadmap',
      'salary',
    ]);

    expect(result.flagged).toBe(false);
  });
});

describe('scanCitations', () => {
  const cite = (marker: number) => ({ marker });

  it('passes vacuously when no citations exist', () => {
    const result = scanCitations('Here is some text without any markers.', []);
    expect(result.flagged).toBe(false);
    expect(result.underCited).toBe(false);
    expect(result.hallucinatedMarkers).toEqual([]);
  });

  it('passes when text references a valid marker', () => {
    const result = scanCitations('The deposit must be protected within 30 days [1].', [
      cite(1),
      cite(2),
    ]);
    expect(result.flagged).toBe(false);
    expect(result.underCited).toBe(false);
    expect(result.hallucinatedMarkers).toEqual([]);
  });

  it('flags under-citation when citations exist but no markers appear', () => {
    const result = scanCitations(
      'The deposit must be protected within 30 days, otherwise a Section 21 is invalid.',
      [cite(1), cite(2)]
    );
    expect(result.flagged).toBe(true);
    expect(result.underCited).toBe(true);
    expect(result.hallucinatedMarkers).toEqual([]);
  });

  it('flags hallucinated markers that have no matching citation', () => {
    const result = scanCitations('See [1] and [3] for the relevant rules.', [cite(1), cite(2)]);
    expect(result.flagged).toBe(true);
    expect(result.underCited).toBe(false);
    expect(result.hallucinatedMarkers).toEqual([3]);
  });

  it('returns hallucinated markers sorted ascending and deduplicated', () => {
    const result = scanCitations('See [9], then [3], and again [9] and [3].', [cite(1)]);
    expect(result.flagged).toBe(true);
    expect(result.hallucinatedMarkers).toEqual([3, 9]);
  });

  it('flags a response with only hallucinated markers as both under-cited and hallucinated', () => {
    const result = scanCitations('See [99] for details.', [cite(1)]);
    expect(result.flagged).toBe(true);
    expect(result.underCited).toBe(true);
    expect(result.hallucinatedMarkers).toEqual([99]);
  });

  it('treats `[N]` inside code blocks as ordinary markers (heuristic limitation)', () => {
    // Heuristic: the regex is intentionally simple and does not skip code
    // fences. This test pins the current behaviour. If a future change adds
    // code-fence-aware skipping, update this expectation.
    const result = scanCitations('```ts\nconst arr = [0]\n```\nSee source [1].', [cite(1)]);
    expect(result.flagged).toBe(true);
    expect(result.underCited).toBe(false);
    expect(result.hallucinatedMarkers).toEqual([0]);
  });
});
