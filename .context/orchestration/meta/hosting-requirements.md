# Hosting Requirements — Sunrise + Orchestration Layer

What it takes to run Sunrise in production with the agentic layer enabled, the gotchas that bite first, and how the realistic deployment targets compare. Written for engineers picking a platform **and** for smart readers who haven't deployed much before.

**Last updated:** 2026-05-05

---

## How to read this document

**Audience.** Two readers in mind:

- An engineer choosing a deployment target on technical merit.
- A capable reader who is comfortable in code but new to servers, Docker, nginx, or cron — someone deciding what to learn and how much help to ask for.

**Companion docs.**

- `.context/deployment/overview.md` — the canonical deployment table and migration strategy
- `.context/deployment/platforms/*` — per-platform step-by-step guides (Vercel, Render, Railway, Docker)
- `.context/orchestration/scheduling.md` — scheduler tick contract
- `.context/orchestration/external-calls.md` — outbound HTTP behaviour for capabilities
- `Dockerfile`, `docker-compose.prod.yml`, `nginx.conf` — the canonical self-hosted artifact set

This document focuses on the **agentic layer's specific demands** on the host (long streams, scheduler ticks, vector search, LLM tool loops, document ingestion). The base Next.js app would run almost anywhere; the orchestration layer narrows the field considerably.

---

## 0. Before you choose: what these terms mean

If any of the words below are new, this section is the floor. None of these are deep — they're the vocabulary used in the rest of the doc.

| Term                   | Plain meaning                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VPS**                | A virtual private server — a Linux computer in a datacentre that you rent by the month and SSH into. Examples: DigitalOcean droplet, Hetzner, Linode.                                               |
| **Managed platform**   | A service that runs your app for you (Vercel, Render, Fly.io). You give it a Git repo and env vars; it builds, deploys, and serves it.                                                              |
| **Docker / container** | A way to package an app together with everything it needs to run, so it behaves the same on your laptop and on a server. The repo includes a `Dockerfile` that describes how to build that package. |
| **Reverse proxy**      | A web server (usually nginx) that sits in front of your app, terminates HTTPS, and forwards requests to it. Most managed platforms hide this from you.                                              |
| **SSE**                | Server-Sent Events — a way for the server to keep a single HTTP connection open and push messages over it. Sunrise uses SSE so chats can stream tokens.                                             |
| **pgvector**           | A PostgreSQL extension that adds vector similarity search. Sunrise needs it so agents can search your knowledge base by meaning, not just keyword.                                                  |
| **Function timeout**   | On serverless platforms, each request runs inside a "function" with a maximum duration (e.g. 60 s). Long agent runs and SSE streams can hit this ceiling.                                           |
| **Cron / cron tick**   | A scheduler that runs a command on a schedule (e.g. every minute). Sunrise expects something external to "tick" two URLs on a schedule.                                                             |
| **Migration**          | A change to the database schema. `prisma migrate deploy` applies any new migrations to the production DB. Must run before the new app starts.                                                       |
| **Standalone build**   | A flag (`output: 'standalone'`) that makes Next.js bundle a small, self-contained Node server. Already enabled in `next.config.js`.                                                                 |

If you remember one thing: **pick a platform, give it your repo, set the environment variables, point a cron at two URLs.** Everything below is the detail behind that sentence.

---

## 1. Runtime requirements

### 1.1 Process model

In plain terms: Sunrise is a normal long-running web server (Node.js). Some platforms (Vercel) run web apps as short-lived "functions" instead, which is great for short requests but creates friction for the agentic layer's long streams.

Sunrise runs as a **single long-lived Node 20+ process** built from `next build` with `output: 'standalone'` (`next.config.js:4`). The orchestration layer assumes a real, persistent Node runtime — it is not designed for an Edge runtime, and several pieces (native modules, long SSE streams, in-process scheduling assumptions) preclude purely serverless execution models that hard-cap function duration at 60 seconds.

| Requirement                           | Why it matters                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Node 20+                              | Required by Prisma 7's client and the Next.js 16 / React 19 toolchain                                   |
| `output: 'standalone'`                | Produces `.next/standalone/server.js` so the runtime image carries only what it needs                   |
| `serverExternalPackages`              | `@prisma/client`, `@prisma/adapter-pg`, `ioredis` are excluded from the bundler — must exist at runtime |
| `.npmrc` with `legacy-peer-deps=true` | Required by `better-auth` + Prisma 7 — must be present at install time, not just dev                    |
| Build memory ≥ 2 GB                   | `next build` + Prisma generate + type-check peaks high; tiny VMs OOM mid-build                          |

