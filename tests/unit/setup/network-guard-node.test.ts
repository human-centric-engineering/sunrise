/**
 * The network guard, under the **node** environment.
 *
 * `tests/setup.ts` refuses real network requests so a component that fetches on
 * mount cannot spend the run connecting to a dev server that isn't there
 * (#597). That guard was installed through happy-dom's own fetch interceptor —
 * which meant that when `vitest.config.ts` moved to `node` by default, the 605
 * files running there lost it. Not loudly: they simply ran against real undici
 * with nothing in the way.
 *
 * Neither half of the guard had a test before this file. That is the more
 * embarrassing find of the two, because "no test reaches the network" is
 * exactly the property that fails silently when it stops holding.
 *
 * The happy-dom half is covered by its sibling,
 * `network-guard-happy-dom.test.ts`. The two must stay in step: a test that
 * asserts on the error shape should not care which environment it ran in.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

describe('node network guard', () => {
  // Unstub here rather than at the end of the stubbing test: if that test's
  // assertion fails, an inline call never runs, the stub leaks into the next
  // test, and "restores the guard" fails too — reporting the leak instead of
  // the real failure.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs under the node environment, or the rest of this file proves nothing', () => {
    // The sibling file asserts the inverse. Without this pair, a stray
    // environment directive would silently move these cases onto the other
    // implementation and they would still pass.
    //
    // This assertion has already earned its place: the comment that used to sit
    // here spelled the directive out in full, and vitest matches it ANYWHERE in
    // a file rather than only in the header — so a comment *about* the docblock
    // put this whole file on happy-dom. Nothing else would have said so.
    expect(typeof window).toBe('undefined');
  });

  it('refuses a real request with a NetworkError, not a TypeError', () => {
    // Matches what happy-dom throws for a failed connection, so a test that
    // asserts on the shape sees the same thing in both environments.
    return expect(fetch('http://127.0.0.1:9/nope')).rejects.toMatchObject({
      name: 'NetworkError',
    });
  });

  it('names the URL and how to stub it', async () => {
    await expect(fetch('http://example.com/thing')).rejects.toThrow(
      /Blocked a real network request to http:\/\/example\.com\/thing/
    );
    await expect(fetch('http://example.com/thing')).rejects.toThrow(/vi\.stubGlobal/);
  });

  it('accepts a Request object, not just a string', async () => {
    await expect(fetch(new Request('http://example.com/from-request'))).rejects.toThrow(
      /from-request/
    );
  });

  it('accepts a URL object', async () => {
    await expect(fetch(new URL('http://example.com/from-url'))).rejects.toThrow(/from-url/);
  });

  it('lets a data: URI through, because it opens no socket', async () => {
    const response = await fetch('data:text/plain,hello');
    expect(await response.text()).toBe('hello');
  });

  it('rejects an aborted request as an abort, not as a network failure', async () => {
    // happy-dom checks the signal before refusing, so node must too — otherwise
    // every `if (err.name === 'AbortError') return` branch under test is
    // silently disabled in one environment and not the other.
    const controller = new AbortController();
    controller.abort();
    await expect(fetch('http://example.com', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('still lets a test stub fetch, which is the documented escape hatch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('stubbed')));
    const response = await fetch('http://example.com');
    expect(await response.text()).toBe('stubbed');
  });

  it('restores the guard after the stub is removed', async () => {
    // `vi.unstubAllGlobals` puts back whatever was there — which must be the
    // guard, not undici. A guard that survives only until the first stubbing
    // test would leave every later file in the worker unprotected.
    await expect(fetch('http://example.com/after-unstub')).rejects.toThrow(/Blocked a real/);
  });
});
