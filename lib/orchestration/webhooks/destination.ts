/**
 * Where a webhook or event-hook delivery was sent (§109 t-739).
 *
 * A delivery row is the record of where an event's payload went. Its parent
 * (the subscription or hook) holds only the CURRENT destination, can be edited,
 * and can be deleted, so the row carries its own:
 *
 * - `destination`: readable, and safe to show and export. A URL is reduced by
 *   `loggableUrl` to its origin plus collapsed path; the query string, userinfo
 *   and fragment are dropped, because a webhook URL often carries its
 *   credential in one of those, or in a path segment. An email address is kept
 *   as it is.
 * - `destinationFingerprint`: a keyed HMAC of the FULL destination. The reduced
 *   form cannot tell one `https://hooks.slack.com/services/[param]/…` from
 *   another, which is exactly the question an auditor asks ("was it sent to OUR
 *   Slack?"). With the fingerprint, an operator with server access can confirm
 *   an exact URL (`fingerprintDestination`) and tell whether two deliveries went
 *   to the same place, without the row holding the secret.
 *
 * **Keyed, not a plain hash.** Delivery rows go out in the org export
 * (`lib/privacy/org-sources.ts`), and a plain SHA-256 of a URL whose secret is a
 * short path segment could be brute-forced offline from that file. The key is
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
import { loggableUrl } from '@/lib/logging/redact-path';

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

/** The readable form and the fingerprint of one full destination. */
export function describeDestination(channel: DestinationChannel, raw: string): DeliveryDestination {
  return {
    destination: channel === 'email' ? raw : loggableUrl(raw),
    destinationFingerprint: fingerprintDestination(channel, raw),
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
 * delivery row, such as the admin audit log: the reduced URL, or `null` for an
 * email address. The audit log is kept through a person's erasure (its actor
 * is `SetNull`), so an address written there would outlive the erasure of the
 * person it belongs to. A reduced URL is always `http(s)://…`; an email
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
  const target = address.toLowerCase();
  let changed = false;
  const redacted = history.map((entry) => {
    if (entry.destination.toLowerCase() !== target) return entry;
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
