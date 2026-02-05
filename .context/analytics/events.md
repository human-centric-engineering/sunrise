# Analytics Events

> Event catalog, naming conventions, and property schemas

## Event Catalog

### Authentication Events

| Event             | Constant                 | Trigger             | Properties              |
| ----------------- | ------------------------ | ------------------- | ----------------------- |
| `user_signed_up`  | `EVENTS.USER_SIGNED_UP`  | Signup form success | `{ method, provider? }` |
| `user_logged_in`  | `EVENTS.USER_LOGGED_IN`  | Login form success  | `{ method, provider? }` |
| `user_logged_out` | `EVENTS.USER_LOGGED_OUT` | Logout button       | `{}`                    |

**Property Schema:**

- `method`: `'email'` | `'oauth'`
- `provider`: OAuth provider ID (e.g., `'google'`, `'github'`)

### Settings Events

| Event                  | Constant                      | Trigger            | Properties                       |
| ---------------------- | ----------------------------- | ------------------ | -------------------------------- |
| `settings_tab_changed` | `EVENTS.SETTINGS_TAB_CHANGED` | Tab navigation     | `{ tab, previous_tab }`          |
| `profile_updated`      | `EVENTS.PROFILE_UPDATED`      | Profile form save  | `{ fields_changed }`             |
| `password_changed`     | `EVENTS.PASSWORD_CHANGED`     | Password form save | `{}`                             |
| `preferences_updated`  | `EVENTS.PREFERENCES_UPDATED`  | Preferences save   | `{ marketing, product_updates }` |
| `avatar_uploaded`      | `EVENTS.AVATAR_UPLOADED`      | Avatar upload      | `{}`                             |
| `account_deleted`      | `EVENTS.ACCOUNT_DELETED`      | Account deletion   | `{}`                             |

### Form Events (Generic)

Form events use `useFormAnalytics()` which generates `{formName}_form_submitted`:

```typescript
import { useFormAnalytics } from '@/lib/analytics/events';

const { trackFormSubmitted } = useFormAnalytics();
await trackFormSubmitted('contact'); // → contact_form_submitted
await trackFormSubmitted('feedback', { rating: 5 }); // → feedback_form_submitted { rating: 5 }
```

The `trackFormSubmitted()` helper:

- Automatically uses the naming convention `{formName}_form_submitted`
- Normalizes form names (lowercase, replaces spaces/hyphens with underscores)
- Accepts optional properties for additional context
- No library changes needed for new forms

## EventName Type

The `EventName` type is a union of all predefined event names, derived from the `EVENTS` constant. Use it for type-safe event tracking functions:

```typescript
import type { EventName } from '@/lib/analytics';

function trackEvent(event: EventName, props?: Record<string, unknown>) {
  // event is type-checked against EVENTS values
}

// Also works with direct track() calls
import { useAnalytics, EVENTS } from '@/lib/analytics';

const { track } = useAnalytics();
track(EVENTS.USER_LOGGED_IN, { method: 'email' }); // Type-safe
```

The type is defined in `lib/analytics/events/constants.ts` as:

```typescript
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];
```

## Naming Convention

**Standard: `snake_case` with past tense**

```typescript
// ✅ Good (action completed)
user_logged_in;
profile_updated;
avatar_uploaded;

// ❌ Bad (ambiguous tense)
user_login;
profile_update;
```

All predefined events follow this convention. Custom events should too.

## Best Practices

### What to Track

**Do track:**

- User actions that indicate engagement (signups, logins, feature usage)
- Conversion events (upgrades, purchases, form submissions)
- Navigation patterns (tab changes, page views)
- Errors that affect user experience

**Don't track:**

- Every click or interaction (noise reduces signal)
- Sensitive data (passwords, payment details, health info)
- PII without consent (use `identify()` only after consent)

### Event Property Guidelines

```typescript
// ✅ Good: Descriptive, consistent, typed
track(EVENTS.PROFILE_UPDATED, {
  fields_changed: ['name', 'bio'],
});

// ❌ Bad: Vague, inconsistent, untyped
track('click', { x: 'profile', from: 'sttngs' });
```

- Use consistent property names across events (`user_id` not sometimes `userId`)
- Include context (`source`, `location`) for analysis
- Avoid high-cardinality values (don't track unique IDs as property values)

### Client-Side vs Server-Side

| Use Client-Side    | Use Server-Side                 |
| ------------------ | ------------------------------- |
| UI interactions    | Critical conversions (payments) |
| Page views         | Events that must not be blocked |
| Feature usage      | Backend-triggered events        |
| Real-time tracking | Webhook-triggered events        |

Server-side tracking bypasses ad blockers but requires API keys.

## Usage Examples

### Basic Event Tracking

```typescript
'use client';
import { useAnalytics, EVENTS } from '@/lib/analytics';

function LoginForm() {
  const { track, identify } = useAnalytics();

  const onSuccess = async (user: User) => {
    await identify(user.id);
    await track(EVENTS.USER_LOGGED_IN, { method: 'email' });
  };
}
```

### Custom Event Tracking Hook

```typescript
import { useTrackEvent } from '@/lib/analytics';

function ProductCard({ productId }: { productId: string }) {
  const trackClick = useTrackEvent('product_clicked');

  return <div onClick={() => trackClick({ productId })}>{/* Product content */}</div>;
}
```

## Related

- [Overview](./overview.md) - Architecture and quick start
- [Extending](./extending.md) - Adding new events and property types