### 1.2 Native dependencies

In plain terms: a few of the libraries Sunrise uses are not pure JavaScript — they include compiled binaries. Most platforms handle this transparently; the only platform-level catch is that very stripped-down Linux images (Alpine) need an extra package.

| Dependency      | Purpose                                  | Host implication                                          |
| --------------- | ---------------------------------------- | --------------------------------------------------------- |
| `sharp`         | Image transforms (Next.js + uploads)     | Pre-built binaries for glibc; Alpine needs `libc6-compat` |
| `pdf-parse`     | Knowledge base PDF ingestion             | Pure JS, but heap-heavy on large PDFs                     |
| `mammoth`       | DOCX ingestion                           | Pure JS                                                   |
| `epub2`         | EPUB ingestion                           | Pure JS                                                   |
| `gpt-tokenizer` | Token counting for cost / context limits | Pure JS                                                   |

The `Dockerfile` already handles `libc6-compat` and the standalone trace; non-Docker hosts must ensure equivalent base packages.

### 1.3 Database — PostgreSQL with `pgvector`

In plain terms: Sunrise needs PostgreSQL with one extra extension installed (`pgvector`) so the knowledge base can search documents by meaning. Most managed Postgres providers either include it or let you turn it on with one command. A Postgres install you do yourself on a VPS will need an extra `apt install` step.

- Migration `prisma/migrations/20260409153925_enable_pgvector/migration.sql` runs `CREATE EXTENSION vector`
- `docker-compose.prod.yml` ships `pgvector/pgvector:pg15` for this reason
- Plain managed Postgres (vanilla RDS, vanilla Cloud SQL, hand-installed Postgres on a VPS) **will not** have the extension — `migrate deploy` fails on first run

Acceptable databases: Vercel Postgres (Neon-backed, pgvector available), Neon directly, Supabase, Railway, Render, Fly Postgres, or any self-managed Postgres where you can `apt install postgresql-XX-pgvector`. RDS supports pgvector since 15.2; Cloud SQL since PG 15.

Connection pooling: Prisma's adapter (`@prisma/adapter-pg`) holds its own pool. For serverless or many-instance deployments, front the DB with PgBouncer / Neon's pooler / Supabase's connection pooler to avoid connection storms.

### 1.4 Cache / rate-limit store (optional)

In plain terms: rate limiting works fine without anything extra on a single instance. If you scale to multiple instances later, you'll want Redis so they can share counters.

`lib/security/rate-limit.ts` and the orchestration rate limits use an in-process LRU by default and **opportunistically** Redis if `ioredis` is installed and `REDIS_URL` is set (see the lazy require + `serverExternalPackages: ['ioredis']` in `next.config.js`). Single-instance deploys can skip Redis entirely; multi-instance deploys must add it or accept per-instance limits.

### 1.5 Object storage

In plain terms: somewhere to put uploaded files (knowledge documents, avatars). Three options ship in the box:

`lib/storage/providers/` ships three drivers, selected by `STORAGE_PROVIDER`:

- `s3` — any S3-compatible bucket (AWS, Cloudflare R2, Backblaze B2, MinIO)
- `vercel-blob` — Vercel's blob store
- `local` — host filesystem (single-instance only; ephemeral on serverless)

For most deployments, an S3-compatible bucket (Cloudflare R2 is the cheapest at small scale) is the safest default — it works on every host and survives instance restarts.

---

## 2. Network and protocol requirements

### 2.1 Long-lived SSE streams

In plain terms: agent chats and workflow runs hold a single HTTP connection open for as long as the response takes — sometimes minutes. The host (and any proxy in front of it) must let that connection stay open without killing it or buffering the output.

Multiple endpoints stream Server-Sent Events for minutes at a time:

| Endpoint                                                                | Use                                           |
| ----------------------------------------------------------------------- | --------------------------------------------- |
| `app/api/v1/chat/stream/route.ts`                                       | Consumer chat streaming (tool calls + tokens) |
| `app/api/v1/embed/chat/stream/route.ts`                                 | Embedded widget chat                          |
| `app/api/v1/admin/orchestration/chat/stream/route.ts`                   | Admin chat                                    |
| `app/api/v1/admin/orchestration/workflows/[id]/execute-stream/route.ts` | Workflow execution event stream               |
| `app/api/v1/mcp/route.ts`                                               | Model Context Protocol session                |

