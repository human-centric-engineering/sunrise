# Anonymous Visitor ID — Privacy Posture

**Related**: [Privacy Overview](./overview.md) | [Account Deletion & Erasure](./data-erasure.md) | [Visitor Tracing (logging)](../logging/visitor-tracing.md)

Sunrise issues a durable, signed anonymous `visitorId` (the `sunrise_vid`
cookie) so server logs can correlate an anonymous visitor's journey across
requests. This document states its privacy classification, retention, and
erasure model. For how it works mechanically, see
[`../logging/visitor-tracing.md`](../logging/visitor-tracing.md).

## What the cookie is

| Property        | Value                                                                  |
| --------------- | ---------------------------------------------------------------------- |
| Name            | `sunrise_vid`                                                          |
| Value           | Opaque random `nanoid`, HMAC-signed. **No PII, no IP, no UA encoded.** |
| Flags           | `HttpOnly`, `SameSite=Lax`, `Secure` (production), `Path=/`            |
| Lifetime        | 180 days                                                               |
| Readable by JS? | No (`HttpOnly`)                                                        |
| Cross-site?     | No (`SameSite=Lax`, first-party only)                                  |

## Classification: strictly-necessary / legitimate interest

The cookie is classified as **essential (strictly-necessary)**, not optional
analytics, and is therefore set without prior consent. The rationale:

- It exists solely for **security and operational observability** — tracing
  errors and abuse for an anonymous visitor — which is a recognised legitimate
  interest, not behavioural advertising.
- It is `HttpOnly` and first-party with **no cross-site use** and **no profile
  building**; the value is an opaque random token.
- It carries no PII itself; the linkage to a person only exists transiently in
  the log stream, governed by log retention (below).

This mirrors how the [cookie-consent system](./overview.md) treats
authentication and security cookies (the "Essential" category, always active).

> **This is a deliberate call, not a default to copy blindly.** A fork
> operating under a stricter interpretation (or in a jurisdiction/sector where
> any durable identifier requires consent) should either gate cookie-issuance
> behind the consent banner or disable the feature entirely with
> `LOG_VISITOR_ID=false`. The seam is built to make that a one-line change.

## Retention & erasure

The `visitorId` is **not** part of the `eraseUser()` cascade (see
[`./data-erasure.md`](./data-erasure.md)). That model covers authenticated
personal data held in the database under a `userId`/`createdBy` FK. The
`visitorId` is different:

- It lives **only in the log stream**, not in a Prisma model, so there is no FK
  and no cascade/`SetNull` policy to declare.
- It is governed by **log-retention windows** — when logs age out, the
  `visitorId` occurrences age out with them. This is the correct retention
  surface for an observability identifier.
- The cookie itself expires after 180 days (or immediately if the operator
  rotates `BETTER_AUTH_SECRET`, which invalidates all existing cookies).

If a fork needs visitor-level erasure on request (e.g. to satisfy an erasure
request that names a specific `visitorId`), that is a **log-scrubbing**
operation against the log store, not an `eraseUser()` concern — handle it in
the log-retention/pipeline layer.

## Disabling

Set `LOG_VISITOR_ID=false`. The proxy then issues no cookie, logs no
`visitorId`, and strips any client-supplied `x-visitor-id` header. Existing
`sunrise_vid` cookies simply expire unused.

## Documenting it to end users

A fork that ships this enabled should list `sunrise_vid` in its cookie policy
under strictly-necessary/essential cookies, with purpose "security and error
diagnostics" and a 180-day duration.
