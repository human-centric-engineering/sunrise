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

Migrations run **at deployment time**, not during Docker build:

```bash
# After container starts
docker compose -f docker-compose.prod.yml exec web npx prisma migrate deploy
```

**Why?** Database doesn't exist during build. Migration files are included in the image; execution happens when you deploy.

See [Architecture Decisions](../architecture/decisions.md#database-migrations-at-deploy-time) for rationale.

## CI/CD Integration

**GitHub Actions example:**

```yaml
- name: Deploy
  run: |
    docker compose -f docker-compose.prod.yml up -d --build
    docker compose -f docker-compose.prod.yml exec -T web npx prisma migrate deploy
    docker compose -f docker-compose.prod.yml exec -T web curl -f http://localhost:3000/api/health
```

Use `-T` flag for non-interactive CI environments.

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
