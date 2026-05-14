---
name: api-builder
description: |
  Canonical recipe for building API endpoints in Sunrise. Produces routes
  that match the codebase pattern: Zod validation, `withAuth` / `withAdminAuth`
  wrappers from `lib/auth/guards.ts`, rate limiting on mutating endpoints,
  standardised responses, structured route logging, and the standard error
  envelope. Use when creating new routes under `app/api/v1/` or modifying
  existing ones. Defers test writing to the `testing` skill / `/test-write`.
---

# API Builder Skill

Build endpoints that match what's already in the codebase. The patterns below are taken from real routes (`app/api/v1/admin/orchestration/quiz-scores/route.ts`, `app/api/v1/chat/agents/route.ts`, `app/api/v1/contact/route.ts`) — copy them, don't invent your own.

**Critical rule:** routes wrap handlers with `withAuth` / `withAdminAuth` from `lib/auth/guards.ts`. The wrappers handle session lookup, role check, error catching, and the error envelope automatically. **Do not write `try/catch` in the handler.** Throw a typed error (`UnauthorizedError`, `ForbiddenError`, `ValidationError`, `NotFoundError`, `ConflictError`) and the wrapper formats it.

---

## The standard envelope

```typescript
// Success
{ success: true, data: { ... }, meta?: { ... } }

// Error
{ success: false, error: { code: 'ERROR_CODE', message: '…', details?: { ... } } }
```

Use the helpers in `@/lib/api/responses`:

- `successResponse(data, meta?, options?)` — 200 by default; pass `{ status: 201 }` for creates
- `paginatedResponse(data, { page, limit, total })` — wraps data with pagination meta
- `errorResponse(message, { code, status, details, headers })` — rarely used directly; throw a typed error instead

---

## Auth wrappers (the only auth pattern routes should use)

```typescript
import { withAuth, withAdminAuth } from '@/lib/auth/guards';

// Any authenticated user
export const GET = withAuth(async (request, session) => {
  return successResponse({ user: session.user });
});

// Admin only
export const POST = withAdminAuth(async (request, session) => {
  // session is guaranteed to be an admin
});
```

The wrappers:

- Resolve the session via `auth.api.getSession({ headers: await headers() })` for you
- Throw `UnauthorizedError` if no session
- Throw `ForbiddenError` if `withAdminAuth` and the role isn't admin
- Route all thrown errors through `handleAPIError(error)` automatically

Use `getServerSession()` / `requireAuth()` / `requireRole()` from `@/lib/auth/utils` only **outside** route handlers (server components, background jobs, scripts). Inside a route, always use the wrappers.

---

## The canonical recipe

A mutating admin endpoint with everything wired correctly. Strip parts you don't need (rate-limit on GETs, request body on listing endpoints) but keep the structure.

### Step 1 — Zod schema

`lib/validations/<domain>.ts`:

```typescript
import { z } from 'zod';

export const createWidgetSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

export const widgetQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  q: z.string().optional(),
});

export type CreateWidgetInput = z.infer<typeof createWidgetSchema>;
export type WidgetQuery = z.infer<typeof widgetQuerySchema>;
```

Reuse what's already in `lib/validations/` — `emailSchema`, `nameSchema`, common pagination fields, etc. — before adding new ones.

### Step 2 — Route handler

`app/api/v1/widgets/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse, paginatedResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody, validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { createWidgetSchema, widgetQuerySchema } from '@/lib/validations/widget';

export const GET = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const { page, limit, q } = validateQueryParams(request.nextUrl.searchParams, widgetQuerySchema);
  const skip = (page - 1) * limit;

  const where = {
    ownerId: session.user.id,
    ...(q && { name: { contains: q, mode: 'insensitive' as const } }),
  };

  const [data, total] = await Promise.all([
    prisma.widget.findMany({
      where,
      skip,
      take: limit,
      select: { id: true, name: true, description: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.widget.count({ where }),
  ]);

  log.info('Widgets listed', { count: data.length, total, userId: session.user.id });
  return paginatedResponse(data, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  // Rate limit mutating endpoints (CLAUDE.md mandates this for POST/PATCH/DELETE)
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createWidgetSchema);

  const widget = await prisma.widget.create({
    data: { ...body, ownerId: session.user.id },
    select: { id: true, name: true, description: true, createdAt: true },
  });

  log.info('Widget created', { widgetId: widget.id, userId: session.user.id });
  return successResponse(widget, undefined, { status: 201 });
});
```

### Step 3 — Dynamic route params (Next.js 16)

Params are now async. Apply this anywhere you have `[id]`:

```typescript
export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const { id } = await params;
  const widget = await prisma.widget.findFirst({
    where: { id, ownerId: session.user.id },
  });
  if (!widget) throw new NotFoundError('Widget not found');
  return successResponse(widget);
});
```

Note the generic on `withAuth<{ id: string }>` — that's what types the `params` arg.

### Step 4 — Tests

**Defer to the `testing` skill or `/test-write`.** The api-builder skill only produces the route + schema. Hand off testing as a separate step so the anti-green-bar lens applies.

