# UI Patterns

## Overview

This document covers reusable UI patterns in Sunrise. These patterns establish conventions for common UI challenges, ensuring consistency and reducing duplication across the codebase.

## URL-Persistent Tabs

### Problem

Tab interfaces lose their state on page refresh. Users can't share links to specific tabs, and browser back/forward doesn't work as expected.

### Solution

The `useUrlTabs` hook syncs tab state with URL query parameters, providing:

- **URL persistence**: Each tab has a shareable URL (`/settings?tab=security`)
- **SPA behavior**: Tab switching doesn't reload the page
- **Browser navigation**: Back/forward buttons work correctly
- **Invalid URL handling**: Malformed URLs automatically clean up

### Files

| File                                    | Purpose                           |
| --------------------------------------- | --------------------------------- |
| `lib/hooks/use-url-tabs.ts`             | Reusable hook for URL-synced tabs |
| `lib/constants/settings.ts`             | Example tab constants (type-safe) |
| `components/settings/settings-tabs.tsx` | Example implementation            |

### Usage

**1. Define tab constants (recommended for type safety):**

```typescript
// lib/constants/[feature].ts
export const FEATURE_TABS = {
  OVERVIEW: 'overview',
  DETAILS: 'details',
  HISTORY: 'history',
} as const;

export const FEATURE_TAB_VALUES = Object.values(FEATURE_TABS);
export type FeatureTab = (typeof FEATURE_TABS)[keyof typeof FEATURE_TABS];
export const DEFAULT_FEATURE_TAB: FeatureTab = FEATURE_TABS.OVERVIEW;
```

**2. Use the hook in a client component:**

```typescript
'use client';

import { useUrlTabs } from '@/lib/hooks/use-url-tabs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  FEATURE_TABS,
  FEATURE_TAB_VALUES,
  DEFAULT_FEATURE_TAB,
  type FeatureTab,
} from '@/lib/constants/feature';

export function FeatureTabs() {
  const { activeTab, setActiveTab } = useUrlTabs<FeatureTab>({
    defaultTab: DEFAULT_FEATURE_TAB,
    allowedTabs: FEATURE_TAB_VALUES,
  });

  // Wrapper for Radix's string type
  const handleTabChange = (value: string) => {
    setActiveTab(value as FeatureTab);
  };

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <TabsList>
        <TabsTrigger value={FEATURE_TABS.OVERVIEW}>Overview</TabsTrigger>
        <TabsTrigger value={FEATURE_TABS.DETAILS}>Details</TabsTrigger>
        <TabsTrigger value={FEATURE_TABS.HISTORY}>History</TabsTrigger>
      </TabsList>

      <TabsContent value={FEATURE_TABS.OVERVIEW}>
        {/* Overview content */}
      </TabsContent>
      {/* ... other tab contents */}
    </Tabs>
  );
}
```

**3. Use in a page with server-side data:**

```typescript
// app/(protected)/feature/page.tsx
import { FeatureTabs } from '@/components/feature/feature-tabs';

export default async function FeaturePage() {
  // Fetch data server-side
  const data = await fetchData();

  return (
    <div>
      <h1>Feature</h1>
      <FeatureTabs data={data} />
    </div>
  );
}
```

### Hook API

```typescript
interface UseUrlTabsOptions<T extends string> {
  /** Query parameter name (default: 'tab') */
  paramName?: string;
  /** Default tab when URL param is missing or invalid */
  defaultTab: T;
  /** Valid tab values for validation */
  allowedTabs: readonly T[];
  /** Optional map of tab values to page titles (updates document.title) */
  titles?: Partial<Record<T, string>>;
}

interface UseUrlTabsReturn<T extends string> {
  /** Currently active tab */
  activeTab: T;
  /** Set the active tab (updates URL) */
  setActiveTab: (tab: T) => void;
  /** Check if a specific tab is active */
  isActive: (tab: T) => boolean;
}
```

### Behavior

| Scenario              | Result                                            |
| --------------------- | ------------------------------------------------- |
| `/page`               | Shows default tab, clean URL                      |
| `/page?tab=details`   | Shows details tab                                 |
| `/page?tab=invalid`   | Shows default tab, URL cleaned to `/page`         |
| Click non-default tab | URL updates to `/page?tab=details`, title updates |
| Click default tab     | URL cleans to `/page`, title updates              |
| Browser back          | Returns to previous tab, title updates            |

### Dynamic Page Titles

The hook can automatically update `document.title` when tabs change:

```typescript
// lib/constants/feature.ts
export const FEATURE_TAB_TITLES: Record<FeatureTab, string> = {
  overview: 'Overview - Feature - Sunrise',
  details: 'Details - Feature - Sunrise',
  history: 'History - Feature - Sunrise',
};

// In component
const { activeTab, setActiveTab } = useUrlTabs({
  defaultTab: 'overview',
  allowedTabs: ['overview', 'details', 'history'],
  titles: FEATURE_TAB_TITLES,
});
```

When a user switches to the Details tab, the browser title updates to "Details - Feature - Sunrise".

### Custom Parameter Name

For pages with multiple tab groups or specific naming needs:

```typescript
const { activeTab, setActiveTab } = useUrlTabs({
  paramName: 'section', // Uses ?section=value instead of ?tab=value
  defaultTab: 'general',
  allowedTabs: ['general', 'advanced'],
});
```

### Testing

The hook and components have comprehensive tests. When implementing:

1. Mock `next/navigation` hooks (`useSearchParams`, `useRouter`, `usePathname`)
2. Test URL sync behavior (reading from and writing to URL)
3. Test invalid value handling (should clean URL)
4. Test that valid tabs don't trigger unnecessary URL updates

See `tests/unit/lib/hooks/use-url-tabs.test.ts` for examples.

## Decision Rationale

### Query Parameters vs Hash

**Chosen**: Query parameters (`?tab=security`)

**Why**:

- Works with Next.js navigation system
- Can be read server-side if needed
- Cleaner integration with existing URL handling
- Hash fragments are traditionally for in-page anchors

### URL Cleanup for Invalid Values

**Chosen**: Automatically remove invalid tab params

**Why**:

- Prevents confusing state (URL says one thing, UI shows another)
- Clean URLs are more shareable
- Handles typos and outdated bookmarks gracefully

### Default Tab URL Format

**Chosen**: Remove param for default tab (`/settings` not `/settings?tab=profile`)

**Why**:

- Cleaner canonical URLs
- Consistent with how the page naturally loads
- Reduces URL noise

## Related Patterns

- [Architecture Patterns](../architecture/patterns.md) - General code organization
- [Component Organization](../architecture/patterns.md#component-organization) - How to structure components

## Future Patterns

This document will be extended with additional UI patterns as they're established:

- Form state persistence
- Modal/dialog URL sync
- Pagination patterns
- Filter state management
