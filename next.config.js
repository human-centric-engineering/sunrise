/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable standalone output for Docker deployments
  output: 'standalone',

  // Strict mode for React
  reactStrictMode: true,

  // Prevent Next.js from bundling Prisma's WASM query compiler.
  // Without this, Turbopack/webpack breaks the WASM module loading.
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-pg'],

  // Security headers
  async headers() {
    return [
      {
        // Embed widget routes — allow framing and cross-origin access
        source: '/api/v1/embed/:path*',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
        ],
      },
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