If you need a minimal stub to verify wiring before handing off, mock `withAuth`/`withAdminAuth` as identity functions and call the exported handler directly (see the testing skill's "API route — mocking Prisma + auth guards" section).

---

## Rate limiting

CLAUDE.md mandates rate limiting on **all mutating endpoints** (POST/PATCH/DELETE). The canonical 4-line pattern:

```typescript
const clientIP = getClientIP(request);
const rateLimit = adminLimiter.check(clientIP);
if (!rateLimit.success) return createRateLimitResponse(rateLimit);
```

**Pick the closest pre-built limiter** from `@/lib/security/rate-limit`. Don't create new ones unless none fit:

| Limiter                    | Use for                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `authLimiter`              | Login, signup, OAuth callback — keyed by IP, brute-force tight |
| `passwordResetLimiter`     | Password reset request endpoint                                |
| `verificationEmailLimiter` | Resend-verification flow                                       |
| `contactLimiter`           | Public contact form                                            |
| `apiLimiter`               | Generic authenticated API endpoint, low-volume mutations       |
| `adminLimiter`             | Admin-only writes                                              |
| `acceptInviteLimiter`      | Invitation acceptance flow                                     |
| `inviteLimiter`            | Sending invitations                                            |
| `uploadLimiter`            | File / document upload endpoints                               |
| `audioLimiter`             | Speech-to-text and similar audio endpoints                     |
| `imageLimiter`             | Image generation / upload                                      |
| `chatLimiter`              | Authenticated chat                                             |
| `consumerChatLimiter`      | Public consumer chat                                           |
| `embedChatLimiter`         | Embed widget chat                                              |
| `cspReportLimiter`         | CSP violation reporter                                         |
| `inboundLimiter`           | Inbound webhook receivers (Slack, Postmark, generic-HMAC)      |
| `agentChatLimiter`         | Dynamic per-agent limiter                                      |
| `apiKeyChatLimiter`        | Dynamic per-API-key limiter                                    |

**Key strategy:**

- Anonymous endpoints (login, signup, contact): `getClientIP(request)`
- Authenticated, per-user abuse matters: `` `user:${session.user.id}` ``
- Authenticated, per-key abuse: `` `key:${apiKey.id}` ``

For full security context (CSP, CORS, SSRF guards, sanitisation), see `.context/security/overview.md` and `.context/security/gotchas.md`.

---

## Errors

Throw typed errors from `@/lib/api/errors`. The wrapper catches them and emits the standard envelope:

| Throw                                         | Status | Use when                                                |
| --------------------------------------------- | ------ | ------------------------------------------------------- |
| `UnauthorizedError()`                         | 401    | Wrapper handles this for missing sessions               |
| `ForbiddenError('reason')`                    | 403    | Wrapper handles this for `withAdminAuth` mismatches     |
| `ValidationError('msg', details?)`            | 400    | Schema-level rejections beyond what Zod already catches |
| `NotFoundError('Widget not found')`           | 404    | `findFirst` / `findUnique` returned null                |
| `ConflictError('Widget name already exists')` | 409    | Unique constraint, duplicate slug, etc.                 |
| `new APIError('CODE', 'msg', status)`         | custom | Anything else — pick a kebab-case code                  |

`validateRequestBody` and `validateQueryParams` throw `ValidationError` automatically when the Zod schema rejects. You don't need to wrap them.

---

## Route logger

Every route gets a logger scoped to the request via `getRouteLogger(request)` from `@/lib/api/context`. It carries the request ID, route, method, and user agent so logs are traceable across the request lifecycle.

```typescript
const log = await getRouteLogger(request);
log.info('Widget created', { widgetId: widget.id, userId: session.user.id });
log.warn('Suspicious payload', { reason });
```

Always pass structured fields, never interpolate into the message. `log.info('Widget created: ${id}')` is wrong; `log.info('Widget created', { widgetId: id })` is right.

---

## File layout

```
app/api/v1/<resource>/route.ts                 # GET / POST / etc.
app/api/v1/<resource>/[id]/route.ts            # one-by-id
lib/validations/<resource>.ts                  # Zod schemas
tests/integration/api/v1/<resource>/route.test.ts   # tests (handled by testing skill)
```

Resources go under `app/api/v1/`. Admin-only routes live at `app/api/v1/admin/<resource>/`. Embed-widget routes live at `app/api/v1/embed/<resource>/`.

---

## Pre-completion checklist

Before declaring the endpoint done:

- [ ] Auth wrapper applied (`withAuth` or `withAdminAuth`) — no manual session resolution
- [ ] Zod schema in `lib/validations/`, types exported
- [ ] All input passes through `validateRequestBody` / `validateQueryParams`
- [ ] Mutating verbs (POST/PATCH/DELETE) have a rate-limit check
- [ ] Route logger captures the important events (create, update, delete, denial)
- [ ] `successResponse` / `paginatedResponse` for happy path; throw typed errors otherwise
- [ ] No `try/catch` in the handler (wrappers handle errors)
- [ ] Tests handed off to the testing skill / `/test-write`
- [ ] `npm run validate` passes (lint + type-check + format)

---

## Related material

- `lib/auth/guards.ts` — `withAuth`, `withAdminAuth`
- `lib/api/responses.ts` — `successResponse`, `paginatedResponse`, `errorResponse`
- `lib/api/errors.ts` — `APIError`, typed subclasses, `ErrorCodes`, `handleAPIError`
- `lib/api/validation.ts` — `validateRequestBody`, `validateQueryParams`, `parsePaginationParams`
- `lib/api/context.ts` — `getRouteLogger`
- `lib/api/etag.ts` — `computeETag`, `checkConditional` (for cacheable GETs)
- `.context/api/endpoints.md` — endpoint conventions, error codes, versioning
- `.context/api/examples.md` — fuller worked examples
- `.context/security/overview.md` — security primitives reference
- `.context/security/gotchas.md` — security anti-patterns to avoid
