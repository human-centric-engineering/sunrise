/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable standalone output for Docker
  // This creates a minimal server in .next/standalone
  output: 'standalone',
  
  // Optionally configure image optimization
  images: {
    // Use unoptimized if deploying to environments without image optimization support
    // unoptimized: true,
    
    // Or configure remote patterns for external images
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.example.com',
      },
    ],
  },

  // Other common configurations
  reactStrictMode: true,
  swcMinify: true,

  // Environment variables to expose to the browser
  // Note: These are embedded at build time
  env: {
    // Add any public env vars here
  },

  // Add headers for security
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
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
