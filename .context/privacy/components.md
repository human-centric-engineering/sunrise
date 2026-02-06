# Cookie Consent Components

UI components for the cookie consent system. For conceptual overview and setup, see [overview.md](./overview.md). For hooks and functions, see [api.md](./api.md).

## CookieBanner

The cookie consent banner that appears at the bottom of the screen when a user hasn't made a consent choice.

```typescript
import { CookieBanner } from '@/components/cookie-consent';
```

### Props

None required. The component manages its own state through the `ConsentProvider` context.

### Features

- **GDPR/PECR compliant** - Equal prominence buttons for "Accept All" and "Essential Only"
- **Delayed appearance** - Shows after 500ms to avoid interrupting initial page load
- **Accessible** - Full keyboard navigation and ARIA labels
- **Dark mode support** - Respects system and user theme preferences
- **Privacy link** - Links to `/privacy` policy page

### Usage

The `CookieBanner` must be placed inside the `ConsentProvider` in your root layout:

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

### Behavior

1. Banner remains hidden until the user session starts and delay passes (500ms)
2. Once visible, users can:
   - Click "Accept All" to enable all cookies
   - Click "Essential Only" to reject optional cookies
   - Click "Manage Preferences" to open the detailed preferences modal
3. After any choice, the banner disappears and the preference is stored

---

## PreferencesModal

A dialog for managing cookie preferences with category toggles. Can be opened after initial consent to allow users to change their preferences.

```typescript
import { PreferencesModal } from '@/components/cookie-consent';
```

### Props

| Prop           | Type                      | Required | Description                            |
| -------------- | ------------------------- | -------- | -------------------------------------- |
| `open`         | `boolean`                 | Yes      | Controls whether the modal is visible  |
| `onOpenChange` | `(open: boolean) => void` | Yes      | Callback when modal open state changes |

### Features

- **Category display** - Shows all cookie categories with descriptions
- **Required indicators** - Essential cookies marked as "Required" and cannot be toggled
- **Toggle controls** - Optional cookies can be enabled/disabled
- **State reset** - Internal state resets when modal reopens
- **Save/Cancel** - Changes only apply when explicitly saved

### Usage with State

For standalone usage with local state:

```tsx
'use client';

import { useState } from 'react';
import { PreferencesModal } from '@/components/cookie-consent';

export function CookieSettings() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button onClick={() => setIsOpen(true)}>Cookie Preferences</button>
      <PreferencesModal open={isOpen} onOpenChange={setIsOpen} />
    </>
  );
}
```

### Usage with Context (Recommended)

The preferred approach uses the `useConsent` hook, which manages state automatically:

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

When using `openPreferences` from the context, the `CookieBanner` component automatically renders and controls the `PreferencesModal` - no additional modal component is needed.

### Cookie Categories

The modal displays these categories (defined in `lib/consent/config.ts`):

| Category              | Required | Description                                           |
| --------------------- | -------- | ----------------------------------------------------- |
| Essential             | Yes      | Authentication, security, user preferences (theme)    |
| Analytics & Marketing | No       | Usage tracking, third-party analytics, advertisements |

## Related Documentation

- [Overview](./overview.md) - Conceptual overview and setup
- [API Reference](./api.md) - Hooks, functions, and types
