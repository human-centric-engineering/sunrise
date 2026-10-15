/**
 * Tests: outbound connections check what a hostname resolved to (§111 t-811)
 *
 * The URL guard reads text; a hostname can resolve anywhere. The dispatcher
 * resolves at connect time and refuses an unsafe address. These tests make
 * REAL connections to a local server through the global `fetch`, so they
 * prove the part a mock cannot: that Node's own `fetch` honours the `undici`
 * `Agent` passed as `dispatcher`, and uses its `lookup`. The hostnames are
 * made up and answered by an injected resolver, so a fetch that ignored the
 * dispatcher would fail DNS instead of reaching the server.
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch as undiciFetch } from 'undici';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (t, k) => (k === 'TENANCY_MODE' ? mockEnv.TENANCY_MODE : Reflect.get(t, k)),
    }),
  };
});
vi.mock('@/lib/logging', () => {
  const log = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
  return { logger: { ...log, withContext: vi.fn(() => log) } };
});

import {
  createSafeDispatcher,
  describeOutboundFailure,
  isUnsafeAddressRefusal,
  literalHostRefusedHere,
  outboundDispatcher,
  safeLookup,
  UnsafeResolvedAddressError,
  withOutboundDispatcher,
  type ResolveAll,
} from '@/lib/security/safe-dispatcher';
import { checkSafeAddress, checkSafeProviderUrl } from '@/lib/security/safe-url';
import { runAsOrg, runAsSystem } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const ORG_B = 'cmorg0000000000000000orgb';

/** A resolver that knows a few made-up names, as DNS would answer them. */
const table: Record<string, { address: string; family: number }[]> = {
  'internal.t811.test': [{ address: '127.0.0.1', family: 4 }],
  'metadata.t811.test': [{ address: '169.254.169.254', family: 4 }],
  'mixed.t811.test': [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.5', family: 4 },
  ],
  'public.t811.test': [{ address: '93.184.216.34', family: 4 }],
};
const fakeResolve: ResolveAll = (hostname, _options, callback) => {
  const found = table[hostname];
  if (!found) {
    const err: NodeJS.ErrnoException = new Error(`ENOTFOUND ${hostname}`);
    err.code = 'ENOTFOUND';
    return callback(err, []);
  }
  callback(null, found);
};

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((_req, res) => res.end('internal secret'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  mockEnv.TENANCY_MODE = 'multi';
});

/** The `cause` chain of a failed fetch, flattened. */
function causes(err: unknown): unknown[] {
  const out: unknown[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) out.push(e);
  return out;
}

describe('a real connection through the safe dispatcher', () => {
  // undici's own `fetch`, because tests/setup.ts replaces the global one with
  // a network blocker. The coupling that matters in production — Node's
  // BUILT-IN fetch honouring this package's Agent — is proven by the next
  // block, in a child process where nothing is patched.
  it('refuses a hostname that resolves to loopback — the URL check alone lets it through', async () => {
    const url = `http://internal.t811.test:${port}/`;
    expect(checkSafeProviderUrl(url).ok).toBe(true);

    const err = await undiciFetch(url, { dispatcher: createSafeDispatcher({}, fakeResolve) })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).not.toBeNull();
    expect(causes(err).some((c) => c instanceof UnsafeResolvedAddressError)).toBe(true);
  });

  it('control: the same fetch with loopback allowed reaches the server — so the dispatcher is the one connecting', async () => {
    const res = await undiciFetch(`http://internal.t811.test:${port}/`, {
      dispatcher: createSafeDispatcher({ allowLoopback: true }, fakeResolve),
    });
    expect(await res.text()).toBe('internal secret');
  });
});

