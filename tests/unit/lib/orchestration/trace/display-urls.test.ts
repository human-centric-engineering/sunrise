/**
 * Tests: shortening URL-bearing values in a trace for display (t-777).
 *
 * @see lib/orchestration/trace/display-urls.ts
 */

import { describe, it, expect } from 'vitest';
import { withDisplayUrls, withDisplayUrlsStream } from '@/lib/orchestration/trace/display-urls';

const SECRET = 'Xk9fQ2mZp4LrT7vB1nWc8sYd';
const SLACK = `https://hooks.slack.com/services/T0000/B0000/${SECRET}?token=qs-secret`;
const REDUCED = 'https://hooks.slack.com/services/T0000/B0000/[param]';

describe('withDisplayUrls', () => {
  it('shortens a send_notification entry in both its input and its output', () => {
    const entry = {
      stepId: 'notify',
      stepType: 'send_notification',
      input: { channel: 'webhook', webhookUrl: SLACK, bodyTemplate: 'Done' },
      output: { sent: true, channel: 'webhook', url: SLACK },
    };

    const shown = withDisplayUrls([entry]);

    expect(shown[0]?.input).toEqual({
      channel: 'webhook',
      webhookUrl: REDUCED,
      bodyTemplate: 'Done',
    });
    expect(shown[0]?.output).toEqual({ sent: true, channel: 'webhook', url: REDUCED });
    expect(JSON.stringify(shown)).not.toContain(SECRET);
    expect(JSON.stringify(shown)).not.toContain('qs-secret');
  });

  it('never changes the value it was given, so the persisted trace keeps the working URL', () => {
    const entry = { input: { webhookUrl: SLACK }, output: { url: SLACK } };

    withDisplayUrls([entry]);

    expect(entry.input.webhookUrl).toBe(SLACK);
    expect(entry.output.url).toBe(SLACK);
  });

  it('matches any key ending in url or urls, whatever its case or nesting', () => {
    const shown = withDisplayUrls({
      config: { callbackURL: SLACK, source_url: SLACK, allowedUrls: [SLACK, SLACK] },
      turns: [{ toolCall: { args: { url: SLACK } } }],
    });

    expect(JSON.stringify(shown)).not.toContain(SECRET);
    expect(shown.config.allowedUrls).toEqual([REDUCED, REDUCED]);
    expect(shown.turns[0]?.toolCall.args.url).toBe(REDUCED);
  });

  it('leaves URLs in free text, templates and non-http values as written', () => {
    const value = {
      answer: `See ${SLACK}`,
      webhookUrl: '{{steps.lookup.output.url}}',
      url: 'mailto:someone@example.com',
      count: 3,
      nothing: null,
    };

    expect(withDisplayUrls(value)).toEqual(value);
  });

  it('passes a Date or other class instance through, so its toJSON still applies', () => {
    const createdAt = new Date('2026-10-13T00:00:00Z');
    class Decimalish {
      toJSON() {
        return '12.50';
      }
    }
    const amount = new Decimalish();

    const shown = withDisplayUrls({ createdAt, amount, url: SLACK });

    expect(shown.createdAt).toBe(createdAt);
    expect(shown.amount).toBe(amount);
    expect(JSON.stringify(shown)).toBe(
      `{"createdAt":"2026-10-13T00:00:00.000Z","amount":"12.50","url":"${REDUCED}"}`
    );
  });

  it('replaces an object nested past the depth cap rather than passing it on unread', () => {
    let deep: Record<string, unknown> = { url: SLACK };
    for (let i = 0; i < 40; i++) deep = { next: deep };

    expect(JSON.stringify(withDisplayUrls(deep))).not.toContain(SECRET);
    expect(JSON.stringify(withDisplayUrls(deep))).toContain('[depth limit]');
  });

  it("reduces an external_call source's reference, and leaves a citation or an id alone", () => {
    const shown = withDisplayUrls({
      sources: [
        { source: 'external_call', reference: `https://api.example.com/v1/data?api_key=${SECRET}` },
        { source: 'web_search', reference: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
        { source: 'knowledge_base', reference: 'chunk_123' },
      ],
    });

    expect(shown.sources[0]?.reference).toBe('https://api.example.com/v1/data');
    expect(shown.sources[1]?.reference).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(shown.sources[2]?.reference).toBe('chunk_123');
  });
});

describe('withDisplayUrlsStream', () => {
  it('reduces every event and closes the source when the reader stops', async () => {
    let closed = false;
    async function* source() {
      try {
        yield { type: 'step_completed', output: { url: SLACK } };
        yield { type: 'step_completed', output: { url: SLACK } };
      } finally {
        closed = true;
      }
    }

    const seen: unknown[] = [];
    for await (const event of withDisplayUrlsStream(source())) {
      seen.push(event);
      break;
    }

    expect(seen).toEqual([{ type: 'step_completed', output: { url: REDUCED } }]);
    expect(closed).toBe(true);
  });
});
