/**
 * Where a webhook or event-hook delivery was sent (§109 t-739).
 *
 * A delivery row is the record of where an event's payload went. Its parent
 * (the subscription or hook) holds only the CURRENT destination, can be edited,
 * and can be deleted, so the row carries its own:
 *
 * - `destination`: readable, and safe to show and export. A URL is recorded
 *   as its **origin only** — scheme, host and port. A webhook URL often
 *   carries its credential in the path, the query, the userinfo or the
 *   fragment, and no heuristic can tell a short path token from a route name
 *   (`loggableUrl`, built for log lines, keeps any segment it does not
 *   recognise as an id), so none of them is kept. An email address is kept,
 *   trimmed and lower-cased so that subject access and erasure can find it by
 *   an exact match (see {@link webhookDeliveriesAddressedTo}).
 * - `destinationFingerprint`: a keyed HMAC of the FULL destination. The origin
 *   cannot tell one `https://hooks.slack.com` webhook from another, which is
 *   exactly the question an auditor asks ("was it sent to OUR Slack?"). With the fingerprint, an operator with server access can confirm
 *   an exact URL (`fingerprintDestination`) and tell whether two deliveries went
 *   to the same place, without the row holding the secret.
 *
 * **Keyed, not a plain hash.** Delivery rows go out in the org export
 * (`lib/privacy/org-sources.ts`), and a plain SHA-256 of a URL whose secret is a
 * short path segment could be brute-forced offline from that file, given the
 * rest of the URL. The key is
 * an HKDF subkey of `BETTER_AUTH_SECRET`, domain-separated by its `info` label
 * the way `lib/logging/visitor-id.ts` separates its own. So rotating that
 * secret makes older fingerprints unverifiable. A retry after rotation then
 * records the same URL as a new destination, which over-reports rather than
 * hides.
 *
 * **Retries follow the parent's current destination**, since the row holds no
 * full URL to send to. When that differs from the recorded one, the recorded
 * pair moves into `previousDestinations` before the new one is written, so the
 * row names every destination the payload was sent to (`destinationUpdate`).
 *
 * Platform-agnostic: no Next.js imports.
 */

import { createHmac, hkdfSync } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { env } from '@/lib/env';
import { logger } from '@/lib/logging';

/**
 * HKDF `info` label. It separates this subkey from every other use of
 * `BETTER_AUTH_SECRET`, and is versioned so a scheme change can rotate cleanly.
 */
const KDF_INFO = 'sunrise:delivery-destination:v1';

/** Prefix on every fingerprint, so a future scheme is told apart from this one. */
const FINGERPRINT_VERSION = 'v1';

export type DestinationChannel = 'webhook' | 'email';

/** The pair of columns an attempt writes. */
export interface DeliveryDestination {
  destination: string;
  destinationFingerprint: string;
}

/** What a delivery row currently records, as read back from the database. */
export interface RecordedDestination {
  destination: string | null;
  destinationFingerprint: string | null;
  previousDestinations: Prisma.JsonValue | null;
}

/** The delivery row fields an attempt reads: its id and what it already records. */
export interface DeliveryLike extends RecordedDestination {
  id: string;
}

const previousDestinationsSchema = z.array(
  z.object({
    destination: z.string(),
    /** Null once erased: see {@link redactAddressInHistory}. */
    destinationFingerprint: z.string().nullable(),
    /** When the payload stopped going here: the first attempt at the next destination. */
    until: z.string(),
  })
);

export type PreviousDestination = z.infer<typeof previousDestinationsSchema>[number];

/**
 * Derived on each call rather than cached: a module-level cache is process
 * state the tenancy roster would have to account for, and HKDF over a short
 * secret costs microseconds beside the HTTP request it accompanies.
 */
function fingerprintKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', env.BETTER_AUTH_SECRET, Buffer.alloc(0), KDF_INFO, 32));
}

/**
 * The keyed fingerprint of a full destination. Exported so an operator can
 * confirm a suspected URL against a row from a server shell; the channel is
 * part of the input, so a URL and an email address never collide.
 */
export function fingerprintDestination(channel: DestinationChannel, raw: string): string {
  const mac = createHmac('sha256', fingerprintKey())
    .update(`${channel}:${raw}`, 'utf8')
    .digest('base64url');
  return `${FINGERPRINT_VERSION}:${mac}`;
}

/** An email address as a delivery row records it: trimmed and lower-cased. */
export function normaliseAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * A URL's origin — the only part of it a delivery row records. Anything that
 * does not parse as an http(s) URL is replaced, never echoed, the way
 * `loggableUrl` treats it.
 */
function originOf(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return '[unparseable-url]';
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    ? parsed.origin
    : '[non-http-url]';
}

/**
 * The readable form and the fingerprint of one full destination. An email
 * address is normalised before both, so the same inbox always yields the same
 * pair however the subscription spelled it.
 */
