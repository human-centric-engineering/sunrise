# Cookie Consent Components

## Overview

Sunrise includes GDPR/PECR-compliant cookie consent components that give users control over optional cookies while ensuring essential functionality remains available. The system provides a configurable banner, preferences modal, and conditional script loading for analytics integration.

**Related Documentation:**

- [Privacy Overview](../privacy/overview.md) - Full consent system architecture and setup
- [Privacy API Reference](../privacy/api.md) - Hooks, functions, and types
- [Analytics System](../analytics/overview.md) - Analytics integration with consent

## Component Library

| Component           | Purpose                            | File                                              |
| ------------------- | ---------------------------------- | ------------------------------------------------- |
| `CookieBanner`      | Main consent banner with actions   | `components/cookie-consent/cookie-banner.tsx`     |
| `PreferencesModal`  | Detailed cookie preferences dialog | `components/cookie-consent/preferences-modal.tsx` |
| `ConditionalScript` | Consent-gated script loader        | `lib/consent/conditional-script.tsx`              |

Import components from the barrel export:

```tsx
import { CookieBanner, PreferencesModal } from '@/components/cookie-consent';
import { ConditionalScript } from '@/lib/consent';
```

## CookieBanner

The main cookie consent banner that appears at the bottom of the screen when a user hasn't made a consent choice.

```tsx
import { CookieBanner } from '@/components/cookie-consent';

// In root layout, inside ConsentProvider
<ConsentProvider>
  {children}
  <CookieBanner />
</ConsentProvider>;
```

**Props:**

None required. The component manages its own state through the `ConsentProvider` context.

**Features:**

| Feature             | Description                                               |
| ------------------- | --------------------------------------------------------- |
| GDPR/PECR compliant | Equal prominence buttons (no dark patterns)               |
| Delayed appearance  | Shows after 500ms to avoid interrupting initial page load |
| Accessible          | Full keyboard navigation, ARIA labels, focus management   |
| Dark mode support   | Respects system and user theme preferences                |
| Privacy link        | Links to `/privacy` policy page                           |
| Responsive          | Stacked layout on mobile, horizontal on desktop           |

**Button Actions:**

| Button             | Action                                          |
| ------------------ | ----------------------------------------------- |
| Accept All         | Enables all cookies (essential + optional)      |
| Essential Only     | Enables only required cookies                   |
| Manage Preferences | Opens the PreferencesModal for granular control |

**Behavior:**

1. Banner remains hidden until provider is initialized and delay passes (500ms)
2. Once visible, users make a choice via buttons
3. After any choice, the banner disappears and preference is stored in localStorage
4. Banner never reappears unless consent is reset

## PreferencesModal

A dialog for managing cookie preferences with category toggles. Can be opened after initial consent to allow users to change their preferences.

```tsx
import { PreferencesModal } from '@/components/cookie-consent';

<PreferencesModal open={isOpen} onOpenChange={setIsOpen} />;
```

**Props:**

| Prop           | Type                      | Required | Description                            |
| -------------- | ------------------------- | -------- | -------------------------------------- |
| `open`         | `boolean`                 | Yes      | Controls whether the modal is visible  |
| `onOpenChange` | `(open: boolean) => void` | Yes      | Callback when modal open state changes |

**Features:**

| Feature             | Description                                           |
| ------------------- | ----------------------------------------------------- |
| Category display    | Shows all cookie categories with descriptions         |
| Required indicators | Essential cookies marked as "Required"                |
| Toggle controls     | Optional cookies can be enabled/disabled via switches |
| State reset         | Internal state resets when modal reopens              |
| Save/Cancel         | Changes only apply when explicitly saved              |

**Usage with Context (Recommended):**

The preferred approach uses the `useConsent` hook, which manages modal state automatically:

```tsx
'use client';

import { useConsent } from '@/lib/consent';

export function FooterCookieLink() {
  const { openPreferences } = useConsent();

  return (
    <button onClick={openPreferences} className="text-sm hover:underline">
      Cookie Preferences
    </button>
  );
}
```

When using `openPreferences` from the context, the `CookieBanner` component automatically renders and controls the `PreferencesModal`.

## Cookie Categories

The consent system uses two categories defined in `lib/consent/config.ts`:

| Category              | ID          | Required | Description                                           |
| --------------------- | ----------- | -------- | ----------------------------------------------------- |
| Essential             | `essential` | Yes      | Authentication, security, theme settings              |
| Analytics & Marketing | `optional`  | No       | Usage tracking, third-party analytics, advertisements |