**Host implications:**

- Function timeouts must accommodate the longest expected workflow. Defaults of 10–60 s will sever streams mid-response.
- Reverse proxies need `proxy_buffering off`, `proxy_http_version 1.1`, and `proxy_read_timeout` raised to several minutes.
- HTTP/1.1 keep-alive must survive idle gaps between events.
- Any CDN in front must allow `text/event-stream` to pass through unbuffered.

### 2.2 Outbound HTTP

Capabilities call out to LLM providers (OpenAI, Anthropic, others), Resend, S3, optional webhook receivers, and the optional `webhook` capability. See `.context/orchestration/external-calls.md`. Hosts behind strict egress firewalls must allow outbound 443.

### 2.3 Inbound webhooks and API keys

The MCP server (`/api/v1/mcp`), embed widget endpoints, and self-service API keys (`.context/orchestration/api-keys.md`) accept inbound traffic from third parties. CORS, rate limiting, and bearer-token auth are already in code; hosts only need to permit the inbound traffic.

---

## 3. Background work and scheduling

In plain terms: Sunrise doesn't run its own internal cron. Instead, it expects something external (your platform's cron feature, or `cron` on a Linux box) to send a POST request to two URLs on a schedule. That's it — those POSTs are what wake the scheduler up.

The scheduler is **stateless and pull-driven**:

| Endpoint                                       | Suggested cadence | Purpose                                                              |
| ---------------------------------------------- | ----------------- | -------------------------------------------------------------------- |
| `/api/v1/admin/orchestration/schedules/tick`   | Every minute      | `processDueSchedules()` — claims due cron schedules, fires workflows |
| `/api/v1/admin/orchestration/maintenance/tick` | Every 5–15 min    | Housekeeping (expiry, retries, cleanup)                              |

The endpoints are HTTP POSTs, idempotent within a tick window, and require admin/service auth. **Any host that can issue a `curl` on a cron** can drive this — Vercel Cron, Render Cron Jobs, Fly Machines cron, system `cron`, or a third-party pinger like cron-job.org. There is no in-process cron daemon, by design (`lib/orchestration/scheduling/scheduler.ts:7-13`).

The scheduler does **not** require a singleton instance — the optimistic-lock claim in `processDueSchedules()` makes it safe to fire from multiple ticks racing each other.

---

## 4. Deployment-time requirements

### 4.1 Migrations

In plain terms: when the database schema changes, you must apply that change to the production database before the new code starts serving traffic. The command is `prisma migrate deploy`. Where you put it differs per platform, but the rule is the same.

`prisma migrate deploy` must run **after `next build`, before traffic shifts**. The runtime image ships the Prisma CLI and `prisma/migrations/` so the same artifact serves both roles. See `.context/deployment/overview.md` for the per-platform mapping. Migrations are written to be backward-compatible so a partial rollout is safe.

### 4.2 Build-time environment variables

