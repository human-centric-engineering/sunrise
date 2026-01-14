# Content Security Policy (CSP) Template

## Overview

Environment-aware CSP implementation that's strict in production but allows Next.js HMR in development.

**Use for:** XSS prevention, injection attack mitigation, controlling resource loading.

## Implementation

**File:** `lib/security/csp.ts`

```typescript
type CSPDirective = string[];

interface CSPConfig {
  directives: Record<string, CSPDirective>;
}

/**
 * Production CSP - Strict security
 */
const productionCSP: CSPConfig = {
  directives: {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"], // Required for Tailwind
    'img-src': ["'self'", 'data:', 'https:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'"],
    'media-src': ["'self'"],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'upgrade-insecure-requests': [],
  },
};

/**
 * Development CSP - Permissive for Next.js HMR
 */
const developmentCSP: CSPConfig = {
  directives: {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // HMR needs eval
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'https:', 'http:'],
    'font-src': ["'self'"],
    'connect-src': [
      "'self'",
      'ws://localhost:3000', // WebSocket for HMR
      'ws://127.0.0.1:3000',
      'http://localhost:3000',
    ],
    'media-src': ["'self'"],
    'object-src': ["'none'"],
    'frame-src': ["'self'"], // Allow iframes in dev (for debugging)
    'frame-ancestors': ["'self'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  },
};

/**
 * Build CSP header string from config
 */
function buildCSPHeader(config: CSPConfig): string {
  return Object.entries(config.directives)
    .map(([directive, values]) => {
      if (values.length === 0) {
        return directive; // e.g., 'upgrade-insecure-requests'
      }
      return `${directive} ${values.join(' ')}`;
    })
    .join('; ');
}

/**
 * Get CSP header for current environment
 */
export function getCSPHeader(): string {
  const isDevelopment = process.env.NODE_ENV === 'development';
  const config = isDevelopment ? developmentCSP : productionCSP;
  return buildCSPHeader(config);
}

/**
 * Get CSP config for customization
 */
export function getCSPConfig(): CSPConfig {
  const isDevelopment = process.env.NODE_ENV === 'development';
  return isDevelopment ? { ...developmentCSP } : { ...productionCSP };
}

/**
 * Add custom sources to a directive
 */
export function extendCSP(config: CSPConfig, directive: string, sources: string[]): CSPConfig {
  return {
    directives: {
      ...config.directives,
      [directive]: [...(config.directives[directive] || []), ...sources],
    },
  };
}
```

## Integration in proxy.ts

```typescript
import { getCSPHeader } from '@/lib/security/csp';

// In the response headers section:
export function setSecurityHeaders(response: Response): void {
  // Existing headers
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  // Add CSP header
  response.headers.set('Content-Security-Policy', getCSPHeader());

  // Production-only headers
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}
```

## Extending CSP for Specific Pages

For pages that need additional sources (e.g., embedding external content):

```typescript
import { getCSPConfig, extendCSP, buildCSPHeader } from '@/lib/security/csp';

// In a specific API route or page
export function getExtendedCSPForEmbed(): string {
  let config = getCSPConfig();

  // Allow YouTube embeds
  config = extendCSP(config, 'frame-src', ['https://www.youtube.com']);

  // Allow Google Fonts
  config = extendCSP(config, 'font-src', ['https://fonts.googleapis.com']);
  config = extendCSP(config, 'style-src', ['https://fonts.googleapis.com']);

  return buildCSPHeader(config);
}
```

## CSP Report-Only Mode (For Testing)

Use Report-Only mode to test CSP without breaking anything:

```typescript
/**
 * Get CSP header in report-only mode for testing
 */
export function getCSPReportOnlyHeader(): string {
  return getCSPHeader();
}

// In proxy.ts:
if (process.env.CSP_REPORT_ONLY === 'true') {
  response.headers.set('Content-Security-Policy-Report-Only', getCSPHeader());
} else {
  response.headers.set('Content-Security-Policy', getCSPHeader());
}
```

## Testing

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getCSPHeader, getCSPConfig, extendCSP } from '@/lib/security/csp';

describe('CSP Configuration', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('should return strict CSP in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const header = getCSPHeader();

    expect(header).not.toContain("'unsafe-eval'");
    expect(header).toContain("frame-ancestors 'none'");
    expect(header).toContain('upgrade-insecure-requests');
  });

  it('should return permissive CSP in development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const header = getCSPHeader();

    expect(header).toContain("'unsafe-eval'");
    expect(header).toContain('ws://localhost:3000');
  });

  it('should always include self in default-src', () => {
    const header = getCSPHeader();
    expect(header).toContain("default-src 'self'");
  });

  it('should allow extending CSP config', () => {
    const config = getCSPConfig();
    const extended = extendCSP(config, 'img-src', ['https://cdn.example.com']);

    expect(extended.directives['img-src']).toContain('https://cdn.example.com');
  });

  it('should block object embeds', () => {
    const header = getCSPHeader();
    expect(header).toContain("object-src 'none'");
  });
});
```

## Common CSP Directives Reference

| Directive         | Purpose                             | Recommended Value                                             |
| ----------------- | ----------------------------------- | ------------------------------------------------------------- |
| `default-src`     | Fallback for unspecified directives | `'self'`                                                      |
| `script-src`      | JavaScript sources                  | `'self'` (prod), `'self' 'unsafe-inline' 'unsafe-eval'` (dev) |
| `style-src`       | CSS sources                         | `'self' 'unsafe-inline'` (Tailwind needs inline)              |
| `img-src`         | Image sources                       | `'self' data: https:`                                         |
| `connect-src`     | XHR, WebSocket, fetch               | `'self'` (prod), add `ws://localhost:*` (dev)                 |
| `font-src`        | Font sources                        | `'self'`                                                      |
| `frame-src`       | iframe sources                      | `'none'`                                                      |
| `frame-ancestors` | Who can embed this page             | `'none'`                                                      |
| `object-src`      | Plugin content                      | `'none'`                                                      |
| `base-uri`        | Base URL                            | `'self'`                                                      |
| `form-action`     | Form submission targets             | `'self'`                                                      |

## Troubleshooting

**CSP violations in browser console:**

1. Open browser DevTools → Console
2. Look for CSP violation messages
3. Add the blocked source to appropriate directive
4. Test in Report-Only mode first

**Common issues:**

- Inline scripts blocked → Use nonce or external scripts
- Inline styles blocked → Tailwind needs `'unsafe-inline'` in style-src
- WebSocket blocked → Add `ws://localhost:*` to connect-src (dev only)
- Images not loading → Add source domain to img-src
