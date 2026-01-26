/**
 * Server-Side Analytics
 *
 * Server-side tracking utilities for analytics that bypasses ad blockers.
 * Use this in API routes and server actions for critical event tracking.
 *
 * Phase 4.5: Analytics Integration
 *
 * @see .context/analytics/overview.md for architecture documentation
 */

import { headers } from 'next/headers';
import {
  detectProvider,
  getGA4Config,
  getPostHogConfig,
  getPlausibleConfig,
  GA4_ENV,
  POSTHOG_ENV,
} from './config';
import type { ServerTrackOptions, ServerTrackContext, TrackResult } from './types';
import { logger } from '@/lib/logging';

/**
 * Track an event server-side
 *
 * Sends tracking data directly to the analytics provider's server API,
 * bypassing client-side ad blockers. Use for critical conversion events.
 *
 * Note: Requires server-side API keys to be configured.
 *
 * @param options - Tracking options (event, userId, properties, context)
 * @returns Result indicating success or failure
 *
 * @example
 * ```typescript
 * // In an API route
 * import { serverTrack } from '@/lib/analytics/server';
 *
 * export async function POST(request: Request) {
 *   const user = await getUser();
 *
 *   await serverTrack({
 *     event: 'subscription_created',
 *     userId: user.id,
 *     properties: {
 *       plan: 'pro',
 *       value: 99.99,
 *       currency: 'USD',
 *     },
 *   });
 *
 *   return Response.json({ success: true });
 * }
 * ```
 */
export async function serverTrack(options: ServerTrackOptions): Promise<TrackResult> {
  const provider = detectProvider();

  if (!provider || provider === 'console') {
    // Log for console provider
    logger.debug('Server track (console)', {
      event: options.event,
      userId: options.userId,
      properties: options.properties,
    });
    return { success: true };
  }

  try {
    // Get request context from headers
    const context = await getRequestContext(options.context);

    switch (provider) {
      case 'ga4':
        return await trackGA4(options, context);
      case 'posthog':
        return await trackPostHog(options, context);
      case 'plausible':
        return await trackPlausible(options, context);
      default: {
        // Type-safe exhaustive check
        const _exhaustiveCheck: never = provider;
        return { success: false, error: `Unknown provider: ${String(_exhaustiveCheck)}` };
      }
    }
  } catch (error) {
    logger.error('Server track failed', error, { event: options.event });
    return { success: false, error: String(error) };
  }
}

/**
 * Get request context from Next.js headers
 */
async function getRequestContext(
  providedContext?: ServerTrackContext
): Promise<ServerTrackContext> {
  if (providedContext) {
    return providedContext;
  }

  try {
    const headersList = await headers();

    return {
      ip:
        headersList.get('x-forwarded-for')?.split(',')[0] ??
        headersList.get('x-real-ip') ??
        undefined,
      userAgent: headersList.get('user-agent') ?? undefined,
      page: {
        url: headersList.get('referer') ?? undefined,
        referrer: headersList.get('referer') ?? undefined,
      },
    };
  } catch {
    return {};
  }
}

/**
 * Track event via GA4 Measurement Protocol
 *
 * @see https://developers.google.com/analytics/devguides/collection/protocol/ga4
 */
async function trackGA4(
  options: ServerTrackOptions,
  context: ServerTrackContext
): Promise<TrackResult> {
  const config = getGA4Config();
  const apiSecret = process.env[GA4_ENV.API_SECRET];

  if (!config || !apiSecret) {
    return {
      success: false,
      error: 'GA4 server-side tracking requires GA4_API_SECRET to be configured',
    };
  }

  const { measurementId } = config;
  const clientId = options.userId ?? options.anonymousId ?? generateAnonymousId();

  const payload = {
    client_id: clientId,
    user_id: options.userId,
    events: [
      {
        name: options.event,
        params: {
          ...options.properties,
          engagement_time_msec: 100,
        },
      },
    ],
  };

  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(context.userAgent && { 'User-Agent': context.userAgent }),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    return { success: false, error: `GA4 API error: ${response.status}` };
  }

  return { success: true };
}

/**
 * Track event via PostHog API
 *
 * @see https://posthog.com/docs/api/capture
 */
async function trackPostHog(
  options: ServerTrackOptions,
  context: ServerTrackContext
): Promise<TrackResult> {
  const config = getPostHogConfig();
  const apiKey = process.env[POSTHOG_ENV.API_KEY] || process.env[POSTHOG_ENV.KEY];

  if (!config || !apiKey) {
    return {
      success: false,
      error: 'PostHog server-side tracking requires POSTHOG_API_KEY to be configured',
    };
  }

  const distinctId = options.userId ?? options.anonymousId ?? generateAnonymousId();

  const payload = {
    api_key: apiKey,
    event: options.event,
    distinct_id: distinctId,
    properties: {
      ...options.properties,
      $lib: 'sunrise-server',
      $lib_version: '1.0.0',
      ...(context.ip && { $ip: context.ip }),
      ...(context.userAgent && { $user_agent: context.userAgent }),
      ...(context.page?.url && { $current_url: context.page.url }),
      ...(context.page?.referrer && { $referrer: context.page.referrer }),
    },
  };

  const response = await fetch(`${config.host}/capture/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    return { success: false, error: `PostHog API error: ${response.status}` };
  }

  return { success: true };
}

/**
 * Track event via Plausible Events API
 *
 * @see https://plausible.io/docs/events-api
 */
async function trackPlausible(
  options: ServerTrackOptions,
  context: ServerTrackContext
): Promise<TrackResult> {
  const config = getPlausibleConfig();

  if (!config) {
    return { success: false, error: 'Plausible not configured' };
  }

  const { domain, host } = config;

  // Plausible requires a URL for page views
  const url = context.page?.url ?? `https://${domain}/`;

  const payload = {
    name: options.event,
    url,
    domain,
    props: options.properties
      ? JSON.stringify(
          Object.fromEntries(
            Object.entries(options.properties).filter(
              ([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
            )
          )
        )
      : undefined,
  };

  const response = await fetch(`${host}/api/event`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(context.userAgent && { 'User-Agent': context.userAgent }),
      ...(context.ip && { 'X-Forwarded-For': context.ip }),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    return { success: false, error: `Plausible API error: ${response.status}` };
  }

  return { success: true };
}

/**
 * Generate a random anonymous ID for server-side tracking
 */
function generateAnonymousId(): string {
  return `anon_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Track a page view server-side
 *
 * Convenience function for tracking page views from server components.
 *
 * @param pageName - Name of the page
 * @param url - Full URL of the page
 * @param userId - Optional user ID
 */
export async function serverPageView(
  pageName: string,
  url: string,
  userId?: string
): Promise<TrackResult> {
  return serverTrack({
    event: 'pageview',
    userId,
    properties: {
      page_name: pageName,
      url,
    },
    context: {
      page: { url },
    },
  });
}