Several env vars are read during `next build` (env validation + `NEXT_PUBLIC_*` embedding):
`DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `NEXT_PUBLIC_APP_URL`. The Dockerfile passes these as `ARG`s; non-Docker hosts must supply them in the build environment, not just runtime.

### 4.3 Health checks

`GET /api/health` returns `{ status, services: { database } }` with HTTP 503 when the database is unreachable. Any health-checking infrastructure (load balancer, container orchestrator, external monitor) should target this endpoint.

---

## 5. Operational concerns specific to the agentic layer

| Concern                | Why it's specific to orchestration                                         | What to plan for                                                                                    |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Cost spikes            | LLM calls are billed per token; a runaway tool loop can burn budget fast   | Provider-side budget alarms in addition to in-app budget enforcement                                |
| Long execution windows | Autonomous orchestrator workflows can run for many minutes                 | Function-duration limits and proxy timeouts must clear the worst case                               |
| Memory under load      | Document ingestion (large PDFs, EPUBs) and `sharp` transforms spike RSS    | Right-size containers; watch OOM kills; consider a dedicated worker if you split it later           |
| Concurrency            | Multiple in-flight streams hold sockets and Node event-loop slots          | Plan max concurrent chats per instance; add instances before vertical limits hit                    |
| In-memory state        | Some state (LRU caches, scheduler claim windows) is per-instance           | Acceptable single-instance; for multi-instance, add Redis and use sticky sessions only where needed |
| Secrets surface        | Provider API keys, webhook signing keys, OAuth credentials all live in env | Use the host's secret manager; never commit `.env`                                                  |
| Observability          | LLM tool loops are hard to debug without trace context                     | `lib/logging` is already structured; pipe to Sentry (already integrated) or your log aggregator     |

---

## 6. Compare and contrast: realistic deployment targets

The four options below cover the full spectrum from "easiest, most opinionated" to "most control, most ops". Each is presented on its own merits.

The table scores each option against the requirements above. "OK" means supported with a small amount of configuration; "Yes" means natively supported with no friction; "No" means a blocker for the orchestration layer specifically.

| Capability                     | Vercel                                                  | Render                               | Fly.io                           | VPS + Laravel Forge            |
| ------------------------------ | ------------------------------------------------------- | ------------------------------------ | -------------------------------- | ------------------------------ |
| Long-lived Node process        | Function model                                          | Yes (Web Service)                    | Yes (Machines)                   | Yes                            |
| SSE > 5 min                    | Pro: 5 min cap; Fluid Compute extends but not unbounded | Yes                                  | Yes                              | Yes (proxy config)             |
| Scheduler ticks                | Vercel Cron                                             | Render Cron Job                      | `flyctl machine` cron / external | Forge Scheduled Job            |
| Postgres + `pgvector`          | Vercel Postgres (Neon)                                  | Render Postgres — pgvector available | Fly Postgres or external         | Install extension manually     |
| Persistent file storage        | No local FS — use Vercel Blob or S3                     | Render Disks or S3                   | Fly Volumes or S3                | Local disk OK + S3 recommended |
| Redis (optional)               | Upstash add-on                                          | Render Redis                         | Upstash / Fly Redis              | Native Redis                   |
| Native deps (`sharp`, parsers) | OK (bundle bloat)                                       | Yes                                  | Yes                              | Yes                            |
| Build memory headroom          | Pro tier needed for bigger builds                       | Configurable                         | Configurable                     | Depends on box                 |
| Preview deploys per PR         | Yes                                                     | Yes                                  | Manual via apps                  | No                             |
| Atomic / zero-downtime deploys | Yes (default)                                           | Yes                                  | Yes (rolling)                    | Manual (blue/green)            |
| Global edge / multi-region     | Yes                                                     | Single region per service            | Yes (anycast)                    | Single VPS                     |
| Marginal cost (small deploy)   | $20/mo Pro + DB                                         | $7–25/mo + DB                        | ~$5–15/mo + DB                   | $5–20/mo VPS + Forge $12/mo    |
| Lock-in                        | Function model + Blob                                   | Low — Docker / native                | Low — Docker images              | None — vanilla Linux           |
| Beginner friendliness          | Highest                                                 | High                                 | Moderate                         | Lowest                         |

### 6.1 Vercel

**Strengths.** Fastest path from repo to live URL. Connects to your Git provider and redeploys automatically on every push. Generates a unique preview URL for every pull request. Atomic rollbacks. Tightly integrated with Vercel Postgres (which is Neon under the hood and supports `pgvector`) and Vercel Blob (already supported by `lib/storage/providers/vercel-blob.ts`). Built-in Vercel Cron handles the tick endpoints with a single config block.

**Trade-offs.** Vercel runs your app as serverless functions, each with a maximum duration. On the Hobby plan this is 60 s; on Pro it's 5 minutes; "Fluid Compute" extends the streaming window but does not make it unbounded. Long autonomous orchestrator runs and large workflow execute-streams can be cut off mid-response. Document ingestion of very large PDFs can hit memory limits. The pricing climbs steeply if usage grows.

**Best fit.** Teams that want to ship fast and treat infrastructure as someone else's problem, with workflows that complete in under a few minutes.

### 6.2 Render

**Strengths.** Vercel-style developer experience (Git push deploys, preview environments, managed Postgres, managed Redis, managed cron) **without** the function model — your app runs as a normal long-lived web service, so SSE works without any timeout gymnastics. Render Postgres includes `pgvector`. Already has a step-by-step guide in `.context/deployment/platforms/render.md`.

**Trade-offs.** Single region per service — if you need users served from multiple geographies, you're stacking services. Pricing moves up faster than Fly at higher tiers. No built-in global edge.

**Best fit.** Teams that want managed convenience without serverless duration caps, and don't need multi-region.

### 6.3 Fly.io

**Strengths.** Reads the `Dockerfile` already in the repo and deploys it to small "Machines" (lightweight VMs) anywhere in the world. Persistent volumes, no function-duration cap, global anycast routing. Fly Postgres can be provisioned with `pgvector`. Good fit for stateful Node servers that hold sockets open. Pricing is competitive at the low end.

**Trade-offs.** Slightly more concept overhead than Render — you'll learn Machines, regions, and the `fly` CLI. Cron isn't first-class; you stitch it together with a tiny scheduled Machine, an external pinger like cron-job.org, or a co-located worker. Some operations (custom Postgres migrations, DB snapshots) lean on the CLI.

**Best fit.** Teams that want Docker-native deploys, geographic flexibility, and predictable pricing — and are willing to spend an hour learning the CLI.

### 6.4 VPS + Laravel Forge

**Strengths.** A VPS (a rented Linux server) gives you maximum control and the lowest marginal cost. Laravel Forge is a paid management UI ($12/mo) that provisions the VPS, installs nginx + supervisord + PostgreSQL + Redis + Let's Encrypt SSL + scheduled jobs, and ties them to a Git push deploy script. There are no function-duration caps because there are no functions — your app is just `node server.js` running under supervisord behind nginx. Forge is built around Laravel/PHP but works for any language; the Node setup just needs a custom deploy script and nginx vhost.

**Trade-offs.** This is the option with the most moving parts to understand. You will be:

- Picking and creating a VPS (DigitalOcean / Hetzner / Linode / Vultr)
- Editing Forge's deploy script to install Node 20, run `npm ci`, build, and run migrations
- Editing the nginx vhost so SSE streams aren't buffered (`proxy_buffering off`, raised `proxy_read_timeout`)
- Installing the `pgvector` extension on the system Postgres (`apt install postgresql-XX-pgvector`, then `CREATE EXTENSION vector` in the DB)
- Wiring two Forge Scheduled Jobs to `curl` the tick endpoints

No preview deploys per PR. Scaling is vertical (resize the VPS) until you put a load balancer in front and add Redis. **Forge is one of several VPS managers** — alternatives include Ploi, Cleavr, RunCloud, Coolify (open source), and Dokploy (open source). They differ in UI polish and pricing more than capability.

**Best fit.** Operators who want full control, are comfortable spending a half-day on first-time setup, or who already have a managed VPS workflow they like.

### 6.5 Getting started — what each path actually involves

For a reader who hasn't deployed before, the difference between platforms is mostly the **number of new things you have to learn at once**. Here is the honest count.

#### Vercel (≈30 minutes, ≈0 new concepts)

1. Push the repo to GitHub.
2. Sign up at vercel.com and click "Import Project". Pick the repo.
3. In the project settings, set the build command to `npm run build && npm run db:migrate:deploy`.
4. Provision a database: in Vercel's Storage tab, click "Create Postgres" — it auto-fills `DATABASE_URL`. Or paste a connection string from Neon / Supabase.
5. Add the other env vars from `.env.example` (`BETTER_AUTH_SECRET`, etc.).
6. Add a Vercel Cron entry hitting the two tick endpoints.
7. Push to `main`. It deploys.

You do not need to know what nginx, Docker, or supervisord are.

#### Render (≈45 minutes, ≈0 new concepts)

1. Push the repo to GitHub.
2. Sign up at render.com, create a "Web Service" pointed at the repo. Render auto-detects Next.js.
3. Create a managed Postgres from Render's dashboard, copy the internal connection string into `DATABASE_URL`.
4. Set the pre-deploy command to `npm run db:migrate:deploy`.
5. Add env vars.
6. Create two "Cron Jobs" hitting the tick endpoints.
7. Push to `main`. It deploys.

#### Fly.io (≈1–2 hours, 1 new concept: the `fly` CLI)

1. Install the `fly` CLI on your laptop (`brew install flyctl` on a Mac).
2. Run `fly launch` in the repo. It reads the `Dockerfile`, asks a few questions, generates a `fly.toml`.
3. Run `fly postgres create` to provision a Postgres app; attach it. Enable `pgvector` (`fly pg connect`, then `CREATE EXTENSION vector`).
4. Set env vars with `fly secrets set KEY=value`.
5. Run `fly deploy`.
6. For cron, the simplest path is an external pinger (cron-job.org) hitting the two tick endpoints. Or schedule a small machine.

You'll learn the CLI but you don't need to manage a server.

#### VPS + Forge (≈half a day, 4–5 new concepts: SSH, nginx, systemd/supervisord, apt, cron)

1. Pick a VPS provider (DigitalOcean is the gentlest first time). Create an account.
2. Sign up for Forge and connect it to your VPS provider's API. Click "Create Server".
3. Once provisioned, create a "Site" pointed at your domain.
4. **Install Node 20** on the server (Forge defaults are older). Either pick the Node version in Forge's UI or SSH in and use `nvm`.
5. **Install pgvector** on the Postgres Forge installed: SSH in, `sudo apt install postgresql-15-pgvector`, then connect to the DB and `CREATE EXTENSION vector`.
6. Edit Forge's **deploy script** so it pulls Git, runs `npm ci`, builds, runs `npm run db:migrate:deploy`, and signals the daemon to restart.
7. Add a Forge **Daemon** running `node .next/standalone/server.js` from the deploy directory.
8. Edit Forge's **nginx vhost** to proxy to `127.0.0.1:3000` with `proxy_buffering off` and `proxy_read_timeout 300s`.
9. Click Forge's **SSL** button (Let's Encrypt).
10. Add two Forge **Scheduled Jobs** running `curl -fsS -X POST -H "Authorization: Bearer $TOKEN" https://yourdomain/api/v1/admin/orchestration/schedules/tick` (and the maintenance one).
11. Set env vars in Forge's "Environment" tab.

