# Multi-stage build for optimal image size
# Production-ready Dockerfile for Next.js 16 with standalone output
#
# Stages: base → deps → builder → migrator → seeder → runner
# `runner` is last, so a bare `docker build .` still produces the runtime image.
# Measured image sizes live in one place — see
# .context/deployment/platforms/docker-self-hosted.md — rather than being
# restated here, which is how four mutually inconsistent figures ended up in
# the docs.

FROM node:24-alpine AS base

# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy package files AND .npmrc (critical for better-auth + Prisma 7 compatibility)
# .npmrc contains legacy-peer-deps=true to handle better-auth peer dependency warnings
COPY package.json package-lock.json* .npmrc ./

# Copy Prisma schema + config BEFORE npm ci. The postinstall runs
# "prisma generate", which needs prisma.config.ts to locate the prisma/schema/
# folder (Prisma 7 multi-file schema) and resolve the datasource.
COPY prisma ./prisma
COPY prisma.config.ts ./

# This stage takes NO DATABASE_URL build arg, and that is deliberate.
#
# `npm ci`'s postinstall runs `prisma generate`, which loads prisma.config.ts,
# which resolves env('DATABASE_URL') — so the variable has to be *set*, but it
# never opens a connection, so the value only has to parse. A placeholder is
# therefore sufficient, and it keeps the real DSN out of this stage entirely.
#
# That matters because `migrator` and `seeder` below derive FROM this stage, and
# a build arg is recorded verbatim in `docker history` (both as `ARG NAME=value`
# and in the `RUN |1 NAME=value …` prefix). An ENV would additionally expose it
# in `docker inspect .Config.Env` and to every process in the container. Passing
# a production DSN here would put the password in all three places, in an image
# that is meant to be runnable. `builder` still takes the real value — Next's
# build-time env validation wants it — but `runner` is a fresh `FROM base`, so
# none of builder's history reaches the shipped image.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"

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
# These are required for Next.js build and environment validation
ARG DATABASE_URL
ARG BETTER_AUTH_URL
ARG BETTER_AUTH_SECRET
ARG NEXT_PUBLIC_APP_URL

ENV DATABASE_URL=$DATABASE_URL
ENV BETTER_AUTH_URL=$BETTER_AUTH_URL
ENV BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

# Set environment variables for build
# Next.js collects anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
ENV NEXT_TELEMETRY_DISABLED=1

# Raise Node's heap for the build only. On a ~7GB host (private-repo CI runners,
# small dev/build boxes) `next build` hits Node's default ~2GB heap cap and OOMs
# (FATAL ERROR: Reached heap limit). This ENV lives in the `builder` stage only
# — the `runner` stage below is a fresh `FROM base` and does not inherit it, so
# production runtime memory is unchanged.
#
# Overridable, because a workflow-level `env:` does NOT cross into a container
# build: `ci.yml` raising NODE_OPTIONS moved `typecheck`/`lint`/`build` but left
# this stage pinned at 4096, so a fork that outgrew the default got a green
# board with one permanently red job and a variable that appeared to do nothing
# (#543). CI and `docker-compose.prod.yml` both forward their own value.
#
# The default stays 4096 deliberately: this stage is sized for ~7GB hosts, where
# a larger cap trades a clean V8 heap error for an OS-level kill — a worse
# failure to debug. Only a caller that knows its runner is bigger asks for more.
#
# Declared inside this stage on purpose. An ARG is scoped to the stage that
# declares it (plus stages derived from it), so a top-level one would not reach
# here.
ARG NODE_HEAP_MB=4096
ENV NODE_OPTIONS=--max-old-space-size=${NODE_HEAP_MB}

# Build the application
# Next.js 16 standalone output creates a minimal production server at .next/standalone/
RUN npm run build

# ---------------------------------------------------------------------------
# Deploy-time stages.
#
# These sit BEFORE `runner` on purpose: `docker build .` with no --target builds
# the LAST stage in the file, and that has to stay the runtime image
# (.context/commands.md and DOCKER-TESTING.md both document the bare form).
# BuildKit only materialises stages the requested target depends on, so their
# presence costs a plain build nothing.
# ---------------------------------------------------------------------------

# Migration runner: applies pending Prisma migrations, then exits.
#
# It derives FROM deps rather than from the runtime image because the Prisma
# CLI's dependency closure is 133 packages / ~240 MB — @prisma/studio-core,
# @electric-sql/pglite (a WASM Postgres), effect, elkjs, @visx/*, d3-*,
# @radix-ui/* — none of which belongs in the process that serves traffic. `deps`
# already has the complete node_modules (including node_modules/.bin), the real
# package.json, prisma/ and prisma.config.ts, so this stage duplicates no layers.
#
# Not a server: no EXPOSE, no HEALTHCHECK. It runs once and exits (#583).
FROM deps AS migrator

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Put the local .bin on PATH so `prisma …` resolves directly, and never reach
# for `npx`. A *partial* node_modules/prisma is precisely what made the old
# `npx prisma migrate deploy` exit 127: npx finds the package, stops looking,
# and never falls back to a registry fetch (#583).
ENV PATH="/app/node_modules/.bin:$PATH"

