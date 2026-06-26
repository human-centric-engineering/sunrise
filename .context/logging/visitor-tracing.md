# Anonymous Visitor Tracing

**Related**: [Request Context Tracing](./request-context.md) | [Logging Overview](./overview.md) | [Privacy: visitor-id](../privacy/visitor-id.md)

`requestId` correlates log lines _within one request_. `visitorId` correlates
a single anonymous visitor's activity _across_ requests — page load → contact
form → chat — so an operator can reconstruct "who hit this error, doing what,
under what conditions" for a not-logged-in visitor. The two are complementary
and both appear on every `getRouteLogger`-based log line.

| Key         | Scope                                | Source                                              |
| ----------- | ------------------------------------ | --------------------------------------------------- |
| `requestId` | one request                          | `x-request-id` header (minted in `proxy.ts`)        |
| `visitorId` | one browser, across requests (180 d) | signed `sunrise_vid` cookie, verified in `proxy.ts` |

## How it works

1. **Issue + verify (proxy).** On every matched request, `proxy.ts` reads the
   `sunrise_vid` cookie and verifies its HMAC signature. Valid → reuse the id.
   Absent or tampered → mint a fresh `nanoid`, sign it, and `Set-Cookie`
   (`HttpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/`, 180-day
   `Max-Age`). A returning visitor with a valid cookie gets **no** new
   `Set-Cookie`.
2. **Forward (proxy → app).** The verified id is forwarded to server
   components and route handlers via the `x-visitor-id` request header — the
   same mechanism as `x-nonce`. **The proxy is the sole writer of this
   header**: it sets the verified value or strips any client-supplied one, so
   `x-visitor-id` can never be spoofed from the browser.
3. **Log (handlers).** `getRequestContext()` / `getFullContext()` read the
   header, so `getRouteLogger(request)` lines carry `visitorId` automatically —
   anonymous or authenticated.

## Using it

Most code needs to do **nothing** — `getRouteLogger(request)` already includes
`visitorId`:

```typescript
import { getRouteLogger } from '@/lib/api/context';

export async function POST(request: NextRequest) {
  const log = await getRouteLogger(request);
  log.warn('Contact form rejected'); // includes requestId + visitorId
}
```

For code that builds a logger by hand or forwards context into a long-running
operation (e.g. the streaming chat handler), read the id explicitly:

```typescript
import { getVisitorId } from '@/lib/logging/context';

const visitorId = await getVisitorId(); // undefined when tracking off / cross-site
const events = streamChat({ ...request, requestId, visitorId });
```

`streamChat()` accepts `visitorId` on `ChatRequest` and folds it into the
handler's internal log context, so mid-stream errors carry the visitor key too.

## Configuration

| Env               | Default | Effect                                                                        |
| ----------------- | ------- | ----------------------------------------------------------------------------- |
| `LOG_VISITOR_ID`  | **on**  | Set `false` to disable entirely — no cookie set, no `visitorId` logged.       |
| `LOG_HTTP_ACCESS` | **off** | Set `true` to emit one structured access-log line per request from the proxy. |

Both are read directly from `process.env` in `lib/logging/visitor-id.ts` (so
they work in the proxy runtime), and registered in `lib/env.ts` for validation.

### Access log

With `LOG_HTTP_ACCESS=true`, the proxy emits one `http_access` line per matched
request: `{ requestId, visitorId, method, path }`. This makes anonymous
navigation — which otherwise emits no server logs — visible.

> **Limitation:** middleware cannot observe the final response status of a
> passthrough request, so the access line carries the request shape and
> correlation keys only, not a status code.

## Edge cases & gotchas

- **Third-party embeds get no `visitorId`.** The `sunrise_vid` cookie is
  `SameSite=Lax`, so it is **not** sent on a cross-site embed POST. A true
  third-party embed keeps its own `embed_<hash>` identity (see
  `lib/embed/auth.ts`); a **same-origin** embed _does_ receive the cookie and
  threads `visitorId` through.
- **Pre-login → post-login linkage.** The cookie is independent of the
  better-auth session, so `visitorId` persists across login — a visitor's
  anonymous and authenticated log lines share it.
- **Secret rotation invalidates cookies.** The signing key is derived from
  `BETTER_AUTH_SECRET`; rotating that secret makes existing `sunrise_vid`
  cookies fail verification and re-mint. That is acceptable — the id is only a
  log correlator, never an auth or identity signal.

## Crypto core — `lib/logging/visitor-id.ts`

- Uses the **Web Crypto API** (`crypto.subtle`), which works in both the Edge
  and Node.js runtimes, so signing (proxy) and verification (handlers) share one
  implementation regardless of where a fork runs its proxy. Do **not** swap in
  `node:crypto` — it breaks the Edge runtime.
- The HMAC key is derived from `BETTER_AUTH_SECRET` via **HKDF-SHA256** with a
  versioned `info` label (`sunrise:visitor-id:v1`) for domain separation — the
  raw auth secret is never used directly as a signing key.
- `verifyVisitorId()` uses `crypto.subtle.verify`, which compares the HMAC in
  constant time, and never throws on malformed input (returns `null`).

For the privacy posture (classification, retention, erasure), see
[`../privacy/visitor-id.md`](../privacy/visitor-id.md).