This is the most rewarding path if you want to learn how a server actually works. It is the most painful if you don't.

### 6.6 How Claude can help

If you're new to deployment, the realistic pattern is "pick a platform, then ask Claude to generate the platform-specific bits". Concrete things that work well:

- **"Generate the Forge deploy script for this repo, including Node 20 install via nvm, npm ci, build, prisma migrate deploy, and a graceful daemon restart."** Claude can read the `package.json`, `Dockerfile`, and existing scripts and produce a script you paste into Forge's UI.
- **"Write the nginx vhost block for this app, with SSE-safe settings."** Output you paste into Forge's Edit Files / nginx UI.
- **"Generate a `fly.toml` for this repo with sensible defaults for a small Machine, plus the `fly secrets set` commands I need to run."**
- **"Walk me through enabling `pgvector` on Render Postgres / Fly Postgres / a Forge-managed Postgres."**
- **"Produce a checklist of every env var I need from `.env.example`, grouped by required / optional, with one-line descriptions."**
- **"Wire up the two scheduler tick endpoints with bearer-token auth so my cron job can call them safely."** Claude can generate the auth check, the env var wiring, and the cron command.
- **"Compare what my deploy will cost on Vercel, Render, Fly, and DigitalOcean for ~10k chats/month."**
- **"Review my Dockerfile / nginx config / deploy script and tell me what would break under load or during an SSE stream."**

