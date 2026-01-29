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

To add a new analytics provider (e.g., Mixpanel, Amplitude):

### 1. Create Provider

Create `lib/analytics/providers/mixpanel.ts`:

```typescript
import type { AnalyticsProvider, TrackResult } from './types';

export class MixpanelProvider implements AnalyticsProvider {
  readonly name = 'mixpanel';
  readonly type = 'mixpanel';

  async initialize(): Promise<void> {
    // Load Mixpanel SDK
  }

  async track(event: string, properties?: Record<string, unknown>): Promise<TrackResult> {
    // Implementation
  }

  async identify(userId: string, traits?: Record<string, unknown>): Promise<TrackResult> {
    // Implementation
  }

  async page(name?: string, properties?: Record<string, unknown>): Promise<TrackResult> {
    // Implementation
  }

  async reset(): Promise<TrackResult> {
    // Implementation
  }
}

export function createMixpanelProviderFromEnv(): MixpanelProvider | null {
  const token = process.env.NEXT_PUBLIC_MIXPANEL_TOKEN;
  if (!token) return null;
  return new MixpanelProvider(token);
}
```

### 2. Register in Client

Update `lib/analytics/client.ts`:

```typescript
import { createMixpanelProviderFromEnv } from './providers/mixpanel';

// In createProviderFromEnv():
case 'mixpanel':
  return createMixpanelProviderFromEnv();

// In auto-detection (add before console fallback):
const mixpanel = createMixpanelProviderFromEnv();
if (mixpanel) return mixpanel;
```

### 3. Add Provider Type

Update `lib/analytics/providers/types.ts`:

```typescript
export type AnalyticsProviderType = 'console' | 'ga4' | 'posthog' | 'plausible' | 'mixpanel';
```

### 4. Add Script Loading (If Needed)

Update `components/analytics/analytics-scripts.tsx` if the provider requires external scripts.

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
