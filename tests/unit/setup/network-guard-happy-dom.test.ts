// @vitest-environment happy-dom

/**
 * The network guard, under **happy-dom**.
 *
 * The sibling of `network-guard-node.test.ts`. This half is the original
 * guard — installed through happy-dom's `settings.fetch.interceptor` rather
 * than on `globalThis.fetch`, because happy-dom ships its own fetch over
 * `node:http` and binds its module references at import time (#597).
 *
 * It predates the node default and had no test either. Both are here now
 * because the two implementations have to agree: a test asserting on the error
 * shape should not care which environment it ran in, and the only way to keep
 * that true is to assert it in both.
 */

import { describe, it, expect, vi } from 'vitest';

describe('happy-dom network guard', () => {
  it('runs under happy-dom, or the rest of this file proves nothing', () => {
    expect(typeof window).not.toBe('undefined');
    expect(navigator.userAgent).toMatch(/happydom/i);
  });

  it('refuses a real request with a NetworkError, matching the node half', () => {
    return expect(fetch('http://127.0.0.1:9/nope')).rejects.toMatchObject({
      name: 'NetworkError',
    });
  });

  it('names the URL and how to stub it, matching the node half', async () => {
    await expect(fetch('http://example.com/thing')).rejects.toThrow(
      /Blocked a real network request to http:\/\/example\.com\/thing/
    );
  });

  it('refuses a relative URL, which is the case that caused #597', async () => {
    // happy-dom's document URL is http://localhost:3000, so a relative path in
    // a component that fetches on mount resolved there and opened a real
    // socket — ~470 ECONNREFUSED lines a run. The node half has no document
    // URL, so this case only exists here.
    await expect(fetch('/api/v1/health')).rejects.toThrow(/Blocked a real network request/);
  });

  it('rejects an aborted request as an abort, matching the node half', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetch('http://example.com', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('still lets a test stub fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('stubbed')));
    const response = await fetch('http://example.com');
    expect(await response.text()).toBe('stubbed');
    vi.unstubAllGlobals();
  });
});
