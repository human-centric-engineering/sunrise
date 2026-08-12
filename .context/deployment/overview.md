# Deployment Overview

Choose a deployment platform and follow its guide. This document helps you decide which platform fits your needs.

## Choose Your Platform

| Platform                                         | Best For                                         | Setup Time | Cost     |
| ------------------------------------------------ | ------------------------------------------------ | ---------- | -------- |
| [Vercel](./platforms/vercel.md)                  | Fastest deployment, zero config, preview deploys | 5-10 min   | Free-$$$ |
| [Railway](./platforms/railway.md)                | Developer-friendly, built-in PostgreSQL          | 10-15 min  | $5/mo+   |
| [Render](./platforms/render.md)                  | Good free tier, simple setup                     | 10-15 min  | Free-$   |
| [Self-Hosted](./platforms/docker-self-hosted.md) | Full control, privacy, cost optimization         | 30-60 min  | $5-50/mo |

**Quick Decision:**

- **Just want it deployed?** → Vercel
- **Need database included?** → Railway
- **Budget-conscious?** → Render (free tier)
- **Need full control?** → Self-hosted Docker

## Development with Docker

```bash
docker-compose up    # Starts dev environment with hot-reload
```

- **Dockerfile.dev** includes Python3/make/g++ for native module compilation (bcrypt, sharp)
- Source code mounted as volume — changes trigger hot-reload automatically
- Use `db` as hostname instead of `localhost` for database connections

**When to use:**

| Approach         | Best For                                                |
| ---------------- | ------------------------------------------------------- |
| `docker-compose` | Consistent environment, team onboarding, CI parity      |
| `npm run dev`    | Faster iteration, no Docker overhead, simpler debugging |

## Architecture

**Development:**

```
localhost:3000 → Next.js Dev Server → PostgreSQL
```

**Production:**

```
Internet → HTTPS → [Reverse Proxy] → Next.js Container → PostgreSQL
```

## Migration Strategy

Single production command: `prisma migrate deploy` (exposed as `npm run db:migrate:deploy`). It runs **before traffic shifts**, never during Docker build (no DB exists) and never concurrent with app startup (replica race).

| Platform             | How migrations run                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Docker (self-hosted) | `migrator` compose service (build target `migrator`) runs once; `web` waits via `service_completed_successfully`                                                                                 |
| Vercel               | Build command: `npm run build && npm run db:migrate:deploy`                                                                                                                                      |
| Render               | **Not** the Pre-Deploy Command — migrate from CI, then fire a Deploy Hook. See [render.md](platforms/render.md)                                                                                  |
| Railway              | **Not** the Pre-Deploy Command — `railway run npm run db:migrate:deploy`. See [railway.md](platforms/railway.md)                                                                                 |
| Fly.io               | **Not** `release_command` — `fly proxy` + migrate, or from CI                                                                                                                                    |
| CI                   | `.github/workflows/ci.yml` runs `db:migrate:deploy` + `db:seed` against a Postgres service; the `docker` job additionally proves the real `migrator` image applies them inside the compose stack |

**The runtime image does not contain the Prisma CLI.** It carries only Next's
standalone trace, so the CLI, the schema, the migrations and `prisma.config.ts`
are all absent, and `npx prisma …` / `npm run db:migrate:deploy` fail inside the
`web` container (with a message pointing at the migrator, not a bare
`command not found`).
Migrations run from a separate deploy-time image built from the `migrator`
target of the same `Dockerfile`. The CLI's dependency closure is 133 packages /
~240 MB — Prisma Studio, a WASM Postgres, a charting stack — none of which
belongs in a process serving HTTP, and the hand-maintained partial copy that
used to approximate it never actually worked (#583).

**Any platform whose migration hook runs _inside_ the deployed container must
therefore migrate from somewhere else.** The portable recipe, which is faithful
because it runs the same image, the same CLI version and the same migration
files as the self-hosted path:

```yaml
- name: Apply migrations
  run: |
    docker build --target migrator -t sunrise-migrator:deploy .
    docker run --rm -e DATABASE_URL="${{ secrets.PROD_DATABASE_URL }}" sunrise-migrator:deploy
- name: Trigger deploy
  run: curl -fsS -X POST "${{ secrets.PLATFORM_DEPLOY_HOOK }}"
```

If you would rather not run Docker in CI, `npm ci && npx prisma migrate deploy`
on the runner with `DATABASE_URL` pointed at production does the same job.

**Gate this on `push` to a protected branch, or a protected environment — never
`pull_request_target`.** Either form hands the production `DATABASE_URL` to
whatever code is in the checkout, and a migration file (or an `npm ci`
postinstall) can run arbitrary SQL. That is inherent to migrating from CI on
any platform; the protection is controlling which commits can reach the job.

Authoring discipline lives in [`database/migrations.md`](../database/migrations.md) — always write backward-compatible migrations so a deploy that fails partway leaves the old code compatible with the new schema.

## CI/CD Integration

For self-hosted Docker deploys, the compose file handles migrations automatically:

```yaml
- name: Deploy
  run: |
    # --wait is load-bearing: plain `up -d` returns as soon as the containers
    # are started, so a health check on the next line races Next's boot and
    # fails on a perfectly good deploy. --wait blocks until web reports healthy
    # (or the migrator fails, which keeps web down and fails the step).
    docker compose -f docker-compose.prod.yml up -d --build --wait
    curl -fsS http://localhost:3000/api/health
```

Run the health check from the host. `node:24-alpine` ships no `curl`, so
`exec -T web curl …` fails whatever the app is doing; inside the container the
equivalent is `wget -qO- http://localhost:3000/api/health`.

Vercel migrates in its build command. Render, Railway and Fly.io **cannot** use their pre-deploy / release hooks — those run inside the deployed image — so each platform guide documents the alternative.

## Health Checks

All deployments should monitor `/api/health`.

**Response structure:**

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600,
  "timestamp": "2024-01-15T10:30:00.000Z",
  "services": {
    "database": {
      "status": "operational",
      "connected": true,
      "latency": 5
    }
  }
}
```

**Service status values:**

| Status        | Meaning                      |
| ------------- | ---------------------------- |
| `operational` | Service healthy              |
| `degraded`    | High latency (> 500ms)       |
| `outage`      | Service unavailable or error |

**HTTP status codes:**

- `200` — All services operational
- `503` — Database connection failed

**Memory stats (optional):**

Set `HEALTH_INCLUDE_MEMORY=true` to include memory usage in response. Disabled by default for security (avoids exposing server internals).

**Recommended monitoring:** UptimeRobot, Pingdom, or platform-native health checks.

## Security Checklist

Before going live:

- [ ] Strong `BETTER_AUTH_SECRET` (32+ characters)
- [ ] SSL/HTTPS enabled
- [ ] Environment variables not in git
- [ ] `LOG_SANITIZE_PII=true` for GDPR/CCPA compliance (redacts emails, names, IPs in logs)
- [ ] Database backups configured
- [ ] Rate limiting enabled
- [ ] Storage provider configured (if using file uploads)
- [ ] Health monitoring set up

## Related Documentation

- [Environment Variables](../environment/overview.md) - Configuration reference
- [Architecture Decisions](../architecture/decisions.md) - Why Docker, migrations strategy
- [Security](../security/overview.md) - Headers, CORS, rate limiting
