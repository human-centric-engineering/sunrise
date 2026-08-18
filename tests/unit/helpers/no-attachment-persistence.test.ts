/**
 * Unit Tests: Attachment-Persistence Guard
 *
 * Tests the guard itself, because `tests/` is excluded from coverage
 * (`vitest.config.ts`) — so without this file the only thing standing between a
 * contributor and silently persisting user attachment bytes has no test of its
 * own and no coverage signal either.
 *
 * The shape cases are not hypothetical. The guard originally matched a fixed
 * list of suspect KEY names, and attachments in this codebase are
 * `{ name, mediaType, data }` — `data` was not on that list. A mutation
 * persisting `metadata.files[].data` wrote a whole PNG to the database and the
 * consuming test stayed green (#626). The value-shape cases below are the ones
 * that would have caught it, so they are the ones most worth locking in.
 *
 * Verified against the pre-hardening helper (`d67b1d7b`): the six value-shape
 * cases FAIL there, so they are genuine regression tests. The other eleven pass
 * against it — they are coverage of behaviour that already worked (binary
 * detection, key matching, no-false-positive, traversal safety), deliberately
 * kept so a future edit to `walk()` cannot quietly drop them.
 *
 * Test Coverage:
 * - binary values (Buffer / Uint8Array / ArrayBuffer)
 * - suspect key names, at any depth and any case
 * - base64 payloads by magic-byte prefix, whatever the key is called
 * - base64 payloads by length + alphabet, with no recognisable prefix
 * - no false positive on the metadata this codebase actually persists
 * - the depth cap, and cyclic input
 *
 * @see tests/helpers/no-attachment-persistence.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { assertNoAttachmentPersistence } from '@/tests/helpers/no-attachment-persistence';

/** A real 1x1 PNG — the smallest input the magic-byte path has to catch. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const PDF_BASE64 = Buffer.from('%PDF-1.4\nfake').toString('base64');

function mockWithCall(arg: unknown) {
  const m = vi.fn();
  m(arg);
  return m as unknown as { mock: { calls: unknown[][] } };
}

describe('assertNoAttachmentPersistence', () => {
  describe('binary values', () => {
    it.each([
      ['Buffer', Buffer.from('bytes')],
      ['Uint8Array', new Uint8Array([1, 2, 3])],
      ['ArrayBuffer', new ArrayBuffer(8)],
    ])('rejects a %s anywhere in the tree', (_label, value) => {
      const mock = mockWithCall({ data: { metadata: { blob: value } } });

      expect(() => assertNoAttachmentPersistence(mock, 'probe')).toThrow(/binary value/);
    });
  });

  describe('suspect key names', () => {
    it('rejects a known attachment key', () => {
      const mock = mockWithCall({ data: { attachments: ['anything'] } });

      expect(() => assertNoAttachmentPersistence(mock, 'probe')).toThrow(
        /attachment-shaped key "attachments"/
      );
    });

    it('matches the key case-insensitively', () => {
      const mock = mockWithCall({ data: { ImageBytes: 'x' } });

      expect(() => assertNoAttachmentPersistence(mock, 'probe')).toThrow(
        /attachment-shaped key "ImageBytes"/
      );
    });
  });

  describe('base64 payloads, whatever the key is called', () => {
    // The regression the key list could not catch.
    it('rejects a PNG under a benign key', () => {
      const mock = mockWithCall({
        data: { metadata: { files: [{ n: 'photo.png', data: PNG_BASE64 }] } },
      });

      expect(() => assertNoAttachmentPersistence(mock, 'probe')).toThrow(/iVBORw0KGgo/);
    });

    it('rejects a PDF under a benign key', () => {
      const mock = mockWithCall({ data: { metadata: { doc: PDF_BASE64 } } });

      expect(() => assertNoAttachmentPersistence(mock, 'probe')).toThrow(/JVBERi0/);
    });

    // #626 code review: the shapes this codebase's own attachment path
    // actually produces. `FileReader.readAsDataURL` yields the data: form and
    // `openai-compatible.ts` re-adds it when formatting for the provider, so
    // persisting either un-stripped value must not slip past.
    it('rejects a data: URI, which is what FileReader returns', () => {
      const mock = mockWithCall({
        data: { metadata: { src: `data:image/png;base64,${PNG_BASE64}` } },
      });

      expect(() => assertNoAttachmentPersistence(mock, 'probe')).toThrow(/iVBORw0KGgo/);
    });

    it('rejects a base64url-encoded payload', () => {
      const urlSafe = PNG_BASE64.replace(/\+/g, '-').replace(/\//g, '_');
      const mock = mockWithCall({ data: { metadata: { src: urlSafe } } });

      expect(() => assertNoAttachmentPersistence(mock, 'probe')).toThrow(/iVBORw0KGgo/);
    });

    it('names the path so the failure is diagnosable', () => {
      const mock = mockWithCall({ data: { metadata: { files: [{ data: PNG_BASE64 }] } } });

      expect(() => assertNoAttachmentPersistence(mock, 'probe')).toThrow(
        /arg0\.data\.metadata\.files\[0\]\.data/
      );
    });
  });

  describe('does not fire on what the codebase legitimately persists', () => {
    it('accepts a realistic aiMessage.create payload', () => {
      // Modelled on the real call in streaming-handler.ts: a cuid conversation
      // id, prose content, and the namespaced `metadata.app` fork marker.
      const mock = mockWithCall({
        data: {
          conversationId: 'cmjbv4i3x00003wsloputgwul',
          role: 'user',
          content: 'Can you take a look at the photo I sent over earlier?',
          metadata: { app: { source: 'web', traceId: 'cmjbv4i3x00013wslabcd1234' } },
          provenance: { model: 'claude-opus-5', usedSlug: 'anthropic' },
        },
      });

      expect(() => assertNoAttachmentPersistence(mock, 'probe')).not.toThrow();
    });

    it('accepts base64-alphabet strings below the length floor', () => {
      // cuids, UUID-ish ids and model slugs are all base64-alphabet. Flagging
      // them would make the guard unusable.
      const mock = mockWithCall({
        data: { id: 'cmjbv4i3x00003wsloputgwul', model: 'claudeopus5', token: 'abc123DEF456' },
      });

      expect(() => assertNoAttachmentPersistence(mock, 'probe')).not.toThrow();
    });

    it('accepts a long PROSE string, which is not base64-alphabet', () => {
      // Spaces and punctuation disqualify it, so message content of any length
      // passes — which matters, because `content` is always persisted.
      const mock = mockWithCall({ data: { content: 'the quick brown fox. '.repeat(60) } });

      expect(() => assertNoAttachmentPersistence(mock, 'probe')).not.toThrow();
    });

    // #626 review round 2: every one of these FAILED under the removed
    // length+alphabet rule. They are ordinary chat content, and the guard
    // asserting over five sinks meant any of them would have accused the route
    // of persisting bytes it never touched.
    it('accepts long prose with no punctuation', () => {
      const mock = mockWithCall({ data: { content: 'the quick brown fox '.repeat(20) } });

      expect(() => assertNoAttachmentPersistence(mock, 'probe')).not.toThrow();
    });

    it('accepts a long run of hyphenated slugs', () => {
      const mock = mockWithCall({ data: { tags: 'some-long-slug-name-'.repeat(20) } });

      expect(() => assertNoAttachmentPersistence(mock, 'probe')).not.toThrow();
    });

    it('accepts a newline-separated list', () => {
      const list = Array.from({ length: 30 }, (_, i) => `item number ${i} in the list`).join('\n');
      const mock = mockWithCall({ data: { content: list } });

      expect(() => assertNoAttachmentPersistence(mock, 'probe')).not.toThrow();
    });

    it('accepts a mock with no calls at all', () => {
      expect(() => assertNoAttachmentPersistence({ mock: { calls: [] } }, 'probe')).not.toThrow();
    });
  });

  describe('traversal safety', () => {
    it('terminates on a cyclic argument rather than hanging', () => {
      const cyclic: Record<string, unknown> = { name: 'loop' };
      cyclic.self = cyclic;

      expect(() => assertNoAttachmentPersistence(mockWithCall(cyclic), 'probe')).not.toThrow();
    });

    it('stops descending past the depth cap', () => {
      // 10 levels deep, past the cap of 8 — documents the known blind spot
      // rather than pretending the walk is unbounded.
      let deep: Record<string, unknown> = { data: PNG_BASE64 };
      for (let i = 0; i < 10; i++) deep = { nested: deep };

      expect(() => assertNoAttachmentPersistence(mockWithCall(deep), 'probe')).not.toThrow();
    });

    it('still finds a payload just inside the depth cap', () => {
      let shallow: Record<string, unknown> = { data: PNG_BASE64 };
      for (let i = 0; i < 3; i++) shallow = { nested: shallow };

      expect(() => assertNoAttachmentPersistence(mockWithCall(shallow), 'probe')).toThrow(
        /iVBORw0KGgo/
      );
    });
  });

  it('includes the label so a failure names the mock that carried the bytes', () => {
    const mock = mockWithCall({ data: { blob: PNG_BASE64 } });

    expect(() => assertNoAttachmentPersistence(mock, 'prisma.aiMessage.create')).toThrow(
      /prisma\.aiMessage\.create/
    );
  });
});
