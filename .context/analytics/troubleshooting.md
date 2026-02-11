# Analytics Troubleshooting

> Common issues, testing, and mocking

## Common Issues

### Analytics Not Tracking

1. **Check consent:** User must accept optional cookies
2. **Check provider:** Verify environment variables are set
3. **Check scripts:** Ensure `AnalyticsScripts` is in layout with the `nonce` prop passed from `(await headers()).get('x-nonce')` — without it, inline scripts are blocked by CSP
4. **Check console:** Look for initialization errors

### Ad Blocker Blocking Scripts

Use server-side tracking for critical events:

```typescript
// API route - bypasses ad blockers
await serverTrack({
  event: 'purchase_completed',
  userId: user.id,
  properties: { orderId, amount },
});
```

### PostHog Feature Flags Not Loading

Feature flags require initialization:

```typescript
const posthog = client as PostHogProvider;
posthog.onFeatureFlags((flags) => {
  console.log('Flags loaded:', flags);
});
```

## Testing

### Console Provider for Development

In development, the console provider logs all analytics calls:

```typescript
// .env.local
NEXT_PUBLIC_ANALYTICS_PROVIDER = console;
```

Console output:

```
[Analytics] track [12:34:56.789] signup_clicked { location: 'hero' }
[Analytics] identify [12:34:57.123] user_123 { email: '...' }
[Analytics] page [12:34:58.456] Dashboard { path: '/dashboard' }
```

### Resetting Analytics State

Use `resetAnalyticsClient()` to reset the singleton analytics client between tests. This clears the cached provider instance, initialization promise, and warning state.

```typescript
import { resetAnalyticsClient } from '@/lib/analytics/client';

beforeEach(() => {
  resetAnalyticsClient(); // Clear singleton state between tests
});
```

This is useful when:

- Testing provider initialization behavior
- Verifying auto-detection logic
- Testing fallback behavior when providers are not configured

### Mocking in Tests

```typescript
import { vi } from 'vitest';
import * as analytics from '@/lib/analytics';

vi.mock('@/lib/analytics', () => ({
  useAnalytics: () => ({
    track: vi.fn().mockResolvedValue({ success: true }),
    identify: vi.fn().mockResolvedValue({ success: true }),
    page: vi.fn().mockResolvedValue({ success: true }),
    reset: vi.fn().mockResolvedValue({ success: true }),
    isReady: true,
    isEnabled: true,
    providerName: 'mock',
  }),
}));
```

### Testing Event Calls

```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { useAnalytics } from '@/lib/analytics';

vi.mock('@/lib/analytics');

it('tracks signup click', async () => {
  const mockTrack = vi.fn().mockResolvedValue({ success: true });
  vi.mocked(useAnalytics).mockReturnValue({
    track: mockTrack,
    identify: vi.fn(),
    page: vi.fn(),
    reset: vi.fn(),
    isReady: true,
    isEnabled: true,
    providerName: 'mock',
  });

  render(<SignupButton />);
  fireEvent.click(screen.getByRole('button'));

  expect(mockTrack).toHaveBeenCalledWith('signup_clicked', { location: 'hero' });
});
```

## Debugging Tips

### Check Provider Status

```typescript
import { useAnalytics } from '@/lib/analytics';

function DebugAnalytics() {
  const { isReady, isEnabled, providerName } = useAnalytics();

  console.log({
    provider: providerName,
    consentGiven: isEnabled,
    initialized: isReady,
  });

  return null;
}
```

### Verify Environment Variables

```bash
# Check if analytics env vars are set
echo $NEXT_PUBLIC_ANALYTICS_PROVIDER
echo $NEXT_PUBLIC_POSTHOG_KEY
echo $NEXT_PUBLIC_GA4_MEASUREMENT_ID
```

### Browser DevTools

1. **Network tab:** Look for requests to analytics endpoints
2. **Console:** Check for initialization errors or tracking logs
3. **Application tab:** Verify cookies are being set (if applicable)

## Related

- [Overview](./overview.md) - Architecture and quick start
- [Providers](./providers.md) - Provider configuration
