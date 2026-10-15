/**
 * Outbound connections that check what a hostname resolved to (§111 t-811).
 *
 * `checkSafeProviderUrl` (`lib/security/safe-url.ts`) reads the URL's text.
 * It refuses `http://10.0.0.5/` and `http://169.254.169.254/`, and it cannot
 * refuse `http://db/`, `http://10.0.0.5.nip.io/` or a domain whose A record
 * points inside the network — the module docblock calls that an accepted
 * risk. It was accepted while only the platform operator chose these URLs:
 * the operator already owns the network a hostname resolves into.
 *
 * At `multi` an org OWNER/ADMIN chooses them too — a knowledge URL to import,
 * a webhook subscription and its test — and for them the platform's network
 * is not theirs. Reading the fetched page back, or a webhook's status, would
 * turn the hostname gap into a view of the operator's internal services and
 * cloud metadata. So a fetch made for a customer org connects through
 * {@link outboundDispatcher}: an undici `Agent` whose `lookup` resolves the
 * host, refuses the connection if ANY address it resolved to fails
 * {@link checkSafeAddress}, and connects to the address it checked. Checking
 * at connect time, not before the fetch, is what closes DNS rebinding — there
 * is no second lookup for the answer to change between — and it holds on
 * every redirect hop, because each hop is a new connection.
 *
 * **Who is unchanged.** The install org, a system scope, and every install
 * at `single` get no dispatcher, so their fetches behave as they always
 * have, internal hostnames included. A call stack with no context at all at
 * `multi` is a bug, and is pinned. The same split, for the same
 * reason, as the env-var rule in `lib/orchestration/env-template.ts`.
 *
 * Uses the `undici` package at the major Node's own `fetch` runs on, so the
 * `Agent` is one the global `fetch` accepts as `dispatcher` (Next's patched
 * `fetch` forwards the option).
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { describeFetchFailure } from '@/lib/errors/fetch-error';
import { checkSafeAddress, type SafeUrlCheckOptions } from '@/lib/security/safe-url';
import { actsForPlatform } from '@/lib/tenancy/context';

/** Raised through the connection when a hostname resolved to an address that is not allowed. */
export class UnsafeResolvedAddressError extends Error {
  readonly code = 'UNSAFE_RESOLVED_ADDRESS';
  constructor(
    public readonly hostname: string,
    public readonly address: string,
    public readonly reason: string | undefined
  ) {
    // The address stays on the error for the server's logs, and out of the
    // message: the message reaches the org admin (a webhook test result, a
    // delivery's lastError), and naming where an internal hostname points
    // would map the operator's network for them.
    super(`Refusing to connect: "${hostname}" resolves to a private or internal address`);
    this.name = 'UnsafeResolvedAddressError';
  }
}

/** `dns.lookup` with `all: true`, as a function so a test can answer it. */
export type ResolveAll = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

const resolveAllWithDns: ResolveAll = (hostname, options, callback) =>
  dnsLookup(hostname, options, callback);

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

/**
 * A `lookup` for `net.connect` that resolves every address, refuses if any is
 * unsafe, and hands back only what it checked. Every address, not the first:
 * a name answering one public and one private address could otherwise be
 * connected to the private one by the happy-eyeballs pass.
 */
export function safeLookup(
  options: SafeUrlCheckOptions = {},
  resolveAll: ResolveAll = resolveAllWithDns
) {
  return (hostname: string, lookupOptions: LookupOptions, callback: LookupCallback): void => {
    resolveAll(hostname, { ...lookupOptions, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      for (const { address } of addresses) {
        const check = checkSafeAddress(address, options);
        if (!check.ok) {
          return callback(new UnsafeResolvedAddressError(hostname, address, check.reason), []);
        }
      }
      if (lookupOptions.all) return callback(null, addresses);
      const [first] = addresses;
      if (!first) {
        const none: NodeJS.ErrnoException = new Error(`No address for "${hostname}"`);
        none.code = 'ENOTFOUND';
        return callback(none, []);
      }
      callback(null, first.address, first.family);
    });
  };
}

