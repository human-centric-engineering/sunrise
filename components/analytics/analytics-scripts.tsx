'use client';

/**
 * Analytics Scripts Component
 *
 * Conditionally loads analytics provider scripts based on configuration.
 * Only loads scripts when consent is given (integrates with ConsentProvider).
 *
 * Phase 4.5: Analytics Integration
 *
 * @see .context/analytics/overview.md for architecture documentation
 */

import Script from 'next/script';
import { useHasOptionalConsent } from '@/lib/consent';
import {
  detectProvider,
  getGA4Config,
  getPostHogConfig,
  getPlausibleConfig,
} from '@/lib/analytics/config';

/**
 * AnalyticsScripts component
 *
 * Loads the appropriate analytics scripts based on the detected provider.
 * Scripts are only loaded when the user has consented to optional cookies.
 *
 * Place this component in your root layout, after ConsentProvider.
 *
 * @example
 * ```tsx
 * // In app/layout.tsx
 * <ConsentProvider>
 *   <AnalyticsProvider>
 *     <AnalyticsScripts />
 *     {children}
 *   </AnalyticsProvider>
 * </ConsentProvider>
 * ```
 */
export function AnalyticsScripts() {
  const hasConsent = useHasOptionalConsent();
  const provider = detectProvider();

  // Don't load scripts without consent
  if (!hasConsent) {
    return null;
  }

  // Console provider doesn't need any scripts
  if (provider === 'console') {
    return null;
  }

  // Load provider-specific scripts
  switch (provider) {
    case 'ga4':
      return <GA4Scripts />;
    case 'posthog':
      return <PostHogScripts />;
    case 'plausible':
      return <PlausibleScripts />;
    default:
      return null;
  }
}

/**
 * Google Analytics 4 Scripts
 */
function GA4Scripts() {
  const config = getGA4Config();

  if (!config) {
    return null;
  }

  const { measurementId } = config;

  return (
    <>
      {/* Google tag (gtag.js) */}
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
        strategy="afterInteractive"
      />
      <Script id="gtag-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          window.gtag = gtag;
          gtag('js', new Date());
        `}
      </Script>
    </>
  );
}

/**
 * PostHog Scripts
 */
function PostHogScripts() {
  const config = getPostHogConfig();

  if (!config) {
    return null;
  }

  // Load only the PostHog stub (creates window.posthog with method queuing).
  // Do NOT call posthog.init() here — the PostHogProvider handles initialization
  // with the full config (capture_pageview, session recording, etc.).
  // The stub's init() also loads the actual library (array.js) when called.
  return (
    <Script id="posthog-stub" strategy="afterInteractive">
      {`
        !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures getActiveMatchingSurveys getSurveys onFeatureFlags".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
      `}
    </Script>
  );
}

/**
 * Plausible Scripts
 */
function PlausibleScripts() {
  const config = getPlausibleConfig();

  if (!config) {
    return null;
  }

  const { domain, host } = config;

  // Determine script URL based on features
  // Using the standard script - for hash mode or outbound links, use different scripts
  const scriptUrl = `${host}/js/script.js`;

  return (
    <>
      <Script data-domain={domain} src={scriptUrl} strategy="afterInteractive" />
      <Script id="plausible-init" strategy="afterInteractive">
        {`
          window.plausible = window.plausible || function() { (window.plausible.q = window.plausible.q || []).push(arguments) };
        `}
      </Script>
    </>
  );
}

export default AnalyticsScripts;
