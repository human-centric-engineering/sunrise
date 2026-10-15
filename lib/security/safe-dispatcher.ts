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
 * **Who is unchanged.** The install org, a platform scope with no org, and
 * every install at `single` get no dispatcher, so their fetches behave as
 * they always have, internal hostnames included. The same split, for the same
 * reason, as the env-var rule in `lib/orchestration/env-template.ts`.
 *
 * Uses the `undici` package at the major Node's own `fetch` runs on, so the
 * `Agent` is one the global `fetch` accepts as `dispatcher` (Next's patched
 * `fetch` forwards the option).
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { Agent } from 'undici';
import { checkSafeAddress, type SafeUrlCheckOptions } from '@/lib/security/safe-url';
import { getTenantContext, isMultiTenant } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

/** Raised through the connection when a hostname resolved to an address that is not allowed. */
export class UnsafeResolvedAddressError extends Error {
  readonly code = 'UNSAFE_RESOLVED_ADDRESS';
  constructor(
    public readonly hostname: string,
    public readonly address: string,
    reason: string | undefined
  ) {
    super(
      `Refusing to connect: "${hostname}" resolves to ${address}, a ${reason === 'loopback_not_allowed' ? 'loopback' : 'private or internal'} address`
    );
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
 * org, a platform scope and `single`. Pass it as `fetch(url, { dispatcher })`;
 * `undefined` is the global default.
 *
 * Tenancy posture: one process-wide `Agent` holding no org's data — its
 * sockets are keyed by origin and every new one is checked.
 */
export function outboundDispatcher(): Agent | undefined {
  if (!isMultiTenant()) return undefined;
  const orgId = getTenantContext()?.orgId ?? null;
  if (orgId === null || orgId === INSTALL_ORG_ID) return undefined;
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