/** An `Agent` whose every connection goes through {@link safeLookup}. */
export function createSafeDispatcher(
  options: SafeUrlCheckOptions = {},
  resolveAll?: ResolveAll
): Agent {
  return new Agent({ connect: { lookup: safeLookup(options, resolveAll) } });
}

let defaultDispatcher: Agent | null = null;

/**
 * The dispatcher a caller-chosen outbound fetch should use here, or
 * `undefined` for none: a pinned, checked one when acting for a customer org
 * at `multi`, and nothing — the fetch as it always was — for the install
 * org, a system scope and `single`. Pass it as `fetch(url, { dispatcher })`;
 * `undefined` is the global default.
 *
 * Tenancy posture: one process-wide `Agent` holding no org's data — its
 * sockets are keyed by origin and every new one is checked.
 */
export function outboundDispatcher(): Agent | undefined {
  // A customer org pins; so does a call stack with no context at `multi`,
  // which is a bug and gets the closed answer (`actsForPlatform`).
  if (actsForPlatform()) return undefined;
  defaultDispatcher ??= createSafeDispatcher();
  return defaultDispatcher;
}

/**
 * `init` with {@link outboundDispatcher}'s answer added — the form each
 * caller-chosen outbound fetch is written in: `fetch(url, withOutboundDispatcher({ … }))`.
 */
export function withOutboundDispatcher<T extends RequestInit>(init: T): T & { dispatcher?: Agent } {
  const dispatcher = outboundDispatcher();
  return dispatcher ? { ...init, dispatcher } : init;
}

/**
 * Does the address rule refuse this URL's host as an IP literal, for the
 * caller here? `net.connect` never calls `lookup` for an IP literal, so the
 * dispatcher cannot see one; a caller whose only other check is a host
 * allowlist — `executeHttpRequest`, behind `external_call` and
 * `call_external_api` — asks this before the fetch. `false` wherever
 * {@link outboundDispatcher} gives no dispatcher, and for any hostname.
 */
export function literalHostRefusedHere(url: string, options: SafeUrlCheckOptions = {}): boolean {
  if (outboundDispatcher() === undefined) return false;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  return isIP(host) !== 0 && !checkSafeAddress(host, options).ok;
}

/** The errors along a fetch failure's `cause` chain, an `AggregateError`'s members included. */
function failureChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  const visit = (e: unknown, depth: number): void => {
    if (depth > 8 || e === null || e === undefined) return;
    out.push(e);
    if (e instanceof AggregateError) for (const inner of e.errors) visit(inner, depth + 1);
    if (e instanceof Error) visit(e.cause, depth + 1);
  };
  visit(err, 0);
  return out;
}

/**
 * Was this fetch refused by {@link safeLookup}? No retry can change that —
 * only a new destination can — so a caller that retries treats it as
 * terminal, as it treats the URL-text refusal.
 */
export function isUnsafeAddressRefusal(err: unknown): boolean {
  return failureChain(err).some((e) => e instanceof UnsafeResolvedAddressError);
}

const NAME_NOT_FOUND = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_NODATA']);

/**
 * A failed outbound fetch, in words for whoever chose the URL.
 *
 * For a customer org (where {@link outboundDispatcher} pins), "that name
 * resolves inside the network" and "that name does not exist" read the same:
 * otherwise a webhook test, or a delivery's `lastError`, tells an org admin
 * which internal hostnames the operator's DNS answers, which maps the network
 * the dispatcher is there to keep them out of. Everyone else gets
 * `describeFetchFailure`'s detail, as before.
 */
export function describeOutboundFailure(err: unknown): string {
  if (outboundDispatcher() !== undefined) {
    const chain = failureChain(err);
    const hidden = chain.some(
      (e) =>
        e instanceof UnsafeResolvedAddressError ||
        (e instanceof Error &&
          typeof (e as NodeJS.ErrnoException).code === 'string' &&
          NAME_NOT_FOUND.has((e as NodeJS.ErrnoException).code as string))
    );
    if (hidden) return 'Could not reach the destination: its host is not allowed or does not exist';
  }
  return describeFetchFailure(err);
}
