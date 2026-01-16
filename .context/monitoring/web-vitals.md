# Web Vitals Monitoring

Guide for implementing frontend performance monitoring with Web Vitals in Sunrise.

## Overview

Web Vitals are Google's metrics for measuring user experience:

| Metric | Description               | Good    | Needs Improvement |
| ------ | ------------------------- | ------- | ----------------- |
| LCP    | Largest Contentful Paint  | ≤ 2.5s  | > 4.0s            |
| FID    | First Input Delay         | ≤ 100ms | > 300ms           |
| CLS    | Cumulative Layout Shift   | ≤ 0.1   | > 0.25            |
| TTFB   | Time to First Byte        | ≤ 800ms | > 1800ms          |
| INP    | Interaction to Next Paint | ≤ 200ms | > 500ms           |

## Implementation Options

### Option 1: Next.js Built-in (Recommended)

Next.js has built-in Web Vitals reporting. Create a client component:

```typescript
// app/web-vitals.tsx
'use client';

import { useReportWebVitals } from 'next/web-vitals';

export function WebVitals() {
  useReportWebVitals((metric) => {
    // Send to analytics
    console.log(metric);

    // Example: Send to custom endpoint
    fetch('/api/analytics/web-vitals', {
      method: 'POST',
      body: JSON.stringify(metric),
      headers: { 'Content-Type': 'application/json' },
    });
  });

  return null;
}
```

Add to your root layout:

```typescript
// app/layout.tsx
import { WebVitals } from './web-vitals';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <WebVitals />
        {children}
      </body>
    </html>
  );
}
```

### Option 2: Google Analytics 4

If using Google Analytics:

```typescript
// app/web-vitals.tsx
'use client';

import { useReportWebVitals } from 'next/web-vitals';

export function WebVitals() {
  useReportWebVitals((metric) => {
    // Send to Google Analytics
    window.gtag?.('event', metric.name, {
      value: Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value),
      event_label: metric.id,
      non_interaction: true,
    });
  });

  return null;
}
```

### Option 3: Vercel Analytics

If deploying to Vercel:

```bash
npm install @vercel/analytics
```

```typescript
// app/layout.tsx
import { Analytics } from '@vercel/analytics/react';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
```

### Option 4: Custom Analytics Endpoint

Create an API endpoint to collect metrics:

```typescript
// app/api/analytics/web-vitals/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logging';

interface WebVitalMetric {
  id: string;
  name: string;
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  navigationType: string;
}

export async function POST(request: NextRequest) {
  try {
    const metric: WebVitalMetric = await request.json();

    // Log the metric
    logger.info('Web Vital recorded', {
      metric: metric.name,
      value: metric.value,
      rating: metric.rating,
      id: metric.id,
    });

    // Could also send to external analytics service
    // await sendToAnalytics(metric);

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Failed to record Web Vital', error);
    return NextResponse.json({ success: false, error: 'Failed to record metric' }, { status: 500 });
  }
}
```

## Metric Details

### LCP (Largest Contentful Paint)

Measures loading performance - when the largest content element becomes visible.

**Optimize by:**

- Optimize images (use Next.js Image component)
- Preload critical resources
- Use CDN for static assets
- Minimize render-blocking resources

### FID (First Input Delay)

Measures interactivity - time from first interaction to browser response.

**Optimize by:**

- Minimize JavaScript execution time
- Break up long tasks
- Use web workers for heavy computation
- Defer non-critical JavaScript

### CLS (Cumulative Layout Shift)

Measures visual stability - unexpected layout shifts.

**Optimize by:**

- Always include size attributes on images
- Reserve space for dynamic content
- Avoid inserting content above existing content
- Use CSS transforms for animations

### INP (Interaction to Next Paint)

Measures responsiveness - delay between interactions and visual updates.

**Optimize by:**

- Optimize event handlers
- Use `requestIdleCallback` for non-urgent work
- Minimize main thread work
- Use CSS transitions over JavaScript

## Dashboard Integration

### DataDog RUM

```typescript
// app/web-vitals.tsx
'use client';

import { useReportWebVitals } from 'next/web-vitals';
import { datadogRum } from '@datadog/browser-rum';

export function WebVitals() {
  useReportWebVitals((metric) => {
    datadogRum.addAction(metric.name, {
      value: metric.value,
      rating: metric.rating,
    });
  });

  return null;
}
```

### New Relic Browser

```typescript
// app/web-vitals.tsx
'use client';

import { useReportWebVitals } from 'next/web-vitals';

export function WebVitals() {
  useReportWebVitals((metric) => {
    if (typeof window.newrelic !== 'undefined') {
      window.newrelic.addPageAction('web-vital', {
        name: metric.name,
        value: metric.value,
        rating: metric.rating,
      });
    }
  });

  return null;
}
```

### Grafana

Send to your metrics endpoint:

```typescript
// app/web-vitals.tsx
'use client';

import { useReportWebVitals } from 'next/web-vitals';

export function WebVitals() {
  useReportWebVitals((metric) => {
    // Format for Prometheus/Grafana
    fetch('/api/metrics', {
      method: 'POST',
      body: JSON.stringify({
        name: `web_vitals_${metric.name.toLowerCase()}`,
        value: metric.value,
        labels: {
          page: window.location.pathname,
          rating: metric.rating,
        },
      }),
    });
  });

  return null;
}
```

## Testing Web Vitals

### Chrome DevTools

1. Open DevTools (F12)
2. Go to **Lighthouse** tab
3. Run audit with **Performance** checked
4. Review Core Web Vitals scores

### Web Vitals Extension

Install the [Web Vitals Chrome extension](https://chrome.google.com/webstore/detail/web-vitals/ahfhijdlegdabablpippeagghigmibma) for real-time monitoring.

### PageSpeed Insights

Test production URLs at [PageSpeed Insights](https://pagespeed.web.dev/).

## Best Practices

1. **Monitor in production**: Lab data (Lighthouse) differs from field data (real users)

2. **Set performance budgets**: Alert when metrics exceed thresholds

3. **Track by page**: Different pages have different performance characteristics

4. **Consider device/connection**: Segment by device type and connection speed

5. **Correlate with business metrics**: Link performance to conversion, bounce rate, etc.

## Not Implemented by Default

Web Vitals monitoring is documented but **not implemented** in Sunrise by default because:

1. **Analytics choice varies**: Teams use different analytics platforms
2. **Privacy considerations**: Sending user metrics requires consent
3. **Overhead**: Additional JavaScript and API calls
4. **Flexibility**: Easy to add when needed

Implement when you have analytics infrastructure in place.

## Related

- [Performance Monitoring](./performance.md) - Server-side performance
- [Health Checks](./health-checks.md) - Application health
- [Log Aggregation](./log-aggregation.md) - Metrics collection