export function describeDestination(channel: DestinationChannel, raw: string): DeliveryDestination {
  if (channel === 'email') {
    const address = normaliseAddress(raw);
    return {
      destination: address,
      destinationFingerprint: fingerprintDestination('email', address),
    };
  }
  return {
    destination: originOf(raw),
    destinationFingerprint: fingerprintDestination('webhook', raw),
  };
}

/**
 * The `where` that selects the webhook deliveries sent to a data subject's
 * email address — now or before a retry moved them on — or `null` when none can
 * be attributed to them. Subject access (`export-sources.ts`) and erasure
 * (`erase-user.ts`) both match through this, so the two cannot drift apart.
 *
 * Only for a **verified** address, on the contact-form rule
 * (`lib/privacy/contact-submissions.ts`): with verification off anyone can open
 * an account under someone else's address, and matching it would hand them the
 * notifications another person received, or erase that person's record.
 *
 * ⚠️ Exact, on the normalised address {@link describeDestination} writes —
 * never `mode: 'insensitive'`, which Prisma compiles to an unescaped `ILIKE`, so
 * `_` and `%` in an address would match other people's rows. The JSON half is a
 * `@>` containment, exact for the same reason.
 */
export function webhookDeliveriesAddressedTo(subject: {
  email: string;
  emailVerified: boolean;
}): Prisma.AiWebhookDeliveryWhereInput | null {
  if (!subject.emailVerified) return null;
  const address = normaliseAddress(subject.email);
  return {
    OR: [
      { destination: address },
      { previousDestinations: { array_contains: [{ destination: address }] } },
    ],
  };
}

/**
 * The destination a webhook subscription's next attempt targets, by its
 * channel. `null` when the subscription has none to send to: the attempt is
 * then refused before anything leaves, and there is nothing to record.
 */
export function subscriptionDestination(sub: {
  channel: string;
  url: string | null;
  emailAddress: string | null;
}): DeliveryDestination | null {
  if (sub.channel === 'email') {
    return sub.emailAddress ? describeDestination('email', sub.emailAddress) : null;
  }
  return sub.url ? describeDestination('webhook', sub.url) : null;
}

/**
 * A recorded destination that may be written somewhere longer-lived than the
 * delivery row, such as the admin audit log: the URL's origin, or `null` for an
 * email address. The audit log is kept through a person's erasure (its actor
 * is `SetNull`), so an address written there would outlive the erasure of the
 * person it belongs to. A recorded URL is always `http(s)://…`; an email
 * address never is.
 */
export function auditableDestination(destination: string | null): string | null {
  if (destination === null) return null;
  return destination.startsWith('https://') || destination.startsWith('http://')
    ? destination
    : null;
}

/**
 * What an erased email destination reads as. The delivery row stays — it is
 * the org's record that an event was sent — but the address was the erased
 * person's own, so it does not.
 */
export const ERASED_DESTINATION = '[erased]';

/**
 * `previousDestinations` with every entry for `address` (compared
 * case-insensitively) redacted to {@link ERASED_DESTINATION}, fingerprint and
 * all. `null` when nothing matched, so the caller writes only rows that change.
 */
export function redactAddressInHistory(
  value: Prisma.JsonValue | null,
  address: string
): PreviousDestination[] | null {
  const history = readPreviousDestinations(value);
  const target = normaliseAddress(address);
  let changed = false;
  const redacted = history.map((entry) => {
    if (entry.destination !== target) return entry;
    changed = true;
    return { ...entry, destination: ERASED_DESTINATION, destinationFingerprint: null };
  });
  return changed ? redacted : null;
}

/** The recorded history, validated. A row this module did not write reads as empty. */
function readPreviousDestinations(value: Prisma.JsonValue | null): PreviousDestination[] {
  if (value === null) return [];
  const parsed = previousDestinationsSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logger.error('Delivery previousDestinations is malformed; starting its history afresh', {
    issues: parsed.error.issues.length,
  });
  return [];
}

/**
 * The column writes that bring a delivery's record up to date with the
 * destination an attempt is about to use, for spreading into the attempt's own
 * update. `{}` when nothing changes: the target is already recorded, or there
 * is no target.
 *
 * The first destination is written as is. A different one moves the recorded
 * pair into `previousDestinations`, stamped with `now`, so nothing the payload
 * was sent to is overwritten.
 */
export function destinationUpdate(
  recorded: RecordedDestination,
  target: DeliveryDestination | null,
  now: Date = new Date()
): {
  destination?: string;
  destinationFingerprint?: string;
  previousDestinations?: Prisma.InputJsonValue;
} {
  if (!target) return {};
  if (recorded.destinationFingerprint === target.destinationFingerprint) return {};
  if (recorded.destination === null || recorded.destinationFingerprint === null) {
    return { ...target };
  }
  const previousDestinations: PreviousDestination[] = [
    ...readPreviousDestinations(recorded.previousDestinations),
    {
      destination: recorded.destination,
      destinationFingerprint: recorded.destinationFingerprint,
      until: now.toISOString(),
    },
  ];
  return { ...target, previousDestinations };
}
