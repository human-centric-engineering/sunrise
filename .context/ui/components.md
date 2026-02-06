# UI Utility Components

## Overview

Sunrise includes several utility components that solve common UI challenges. These components handle hydration safety, accessibility, and consistent error presentation.

## Component Library

| Component       | Purpose                        | File                               |
| --------------- | ------------------------------ | ---------------------------------- |
| `ErrorCard`     | Error boundary UI with actions | `components/ui/error-card.tsx`     |
| `ClientDate`    | Hydration-safe date formatting | `components/ui/client-date.tsx`    |
| `PasswordInput` | Password field with toggle     | `components/ui/password-input.tsx` |

## ErrorCard

Reusable error UI for error boundaries across route groups. Provides consistent styling with configurable title, description, action buttons, and dev-only error details.

### Usage

```tsx
import { ErrorCard } from '@/components/ui/error-card';
import { RefreshCw, Home } from 'lucide-react';

// In an error.tsx file
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorCard
      title="Something went wrong"
      description="We encountered an error while loading this page."
      error={error}
      actions={[
        {
          label: 'Try Again',
          onClick: reset,
          icon: <RefreshCw className="mr-2 h-4 w-4" />,
        },
        {
          label: 'Go Home',
          onClick: () => (window.location.href = '/'),
          variant: 'outline',
          icon: <Home className="mr-2 h-4 w-4" />,
        },
      ]}
      footer={
        <p className="text-center text-sm text-muted-foreground">
          Need help?{' '}
          <a href="/support" className="underline">
            Contact support
          </a>
        </p>
      }
    />
  );
}
```

### Props

| Prop                 | Type                          | Default             | Description                                  |
| -------------------- | ----------------------------- | ------------------- | -------------------------------------------- |
| `title`              | `string`                      | (required)          | Card title                                   |
| `description`        | `string`                      | (required)          | Card description                             |
| `icon`               | `ReactNode`                   | `<AlertTriangle />` | Icon displayed next to the title             |
| `iconClassName`      | `string`                      | `"text-red-500"`    | Icon color class                             |
| `error`              | `Error & { digest?: string }` | `undefined`         | Error object for dev-only details            |
| `actions`            | `ErrorCardAction[]`           | `undefined`         | Action buttons                               |
| `footer`             | `ReactNode`                   | `undefined`         | Optional footer content (e.g., support link) |
| `containerClassName` | `string`                      | `"min-h-[400px]"`   | Container min-height class                   |

### ErrorCardAction Type

```typescript
interface ErrorCardAction {
  label: string;
  onClick: () => void;
  variant?: 'default' | 'outline';
  icon?: ReactNode;
}
```

### Notes

- **Dev-only error details**: The component displays the error message and digest only in development mode (`NODE_ENV === 'development'`). In production, users see only the title and description.
- **Consistent styling**: Uses shadcn/ui Card components for a unified look across all error boundaries.
- **Flexible actions**: Supports multiple action buttons with configurable variants and icons.

## ClientDate

Renders dates using the browser's locale, only after client-side hydration. This prevents hydration mismatches caused by different locales between server and client.

### Problem

- Server renders dates with its locale (often en-US)
- Client renders with user's browser locale (could be en-GB, de-DE, etc.)
- This mismatch causes React hydration warnings and visual flicker

### Solution

By deferring to client-only rendering, users always see their locale format. The component shows a minimal placeholder on server, then the localized date after hydration.

### Usage

```tsx
import { ClientDate } from '@/components/ui/client-date';

// Date only (e.g., "1/15/2026" or "15/01/2026" depending on locale)
<ClientDate date={user.createdAt} />

// Date and time (e.g., "1/15/2026, 2:30 PM")
<ClientDate date={log.timestamp} showTime />

// With custom className
<ClientDate date={item.date} className="text-muted-foreground" />

// Accepts ISO strings
<ClientDate date="2026-01-15T14:30:00Z" showTime />
```

### Props

| Prop        | Type             | Default     | Description                                  |
| ----------- | ---------------- | ----------- | -------------------------------------------- |
| `date`      | `Date \| string` | (required)  | Date to display - accepts Date or ISO string |
| `showTime`  | `boolean`        | `false`     | Include time in the output                   |
| `className` | `string`         | `undefined` | Additional CSS classes                       |

### Notes

- **Hydration safety**: Uses `suppressHydrationWarning` to prevent React warnings during the brief moment before hydration completes.
- **Placeholder**: Shows a non-breaking space (`\u00A0`) during SSR to preserve layout.
- **Automatic parsing**: Accepts both `Date` objects and ISO date strings.

## PasswordInput

A password input field with a show/hide toggle button. Wraps the standard Input component with visibility toggle functionality.

### Usage

```tsx
import { PasswordInput } from '@/components/ui/password-input';

// Basic usage
<PasswordInput
  id="password"
  placeholder="Enter password"
/>

// With react-hook-form
<PasswordInput
  id="password"
  placeholder="Enter password"
  {...register('password')}
/>

// With custom styling
<PasswordInput
  id="password"
  className="bg-muted"
  wrapperClassName="max-w-sm"
/>

// Disabled state
<PasswordInput
  id="password"
  disabled
  value="********"
/>
```

### Props

| Prop               | Type      | Default     | Description                               |
| ------------------ | --------- | ----------- | ----------------------------------------- |
| `wrapperClassName` | `string`  | `undefined` | Additional class name for the wrapper div |
| `className`        | `string`  | `undefined` | Additional class name for the input       |
| `disabled`         | `boolean` | `false`     | Disables input and toggle button          |
| `...props`         | -         | -           | All standard input props except `type`    |

### Notes

- **Ref forwarding**: Forwards ref to the underlying input element for form library integration.
- **Type managed internally**: The `type` prop is omitted from the interface as it's controlled by the visibility toggle.
- **Accessibility**: Toggle button has proper `aria-label` that updates based on visibility state ("Show password" / "Hide password").
- **Tab behavior**: Toggle button has `tabIndex={-1}` to keep keyboard navigation focused on form fields.

## Related Documentation

- [UI Patterns Overview](./overview.md) - URL-persistent tabs and other patterns
- [Marketing Components](./marketing.md) - Hero, Features, Pricing, FAQ, CTA
- [Architecture Patterns](../architecture/patterns.md) - Component organization
