/**
 * Security Headers Unit Tests
 *
 * Tests for CSP generation and security header utilities.
 *
 * @see lib/security/headers.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextResponse } from 'next/server';
import {
  buildCSP,
  getCSP,
  getCSPConfig,
  setSecurityHeaders,
  extendCSP,
} from '@/lib/security/headers';
import type { CSPConfig } from '@/lib/security/headers';

describe('Security Headers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('buildCSP', () => {
    it('should build CSP string from config', () => {
      const config: CSPConfig = {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'unsafe-inline'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        'base-uri': ["'self'"],
        'object-src': ["'none'"],
      };

      const csp = buildCSP(config);

      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self' 'unsafe-inline'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).toContain("img-src 'self' data:");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
    });

    it('should include report-uri when provided', () => {
      const config: CSPConfig = {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'"],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        'base-uri': ["'self'"],
        'object-src': ["'none'"],
        'report-uri': '/api/csp-report',
      };

      const csp = buildCSP(config);
      expect(csp).toContain('report-uri /api/csp-report');
    });

    it('should not include report-uri when not provided', () => {
      const config: CSPConfig = {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'"],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        'base-uri': ["'self'"],
        'object-src': ["'none'"],
      };

      const csp = buildCSP(config);
      expect(csp).not.toContain('report-uri');
    });
  });

  describe('getCSPConfig', () => {
    it('should return development config in development mode', () => {
      vi.stubEnv('NODE_ENV', 'development');
      const config = getCSPConfig();

      // Development allows unsafe-eval for HMR
      expect(config['script-src']).toContain("'unsafe-eval'");
      expect(config['connect-src']).toContain('ws://localhost:*');
    });

    it('should return production config in production mode', () => {
      vi.stubEnv('NODE_ENV', 'production');
      const config = getCSPConfig();

      // Production should not have unsafe-eval
      expect(config['script-src']).not.toContain("'unsafe-eval'");
      // Production should have report-uri
      expect(config['report-uri']).toBe('/api/csp-report');
    });
  });

  describe('getCSP', () => {
    it('should return CSP string for current environment', () => {
      const csp = getCSP();

      expect(typeof csp).toBe('string');
      expect(csp).toContain("default-src 'self'");
    });
  });

  describe('setSecurityHeaders', () => {
    it('should set all required security headers', () => {
      const response = NextResponse.next();
      setSecurityHeaders(response);

      // Check CSP is set
      expect(response.headers.get('Content-Security-Policy')).toBeTruthy();

      // Check other security headers
      expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
      expect(response.headers.get('Permissions-Policy')).toContain('geolocation=()');
    });

    it('should NOT set deprecated X-XSS-Protection header', () => {
      const response = NextResponse.next();
      setSecurityHeaders(response);

      expect(response.headers.get('X-XSS-Protection')).toBeNull();
    });

    it('should set HSTS in production only', () => {
      vi.stubEnv('NODE_ENV', 'development');
      const devResponse = NextResponse.next();
      setSecurityHeaders(devResponse);
      expect(devResponse.headers.get('Strict-Transport-Security')).toBeNull();

      vi.stubEnv('NODE_ENV', 'production');
      const prodResponse = NextResponse.next();
      setSecurityHeaders(prodResponse);
      expect(prodResponse.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    });
  });

  describe('extendCSP', () => {
    it('should extend CSP with additional directives', () => {
      const extended = extendCSP({
        'img-src': ['https://cdn.example.com'],
      });

      expect(extended).toContain("img-src 'self'");
      expect(extended).toContain('https://cdn.example.com');
    });

    it('should not duplicate existing values', () => {
      const extended = extendCSP({
        'default-src': ["'self'"], // Already in base
      });

      // Should only have one 'self' in default-src
      const matches = extended.match(/default-src[^;]*/)?.[0];
      const selfCount = (matches?.match(/'self'/g) || []).length;
      expect(selfCount).toBe(1);
    });

    it('should allow overriding report-uri', () => {
      vi.stubEnv('NODE_ENV', 'production');
      const extended = extendCSP({
        'report-uri': '/custom/csp-report',
      });

      expect(extended).toContain('report-uri /custom/csp-report');
    });

    it('should add connect-src for external APIs', () => {
      const extended = extendCSP({
        'connect-src': ['https://api.analytics.com'],
      });

      // Check that the external API is added to connect-src
      expect(extended).toContain('https://api.analytics.com');
      // Base 'self' should still be there
      expect(extended).toContain("connect-src 'self'");
    });
  });

  describe('analytics CSP domains', () => {
    afterEach(() => {
      // Clean up all analytics env vars after each test
      vi.unstubAllEnvs();
    });

    it('should add PostHog domains to CSP when configured', () => {
      // Arrange
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test123');
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://eu.i.posthog.com');

      // Act
      const config = getCSPConfig();

      // Assert
      expect(config['script-src']).toContain('https://eu.i.posthog.com');
      expect(config['script-src']).toContain('https://eu-assets.i.posthog.com');
      expect(config['connect-src']).toContain('https://eu.i.posthog.com');
      expect(config['connect-src']).toContain('https://eu-assets.i.posthog.com');
    });

    it('should add default PostHog US host when no host configured', () => {
      // Arrange
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test123');
      // No NEXT_PUBLIC_POSTHOG_HOST set

      // Act
      const config = getCSPConfig();

      // Assert
      expect(config['script-src']).toContain('https://us.i.posthog.com');
      expect(config['script-src']).toContain('https://us-assets.i.posthog.com');
      expect(config['connect-src']).toContain('https://us.i.posthog.com');
      expect(config['connect-src']).toContain('https://us-assets.i.posthog.com');
    });

    it('should add GA4 domains to CSP when configured', () => {
      // Arrange
      vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', 'G-TEST123');

      // Act
      const config = getCSPConfig();

      // Assert
      expect(config['script-src']).toContain('https://www.googletagmanager.com');
      expect(config['connect-src']).toContain('https://www.google-analytics.com');
      expect(config['connect-src']).toContain('https://*.google-analytics.com');
      expect(config['connect-src']).toContain('https://www.googletagmanager.com');
    });

    it('should add Plausible domains to CSP when configured', () => {
      // Arrange
      vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', 'example.com');
      vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_HOST', 'https://analytics.example.com');

      // Act
      const config = getCSPConfig();

      // Assert
      expect(config['script-src']).toContain('https://analytics.example.com');
      expect(config['connect-src']).toContain('https://analytics.example.com');
    });

    it('should add default Plausible host when no host configured', () => {
      // Arrange
      vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', 'example.com');
      // No NEXT_PUBLIC_PLAUSIBLE_HOST set

      // Act
      const config = getCSPConfig();

      // Assert
      expect(config['script-src']).toContain('https://plausible.io');
      expect(config['connect-src']).toContain('https://plausible.io');
    });

    it('should add multiple provider domains when multiple providers configured', () => {
      // Arrange
      vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', 'G-TEST123');
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test123');
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://eu.i.posthog.com');
      vi.stubEnv('NEXT_PUBLIC_PLAUSIBLE_DOMAIN', 'example.com');

      // Act
      const config = getCSPConfig();

      // Assert - GA4 domains
      expect(config['script-src']).toContain('https://www.googletagmanager.com');
      expect(config['connect-src']).toContain('https://www.google-analytics.com');

      // Assert - PostHog domains
      expect(config['script-src']).toContain('https://eu.i.posthog.com');
      expect(config['connect-src']).toContain('https://eu.i.posthog.com');

      // Assert - Plausible domains
      expect(config['script-src']).toContain('https://plausible.io');
      expect(config['connect-src']).toContain('https://plausible.io');
    });

    it('should not add analytics domains when no providers configured', () => {
      // Arrange - no analytics env vars

      // Act
      const config = getCSPConfig();

      // Assert - should only have base CSP directives
      expect(config['script-src']).not.toContain('posthog');
      expect(config['script-src']).not.toContain('googletagmanager');
      expect(config['script-src']).not.toContain('plausible');
    });

    it('should build valid CSP string with analytics domains', () => {
      // Arrange
      vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', 'G-TEST123');

      // Act
      const csp = getCSP();

      // Assert
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain('https://www.googletagmanager.com');
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain('https://www.google-analytics.com');
    });

    it('should handle invalid PostHog host URL gracefully', () => {
      // Arrange
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test123');
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'not-a-valid-url');

      // Act - should not throw
      const config = getCSPConfig();

      // Assert - should still include the invalid host (but no assets domain)
      expect(config['script-src']).toContain('not-a-valid-url');
      // Assets domain should not be added due to URL parse failure
      expect(config['script-src']).not.toContain('assets');
    });

    it('should handle PostHog host with single-part hostname', () => {
      // Arrange
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test123');
      vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://localhost');

      // Act
      const config = getCSPConfig();

      // Assert - should include host but not derive assets domain (not enough parts)
      expect(config['script-src']).toContain('https://localhost');
      expect(config['script-src']).not.toContain('localhost-assets');
    });

    it('should add analytics domains in both development and production', () => {
      // Arrange - Development
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID', 'G-TEST123');

      // Act
      const devConfig = getCSPConfig();

      // Assert - Development should have analytics domains
      expect(devConfig['script-src']).toContain('https://www.googletagmanager.com');

      // Arrange - Production
      vi.stubEnv('NODE_ENV', 'production');

      // Act
      const prodConfig = getCSPConfig();

      // Assert - Production should also have analytics domains
      expect(prodConfig['script-src']).toContain('https://www.googletagmanager.com');
    });
  });
});
