/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable standalone output for Docker deployments
  output: 'standalone',

  // Strict mode for React
  reactStrictMode: true,

  // Disable the client-side Router Cache for dynamic pages. Without this,
  // Next.js caches RSC payloads on the client during navigation, causing
  // stale data (e.g. empty tables) when navigating back to list pages.
  experimental: {
    staleTimes: {
      dynamic: 0,
    },
  },

  // Prevent Next.js from bundling Prisma's WASM query compiler.
  // Without this, Turbopack/webpack breaks the WASM module loading.
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-pg'],

  // Security headers
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
