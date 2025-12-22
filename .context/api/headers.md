# API Headers & Middleware

> **Implementation Status:** December 2025
>
> - ✅ **Implemented** - Headers and patterns currently configured
> - 📋 **Planned** - Patterns defined for future implementation

## HTTP Headers Strategy

Sunrise implements comprehensive HTTP header management for security, performance, and API functionality. Headers are set through Next.js proxy (middleware) and route-specific logic.

## Security Headers

✅ **Implemented in:** `proxy.ts` and `next.config.js`

### Implementation via Next.js Proxy

```typescript
// proxy.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const authenticated = isAuthenticated(request);

  // ... route protection logic ...

  // Add security headers to all responses
  const response = NextResponse.next();

  // Prevent clickjacking attacks
  response.headers.set('X-Frame-Options', 'DENY');

  // Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Enable XSS filter
  response.headers.set('X-XSS-Protection', '1; mode=block');

  // Control referrer information
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy - disable unnecessary features
  response.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // Force HTTPS in production
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  return response;
}

/**
 * Configure which routes the proxy runs on
 */
export const config = {
  matcher: [
    // Match all routes except api/auth, _next/static, _next/image, favicon, and image files
    '/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
```

### Additional Headers via next.config.js

✅ **Implemented in:** `next.config.js`

