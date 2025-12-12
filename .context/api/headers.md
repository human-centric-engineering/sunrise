# API Headers & Middleware

## HTTP Headers Strategy

Sunrise implements comprehensive HTTP header management for security, performance, and API functionality. Headers are set through Next.js middleware and route-specific logic.

## Security Headers

### Implementation via Middleware

```typescript
// middleware.ts
import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // Security headers
  setSecurityHeaders(response);

  // CORS headers (if needed)
  if (request.nextUrl.pathname.startsWith('/api/v1/')) {
    setCORSHeaders(response, request);
  }

  return response;
}

function setSecurityHeaders(response: NextResponse) {
  // Prevent clickjacking attacks
  response.headers.set('X-Frame-Options', 'DENY');

  // Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Enable XSS filter (legacy browsers)
  response.headers.set('X-XSS-Protection', '1; mode=block');

  // Content Security Policy
  response.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );

  // Force HTTPS in production
  if (process.env.NODE_ENV === 'production') {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload'
    );
  }

  // Referrer policy
  response.headers.set(
    'Referrer-Policy',
    'strict-origin-when-cross-origin'
  );

  // Permissions policy
  response.headers.set(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=(), payment=()'
  );
}
```

### Security Header Descriptions

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Frame-Options` | `DENY` | Prevent clickjacking by blocking iframe embedding |
| `X-Content-Type-Options` | `nosniff` | Prevent MIME type sniffing attacks |
| `X-XSS-Protection` | `1; mode=block` | Enable browser XSS filter (legacy) |
| `Content-Security-Policy` | See above | Restrict resource loading to prevent XSS |
| `Strict-Transport-Security` | `max-age=31536000` | Force HTTPS for 1 year |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Control referrer information leakage |
| `Permissions-Policy` | Feature restrictions | Disable unnecessary browser features |

## CORS (Cross-Origin Resource Sharing)

### CORS Configuration

```typescript
// lib/api/cors.ts
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

  response.headers.set(
    'Access-Control-Allow-Methods',
    options.methods?.join(', ') || ''
  );

  response.headers.set(
    'Access-Control-Allow-Headers',
    options.allowedHeaders?.join(', ') || ''
  );

  if (options.exposedHeaders) {
    response.headers.set(
      'Access-Control-Expose-Headers',
      options.exposedHeaders.join(', ')
    );
  }

  if (options.maxAge) {
    response.headers.set('Access-Control-Max-Age', String(options.maxAge));
  }
}

function isOriginAllowed(
  origin: string,
  allowed?: string | string[]
): boolean {
  if (!allowed) return false;
  if (allowed === '*') return true;
  if (typeof allowed === 'string') return origin === allowed;
  return allowed.includes(origin);
}
```

### OPTIONS Preflight Handler

```typescript
// app/api/v1/[...route]/route.ts
export async function OPTIONS(request: NextRequest) {
  const response = new NextResponse(null, { status: 204 });
  setCORSHeaders(response, request);
  return response;
}
```

### Per-Route CORS Override

```typescript
// app/api/v1/public/data/route.ts
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

## Rate Limiting Headers

### Rate Limit Implementation

```typescript
// middleware.ts
import { rateLimit } from '@/lib/security/rate-limit';

const limiter = rateLimit({
  interval: 60 * 1000, // 1 minute
  uniqueTokenPerInterval: 500,
});

export function middleware(request: NextRequest) {
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

| Header | Description | Example |
|--------|-------------|---------|
| `X-RateLimit-Limit` | Maximum requests allowed in window | `100` |
| `X-RateLimit-Remaining` | Requests remaining in current window | `42` |
| `X-RateLimit-Reset` | Timestamp when limit resets | `1640995200` |
| `Retry-After` | Seconds to wait before retrying | `60` |

## Content Type Headers

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

### API Version Headers

```typescript
// middleware.ts
export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // API version information
  response.headers.set('X-API-Version', 'v1');
  response.headers.set('X-API-Deprecation-Date', '2026-12-31');

  return response;
}
```

### Request ID Tracing

```typescript
// middleware.ts
import { randomUUID } from 'crypto';

export function middleware(request: NextRequest) {
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

```typescript
// app/api/v1/users/route.ts
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

### Bearer Token Pattern (Future Enhancement)

```typescript
// For API key authentication (alternative to session cookies)
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
    return Response.json(
      { success: false, error: { message: 'Invalid token' } },
      { status: 401 }
    );
  }
}
```

## Decision History & Trade-offs

### Middleware vs. Route-Level Headers
**Decision**: Set security headers in middleware, CORS per-route
**Rationale**:
- Security headers: Same for all routes (centralized)
- CORS: May vary per endpoint (public vs. authenticated)
- Reduces duplication while maintaining flexibility

**Trade-offs**: Middleware runs on every request (minimal overhead)

### CSP Inline Script Allowance
**Decision**: Allow `unsafe-inline` for scripts/styles
**Rationale**:
- Next.js and React require inline scripts for hydration
- Tailwind uses inline styles
- Stricter CSP would break core functionality

**Trade-offs**: Reduced XSS protection (mitigated by React's auto-escaping)

### HSTS Preload
**Decision**: Include `preload` directive in production
**Rationale**:
- Maximum security for HTTPS enforcement
- Prevents protocol downgrade attacks
- Required for HSTS preload list submission

**Trade-offs**: Difficult to undo if HTTPS becomes unavailable (intentional design)

## Performance Considerations

### Header Size
Headers are sent with every request. Keep custom headers minimal:
- **Good**: `X-Request-ID: uuid` (~50 bytes)
- **Bad**: Embedding large JSON in headers (use response body instead)

### Middleware Overhead
Middleware runs on every matching request:
```typescript
// Efficient: Simple header setting
response.headers.set('X-API-Version', 'v1');

// Inefficient: Database queries in middleware
const user = await prisma.user.findUnique({ where: { id } }); // Don't do this
```

## Related Documentation

- [API Endpoints](./endpoints.md) - API route implementation
- [API Examples](./examples.md) - Client implementation with headers
- [Auth Security](../auth/security.md) - Authentication security measures
- [Architecture Overview](../architecture/overview.md) - Middleware architecture
