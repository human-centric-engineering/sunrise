# Privacy & Cookie Consent

## Overview

Sunrise includes a GDPR/PECR-compliant cookie consent system that gives users control over optional cookies while ensuring essential functionality remains available. The system provides a configurable banner, preferences modal, and conditional script loading.

**Documentation:**

- [Components](./components.md) - CookieBanner and PreferencesModal UI components
- [API Reference](./api.md) - Hooks, functions, types, and exports

## Architecture

```
lib/consent/
├── index.ts              # Main exports
├── types.ts              # TypeScript interfaces
├── config.ts             # Configuration constants
├── consent-provider.tsx  # React context provider
├── use-consent.ts        # React hooks
└── conditional-script.tsx # Conditional script loader

components/cookie-consent/
├── index.ts              # Component exports
├── cookie-banner.tsx     # Main consent banner
└── preferences-modal.tsx # Detailed preferences dialog
```

## Cookie Categories

| Category  | Always Active | Description                                        |
| --------- | ------------- | -------------------------------------------------- |
| Essential | Yes           | Authentication, security, theme settings           |
| Optional  | No            | Analytics, marketing, third-party tracking scripts |

Essential cookies cannot be disabled. Optional cookies require explicit consent.

## Usage

### Setup (Already Configured)

The `ConsentProvider` and `CookieBanner` are already configured in `app/layout.tsx`:

```tsx
import { ConsentProvider } from '@/lib/consent';
import { CookieBanner } from '@/components/cookie-consent';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <ConsentProvider>
          {children}
          <CookieBanner />
        </ConsentProvider>
      </body>
    </html>
  );
}
```

**Provider Nesting:** If using analytics providers (e.g., PostHog, Google Analytics), place them inside `ConsentProvider` so they can access consent state:

```tsx
<ConsentProvider>
  <AnalyticsProvider>{children}</AnalyticsProvider>
  <CookieBanner />
</ConsentProvider>
```

### Using the `useConsent` Hook

Access consent state and actions in any client component:

```tsx
'use client';

import { useConsent } from '@/lib/consent';

export function AnalyticsStatus() {
  const { consent, hasConsented, acceptAll, rejectOptional } = useConsent();

  if (!hasConsented) {
    return <p>No consent choice made yet</p>;
  }

  return (
    <div>
      <p>Optional cookies: {consent.optional ? 'Enabled' : 'Disabled'}</p>
      <button onClick={acceptAll}>Accept All</button>
      <button onClick={rejectOptional}>Essential Only</button>
    </div>
  );
}
```

For complete hook documentation, see [API Reference](./api.md#hooks).

### Conditional Script Loading

Use `ConditionalScript` to load third-party scripts only when consent is granted:

```tsx
import { ConditionalScript } from '@/lib/consent';
import Script from 'next/script';

// Load Google Analytics only with consent
<ConditionalScript>
  <Script
    src="https://www.googletagmanager.com/gtag/js?id=GA_MEASUREMENT_ID"
    strategy="afterInteractive"
  />
</ConditionalScript>

// Execute code conditionally
<ConditionalScript>
  {() => {
    window.gtag('config', 'GA_MEASUREMENT_ID');
  }}
</ConditionalScript>
```

### Check Consent State

For simpler checks:

```tsx
import { useHasOptionalConsent } from '@/lib/consent';

function MyComponent() {
  const hasOptionalConsent = useHasOptionalConsent();

  if (hasOptionalConsent) {
    // Initialize analytics or load marketing scripts
  }
}
```

## Configuration

### Disable Cookie Consent

Set the environment variable to disable the consent system entirely:

```bash
NEXT_PUBLIC_COOKIE_CONSENT_ENABLED=false
```

When disabled, the provider assumes all consent is granted and the banner never shows.

### Customize Categories

Edit `lib/consent/config.ts` to modify category descriptions:

```typescript
export const COOKIE_CATEGORIES: CookieCategory[] = [
  {
    id: 'essential',
    name: 'Essential',
    description: 'Your custom description...',
    required: true,
  },
  {
    id: 'optional',
    name: 'Analytics & Marketing',
    description: 'Your custom description...',
    required: false,
  },
];
```

### Banner Delay

The banner appears after a configurable delay (default 500ms) to avoid interrupting initial page load:

```typescript
export const BANNER_DELAY_MS = 500;
```

## Data Storage

Consent state is stored in `localStorage` under the key `cookie-consent`:

```typescript
interface ConsentState {
  essential: true; // Always true
  optional: boolean; // User's choice
  timestamp: number | null; // When consent was given, null if no consent yet
  version: number; // For future migrations
}
```

## GDPR Compliance Features

1. **Equal Prominence**: "Accept All" and "Essential Only" buttons have equal visual weight
2. **Granular Control**: Users can manage preferences via the preferences modal
3. **Revocable**: Users can change preferences at any time via footer link
4. **Pre-consent Blocking**: Optional scripts don't load until consent is given
5. **Clear Information**: Banner explains cookie purposes with link to Privacy Policy

## Testing Consent State

Reset consent for testing:

```tsx
const { resetConsent } = useConsent();

// In a dev tools component or browser console
resetConsent();
```

Or clear localStorage directly:

```javascript
localStorage.removeItem('cookie-consent');
```

## Future: Google Consent Mode v2

When integrating Google Analytics 4, the consent system is ready for Google Consent Mode v2:

```tsx
// In your analytics initialization
const hasOptional = useHasOptionalConsent();

window.gtag('consent', 'update', {
  analytics_storage: hasOptional ? 'granted' : 'denied',
  ad_storage: hasOptional ? 'granted' : 'denied',
});
```

## Related Documentation

- [Components](./components.md) - CookieBanner and PreferencesModal
- [API Reference](./api.md) - Hooks, functions, types, and exports
- [Security Overview](../security/overview.md) - Application security features
- [Environment Reference](../environment/reference.md) - Environment variable configuration