Essential cookies are always enabled and cannot be disabled by users. Optional cookies require explicit consent and default to disabled.

**Customizing Categories:**

```typescript
// lib/consent/config.ts
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

## Analytics Integration

The consent system integrates with the analytics module to conditionally load tracking scripts.

**Using ConditionalScript:**

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

**Using the Hook:**

```tsx
'use client';

import { useHasOptionalConsent } from '@/lib/consent';

function AnalyticsComponent() {
  const hasConsent = useHasOptionalConsent();

  useEffect(() => {
    if (hasConsent) {
      // Initialize analytics
    }
  }, [hasConsent]);
}
```

**With AnalyticsProvider:**

Place analytics providers inside `ConsentProvider` so they can access consent state:

```tsx
<ConsentProvider>
  <AnalyticsProvider>{children}</AnalyticsProvider>
  <CookieBanner />
</ConsentProvider>
```

## Usage Examples

### Basic Setup (Root Layout)

```tsx
// app/layout.tsx
import { ConsentProvider } from '@/lib/consent';
import { CookieBanner } from '@/components/cookie-consent';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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

### Footer Cookie Preferences Link

Both `PublicFooter` and `ProtectedFooter` include a "Cookie Preferences" link:

```tsx
'use client';

import { useConsent } from '@/lib/consent';

export function CookiePreferencesButton() {
  const { openPreferences } = useConsent();

  return (
    <button
      onClick={openPreferences}
      className="text-sm text-muted-foreground hover:text-foreground"
    >
      Cookie Preferences
    </button>
  );
}
```

### Checking Consent Status

```tsx
'use client';

import { useConsent, useHasOptionalConsent } from '@/lib/consent';

function ConsentStatus() {
  const { consent, hasConsented } = useConsent();
  const hasOptional = useHasOptionalConsent();

  if (!hasConsented) {
    return <p>No consent choice made yet</p>;
  }

  return (
    <div>
      <p>Essential: Always enabled</p>
      <p>Optional: {hasOptional ? 'Enabled' : 'Disabled'}</p>
      <p>Consented at: {new Date(consent.timestamp!).toLocaleString()}</p>
    </div>
  );
}
```

### Resetting Consent (Development)

```tsx
const { resetConsent } = useConsent();

// In a dev tools component
<button onClick={resetConsent}>Reset Cookie Consent</button>;

// Or via browser console
localStorage.removeItem('cookie-consent');
```

## GDPR/PECR Compliance

The consent system implements key compliance features:

| Requirement          | Implementation                                              |
| -------------------- | ----------------------------------------------------------- |
| Equal prominence     | "Accept All" and "Essential Only" buttons have equal weight |
| Granular control     | Users can manage preferences via the preferences modal      |
| Revocable consent    | Users can change preferences at any time via footer link    |
| Pre-consent blocking | Optional scripts don't load until consent is given          |
| Clear information    | Banner explains cookie purposes with link to Privacy Policy |
| Informed consent     | Categories shown with descriptions before user decides      |
| No pre-checked boxes | Optional cookies default to disabled                        |

**Important Notes:**

- The banner must not obscure primary content in a way that forces consent
- Both accept and reject options must be equally accessible
- No "cookie walls" that block access without consent
- Users must be able to withdraw consent as easily as they gave it

## Configuration

### Disable Cookie Consent

Set the environment variable to disable the consent system entirely (e.g., for development):

```bash
NEXT_PUBLIC_COOKIE_CONSENT_ENABLED=false
```

When disabled, the provider assumes all consent is granted and the banner never shows.

### Banner Delay

The banner appears after a configurable delay (default 500ms):

```typescript
// lib/consent/config.ts
export const BANNER_DELAY_MS = 500;
```

### Storage

Consent state is stored in `localStorage` under the key `cookie-consent`:

```typescript
interface ConsentState {
  essential: true; // Always true
  optional: boolean; // User's choice
  timestamp: number | null; // When consent was given
  version: number; // For future migrations
}
```

## Related Documentation

- [Privacy Overview](../privacy/overview.md) - Full consent system architecture
- [Privacy API Reference](../privacy/api.md) - Hooks, functions, and types
- [Analytics System](../analytics/overview.md) - Event tracking and providers
- [Marketing Components](./marketing.md) - Landing page components
- [UI Patterns Overview](./overview.md) - Other UI patterns
