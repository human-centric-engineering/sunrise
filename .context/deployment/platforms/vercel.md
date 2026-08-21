# Vercel Deployment Guide

**Platform:** Vercel
**Best For:** Fastest deployment, zero configuration, automatic preview deployments
**Estimated Setup Time:** 5-10 minutes

## Prerequisites

- Vercel account ([vercel.com](https://vercel.com))
- GitHub, GitLab, or Bitbucket repository with your Sunrise project
- PostgreSQL database (Vercel Postgres or external provider)

## Deployment Steps

### 1. Import Project

1. Go to [vercel.com/new](https://vercel.com/new)
2. Click "Import Git Repository"
3. Select your Sunrise repository
4. Vercel auto-detects Next.js and configures everything

### 2. Configure Environment Variables

In Vercel dashboard > Project Settings > Environment Variables, add:

**Required:**

```
DATABASE_URL=postgresql://user:password@host:5432/dbname
DATABASE_POOL_MAX=1
BETTER_AUTH_SECRET=<generate with: openssl rand -base64 32>
BETTER_AUTH_URL=https://your-project.vercel.app
NEXT_PUBLIC_APP_URL=https://your-project.vercel.app
```

`DATABASE_POOL_MAX=1` is not optional on Vercel in practice. It defaults to 10,
which is right for one long-running server but wrong here: every warm function
instance holds its own pool, so a few dozen instances exhaust the database's
connection limit. Set it to 1 **and** point `DATABASE_URL` at a pooled endpoint
(see Database Setup below) — the pooler multiplexes, so one connection per
instance is plenty. See
[database-env.md](../../environment/database-env.md#database_pool_max).

**`MCP_SESSION_MODE` is the same shape of problem, and needs no setting** — its
default (`stateless`) is already the correct value here. It is worth knowing why,
because the failure it prevents looks like something else entirely.

MCP sessions were held in a per-process `Map`. On Vercel, `initialize` mints a
session on one instance and the client's next call is load-balanced to another,
which looks that id up in its own empty map and returns `404 Session not found or
expired` — so the handshake fails intermittently and reads as session expiry. No
client retry recovers it, because the session is not lost, it is invisible to
live siblings. In stateless mode no session id is issued and there is nothing to
look up.

If you deliberately set `MCP_SESSION_MODE=stateful` here **the build fails** —
during _Collecting page data_, with that explanation. Two things worth knowing
about that guard. It fails the **whole app**, not just MCP: the check sits at
module scope in a file the MCP barrel re-exports, and seven non-MCP admin routes
reach that barrel transitively, so the deploy fails even with the MCP server
switched off in the database. And it only catches platforms that announce
themselves via `VERCEL` or `AWS_LAMBDA_FUNCTION_NAME` — a multi-replica container
deploy elsewhere hits the identical bug undetected. See
[mcp.md](../../orchestration/mcp.md#session-model--mcp_session_mode).

**Optional (for email):**

```
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@yourdomain.com
```

**Optional (for OAuth):**

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

**Optional (for file uploads):**

```
STORAGE_PROVIDER=vercel-blob  # Options: s3, vercel-blob, local
# See .env.example for full S3/Vercel Blob configuration
```

### 3. Database Setup

**Option A: Vercel Postgres (Recommended)**

1. In Vercel dashboard, go to Storage
2. Create a new Postgres database
3. Connect to your project
4. Environment variables are auto-populated

**Option B: External Database (Supabase, Neon, Railway)**

1. Create database on your provider
2. Copy the **pooled** connection string to `DATABASE_URL` — Neon's `-pooler`
   host, Supabase's port `:6543`, or your own PgBouncer in transaction mode.
   The direct endpoint will run out of connections under load.
3. Ensure SSL is enabled for production

### 4. Configure Migrations

In Vercel dashboard > Project Settings > General > **Build Command**, override the default with:

```
npm run build && npm run db:migrate:deploy
```

This runs `prisma migrate deploy` after `next build` succeeds but before the deployment is promoted — so the DB schema is always ahead of (or equal to) the code serving traffic. Write backward-compatible migrations so a partial failure between build and promotion is safe.

**Why not `postbuild`?** `postbuild` fires inside `npm run build`, which also runs in CI and Docker builds — neither has a real production `DATABASE_URL`. Using Vercel's build command keeps the migration scoped to actual deployments.

### 5. Deploy

Push to your connected branch (usually `main`):

```bash
git push origin main
```

Vercel automatically builds and deploys.

## Vercel-Specific Configuration

### Build Settings (Auto-Detected)

- **Framework Preset:** Next.js
- **Build Command:** `npm run build`
- **Output Directory:** `.next`
- **Install Command:** `npm install`

### Node.js Version (handled by `engines`, no dashboard change needed)

Vercel is the one deployment target that does not build from this repo's
`Dockerfile`, so it never sees `node:24-alpine` and does not read `.nvmrc`.

It does read `engines.node`, and that **overrides** the dashboard:

> "You can define the major Node.js version in the `engines#node` section of the
> `package.json` to override the one you have selected in the Project Settings"
> — [Vercel: supported Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)

`package.json` declares `>=24`, which Vercel resolves to the **latest 24.x**.
So a project whose dashboard still says 20.x deploys on 24 anyway, and there is
nothing to change after syncing this repo.

The corollary is the part worth knowing: **the dashboard value is not the truth
on this platform.** Pinning 20.x under Settings → Build and Deployment →
Node.js Version will not give you 20.x while `engines.node` says `>=24` — it
will quietly keep deploying 24, and the setting will read back as though it took
effect. If you genuinely need a different major, change `engines.node`; the
version-consistency check (`npm run check:node-version`) will then require the
Dockerfiles, `.nvmrc` and the `@types/node` devDependency to move with it — five
declarations in four files, all of which must agree. `@types/node` is in that
set because it is what `tsc` type-checks against: ahead of the runtime it
accepts APIs that throw in production and reports nothing (#584). Moving it also
means updating its Dependabot `ignore` entry.

To confirm what a deployment actually ran, log `process.version` or run
`node -v` in the build command.

### Function Configuration (vercel.json)

Create `vercel.json` in your project root only if you need custom function configuration (e.g., longer timeouts). This file is **not included** in the starter template — Vercel auto-detects Next.js settings by default.

See [Vercel Project Configuration](https://vercel.com/docs/projects/project-configuration) for the full schema reference.

**Example configuration for longer API timeouts:**

```json
{
  "functions": {
    "app/api/**/*.ts": {
      "maxDuration": 30
    }
  }
}
```

### Preview Deployments

Every pull request gets a unique preview URL automatically.

### Health Monitoring

Vercel handles infrastructure health monitoring automatically. The `/api/health` endpoint can be used with external monitoring services (UptimeRobot, Pingdom, Better Uptime) for application-level health checks and alerting.

## Verifying Deployment

1. Check deployment status in Vercel dashboard
2. Visit `https://your-project.vercel.app/api/health`
3. Expected response:
   ```json
   {
     "status": "ok",
     "version": "1.0.0",
     "services": {
       "database": { "status": "operational", "connected": true }
     }
   }
   ```
   **Note:** `services.database.status` is `operational`, `degraded`, or `outage`. Returns HTTP 503 on database failure.

## Common Issues

### Database Connection Fails

- Ensure `DATABASE_URL` uses SSL (`?sslmode=require`)
- Verify database allows connections from Vercel IPs
- Check connection string format

### Build Timeout

- Free tier has 45s timeout; Pro has 5 minutes
- Check for slow dependencies
- **Do not enable `output: 'standalone'` for Vercel.** Vercel builds its own
  serverless output and does not use it; `next.config.js` deliberately switches
  it off when `process.env.VERCEL` is set (see below)

### Build Fails With `ENOENT: .next/next-server.js.nft.json`

Caused by `output: 'standalone'` being active on Vercel. From Next 16.3.0,
Turbopack stops emitting `next-server.js.nft.json` when a deployment adapter is
driving the build, on the grounds that adapters do not read it
([vercel/next.js#93684](https://github.com/vercel/next.js/pull/93684)).
Standalone output _does_ read it, so the combination fails at
`onBuildComplete` ([#93915](https://github.com/vercel/next.js/pull/93915)).

The build succeeds locally, which makes this confusing to diagnose: with no
adapter present, Next still generates the file, so `npm run build` on a laptop
never reproduces it.

`next.config.js` already handles this by setting `output` to `undefined` when
`VERCEL` is set. If you fork and hardcode `output: 'standalone'` back, expect
this error on Vercel while Docker keeps working.

### Environment Variables Not Loading

- `NEXT_PUBLIC_*` vars are embedded at build time - redeploy after changes
- Verify variables are set for correct environment (Production/Preview/Development)

### Migrations Not Running

- Verify Build Command in Vercel is `npm run build && npm run db:migrate:deploy`
- Or run manually: `vercel env pull .env.local && npx prisma migrate deploy`

## Cost Considerations

| Tier   | Price     | Includes                           |
| ------ | --------- | ---------------------------------- |
| Hobby  | Free      | Personal projects, 100GB bandwidth |
| Pro    | $20/month | Team features, 1TB bandwidth       |
| Vercel | Custom    | Postgres from $0.10/GB             |

## Related Documentation

- [Vercel Next.js Docs](https://vercel.com/docs/frameworks/nextjs)
- [Vercel Postgres](https://vercel.com/docs/storage/vercel-postgres)
- [Environment Variables](https://vercel.com/docs/environment-variables)