Two rules of thumb when working with Claude on deploys:

1. **Show, don't tell.** Paste the actual output of the failing command, the actual nginx config, the actual env var dump (with secrets redacted). Claude reasons better from artifacts than from descriptions.
2. **Ask for the smallest reversible step first.** "Write the deploy script" is fine. "Deploy it to production" is not — run the script yourself, see what breaks, paste the error.

---

## 7. Quick decision guide

Pick by the constraint that hurts most:

| If your top constraint is…                                        | Pick                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| "I'm new to deployment and want the fewest moving parts"          | Vercel                                                                     |
| "Managed convenience without serverless duration caps"            | Render                                                                     |
| "Docker-native, predictable pricing, geographic flexibility"      | Fly.io                                                                     |
| "Maximum control, lowest marginal cost, willing to learn servers" | VPS + Forge (or Ploi / Coolify / similar)                                  |
| "Self-hosted with maximum control and the docs already cover it"  | Docker self-hosted (`.context/deployment/platforms/docker-self-hosted.md`) |
| "Long agent runs that take many minutes are core to my use case"  | Render, Fly.io, or VPS — avoid Vercel                                      |
| "Preview deploys per PR are non-negotiable"                       | Vercel or Render                                                           |

The orchestration layer punishes hosts that cap function duration aggressively or hide the proxy from you. It rewards hosts that let you run a real Node process, pin a Postgres with pgvector, and `curl` a URL on a cron. Every option above qualifies — they differ in how much of that you assemble yourself versus how much the platform does for you.