describe('Node’s built-in fetch accepts this package’s Agent and uses its lookup', () => {
  // The production call sites pass `dispatcher` to the GLOBAL fetch, which is
  // the undici bundled inside Node — a different copy from the package. If
  // the two majors ever stopped agreeing, the option would be ignored or
  // refused and the pinning would silently stop. This runs the real thing.
  it('connects a made-up name through the Agent’s lookup, and refuses when the lookup does', () => {
    const script = `
      import { Agent } from 'undici';
      import { createServer } from 'node:http';
      const server = createServer((_q, r) => r.end('reached'));
      await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
      const { port } = server.address();
      const agent = (refuse) => new Agent({ connect: { lookup: (host, opts, cb) =>
        refuse ? cb(new Error('refused ' + host)) :
        opts.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4) } });
      const url = 'http://made-up.t811.test:' + port + '/';
      const ok = await (await fetch(url, { dispatcher: agent(false) })).text();
      const refused = await fetch(url, { dispatcher: agent(true) }).then(() => 'no', (e) => String(e.cause?.message ?? e));
      server.close();
      console.log(JSON.stringify({ ok, refused }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(JSON.parse(out.trim())).toEqual({ ok: 'reached', refused: 'refused made-up.t811.test' });
  });
});

describe('safeLookup', () => {
  const lookup = (hostname: string, all: boolean) =>
    new Promise<{ err: unknown; address: unknown }>((resolve) =>
      safeLookup({}, fakeResolve)(hostname, { all }, (err, address) => resolve({ err, address }))
    );

  it('refuses a name resolving to cloud metadata — naming the host, never the address', async () => {
    const { err } = await lookup('metadata.t811.test', false);
    expect(err).toBeInstanceOf(UnsafeResolvedAddressError);
    // The message reaches an org admin (a webhook test, a delivery's lastError):
    // naming where an internal name points would map the operator's network.
    expect((err as Error).message).not.toContain('169.254');
    expect((err as UnsafeResolvedAddressError).address).toBe('169.254.169.254');
  });

  it('refuses a name with one public and one private address — every address is checked', async () => {
    const { err } = await lookup('mixed.t811.test', true);
    expect(err).toBeInstanceOf(UnsafeResolvedAddressError);
    expect((err as UnsafeResolvedAddressError).address).toBe('10.0.0.5');
  });

  it('answers a public name in both callback shapes', async () => {
    expect(await lookup('public.t811.test', false)).toEqual({
      err: null,
      address: '93.184.216.34',
    });
    expect(await lookup('public.t811.test', true)).toEqual({
      err: null,
      address: [{ address: '93.184.216.34', family: 4 }],
    });
  });

  it('passes a resolver error through', async () => {
    const { err } = await lookup('nowhere.t811.test', false);
    expect((err as NodeJS.ErrnoException).code).toBe('ENOTFOUND');
  });
});

describe('checkSafeAddress', () => {
  it.each([
    '127.0.0.1',
    '::1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.170.2',
    '100.100.100.200',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '0.0.0.0',
  ])('refuses %s', (address) => {
    expect(checkSafeAddress(address).ok).toBe(false);
  });

  it.each([
    ['NAT64 wrapping 10.0.0.5', '64:ff9b::a00:5'],
    ['NAT64 local-use wrapping 127.0.0.1', '64:ff9b:1::7f00:1'],
    ['NAT64 dotted wrapping 169.254.169.254', '64:ff9b::169.254.169.254'],
    ['6to4 wrapping 192.168.0.1', '2002:c0a8:1::1'],
    ['0.0.0.0/8', '0.1.2.3'],
    ['site-local fec0::/10', 'fec0::1'],
    ['6to4, zero-compressed, wrapping 192.168.0.0', '2002:c0a8::1'],
    ['6to4, zero-compressed, wrapping 10.0.0.0', '2002:a00::5'],
    ['NAT64, zero-compressed, wrapping 0.0.0.5', '64:ff9b::5'],
  ])('refuses %s (%s)', (_label, address) => {
    expect(checkSafeAddress(address).ok).toBe(false);
  });

  it.each(['64:ff9b::5db8:d822', '2002:5db8:d822::1'])(
    'allows %s, which wraps a public address',
    (address) => {
      expect(checkSafeAddress(address).ok).toBe(true);
    }
  );

  it.each(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])('allows %s', (address) => {
    expect(checkSafeAddress(address).ok).toBe(true);
  });
});

describe('checkSafeProviderUrl — a trailing dot names the same host', () => {
  it('refuses the metadata name with a trailing dot', () => {
    expect(checkSafeProviderUrl('http://metadata.google.internal./computeMetadata/v1/').ok).toBe(
      false
    );
    expect(checkSafeProviderUrl('http://169.254.169.254./latest/').ok).toBe(false);
  });
});

describe('outboundDispatcher — who gets one', () => {
  it('a customer org at multi does', async () => {
    await runAsOrg(ORG_B, async () => {
      expect(outboundDispatcher()).toBeDefined();
      expect(withOutboundDispatcher({ method: 'GET' })).toHaveProperty('dispatcher');
    });
  });

  it('so does a call stack with no context at all at multi — a bug, pinned rather than trusted', () => {
    expect(outboundDispatcher()).toBeDefined();
  });

  it('the install org, a system scope, and single installs do not', async () => {
    await runAsOrg(INSTALL_ORG_ID, async () => expect(outboundDispatcher()).toBeUndefined());
    await runAsSystem('test: a platform job', async () =>
      expect(outboundDispatcher()).toBeUndefined()
    );
    mockEnv.TENANCY_MODE = 'single';
    await runAsOrg(ORG_B, async () => {
      expect(outboundDispatcher()).toBeUndefined();
      expect(withOutboundDispatcher({ method: 'GET' })).toEqual({ method: 'GET' });
    });
  });
});

describe('literalHostRefusedHere — an IP literal is never looked up', () => {
  it('refuses a private or metadata literal for a customer org', async () => {
    await runAsOrg(ORG_B, async () => {
      expect(literalHostRefusedHere('http://10.0.0.12/x')).toBe(true);
      expect(literalHostRefusedHere('http://169.254.169.254/latest')).toBe(true);
      expect(literalHostRefusedHere('http://[::ffff:7f00:1]/')).toBe(true);
    });
  });

  it('passes a public literal and any hostname (the dispatcher checks names)', async () => {
    await runAsOrg(ORG_B, async () => {
      expect(literalHostRefusedHere('https://93.184.216.34/')).toBe(false);
      expect(literalHostRefusedHere('https://internal.example/')).toBe(false);
      expect(literalHostRefusedHere('not a url')).toBe(false);
    });
  });

  it('control: refuses nothing for the install org', async () => {
    await runAsOrg(INSTALL_ORG_ID, async () =>
      expect(literalHostRefusedHere('http://10.0.0.12/x')).toBe(false)
    );
  });
});

describe('describing a failed fetch to whoever chose the URL', () => {
  const refused = new TypeError('fetch failed', {
    cause: new UnsafeResolvedAddressError('db', '10.0.3.4', 'private_ip'),
  });
  const missing = Object.assign(new Error('getaddrinfo ENOTFOUND nope'), { code: 'ENOTFOUND' });
  const notFound = new TypeError('fetch failed', { cause: missing });
  const reset = new TypeError('fetch failed', {
    cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
  });

  it('knows a dispatcher refusal anywhere along the cause chain, including inside an AggregateError', () => {
    expect(isUnsafeAddressRefusal(refused)).toBe(true);
    expect(
      isUnsafeAddressRefusal(
        new TypeError('fetch failed', { cause: new AggregateError([refused]) })
      )
    ).toBe(true);
    expect(isUnsafeAddressRefusal(notFound)).toBe(false);
  });

  it('reads a refused host and a missing one the same for a customer org — no map of the internal DNS', async () => {
    await runAsOrg(ORG_B, async () => {
      expect(describeOutboundFailure(refused)).toBe(describeOutboundFailure(notFound));
      expect(describeOutboundFailure(refused)).not.toContain('db');
      // Anything else keeps its detail.
      expect(describeOutboundFailure(reset)).toContain('socket hang up');
    });
  });

  it('control: the install org gets the detail', async () => {
    await runAsOrg(INSTALL_ORG_ID, async () => {
      expect(describeOutboundFailure(notFound)).toContain('ENOTFOUND');
    });
  });
});