# Never inherit a build-time DSN: without this the stage would carry the deps
# placeholder, and a missing runtime value would silently migrate whatever that
# happens to point at.
#
# The trade-off is that an empty string still counts as *set*, so dotenv (which
# prisma.config.ts and prisma/seed.ts both call) will not populate it from a
# mounted /app/.env — and the resulting failures are unhelpful: the migrator
# says "Cannot resolve environment variable: DATABASE_URL" even with a perfectly
# good .env mounted, and the seeder gets as far as ECONNREFUSED on
# 127.0.0.1:5432 because `new Pool({connectionString: ''})` falls back to libpq
# defaults. Both CMDs below therefore guard explicitly and say what to do.
ENV DATABASE_URL=""

# node:*-alpine ships uid 1000 `node`, but USER does not update HOME — it would
# stay /root, which this user cannot write. npm needs a writable cache to log to.
ENV HOME=/home/node
ENV npm_config_cache=/home/node/.npm

# Non-root. /app stays root-owned and world-readable: `migrate deploy` only
# reads prisma/schema and prisma/migrations. A recursive chown would copy the
# whole ~2 GB node_modules tree into a new layer to buy nothing.
USER node

# The guard is an ENTRYPOINT, not part of the CMD, so it also covers overridden
# commands — `compose run --rm migrator prisma migrate status`, which this
# repo documents in three places, replaces CMD and would otherwise skip it and
# hit exactly the confusing failure described above.
ENTRYPOINT ["sh", "-c", ": \"${DATABASE_URL:?is empty or unset. Supply it at run time (compose env_file, docker run -e, or --env-file). A mounted /app/.env is NOT read: this image ships DATABASE_URL empty so it can never inherit a build-time DSN, and dotenv does not overwrite a set variable.}\"; exec \"$@\"", "sunrise-migrator"]
CMD ["npm", "run", "db:migrate:deploy"]

# One-shot database seeder.
#
# `npm run db:seed` is `tsx prisma/seed.ts`, and the seed units import from
# @/lib/** and @/types/**, so this needs the application source and tsconfig.json
# on top of the migrator's node_modules (which already carries tsx — a
# devDependency `npm ci` installs). That combination has never existed in the
# runtime image, which is why the documented `exec web npm run db:seed` could
# not work.
#
# FROM migrator and NOT FROM builder, deliberately: `builder` sets
# ENV BETTER_AUTH_SECRET and ENV DATABASE_URL for `next build`, and every stage
# derived from it would inherit both in its image config. Never push this image
# to a registry — it contains the full source tree.
FROM migrator AS seeder
COPY . .
CMD ["npm", "run", "db:seed"]

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

# The Prisma CLI, the schema, the migrations and prisma.config.ts are
# deliberately NOT here. (Next's trace does leave one file under prisma/ —
# seeds/data/chunks/chunks.json, which runtime code reads. Nothing else.)
#
# They used to be, so that one image could both serve traffic and run
# `prisma migrate deploy`. That never worked: the copy was five hand-listed
# directories that omitted node_modules/.bin and the CLI's dependency closure,
# so the migrator exited 127 and `npx` could not fall back to a registry fetch
# because a partial local package stopped it looking. Completing the list would
# have meant importing 133 packages / ~240 MB of deploy-time tooling —
# @prisma/studio-core, @electric-sql/pglite, effect, d3, @visx — into the
# process that serves HTTP. So the CLI moved to the `migrator` stage instead
# (#583).
#
# What the running app needs arrives through the standalone trace above:
# @prisma/client, .prisma/client (including the wasm query compiler),
# @prisma/adapter-pg and pg are all reachable from server.js, and
# next.config.js lists the Prisma packages in serverExternalPackages so nft
# copies them rather than bundling them. Measured: 376 KB of @prisma plus
# 5.3 MB of .prisma, against 171.6 MB for the old wholesale copy.
#
# Note the trace is import-shape-specific — it carries adapter-pg's ESM entry
# and not its CJS one, because that is how the server loads it. Verify this
# image by exercising a real request path, not by hand-writing a `require()`.
#
# Consequences, by design: `npx prisma …`, `npm run db:migrate:deploy` and
# `npm run db:seed` do NOT work inside this container. Use the `migrator` and
# `seeder` services — see docker-compose.prod.yml and
# .context/deployment/overview.md.
#
# A stub stands in for the CLI so that failure is legible. Without it the error
# is `sh: prisma: not found` — byte-identical to the bug this change fixes, so
# an operator running a now-obsolete documented command would land on the same
# dead end they were trying to escape. Left as a plain message rather than
# silently forwarding anywhere, because there is nothing correct to forward to.
RUN printf '%s\n' \
  '#!/bin/sh' \
  'echo "prisma: the Prisma CLI is not installed in the Sunrise runtime image." >&2' \
  'echo "Run migrations with the migrator service instead:" >&2' \
  'echo "  docker compose -f docker-compose.prod.yml run --rm migrator prisma $*" >&2' \
  'echo "Seeding: docker compose -f docker-compose.prod.yml --profile seed run --rm seeder" >&2' \
  'echo "Background: CHANGELOG entry for #583, and .context/deployment/overview.md" >&2' \
  'exit 1' \
  > /usr/local/bin/prisma && chmod 755 /usr/local/bin/prisma

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
