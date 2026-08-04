/**
 * Hosts allowed to reach Next's internal dev endpoints (HMR socket,
 * `/_next/*` dev resources). Next allows `localhost` and `*.localhost` on its
 * own and blocks everything else, so an app served through a local reverse
 * proxy — `https://myapp.test` in front of the loopback port — loses hot reload
 * with "Blocked cross-origin request to Next.js dev resource" until its
 * hostname is named here.
 *
 * Derived from the URLs the app is *already* configured to be served on rather
 * than hardcoded, so no fork has to edit this file: set NEXT_PUBLIC_APP_URL and
 * BETTER_AUTH_URL to the proxied hostname and hot reload follows.
 * ALLOWED_DEV_ORIGINS adds anything else (a LAN IP for device testing, or a
 * `*.myapp.test` wildcard if you serve tenants on subdomains).
 *
 * Development only — Next ignores this key in production builds. It widens
 * nothing in a deployed app.
 *
 * @returns {string[]}
 */
function allowedDevOrigins() {
  const hosts = new Set();

  for (const url of [process.env.NEXT_PUBLIC_APP_URL, process.env.BETTER_AUTH_URL]) {
    if (!url) continue;
    try {
      const { hostname } = new URL(url);
      if (hostname) hosts.add(hostname);
    } catch {
      // A malformed URL is lib/env.ts's problem to report, not this file's —
      // it validates both at startup with a far better message.
    }
  }

  for (const host of (process.env.ALLOWED_DEV_ORIGINS ?? '').split(',')) {
    const trimmed = host.trim();
    if (trimmed) hosts.add(trimmed);
  }

  return [...hosts];
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable standalone output for Docker deployments
  output: 'standalone',

  // Strict mode for React
  reactStrictMode: true,

  // See allowedDevOrigins() above — dev-only, derived from the app's own URLs.
  allowedDevOrigins: allowedDevOrigins(),

  // Prevent Next.js from bundling Prisma's WASM query compiler.
  // Without this, Turbopack/webpack breaks the WASM module loading.
  // `ioredis` is an optional peer dep loaded lazily by the Redis rate-limit
  // store; marking it external silences the "Module not found" warning when
  // it isn't installed (the runtime try/catch already handles absence).
  // `@opentelemetry/api` is the same pattern — opt-in tracer dep loaded
  // lazily by `lib/orchestration/tracing/otel-bootstrap.ts`.
  // `pdf-parse` and `pdfjs-dist` both dynamically `import('./pdf.worker.mjs')`
  // from inside their own package, via a variable specifier no static analysis
  // can follow. That breaks in two independent ways:
  //   1. Bundling — Turbopack pulls them into `.next/dev/server/chunks/` and the
  //      relative target isn't copied alongside. Marking both external is the
  //      fix: they stay in node_modules where relative resolution works.
  //   2. Tracing — on Vercel the Node file tracer never uploads
  //      `pdf.worker.mjs` into the function at all, so externalizing doesn't
  //      help. `pdf-parser.ts` fixes that half by importing the worker with a
  //      literal specifier and registering it on `globalThis.pdfjsWorker`,
  //      which pdfjs prefers over resolving one itself.
  // Both symptoms read the same: "Setting up fake worker failed: Cannot find
  // module …/pdf.worker.mjs". Keep both halves.
  serverExternalPackages: [
    '@prisma/client',
    '@prisma/adapter-pg',
    'ioredis',
    '@opentelemetry/api',
    'pdf-parse',
    'pdfjs-dist',
    // Native canvas backend. `pdf-parser.ts` imports it to polyfill the
    // `DOMMatrix`/`Path2D`/`ImageData` globals pdfjs-dist needs in Node.
    // It ships platform-specific `.node` binaries that must not be bundled.
    '@napi-rs/canvas',
  ],

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