Redundant headers configured in Next.js config for added security (ensures headers are set even if proxy doesn't run):

```javascript
// next.config.js
async headers() {
  return [
    {
      source: '/(.*)',
      headers: [
        {
          key: 'X-Frame-Options',
          value: 'DENY',
        },
        {
          key: 'X-Content-Type-Options',
          value: 'nosniff',
        },
        {
          key: 'Referrer-Policy',
          value: 'strict-origin-when-cross-origin',
        },
      ],
    },
  ]
}
```

### Security Header Descriptions

✅ **Currently Implemented**

| Header                                   | Value                                      | Purpose                                           |
| ---------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `X-Frame-Options`                        | `DENY`                                     | Prevent clickjacking by blocking iframe embedding |
| `X-Content-Type-Options`                 | `nosniff`                                  | Prevent MIME type sniffing attacks                |
| `X-XSS-Protection`                       | `1; mode=block`                            | Enable browser XSS filter (legacy browsers)       |
| `Referrer-Policy`                        | `strict-origin-when-cross-origin`          | Control referrer information leakage              |
| `Permissions-Policy`                     | `geolocation=(), microphone=(), camera=()` | Disable geolocation, microphone, camera           |
| `Strict-Transport-Security` (production) | `max-age=31536000; includeSubDomains`      | Force HTTPS for 1 year, include subdomains        |

### Content Security Policy (CSP)

📋 **Planned** - Not yet implemented

Content Security Policy provides defense-in-depth against XSS attacks by controlling which resources can be loaded:

```typescript
// Example CSP configuration for future implementation
response.headers.set(
  'Content-Security-Policy',
  [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // Required for Next.js and React
    "style-src 'self' 'unsafe-inline'", // Required for Tailwind
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
);
```

**Note**: CSP implementation requires careful configuration with Next.js and Tailwind CSS due to their use of inline scripts and styles.

## CORS (Cross-Origin Resource Sharing)

📋 **Planned** - Not yet implemented

### CORS Configuration

Example implementation for future cross-origin API access:

```typescript
// lib/api/cors.ts (planned)
import { NextRequest, NextResponse } from 'next/server';

interface CORSOptions {
  origin?: string | string[];
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

const defaultCORSOptions: CORSOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Total-Count'],
  credentials: true,
  maxAge: 86400, // 24 hours
};

export function setCORSHeaders(
  response: NextResponse,
  request: NextRequest,
  options: CORSOptions = defaultCORSOptions
) {
  const origin = request.headers.get('origin');

  // Check if origin is allowed
  if (origin && isOriginAllowed(origin, options.origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
  }

  if (options.credentials) {
    response.headers.set('Access-Control-Allow-Credentials', 'true');
  }

  response.headers.set('Access-Control-Allow-Methods', options.methods?.join(', ') || '');

  response.headers.set('Access-Control-Allow-Headers', options.allowedHeaders?.join(', ') || '');

  if (options.exposedHeaders) {
    response.headers.set('Access-Control-Expose-Headers', options.exposedHeaders.join(', '));
  }

  if (options.maxAge) {
    response.headers.set('Access-Control-Max-Age', String(options.maxAge));
  }
}

function isOriginAllowed(origin: string, allowed?: string | string[]): boolean {
  if (!allowed) return false;
  if (allowed === '*') return true;
  if (typeof allowed === 'string') return origin === allowed;
  return allowed.includes(origin);
}
```

### OPTIONS Preflight Handler

```typescript
// app/api/v1/[...route]/route.ts (example for future implementation)
export async function OPTIONS(request: NextRequest) {
  const response = new NextResponse(null, { status: 204 });
  setCORSHeaders(response, request);
  return response;
}
```

### Per-Route CORS Override

```typescript
// app/api/v1/public/data/route.ts (example for future implementation)
export async function GET(request: NextRequest) {
  const data = await fetchPublicData();

  const response = Response.json({ success: true, data });

  // Allow any origin for this public endpoint
  setCORSHeaders(response, request, {
    origin: '*',
    methods: ['GET'],
    credentials: false,
  });

  return response;
}
```

**Note**: CORS is not currently configured. All API routes are session-based and intended for same-origin requests only.

## Rate Limiting Headers

📋 **Planned** - Not yet implemented

### Rate Limit Implementation

Example implementation for future API rate limiting:

```typescript
// proxy.ts (planned addition)
import { rateLimit } from '@/lib/security/rate-limit';

const limiter = rateLimit({
  interval: 60 * 1000, // 1 minute
  uniqueTokenPerInterval: 500,
});

export function proxy(request: NextRequest) {
  // Apply rate limiting to API routes
  if (request.nextUrl.pathname.startsWith('/api/v1/')) {
    const ip = request.ip ?? '127.0.0.1';
    const { success, remaining, reset } = limiter.check(100, ip);

    const response = success
      ? NextResponse.next()
      : new NextResponse('Too Many Requests', { status: 429 });

    // Add rate limit headers
    response.headers.set('X-RateLimit-Limit', '100');
    response.headers.set('X-RateLimit-Remaining', String(remaining));
    response.headers.set('X-RateLimit-Reset', String(reset));

    if (!success) {
      response.headers.set('Retry-After', '60');
    }

    return response;
  }

  return NextResponse.next();
}
```

### Rate Limit Headers

| Header                  | Description                          | Example      |
| ----------------------- | ------------------------------------ | ------------ |
| `X-RateLimit-Limit`     | Maximum requests allowed in window   | `100`        |
| `X-RateLimit-Remaining` | Requests remaining in current window | `42`         |
| `X-RateLimit-Reset`     | Timestamp when limit resets          | `1640995200` |
| `Retry-After`           | Seconds to wait before retrying      | `60`         |

## Content Type Headers

📋 **Guidance** - Standard content type patterns for API routes

### Standard Content Types

```typescript
// API Routes automatically set correct Content-Type

// JSON response (default)
export async function GET() {
  return Response.json({ success: true, data: {} });
  // Content-Type: application/json; charset=utf-8
}

// Plain text
export async function GET() {
  return new Response('OK', {
    headers: { 'Content-Type': 'text/plain' },
  });
}

// Binary data (file download)
export async function GET() {
  const buffer = await generatePDF();
  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="report.pdf"',
    },
  });
}

// Streaming response
export async function GET() {
  const stream = createReadStream('large-file.json');
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/json',
      'Transfer-Encoding': 'chunked',
    },
  });
}
```

## Caching Headers

📋 **Guidance** - Cache control strategies for API routes

### Cache Control Strategies

```typescript
// No caching (default for API routes)
export async function GET() {
  return Response.json(
    { data: dynamicData },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    }
  );
}

// Private caching (user-specific data)
export async function GET() {
  return Response.json(
    { data: userData },
    {
      headers: {
        'Cache-Control': 'private, max-age=300', // 5 minutes
      },
    }
  );
}

// Public caching with revalidation
export async function GET() {
  return Response.json(
    { data: publicData },
    {
      headers: {
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        // CDN cache: 1 hour
        // Serve stale while revalidating: 24 hours
      },
    }
  );
}

// Immutable resources
export async function GET() {
  return Response.json(
    { data: staticData },
    {
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        // 1 year cache
      },
    }
  );
}
```

### ETag Support

```typescript
// app/api/v1/resource/route.ts
import { createHash } from 'crypto';

export async function GET(request: NextRequest) {
  const data = await fetchData();

  // Generate ETag from content
  const content = JSON.stringify(data);
  const etag = `"${createHash('md5').update(content).digest('hex')}"`;

  // Check If-None-Match header
  const clientETag = request.headers.get('If-None-Match');

  if (clientETag === etag) {
    return new Response(null, {
      status: 304, // Not Modified
      headers: { ETag: etag },
    });
  }

  return Response.json(
    { success: true, data },
    {
      headers: {
        ETag: etag,
        'Cache-Control': 'private, max-age=300',
      },
    }
  );
}
```

## Custom Headers

📋 **Planned** - Custom header patterns for future implementation

### API Version Headers

```typescript
// proxy.ts (planned addition)
export function proxy(request: NextRequest) {
  const response = NextResponse.next();

  // API version information
  response.headers.set('X-API-Version', 'v1');
  response.headers.set('X-API-Deprecation-Date', '2026-12-31');

  return response;
}
```

### Request ID Tracing

```typescript
// proxy.ts (planned addition)
import { randomUUID } from 'crypto';

export function proxy(request: NextRequest) {
  const requestId = randomUUID();

  // Add to request headers for logging
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('X-Request-ID', requestId);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // Return in response for client tracking
  response.headers.set('X-Request-ID', requestId);

  return response;
}

// Use in error logging
export async function GET(request: NextRequest) {
  try {
    // ... logic
  } catch (error) {
    const requestId = request.headers.get('X-Request-ID');
    console.error(`[${requestId}] Error:`, error);

    return Response.json(
      {
        success: false,
        error: {
          message: 'Internal server error',
          requestId, // Include in error response
        },
      },
      { status: 500 }
    );
  }
}
```

### Pagination Headers

📋 **Guidance** - Optional pagination header pattern (currently using meta in response body)

```typescript
// app/api/v1/users/route.ts (alternative to meta field)
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '20');

  const [users, total] = await Promise.all([
    prisma.user.findMany({ skip: (page - 1) * limit, take: limit }),
    prisma.user.count(),
  ]);

  return Response.json(
    { success: true, data: users },
    {
      headers: {
        'X-Total-Count': String(total),
        'X-Page': String(page),
        'X-Per-Page': String(limit),
        'X-Total-Pages': String(Math.ceil(total / limit)),
      },
    }
  );
}
```

## Authentication Headers

📋 **Planned** - Bearer token authentication pattern

### Bearer Token Pattern (Future Enhancement)

Currently, authentication uses session cookies managed by better-auth. This section describes an alternative Bearer token pattern for future API key authentication:

```typescript
// For API key authentication (alternative to session cookies, planned)
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return Response.json(
      { success: false, error: { message: 'Missing or invalid token' } },
      {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="API"' },
      }
    );
  }

  const token = authHeader.substring(7);

  try {
    const decoded = await verifyJWT(token);
    // Continue with request
  } catch (error) {
    return Response.json({ success: false, error: { message: 'Invalid token' } }, { status: 401 });
  }
}
```

## Decision History & Trade-offs

📋 **Guidance** - Documentation of design decisions and architectural trade-offs

### Proxy vs. Route-Level Headers

**Decision**: Set security headers in proxy (middleware), CORS per-route (when implemented)
**Rationale**:

- Security headers: Same for all routes (centralized)
- CORS: May vary per endpoint (public vs. authenticated)
- Reduces duplication while maintaining flexibility

**Trade-offs**: Proxy runs on every matched request (minimal overhead)

### CSP Inline Script Allowance

**Decision**: Allow `unsafe-inline` for scripts/styles
**Rationale**:

- Next.js and React require inline scripts for hydration
- Tailwind uses inline styles
- Stricter CSP would break core functionality

**Trade-offs**: Reduced XSS protection (mitigated by React's auto-escaping)

### HSTS Configuration

**Decision**: Enable HSTS in production without `preload` directive
**Rationale**:

- ✅ Implemented: `max-age=31536000; includeSubDomains` provides strong HTTPS enforcement
- Omit `preload`: More flexibility during development and deployment
- Can add `preload` later when ready for HSTS preload list submission

**Trade-offs**: Without preload, first visit to site could still be vulnerable to protocol downgrade (mitigated by secure defaults)

## Performance Considerations

📋 **Guidance** - Performance optimization patterns for headers

### Header Size

Headers are sent with every request. Keep custom headers minimal:

- **Good**: `X-Request-ID: uuid` (~50 bytes)
- **Bad**: Embedding large JSON in headers (use response body instead)

### Proxy Overhead

The proxy (middleware) runs on every matched request:

```typescript
// Efficient: Simple header setting
response.headers.set('X-API-Version', 'v1');

// Inefficient: Database queries in proxy
const user = await prisma.user.findUnique({ where: { id } }); // Don't do this

// Note: Current proxy implementation only sets headers and checks session cookies
// No database queries or expensive operations
```

## Related Documentation

- [API Endpoints](./endpoints.md) - API route implementation
- [API Examples](./examples.md) - Client implementation with headers
- [Auth Security](../auth/security.md) - Authentication security measures
- [Architecture Overview](../architecture/overview.md) - Middleware architecture
