# Extending Analytics

> Adding events, custom hooks, and new providers

## Tracking Custom Events (Ad-hoc)

For one-off events like button clicks, use `track()` directly:

```typescript
import { useAnalytics } from '@/lib/analytics';

function UpgradeButton() {
  const { track } = useAnalytics();

  return (
    <button onClick={() => track('upgrade_clicked', { location: 'pricing_page' })}>
      Upgrade Now
    </button>
  );
}
```

Follow the naming convention: `snake_case` with past tense (`clicked`, `viewed`, `dismissed`).

## Adding Predefined Events

For events used across multiple components, add them to the constants:

### 1. Add Event Name

Add to `lib/analytics/events/constants.ts`:

```typescript
export const EVENTS = {
  // ... existing events

  // Feature Events
  FEATURE_ENABLED: 'feature_enabled',
  FEATURE_DISABLED: 'feature_disabled',
} as const;
```

### 2. Add Property Types (Optional)

Add to `lib/analytics/events/types.ts`:

```typescript
export interface FeatureEventProps {
  feature_name: string;
  source?: 'settings' | 'onboarding' | 'prompt';
  [key: string]: unknown;
}
```

### 3. Use in Components

```typescript
import { useAnalytics, EVENTS } from '@/lib/analytics';

await track(EVENTS.FEATURE_ENABLED, { feature_name: 'dark_mode', source: 'settings' });
```

## Creating Domain-Specific Hooks

For complex tracking logic, create a custom hook:

```typescript
// lib/analytics/events/features.ts
import { useCallback } from 'react';
import { useAnalytics } from '@/lib/analytics';
import { EVENTS } from './constants';

export function useFeatureAnalytics() {
  const { track } = useAnalytics();

  const trackFeatureToggled = useCallback(
    (featureName: string, enabled: boolean, source?: string) => {
      const event = enabled ? EVENTS.FEATURE_ENABLED : EVENTS.FEATURE_DISABLED;
      return track(event, { feature_name: featureName, source });
    },
    [track]
  );

  return { trackFeatureToggled };
}
```

**Note:** For most cases, direct `track()` + `EVENTS` is simpler and preferred.

## Adding a New Provider

To add a new analytics provider (e.g., Mixpanel), follow these four steps:

### 1. Add Config Detection

Update `lib/analytics/config.ts` with environment variable detection:

```typescript
/**
 * Mixpanel environment variable names
 */
export const MIXPANEL_ENV = {
  TOKEN: 'NEXT_PUBLIC_MIXPANEL_TOKEN',
} as const;

/**
 * Check if Mixpanel is configured
 */
export function isMixpanelConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_MIXPANEL_TOKEN;
}

/**
 * Get Mixpanel configuration from environment
 */
export function getMixpanelConfig(): { token: string } | null {
  const token = process.env.NEXT_PUBLIC_MIXPANEL_TOKEN;
  if (!token) return null;
  return { token };
}

// Update detectProvider() to include Mixpanel in auto-detection:
export function detectProvider(): AnalyticsProviderType | null {
  // ... existing code ...

  // Add Mixpanel detection (choose priority based on feature set)
  if (isMixpanelConfigured()) {
    return 'mixpanel';
  }

  // ... rest of detection logic ...
}

// Update getExplicitProvider() validProviders array:
const validProviders: readonly string[] = [
  'ga4',
  'posthog',
  'plausible',
  'mixpanel', // Add new provider
  'console',
] satisfies AnalyticsProviderType[];
```

### 2. Add Provider Type

Update `lib/analytics/types.ts`:

```typescript
export type AnalyticsProviderType = 'ga4' | 'posthog' | 'plausible' | 'mixpanel' | 'console';
```

### 3. Create Provider

Create `lib/analytics/providers/mixpanel.ts` implementing the `AnalyticsProvider` interface:

```typescript
import type {
  UserTraits,
  EventProperties,
  PageProperties,
  TrackResult,
  ProviderFeatures,
} from '../types';
import type { AnalyticsProvider } from './types';
import { logger } from '@/lib/logging';

export interface MixpanelProviderConfig {
  token: string;
  debug?: boolean;
}

export class MixpanelProvider implements AnalyticsProvider {
  readonly name = 'Mixpanel';
  readonly type = 'mixpanel' as const;

  private ready = false;
  private token: string;
  private debug: boolean;

  constructor(config: MixpanelProviderConfig) {
    this.token = config.token;
    this.debug = config.debug ?? false;
  }

  async init(): Promise<void> {
    if (this.ready) return;
    // Load and initialize Mixpanel SDK
    this.ready = true;
  }

  identify(userId: string, traits?: UserTraits): Promise<TrackResult> {
    if (!this.ready) {
      return Promise.resolve({ success: false, error: 'Mixpanel not initialized' });
    }
    // Implementation
    return Promise.resolve({ success: true });
  }

  track(event: string, properties?: EventProperties): Promise<TrackResult> {
    if (!this.ready) {
      return Promise.resolve({ success: false, error: 'Mixpanel not initialized' });
    }
    // Implementation
    return Promise.resolve({ success: true });
  }

  page(name?: string, properties?: PageProperties): Promise<TrackResult> {
    if (!this.ready) {
      return Promise.resolve({ success: false, error: 'Mixpanel not initialized' });
    }
    // Implementation
    return Promise.resolve({ success: true });
  }

  reset(): Promise<TrackResult> {
    if (!this.ready) {
      return Promise.resolve({ success: false, error: 'Mixpanel not initialized' });
    }
    // Implementation
    return Promise.resolve({ success: true });
  }

  isReady(): boolean {
    return this.ready;
  }

  getFeatures(): ProviderFeatures {
    return {
      supportsIdentify: true,
      supportsServerSide: true,
      supportsFeatureFlags: false,
      supportsSessionReplay: false,
      supportsCookieless: false,
    };
  }
}

export function createMixpanelProvider(config: MixpanelProviderConfig): MixpanelProvider {
  return new MixpanelProvider(config);
}
```

### 4. Register in Client

Update `lib/analytics/client.ts` to create and return the provider:

```typescript
import { createMixpanelProvider } from './providers/mixpanel';
import { getMixpanelConfig } from './config';

// Add case in createProvider() switch statement:
function createProvider(type: AnalyticsProviderType): AnalyticsProvider | null {
  switch (type) {
    // ... existing cases ...

    case 'mixpanel': {
      const config = getMixpanelConfig();
      if (!config) {
        logger.error('Mixpanel provider requested but not configured', undefined, {
          missingVars: ['NEXT_PUBLIC_MIXPANEL_TOKEN'],
        });
        return null;
      }
      return createMixpanelProvider({
        ...config,
        debug: isDevelopment(),
      });
    }

    // ... default case ...
  }
}
```

**Optional:** If the provider requires external scripts, update `components/analytics/analytics-scripts.tsx`.

## Generic Form Tracking

Track any form submission without modifying the analytics library:

```typescript
import { useFormAnalytics } from '@/lib/analytics/events';

function SupportForm() {
  const { trackFormSubmitted } = useFormAnalytics();

  const onSubmit = async (data: FormData) => {
    await submitTicket(data);
    // Tracks: support_form_submitted
    await trackFormSubmitted('support');
  };
}

// With additional properties
function FeedbackForm() {
  const { trackFormSubmitted } = useFormAnalytics();

  const onSubmit = async (data: FormData) => {
    await submitFeedback(data);
    // Tracks: feedback_form_submitted { source: 'footer', rating: 5 }
    await trackFormSubmitted('feedback', { source: 'footer', rating: 5 });
  };
}
```

## Related

- [Overview](./overview.md) - Architecture and quick start
- [Events](./events.md) - Event catalog and naming conventions
- [Providers](./providers.md) - Provider configuration
