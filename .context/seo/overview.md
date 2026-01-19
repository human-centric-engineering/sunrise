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
        disallow: ['/api/', '/dashboard/', '/settings/', '/profile/', '/login', '/signup'],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
```

**Blocked paths:**

- `/api/` - All API routes
- `/dashboard/`, `/settings/`, `/profile/` - Protected pages
- `/login`, `/signup` - Authentication pages

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

Use Next.js Metadata API for per-page SEO:

```typescript
// app/(public)/about/page.tsx
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'About',
  description: 'Learn about Sunrise and our mission.',
  openGraph: {
    title: 'About Sunrise',
    description: 'Learn about Sunrise and our mission.',
    type: 'website',
  },
};

export default function AboutPage() {
  return <div>...</div>;
}
```

### Base Metadata Template

The root layout provides default metadata that pages inherit:

```typescript
// app/layout.tsx
export const metadata: Metadata = {
  title: {
    template: '%s | Sunrise', // Page titles become "About | Sunrise"
    default: 'Sunrise',
  },
  description: 'Production-ready Next.js starter template',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'),
  openGraph: {
    type: 'website',
    siteName: 'Sunrise',
  },
  twitter: {
    card: 'summary_large_image',
  },
};
```

### Twitter Cards

Twitter card configuration is inherited from the root layout. For custom Twitter cards per page:

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
