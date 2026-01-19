import type { MetadataRoute } from 'next';

/**
 * Robots.txt Configuration
 *
 * Controls how search engine crawlers access the site.
 * - Allows all crawlers to access public pages
 * - Blocks access to API routes and auth pages
 * - References the sitemap for discovery
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots
 *
 * Phase 3.5: Landing Page & Marketing
 */
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
