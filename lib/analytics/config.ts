/**
 * Analytics Configuration
 *
 * Centralized configuration for the analytics system.
 * Handles environment variable detection and provider selection.
 *
 * Phase 4.5: Analytics Integration
 *
 * @see .context/analytics/overview.md for architecture documentation
 */

import type { AnalyticsProviderType } from './types';

/**
 * Analytics provider environment variable name
 */
export const ANALYTICS_PROVIDER_ENV = 'NEXT_PUBLIC_ANALYTICS_PROVIDER';

/**
 * GA4 environment variable names
 */
export const GA4_ENV = {
  MEASUREMENT_ID: 'NEXT_PUBLIC_GA4_MEASUREMENT_ID',
  API_SECRET: 'GA4_API_SECRET',
} as const;

/**
 * PostHog environment variable names
 */
export const POSTHOG_ENV = {
  KEY: 'NEXT_PUBLIC_POSTHOG_KEY',
  HOST: 'NEXT_PUBLIC_POSTHOG_HOST',
} as const;

/**
 * Plausible environment variable names
 */
export const PLAUSIBLE_ENV = {
  DOMAIN: 'NEXT_PUBLIC_PLAUSIBLE_DOMAIN',
  HOST: 'NEXT_PUBLIC_PLAUSIBLE_HOST',
} as const;

/**
 * Default PostHog host
 */
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * Default Plausible host
 */
export const DEFAULT_PLAUSIBLE_HOST = 'https://plausible.io';

/**
 * Check if running in browser environment
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/**
 * Check if running in development mode
 */
export function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development';
}

/**
 * Get the explicitly configured analytics provider
 *
 * @returns Provider type or undefined if not explicitly set
 */
export function getExplicitProvider(): AnalyticsProviderType | undefined {
  // Must use literal process.env access for Next.js client-side inlining
  const provider = process.env.NEXT_PUBLIC_ANALYTICS_PROVIDER as AnalyticsProviderType | undefined;

  if (provider && !['ga4', 'posthog', 'plausible', 'console'].includes(provider)) {
    // eslint-disable-next-line no-console
    console.warn(`[analytics] Unknown provider: ${provider}. Using auto-detection.`);
    return undefined;
  }

  return provider;
}

/**
 * Check if GA4 is configured
 *
 * @returns True if GA4 measurement ID is set
 */
export function isGA4Configured(): boolean {
  return !!process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
}

/**
 * Get GA4 configuration from environment
 *
 * @returns GA4 config or null if not configured
 */
export function getGA4Config(): { measurementId: string; apiSecret?: string } | null {
  const measurementId = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;

  if (!measurementId) {
    return null;
  }

  return {
    measurementId,
    apiSecret: process.env[GA4_ENV.API_SECRET], // Server-only, dynamic access is fine
  };
}

/**
 * Check if PostHog is configured
 *
 * @returns True if PostHog API key is set
 */
export function isPostHogConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_POSTHOG_KEY;
}

/**
 * Get PostHog configuration from environment
 *
 * @returns PostHog config or null if not configured
 */
export function getPostHogConfig(): { apiKey: string; host: string } | null {
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;

  if (!apiKey) {
    return null;
  }

  return {
    apiKey,
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
  };
}

/**
 * Check if Plausible is configured
 *
 * @returns True if Plausible domain is set
 */
export function isPlausibleConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN;
}

/**
 * Get Plausible configuration from environment
 *
 * @returns Plausible config or null if not configured
 */
export function getPlausibleConfig(): { domain: string; host: string } | null {
  const domain = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN;

  if (!domain) {
    return null;
  }

  return {
    domain,
    host: process.env.NEXT_PUBLIC_PLAUSIBLE_HOST || DEFAULT_PLAUSIBLE_HOST,
  };
}

/**
 * Detect which analytics provider should be used
 *
 * Priority:
 * 1. Explicit provider via NEXT_PUBLIC_ANALYTICS_PROVIDER
 * 2. Auto-detect based on available credentials (PostHog > GA4 > Plausible)
 * 3. Console fallback in development
 *
 * @returns The provider type to use, or null if none available
 */
export function detectProvider(): AnalyticsProviderType | null {
  // 1. Check for explicit provider
  const explicit = getExplicitProvider();
  if (explicit) {
    return explicit;
  }

  // 2. Auto-detect based on credentials
  // PostHog first (most full-featured)
  if (isPostHogConfigured()) {
    return 'posthog';
  }

  // GA4 second (most common)
  if (isGA4Configured()) {
    return 'ga4';
  }

  // Plausible third (privacy-focused alternative)
  if (isPlausibleConfigured()) {
    return 'plausible';
  }

  // 3. Console fallback in development
  if (isDevelopment()) {
    return 'console';
  }

  // No provider available
  return null;
}

/**
 * Check if analytics is enabled
 *
 * Analytics is enabled if a provider can be detected.
 *
 * @returns True if analytics is available
 */
export function isAnalyticsEnabled(): boolean {
  return detectProvider() !== null;
}
