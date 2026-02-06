# Auth and Theme Components

## Overview

Sunrise provides authentication UI components and a theme system for consistent user experience across the application. These components integrate with better-auth for authentication and use CSS classes for theming.

## Component Library

| Component       | Purpose                        | File                                |
| --------------- | ------------------------------ | ----------------------------------- |
| `UserButton`    | User avatar/menu dropdown      | `components/auth/user-button.tsx`   |
| `LogoutButton`  | Standalone logout button       | `components/auth/logout-button.tsx` |
| `ThemeToggle`   | Light/dark theme toggle button | `components/theme-toggle.tsx`       |
| `ThemeProvider` | Theme context provider         | `hooks/use-theme.tsx`               |
| `useTheme`      | Theme management hook          | `hooks/use-theme.tsx`               |

## UserButton

Dropdown menu button that displays authentication state and navigation options.

**Behavior:**

- **Not authenticated:** Shows user icon with "Log in" and "Create account" options
- **Loading:** Shows skeleton placeholder to prevent hydration mismatch
- **Authenticated:** Shows avatar with profile, settings, admin (if admin), and sign out options

```tsx
import { UserButton } from '@/components/auth/user-button';

// In a header component
<header>
  <nav>{/* ... navigation links */}</nav>
  <UserButton />
</header>;
```

**Features:**

| Feature               | Description                                              |
| --------------------- | -------------------------------------------------------- |
| Avatar display        | Shows user image or initials fallback                    |
| Admin detection       | Shows admin dashboard link for users with `ADMIN` role   |
| Analytics integration | Tracks `USER_LOGGED_OUT` event on sign out               |
| Loading state         | Skeleton loader prevents hydration mismatch              |
| Hard redirect         | Uses `window.location.href` to fully clear session state |

**Menu Items (Authenticated):**

| Item            | Link        | Condition               |
| --------------- | ----------- | ----------------------- |
| View profile    | `/profile`  | Always                  |
| Settings        | `/settings` | Always                  |
| Admin Dashboard | `/admin`    | `user.role === 'ADMIN'` |
| Sign out        | -           | Always                  |

**Menu Items (Not Authenticated):**

| Item           | Link      |
| -------------- | --------- |
| Log in         | `/login`  |
| Create account | `/signup` |

## LogoutButton

Standalone button component for signing out users.

```tsx
import { LogoutButton } from '@/components/auth/logout-button';

// Default usage
<LogoutButton />

// With custom styling
<LogoutButton variant="outline" size="sm" />

// Custom redirect after logout
<LogoutButton redirectTo="/login" />
```

**Props:**

| Prop         | Type                                                                                    | Default     | Description                   |
| ------------ | --------------------------------------------------------------------------------------- | ----------- | ----------------------------- |
| `variant`    | `"default"` \| `"destructive"` \| `"outline"` \| `"secondary"` \| `"ghost"` \| `"link"` | `"ghost"`   | Button visual variant         |
| `size`       | `"default"` \| `"sm"` \| `"lg"` \| `"icon"`                                             | `"default"` | Button size                   |
| `className`  | `string`                                                                                | -           | Additional CSS classes        |
| `redirectTo` | `string`                                                                                | `"/"`       | Path to redirect after logout |

**Features:**

| Feature               | Description                                    |
| --------------------- | ---------------------------------------------- |
| Loading state         | Shows "Signing out..." while processing        |
| Analytics integration | Tracks `USER_LOGGED_OUT` and resets identity   |
| Error handling        | Logs errors and restores button state          |
| Router integration    | Uses Next.js router for navigation and refresh |

## ThemeToggle

Button component that toggles between light and dark themes.

```tsx
import { ThemeToggle } from '@/components/theme-toggle';

// In a header or settings panel
<div className="flex items-center gap-2">
  <ThemeToggle />
</div>;
```

**Behavior:**

- Displays sun icon in light mode, moon icon in dark mode
- Icons animate with rotation and scale transitions
- Uses `useTheme` hook to read and update theme state

**Styling:**

The component uses CSS transitions for smooth icon switching:

```css
/* Light mode: sun visible, moon hidden */
.sun {
  scale: 1;
  rotate: 0deg;
}
.moon {
  scale: 0;
  rotate: 90deg;
}

/* Dark mode: sun hidden, moon visible */
.dark .sun {
  scale: 0;
  rotate: -90deg;
}
.dark .moon {
  scale: 1;
  rotate: 0deg;
}
```

## Theme System

### ThemeProvider

Context provider that manages theme state and applies theme classes to the document.

```tsx
// In app/layout.tsx or a root layout
import { ThemeProvider } from '@/hooks/use-theme';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
```

**Initialization Order:**

1. Check `localStorage` for saved theme preference
2. If not found, check system preference via `prefers-color-scheme`
3. Save detected preference to `localStorage`
4. Default to `light` if running server-side

**Side Effects:**

- Adds/removes `light` or `dark` class on `<html>` element
- Persists theme choice to `localStorage`

### useTheme Hook

Hook for reading and updating the current theme.

```tsx
'use client';

import { useTheme } from '@/hooks/use-theme';

export function MyComponent() {
  const { theme, setTheme } = useTheme();

  return (
    <div>
      <p>Current theme: {theme}</p>
      <button onClick={() => setTheme('dark')}>Dark Mode</button>
      <button onClick={() => setTheme('light')}>Light Mode</button>
    </div>
  );
}
```

**Return Value:**

| Property   | Type                     | Description                  |
| ---------- | ------------------------ | ---------------------------- |
| `theme`    | `"light"` \| `"dark"`    | Current active theme         |
| `setTheme` | `(theme: Theme) => void` | Function to update the theme |

**Requirements:**

- Must be used within a `ThemeProvider`
- Throws error if used outside provider context
- Only works in client components (`'use client'`)

## Integration Notes

### Theme Classes

The theme system applies CSS classes to the document root:

```html
<!-- Light mode -->
<html class="light">
  <!-- Dark mode -->
  <html class="dark"></html>
</html>
```

Use Tailwind's dark mode utilities in your components:

```tsx
<div className="bg-white dark:bg-gray-900">
  <p className="text-gray-900 dark:text-gray-100">This text adapts to the theme</p>
</div>
```

### Preventing Flash of Wrong Theme

Add `suppressHydrationWarning` to the `<html>` element to prevent hydration warnings when the server-rendered theme differs from the client preference:

```tsx
<html lang="en" suppressHydrationWarning>
```

### Analytics Events

Both `UserButton` and `LogoutButton` track the `USER_LOGGED_OUT` event and reset the analytics identity on sign out. This ensures:

- The logout event is attributed to the correct user
- Future events are not incorrectly attributed to the signed-out user

## Related Documentation

- [Authentication Overview](../auth/overview.md) - better-auth integration
- [UI Patterns Overview](./overview.md) - Other UI patterns
- [Architecture Patterns](../architecture/patterns.md) - Component organization
