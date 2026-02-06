# Cookie Consent API Reference

Complete API reference for the cookie consent system. For conceptual overview and setup, see [overview.md](./overview.md). For UI components, see [components.md](./components.md).

## Hooks

### `useConsent()`

Access the full consent context with all state and methods.

```typescript
function useConsent(): ConsentContextValue;
```

**Returns:** `ConsentContextValue` with the following properties:

| Property            | Type                          | Description                                                                    |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| `consent`           | `ConsentState`                | Current consent state with `essential`, `optional`, `timestamp`, and `version` |
| `hasConsented`      | `boolean`                     | Whether the user has made a consent choice                                     |
| `isInitialized`     | `boolean`                     | Whether the consent UI has been initialized (hydrated)                         |
| `acceptAll`         | `() => void`                  | Accept all cookies (essential + optional)                                      |
| `rejectOptional`    | `() => void`                  | Reject optional cookies (essential only)                                       |
| `updateConsent`     | `(optional: boolean) => void` | Update optional consent                                                        |
| `resetConsent`      | `() => void`                  | Reset consent for testing/debugging                                            |
| `openPreferences`   | `() => void`                  | Open the preferences modal                                                     |
| `closePreferences`  | `() => void`                  | Close the preferences modal                                                    |
| `isPreferencesOpen` | `boolean`                     | Whether the preferences modal is open                                          |

**Throws:** Error if used outside of `ConsentProvider`.

```tsx
import { useConsent } from '@/lib/consent';

function ConsentControls() {
  const { consent, acceptAll, rejectOptional, openPreferences } = useConsent();

  if (consent.optional) {
    // Analytics are enabled
  }

  return (
    <div>
      <button onClick={acceptAll}>Accept All</button>
      <button onClick={rejectOptional}>Essential Only</button>
      <button onClick={openPreferences}>Manage Preferences</button>
    </div>
  );
}
```

---

### `useHasOptionalConsent()`

Check if the user has consented to optional cookies.

```typescript
function useHasOptionalConsent(): boolean;
```

**Returns:** `true` if user has consented AND optional cookies are enabled, `false` otherwise.

```tsx
import { useHasOptionalConsent } from '@/lib/consent';

function AnalyticsLoader() {
  const hasOptional = useHasOptionalConsent();

  if (hasOptional) {
    // Initialize analytics
  }

  return null;
}
```

---

### `useShouldShowConsentBanner()`

Determine whether to display the consent banner.

```typescript
function useShouldShowConsentBanner(): boolean;
```

**Returns:** `true` when:

- The provider has been initialized (hydrated)
- The user has not yet made a consent choice

Returns `false` during SSR/hydration or after the user has consented.

```tsx
import { useShouldShowConsentBanner } from '@/lib/consent';
import { CookieBanner } from '@/components/cookie-banner';

function ConsentBannerWrapper() {
  const shouldShowBanner = useShouldShowConsentBanner();

  if (!shouldShowBanner) {
    return null;
  }

  return <CookieBanner />;
}
```

---

### `useShouldLoadOptionalScripts()`

Semantic alias for `useHasOptionalConsent` for script loading contexts.

```typescript
function useShouldLoadOptionalScripts(): boolean;
```

**Returns:** `true` if optional scripts should be loaded (user has consented to optional cookies).

```tsx
import { useShouldLoadOptionalScripts } from '@/lib/consent';
import { useEffect } from 'react';

function AnalyticsInitializer() {
  const shouldLoadAnalytics = useShouldLoadOptionalScripts();

  useEffect(() => {
    if (shouldLoadAnalytics) {
      // Initialize complex analytics setup
      window.gtag?.('config', 'GA_MEASUREMENT_ID');
    }
  }, [shouldLoadAnalytics]);

  return null;
}
```

## Functions

### `isConsentEnabled()`

Checks whether the cookie consent system is enabled.

```typescript
function isConsentEnabled(): boolean;
```

**Returns:** `boolean` - `true` unless `NEXT_PUBLIC_COOKIE_CONSENT_ENABLED` is explicitly set to `'false'`

**Environment Variable:** `NEXT_PUBLIC_COOKIE_CONSENT_ENABLED`

```typescript
import { isConsentEnabled } from '@/lib/consent';

if (isConsentEnabled()) {
  // Show consent banner
}
```

## Components

### `ConsentProvider`

React context provider for managing cookie consent state. Handles localStorage persistence and SSR-safe initialization.

```typescript
interface ConsentProviderProps {
  children: React.ReactNode;
}
```

**Usage:** Must be placed high in the component tree.

```tsx
import { ConsentProvider } from '@/lib/consent';

<ConsentProvider>
  <App />
</ConsentProvider>;
```

---

