# Multi-stage build for optimal image size
# Production-ready Dockerfile for Next.js 16 with standalone output
# Expected final image size: ~150-200MB

FROM node:20-alpine AS base

# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy package files AND .npmrc (critical for better-auth + Prisma 7 compatibility)
# .npmrc contains legacy-peer-deps=true to handle better-auth peer dependency warnings
COPY package.json package-lock.json* .npmrc ./

# Copy Prisma schema BEFORE npm ci
# This is required because the postinstall script runs "prisma generate"
COPY prisma ./prisma

# Install dependencies
# The postinstall script will run "prisma generate" automatically
RUN npm ci

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma

# Copy application source
COPY . .

# Build arguments for environment variables needed at build time
# NEXT_PUBLIC_* variables are embedded into the JavaScript bundle during build
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

# Set environment variables for build
# Next.js collects anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
ENV NEXT_TELEMETRY_DISABLED=1

# Build the application
# Next.js 16 standalone output creates a minimal production server at .next/standalone/
RUN npm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create a non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy necessary files
COPY --from=builder /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
# HOSTNAME="0.0.0.0" allows connections from outside the container
ENV HOSTNAME="0.0.0.0"

# Health check to verify the application is running
# Checks /api/health endpoint every 30 seconds
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
# server.js is created by Next.js standalone build
CMD ["node", "server.js"]
