# Rate Limiting Template

## Overview

In-memory rate limiting using LRU cache with sliding window algorithm.

**Use for:** Preventing brute force attacks, DoS protection, API abuse prevention.

## Implementation

**File:** `lib/security/rate-limit.ts`

```typescript
import { LRUCache } from 'lru-cache';

interface RateLimitConfig {
  /** Maximum requests per window */
  limit: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  headers: Record<string, string>;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// Default configurations by endpoint type
export const RATE_LIMIT_CONFIGS: Record<string, RateLimitConfig> = {
  // Auth endpoints - strict limits
  '/api/auth/sign-in': { limit: 5, windowMs: 60 * 1000 }, // 5 per minute
  '/api/auth/sign-up': { limit: 3, windowMs: 60 * 1000 }, // 3 per minute
  '/api/auth/forgot-password': { limit: 3, windowMs: 15 * 60 * 1000 }, // 3 per 15 min

  // API endpoints - moderate limits
  '/api/v1/*': { limit: 100, windowMs: 60 * 1000 }, // 100 per minute

  // Default for unspecified endpoints
  default: { limit: 60, windowMs: 60 * 1000 }, // 60 per minute
};

class RateLimiter {
  private cache: LRUCache<string, RateLimitEntry>;

  constructor(maxKeys: number = 10000) {
    this.cache = new LRUCache({
      max: maxKeys,
      ttl: 15 * 60 * 1000, // 15 minutes max TTL
    });
  }

  /**
   * Check if request is allowed
   * @param key - Rate limit key (usually IP or user ID)
   * @param endpoint - Endpoint path for config lookup
   */
  check(key: string, endpoint: string): RateLimitResult {
    const config = this.getConfig(endpoint);
    const now = Date.now();
    const cacheKey = `${key}:${endpoint}`;

    let entry = this.cache.get(cacheKey);

    // Reset if window expired
    if (!entry || entry.resetTime <= now) {
      entry = {
        count: 0,
        resetTime: now + config.windowMs,
      };
    }

    entry.count++;
    this.cache.set(cacheKey, entry);

    const allowed = entry.count <= config.limit;
    const remaining = Math.max(0, config.limit - entry.count);
    const resetInSeconds = Math.ceil((entry.resetTime - now) / 1000);

    return {
      allowed,
      remaining,
      resetTime: entry.resetTime,
      headers: {
        'X-RateLimit-Limit': String(config.limit),
        'X-RateLimit-Remaining': String(remaining),
        'X-RateLimit-Reset': String(entry.resetTime),
        ...(!allowed && { 'Retry-After': String(resetInSeconds) }),
      },
    };
  }

  /**
   * Reset rate limit for a key (for admin use or after successful action)
   */
  reset(key: string, endpoint: string): void {
    this.cache.delete(`${key}:${endpoint}`);
  }

  private getConfig(endpoint: string): RateLimitConfig {
    // Check for exact match
    if (RATE_LIMIT_CONFIGS[endpoint]) {
      return RATE_LIMIT_CONFIGS[endpoint];
    }

    // Check for wildcard matches
    for (const [pattern, config] of Object.entries(RATE_LIMIT_CONFIGS)) {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        if (endpoint.startsWith(prefix)) {
          return config;
        }
      }
    }

    return RATE_LIMIT_CONFIGS.default;
  }
}

// Singleton instance
export const rateLimiter = new RateLimiter();

/**
 * Get client IP address from request
 * Only trusts X-Forwarded-For if TRUSTED_PROXY is set
 */
export function getClientIP(request: Request): string {
  if (process.env.TRUSTED_PROXY === 'true') {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
      const ips = forwarded.split(',').map((ip) => ip.trim());
      // Take the last IP (closest to your server in proxy chain)
      return ips[ips.length - 1] || 'unknown';
    }
  }

  // For Vercel, use x-real-ip
  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }

  return 'unknown';
}

/**
 * Create rate limit key based on request
 * Uses user ID for authenticated requests, IP for anonymous
 */
export function getRateLimitKey(request: Request, userId?: string | null): string {
  if (userId) {
    return `user:${userId}`;
  }
  return `ip:${getClientIP(request)}`;
}
```

## Integration in proxy.ts

```typescript
import { rateLimiter, getRateLimitKey, getClientIP } from '@/lib/security/rate-limit';

// In proxy function, before route handling:
export async function proxyMiddleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Apply rate limiting to sensitive endpoints
  if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/v1/')) {
    const session = await getServerSession();
    const key = getRateLimitKey(request, session?.user?.id);
    const result = rateLimiter.check(key, pathname);

    if (!result.allowed) {
      logger.warn('Rate limit exceeded', {
        key,
        endpoint: pathname,
        ip: getClientIP(request),
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please try again later.',
          },
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            ...result.headers,
          },
        }
      );
    }

    // Add rate limit headers to successful responses too
    // (This needs to be done after the response is created)
  }

  // Continue with normal request handling...
}
```

## Usage in API Routes (Optional Per-Route Rate Limiting)

```typescript
import { rateLimiter, getRateLimitKey } from '@/lib/security/rate-limit';

export async function POST(request: NextRequest) {
  // Custom rate limiting for this specific endpoint
  const key = getRateLimitKey(request);
  const result = rateLimiter.check(key, '/api/v1/special-endpoint');

  if (!result.allowed) {
    return Response.json(
      {
        success: false,
        error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests' },
      },
      { status: 429, headers: result.headers }
    );
  }

  // Normal endpoint logic...
}
```

## Testing

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { rateLimiter } from '@/lib/security/rate-limit';

describe('Rate Limiter', () => {
  beforeEach(() => {
    // Reset is private, so we test with unique keys per test
  });

  it('should allow requests under limit', () => {
    const key = 'test-under-limit';
    for (let i = 0; i < 5; i++) {
      const result = rateLimiter.check(key, '/api/auth/sign-in');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4 - i);
    }
  });

  it('should block requests over limit', () => {
    const key = 'test-over-limit';
    // Fill up the limit (5 for sign-in)
    for (let i = 0; i < 5; i++) {
      rateLimiter.check(key, '/api/auth/sign-in');
    }

    // 6th request should be blocked
    const result = rateLimiter.check(key, '/api/auth/sign-in');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.headers['Retry-After']).toBeDefined();
  });

  it('should use correct config for different endpoints', () => {
    const result = rateLimiter.check('config-test', '/api/v1/users');
    expect(result.headers['X-RateLimit-Limit']).toBe('100');
  });

  it('should include all required headers', () => {
    const result = rateLimiter.check('headers-test', '/api/auth/sign-in');
    expect(result.headers['X-RateLimit-Limit']).toBeDefined();
    expect(result.headers['X-RateLimit-Remaining']).toBeDefined();
    expect(result.headers['X-RateLimit-Reset']).toBeDefined();
  });
});
```

## Dependencies

```bash
npm install lru-cache
```

Add to `package.json`:

```json
{
  "dependencies": {
    "lru-cache": "^10.0.0"
  }
}
```