### `ConditionalScript`

Renders children only when the user has consented to optional cookies. Use this to wrap analytics scripts, marketing pixels, or any third-party scripts that require consent.

```typescript
interface ConditionalScriptProps {
  /**
   * Children to render when consent is given.
   * Can be React nodes (like Script components) or a function to execute.
   */
  children: React.ReactNode | (() => void);
  /**
   * Callback when consent status changes.
   * Useful for cleanup when consent is revoked.
   */
  onConsentChange?: (hasConsent: boolean) => void;
}
```

**Props:**

| Prop              | Type                            | Description                                                      |
| ----------------- | ------------------------------- | ---------------------------------------------------------------- |
| `children`        | `ReactNode \| (() => void)`     | Content to render or function to execute when consent is granted |
| `onConsentChange` | `(hasConsent: boolean) => void` | Optional callback fired when consent status changes              |

**Usage with Script components:**

```tsx
import { ConditionalScript } from '@/lib/consent';
import Script from 'next/script';

<ConditionalScript>
  <Script
    src="https://www.googletagmanager.com/gtag/js?id=GA_MEASUREMENT_ID"
    strategy="afterInteractive"
  />
</ConditionalScript>;
```

**Usage with function execution:**

```tsx
<ConditionalScript>
  {() => {
    window.gtag('config', 'GA_MEASUREMENT_ID');
  }}
</ConditionalScript>
```

**Usage with consent change callback:**

```tsx
<ConditionalScript
  onConsentChange={(hasConsent) => {
    if (!hasConsent) {
      // Cleanup analytics when consent is revoked
      window.gtag('consent', 'update', { analytics_storage: 'denied' });
    }
  }}
>
  <Script src="https://analytics.example.com/script.js" />
</ConditionalScript>
```

## Types

### `ConsentState`

Consent state stored in localStorage.

```typescript
interface ConsentState {
  /** Essential cookies - always true, not toggleable */
  essential: true;
  /** Optional cookies (analytics, marketing) - user's choice */
  optional: boolean;
  /** Timestamp when consent was given (Date.now()), null if no consent yet */
  timestamp: number | null;
  /** Version number for future migrations */
  version: number;
}
```

---

### `ConsentContextValue`

Context value provided by `ConsentProvider`.

```typescript
interface ConsentContextValue {
  /** Current consent state */
  consent: ConsentState;
  /** Whether the user has made a consent choice */
  hasConsented: boolean;
  /** Whether the consent UI has been initialized (hydrated) */
  isInitialized: boolean;
  /** Accept all cookies (essential + optional) */
  acceptAll: () => void;
  /** Reject optional cookies (essential only) */
  rejectOptional: () => void;
  /** Update optional consent */
  updateConsent: (optional: boolean) => void;
  /** Reset consent for testing/debugging */
  resetConsent: () => void;
  /** Open the preferences modal */
  openPreferences: () => void;
  /** Close the preferences modal */
  closePreferences: () => void;
  /** Whether the preferences modal is open */
  isPreferencesOpen: boolean;
}
```

---

### `CookieCategory`

Cookie category definition for display in consent UI.

```typescript
interface CookieCategory {
  /** Category ID */
  id: 'essential' | 'optional';
  /** Display name */
  name: string;
  /** Description shown to users */
  description: string;
  /** Whether this category can be toggled (false = user can disable) */
  required: boolean;
}
```

## Exports

The `@/lib/consent` module exports:

```typescript
// Components
export { ConsentProvider } from './consent-provider';
export { ConditionalScript } from './conditional-script';

// Hooks
export { useConsent } from './use-consent';
export { useHasOptionalConsent } from './use-consent';
export { useShouldShowConsentBanner } from './use-consent';
export { useShouldLoadOptionalScripts } from './conditional-script';

// Functions
export { isConsentEnabled } from './config';

// Constants
export { COOKIE_CATEGORIES } from './config';
export { BANNER_DELAY_MS } from './config';

// Types
export type { ConsentState } from './types';
export type { ConsentContextValue } from './types';
export type { CookieCategory } from './types';

// Advanced: Direct context access
export { ConsentContext } from './consent-provider';
```

**Advanced Usage - Direct Context Access:**

For advanced use cases where you need direct access to the context (e.g., creating custom hooks or accessing context in class components), `ConsentContext` is exported:

```typescript
import { useContext } from 'react';
import { ConsentContext } from '@/lib/consent';

// Custom hook with different error handling
function useConsentOptional() {
  const context = useContext(ConsentContext);
  return context; // Returns undefined if outside provider
}
```

## Related Documentation

- [Overview](./overview.md) - Conceptual overview and setup
- [Components](./components.md) - CookieBanner and PreferencesModal
