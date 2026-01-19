# Deployment Overview

**Domain**: Deployment & Infrastructure
**Last Updated**: 2025-12-19
**Status**: Production-ready Docker setup complete

## Purpose

This document provides deployment strategies for Sunrise across various platforms, from managed services to self-hosted solutions. Focus is on Docker-based deployments using the production-optimized configuration.

## Quick Start

### Prerequisites

- Docker configured in project root (✅ Phase 1.8 complete)
- Environment variables configured (see `.env.example`)
- Database migrations ready to run

### Fastest Deployment Options

**1. Vercel (Recommended for simplicity)**

```bash
git push origin main
# Import repo at vercel.com - auto-deploys
```

**2. Railway/Render (Docker-based)**

```bash
git push origin main
# Connect repo in platform dashboard
# Platform detects Dockerfile and auto-deploys
```

**3. Self-Hosted Docker**

```bash
cp .env.example .env
# Edit .env with production values
docker-compose -f docker-compose.prod.yml up -d --build
docker-compose -f docker-compose.prod.yml exec web npx prisma migrate deploy
```

## Deployment Architecture

### Development (Local)

```
Developer → localhost:3000 → Next.js Dev Server → PostgreSQL
                              (Hot Reload)
```

### Production (Docker)

```
Internet → Port 443/80 → [Optional: Nginx] → Next.js Container → PostgreSQL
           (HTTPS)        (Reverse Proxy)     (Port 3000)         (Container)
```

## Platform Comparison

| Platform        | Setup         | Cost          | Best For                        |
| --------------- | ------------- | ------------- | ------------------------------- |
| **Vercel**      | 1-click       | Free-$$$      | Fastest deployment, zero config |
| **Railway**     | GitHub import | $5/mo         | Developer-friendly, includes DB |
| **Render**      | GitHub import | Free-$        | Good free tier                  |
| **Fly.io**      | CLI           | Pay-as-you-go | Global edge, performance        |
| **Self-Hosted** | Manual        | $5-50/mo      | Full control, privacy           |

## Docker Configuration Files

All files in project root:

- **`Dockerfile`** - Production build (multi-stage, ~150-200MB)
- **`Dockerfile.dev`** - Development build (with hot-reload)
- **`docker-compose.yml`** - Development environment
- **`docker-compose.prod.yml`** - Production stack
- **`nginx.conf`** - Optional reverse proxy
- **`.dockerignore`** - Build optimization

## Production Deployment Workflow

### Initial Deployment

**Step 1: Prepare Environment**

```bash
cp .env.example .env
# Edit with production credentials:
# - BETTER_AUTH_SECRET (openssl rand -base64 32)
# - DATABASE_URL (production database)
# - BETTER_AUTH_URL (your domain)
```

**Step 2: Build and Start**

```bash
docker-compose -f docker-compose.prod.yml up -d --build
```

**Step 3: Run Migrations** (REQUIRED)

```bash
docker-compose -f docker-compose.prod.yml exec web npx prisma migrate deploy
```

**Step 4: Verify**

```bash
curl http://localhost:3000/api/health
# Expected: {"status":"ok","database":{"connected":true}}
```

### Subsequent Deployments

```bash
git pull
docker-compose -f docker-compose.prod.yml up -d --build
docker-compose -f docker-compose.prod.yml exec web npx prisma migrate deploy
```

## Migration Strategy

**Why migrations aren't in Dockerfile:**

- Database doesn't exist during `docker build`
- Migrations modify state, not build artifacts
- Industry standard: migrations run as deployment step

**When migrations run:**

- Development: `docker-compose exec web npx prisma migrate dev`
- Production: `docker-compose exec web npx prisma migrate deploy`
- CI/CD: Automated step after container starts

**Migration files are included in image:**

- ✅ `prisma/migrations/` copied during build
- ✅ `prisma migrate deploy` command available
- ❌ Execution happens at deployment, not build time

## Environment Variables

### Required (Production)

```bash
DATABASE_URL="postgresql://user:pass@db:5432/sunrise"
BETTER_AUTH_URL="https://yourdomain.com"
BETTER_AUTH_SECRET="<32+ character secret>"
NEXT_PUBLIC_APP_URL="https://yourdomain.com"
NODE_ENV="production"
```

### Optional (Phase 3+)

```bash
GOOGLE_CLIENT_ID="<oauth-id>"
GOOGLE_CLIENT_SECRET="<oauth-secret>"
RESEND_API_KEY="<email-api-key>"
EMAIL_FROM="noreply@yourdomain.com"
```

### Docker-Specific (docker-compose.prod.yml)

```bash
DB_USER="postgres"
DB_PASSWORD="<secure-password>"
DB_NAME="sunrise"
```

## Platform-Specific Guides

Detailed deployment guides for each platform:

| Platform        | Guide                                                                | Best For                                   |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| **Vercel**      | [platforms/vercel.md](./platforms/vercel.md)                         | Zero-config, automatic preview deployments |
| **Railway**     | [platforms/railway.md](./platforms/railway.md)                       | Developer-friendly, built-in PostgreSQL    |
| **Render**      | [platforms/render.md](./platforms/render.md)                         | Good free tier, simple setup               |
| **Self-Hosted** | [platforms/docker-self-hosted.md](./platforms/docker-self-hosted.md) | Full control, privacy, VPS/cloud VM        |

### Quick Platform Notes

**Vercel**

- No Docker needed (uses Next.js build directly)
- Auto-detects Next.js and configures everything
- Add DATABASE_URL in dashboard environment variables

**Railway/Render**

- Auto-detects Dockerfile
- Built-in database provisioning available
- Environment variables via dashboard

**Fly.io**

- Requires `fly.toml` configuration
- Use `flyctl launch` for initial setup
- Secrets via `flyctl secrets set`

**Self-Hosted**

- Nginx reverse proxy recommended for SSL
- Let's Encrypt for free SSL certificates
- Set up monitoring and backups

## Health Checks

**Endpoint:** `/api/health`

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2025-12-19T...",
  "database": {
    "connected": true,
    "latency": 5
  }
}
```

**Docker Health Check** (in Dockerfile):

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', ...)"
```

## Troubleshooting

### Database Connection Failed

**Symptom:** "relation does not exist" or connection errors
**Solution:**

1. Verify `DATABASE_URL` format
2. Ensure database container is healthy: `docker-compose ps`
3. Run migrations: `docker-compose exec web npx prisma migrate deploy`

### Environment Variables Not Working

**Symptom:** App can't read env vars
**Solution:**

- `NEXT_PUBLIC_*` vars are embedded at build time - rebuild after changes
- Server vars are runtime - restart container
- Check `.env` file is loaded in docker-compose.prod.yml

### Port Already in Use

**Symptom:** "port 3000 already allocated"
**Solution:** Stop local dev server or change port mapping in docker-compose.yml

### Image Size Too Large

**Symptom:** Docker image > 500MB
**Solution:** Verify `.dockerignore` excludes `node_modules`, `.next`, etc.

## Security Checklist

Before production deployment:

- [ ] Strong `BETTER_AUTH_SECRET` (32+ characters)
- [ ] SSL/HTTPS enabled
- [ ] Environment variables not committed to git
- [ ] Database backups configured
- [ ] Security headers enabled (in `next.config.js`)
- [ ] Rate limiting configured
- [ ] CORS properly configured
- [ ] Health check endpoint working
- [ ] Monitoring/error tracking set up

## Performance Optimization

**Image Size:**

- Production image: ~150-200MB (with standalone output)
- Development image: ~800MB-1GB (includes dev tools)

**Build Time:**

- First build: 3-5 minutes
- Cached rebuild: 30-60 seconds

**Startup Time:**

- Cold start: 10-20 seconds
- Warm restart: 5-10 seconds

## CI/CD Integration

**GitHub Actions Example:**

```yaml
- name: Deploy to Production
  run: |
    docker-compose -f docker-compose.prod.yml up -d --build
    docker-compose -f docker-compose.prod.yml exec -T web npx prisma migrate deploy
    docker-compose -f docker-compose.prod.yml exec -T web curl -f http://localhost:3000/api/health
```

**Note:** Use `-T` flag for non-interactive environments (CI/CD).

## Monitoring Recommendations

**Essential:**

- Uptime monitoring (UptimeRobot, Pingdom)
- Error tracking (Sentry)
- Health endpoint checks

**Optional:**

- Performance monitoring (Vercel Analytics)
- Log aggregation (Logflare, Papertrail)
- Server metrics (Netdata for self-hosted)

## Related Documentation

- [Architecture](../architecture/overview.md) - System design and component boundaries
- [Database](../database/migrations.md) - Migration workflow details
- [Environment](../environment/overview.md) - Environment variable configuration
- [API](../api/headers.md) - CORS and security headers

## Decision History

**Docker as Primary Deployment Method**

- **Decision:** Docker-first with multi-stage builds
- **Rationale:** Platform-agnostic, reproducible, optimized for production
- **Trade-offs:** Slightly more complex than platform-specific builds, but maximizes portability

**Nginx as Optional**

- **Decision:** Include nginx.conf but mark as optional
- **Rationale:** Most platforms provide load balancers; nginx only needed for self-hosted
- **Trade-offs:** Additional configuration for self-hosted setups

**Migrations as Deployment Step**

- **Decision:** Run migrations after container starts, not during build
- **Rationale:** Database doesn't exist during build; industry standard pattern
- **Trade-offs:** Requires explicit migration step in deployment workflow
