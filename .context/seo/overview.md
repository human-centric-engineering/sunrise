# SEO & Discovery

## Overview

Sunrise includes SEO configuration for search engine optimization, including dynamic sitemap generation, robots.txt configuration, and standardized metadata patterns for social sharing.

## Files

| File             | Purpose                                |
| ---------------- | -------------------------------------- |
| `app/robots.ts`  | Robots.txt configuration               |
| `app/sitemap.ts` | Dynamic sitemap generation             |
| Page `metadata`  | Per-page title, description, OG images |

## Robots.txt

The `app/robots.ts` file controls crawler access:

```typescript
// app/robots.ts
export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/admin/',
          '/dashboard/',
          '/settings/',
          '/profile/',
          '/login',
          '/signup',
        ],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
```

**Blocked paths:**

- `/api/` - All API routes
- `/admin/` - Admin panel pages
- `/dashboard/`, `/settings/`, `/profile/` - Protected pages
- `/login`, `/signup` - Authentication pages

> **Note:** Transactional pages like `/verify-email` and `/accept-invite` fall under the `(auth)` route group. While not explicitly listed, they are effectively blocked as non-public pages that search engines shouldn't index.

## Sitemap

The `app/sitemap.ts` dynamically generates the sitemap:

```typescript
// app/sitemap.ts
export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  const publicPages = [
    { path: '', priority: 1.0, changeFrequency: 'weekly' as const },
    { path: '/about', priority: 0.8, changeFrequency: 'monthly' as const },
    { path: '/contact', priority: 0.8, changeFrequency: 'monthly' as const },
    { path: '/privacy', priority: 0.3, changeFrequency: 'yearly' as const },
    { path: '/terms', priority: 0.3, changeFrequency: 'yearly' as const },
  ];

  return publicPages.map((page) => ({
    url: `${baseUrl}${page.path}`,
    lastModified: new Date(),
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));
}
```

### Adding New Pages to Sitemap

When adding new public pages, add them to the `publicPages` array:

```typescript
const publicPages = [
  // ... existing pages
  { path: '/pricing', priority: 0.9, changeFrequency: 'monthly' as const },
  { path: '/features', priority: 0.8, changeFrequency: 'monthly' as const },
];
```

**Priority Guidelines:**

- `1.0` - Homepage
- `0.9` - Primary conversion pages (pricing, features)
- `0.8` - Secondary pages (about, contact)
- `0.5` - Tertiary pages (blog posts)
- `0.3` - Legal pages (privacy, terms)

**Change Frequency:**

- `daily` - Frequently updated content
- `weekly` - Regularly updated pages
- `monthly` - Stable content pages
- `yearly` - Legal/policy pages

## Page Metadata

Use Next.js Metadata API for per-page SEO.

> **Note:** Auth and protected pages have metadata even though they're blocked from search engines. This ensures proper browser tab titles and social sharing when users share direct links while authenticated.

```typescript
// app/(public)/about/page.tsx
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'About',
  description: 'Learn about Sunrise and our mission.',
  openGraph: {
    title: 'About - Sunrise',
    description: 'Learn about Sunrise and our mission.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'About - Sunrise',
    description: 'Learn about Sunrise and our mission.',
  },
};

export default function AboutPage() {
  return <div>...</div>;
}
```

### Root Layout Metadata

The root layout (`app/layout.tsx`) provides simple base metadata:

```typescript
// app/layout.tsx
export const metadata: Metadata = {
  title: 'Sunrise - Next.js Starter',
  description: 'A production-ready Next.js starter template...',
};
```

### Route Group Layouts

Title templates are defined in route group layouts, not the root layout. Each route group sets its own template:

```typescript
// app/(public)/layout.tsx, app/(protected)/layout.tsx, app/(auth)/layout.tsx
export const metadata: Metadata = {
  title: {
    template: '%s - Sunrise', // Page titles become "About - Sunrise"
    default: 'Sunrise',
  },
  description: '...',
};
```

This means page titles like `title: 'About'` become "About - Sunrise" in the browser tab.

### Metadata Inheritance

Metadata cascades from layouts to pages:

```
app/layout.tsx (root)
└── Basic title and description
    │
    ├── app/(public)/layout.tsx
    │   └── title.template: '%s - Sunrise'
    │
    ├── app/(protected)/layout.tsx
    │   └── title.template: '%s - Sunrise'
    │
    ├── app/(auth)/layout.tsx
    │   └── title.template: '%s - Sunrise'
    │
    └── app/admin/layout.tsx
        └── title.template: '%s - Admin - Sunrise'
```

**How it works:**

- Page sets `title: 'About'`
- Layout template transforms to "About - Sunrise"
- Admin pages become "Users - Admin - Sunrise"

### Twitter Cards

Each page must define its own Twitter card configuration:

```typescript
export const metadata: Metadata = {
  title: 'My Page',
  twitter: {
    card: 'summary_large_image',
    title: 'Custom Twitter Title',
    description: 'Custom Twitter description',
    images: ['/og/my-page.png'],
  },
};
```

### Dynamic Metadata

For dynamic routes that need params in metadata, use `generateMetadata()`:

```typescript
// app/admin/users/[id]/page.tsx
import type { Metadata } from 'next';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `User ${id}`,
    description: 'View user profile',
  };
}
```

**When to use:**

- Static `export const metadata` - Pages with fixed titles
- `generateMetadata()` - Pages with dynamic params (user IDs, slugs, etc.)

**Note:** In Next.js 16, `params` is a Promise and must be awaited.

### OpenGraph Images

For custom OG images per page:

```typescript
export const metadata: Metadata = {
  openGraph: {
    images: [
      {
        url: '/og/about.png',
        width: 1200,
        height: 630,
        alt: 'About Sunrise',
      },
    ],
  },
};
```

## Environment Configuration

The `NEXT_PUBLIC_APP_URL` environment variable is used for absolute URLs in sitemap and metadata:

```bash
# .env.local
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Production
NEXT_PUBLIC_APP_URL=https://app.example.com
```

## Icons and Favicons

Sunrise does not include favicon setup by default. To add icons:

1. **Static icons**: Place `favicon.ico` in the `app/` directory
2. **Generated icons**: Create `app/icon.tsx` for dynamic generation

See [Next.js Icons documentation](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/app-icons) for details.

## Adding New Public Pages Checklist

When adding a new public page:

1. **Create the page** in `app/(public)/[page-name]/page.tsx`
2. **Add metadata** with title, description, and OG tags
3. **Update sitemap** - Add to `publicPages` array in `app/sitemap.ts`
4. **Check robots.txt** - Ensure path isn't blocked
5. **Verify** - Check `/sitemap.xml` includes the new page

## Verification

Test your SEO configuration:

```bash
# View sitemap
curl http://localhost:3000/sitemap.xml

# View robots.txt
curl http://localhost:3000/robots.txt
```

## Related Documentation

- [Deployment Overview](../deployment/overview.md) - Production deployment
- [Environment Reference](../environment/reference.md) - Environment variables
