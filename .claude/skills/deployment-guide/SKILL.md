---
name: deployment-guide
version: 1.0.0
description: |
  Deployment guide generator for Sunrise. Creates platform-specific deployment
  documentation with environment variable checklists, database setup, and
  troubleshooting guides. Use when deploying to new platforms or updating deployment docs.

triggers:
  - 'deploy to vercel'
  - 'railway deployment'
  - 'self-hosted setup'
  - 'create deployment guide'
  - 'docker production'
  - 'how to deploy'

contexts:
  - 'Dockerfile'
  - 'docker-compose*.yml'
  - '.context/deployment/'
  - 'next.config.js'
  - '.env.example'

mcp_integrations:
  next_devtools: true
---

# Deployment Guide Skill - Overview

## Mission

You are a deployment specialist for Sunrise. Your role is to generate platform-specific deployment documentation, environment variable checklists, and troubleshooting guides for various hosting platforms.

**CRITICAL:** Always verify the platform's current documentation for any recent changes to deployment processes.

## Supported Platforms

| Platform          | Type          | Docker   | Database     | Difficulty |
| ----------------- | ------------- | -------- | ------------ | ---------- |
| Vercel            | Serverless    | No       | External     | Easy       |
| Railway           | PaaS          | No       | Built-in     | Easy       |
| Render            | PaaS          | Optional | Built-in     | Easy       |
| Fly.io            | Container     | Yes      | External     | Medium     |
| DigitalOcean      | VPS/Container | Yes      | External     | Medium     |
| AWS (ECS/Fargate) | Container     | Yes      | RDS          | Hard       |
| Self-hosted       | VPS           | Yes      | Self-managed | Medium     |

## 4-Step Deployment Workflow

### Step 1: Pre-Deployment Checklist

**For ALL deployments:**

- [ ] Environment variables documented
- [ ] Database accessible from deployment platform
- [ ] `npm run build` succeeds locally
- [ ] `npm run validate` passes
- [ ] All tests pass
- [ ] Secrets are not in repository

**Environment Variables Required:**

```bash
# Database (Required)
DATABASE_URL="postgresql://user:password@host:5432/database"

# Authentication (Required)
BETTER_AUTH_SECRET="minimum-32-character-secret"
BETTER_AUTH_URL="https://your-domain.com"
NEXT_PUBLIC_APP_URL="https://your-domain.com"

# OAuth (Optional)
GOOGLE_CLIENT_ID="your-client-id"
GOOGLE_CLIENT_SECRET="your-client-secret"

# Email (Required for production)
RESEND_API_KEY="re_..."
EMAIL_FROM="noreply@your-domain.com"

# Environment
NODE_ENV="production"
```

### Step 2: Platform-Specific Setup

See templates below for each platform.

### Step 3: Database Migration

**After deployment, run migrations:**

```bash
# For container platforms with shell access
npx prisma migrate deploy

# For Vercel (use build command)
# Add to build: "prisma generate && prisma migrate deploy && next build"
```

### Step 4: Verification

**Post-deployment checks:**

1. Visit `/api/health` - should return `{ "status": "ok" }`
2. Test signup/login flow
3. Check error tracking (if configured)
4. Verify email sending (if configured)

## Platform Templates

### Vercel (Recommended for Simplicity)

**Setup:**

1. Push code to GitHub/GitLab
2. Import project in Vercel dashboard
3. Add environment variables
4. Deploy

**Environment Variables:**

```
DATABASE_URL=postgresql://...
BETTER_AUTH_SECRET=...
BETTER_AUTH_URL=https://your-project.vercel.app
NEXT_PUBLIC_APP_URL=https://your-project.vercel.app
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
RESEND_API_KEY=...
EMAIL_FROM=noreply@your-domain.com
```

**Build Settings:**

- Build Command: `prisma generate && prisma migrate deploy && npm run build`
- Output Directory: `.next`
- Install Command: `npm install`

**Database Options:**

- Vercel Postgres (built-in)
- Neon (serverless PostgreSQL)
- Supabase
- PlanetScale (MySQL - would need schema changes)

---

### Railway

**Setup:**

1. Create new project from GitHub
2. Add PostgreSQL service
3. Railway auto-detects Next.js

**Environment Variables:**

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
BETTER_AUTH_SECRET=your-secret
BETTER_AUTH_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
NEXT_PUBLIC_APP_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
```

**railway.json:**

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npm run start",
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE"
  }
}
```

**Database:** Railway provisions PostgreSQL automatically when you add the plugin.

---

### Render

**Setup:**

1. Create new Web Service from GitHub
2. Add PostgreSQL database
3. Configure environment

**render.yaml:**

```yaml
services:
  - type: web
    name: sunrise
    runtime: node
    buildCommand: npm install && prisma generate && prisma migrate deploy && npm run build
    startCommand: npm run start
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: sunrise-db
          property: connectionString
      - key: NODE_ENV
        value: production
      - key: BETTER_AUTH_SECRET
        generateValue: true
      - key: BETTER_AUTH_URL
        sync: false
      - key: NEXT_PUBLIC_APP_URL
        sync: false

databases:
  - name: sunrise-db
    plan: free
    databaseName: sunrise
```

---

### Fly.io

**Setup:**

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login and launch
fly auth login
fly launch

# Set secrets
fly secrets set DATABASE_URL="postgresql://..."
fly secrets set BETTER_AUTH_SECRET="your-secret"
fly secrets set BETTER_AUTH_URL="https://your-app.fly.dev"
fly secrets set NEXT_PUBLIC_APP_URL="https://your-app.fly.dev"

# Deploy
fly deploy
```

**fly.toml:**

```toml
app = "sunrise"
primary_region = "iad"

[build]

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0
  processes = ["app"]

[[services]]
  protocol = "tcp"
  internal_port = 3000
  processes = ["app"]

  [[services.ports]]
    port = 80
    handlers = ["http"]

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

  [[services.http_checks]]
    interval = "10s"
    timeout = "2s"
    grace_period = "5s"
    method = "GET"
    path = "/api/health"

[env]
  NODE_ENV = "production"
  PORT = "3000"
```

**Database:** Use Fly Postgres or external PostgreSQL.

---

### Docker Self-Hosted

**Using docker-compose.prod.yml:**

```bash
# Build and start
docker-compose -f docker-compose.prod.yml up -d --build

# Run migrations
docker-compose -f docker-compose.prod.yml exec web npx prisma migrate deploy

# View logs
docker-compose -f docker-compose.prod.yml logs -f web
```

**Environment (.env.production):**

```bash
DATABASE_URL=postgresql://postgres:password@db:5432/sunrise
BETTER_AUTH_SECRET=your-production-secret
BETTER_AUTH_URL=https://your-domain.com
NEXT_PUBLIC_APP_URL=https://your-domain.com
NODE_ENV=production
```

**Nginx reverse proxy (optional):**

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Troubleshooting

### Build Fails

**Issue:** `prisma generate` fails

```bash
# Ensure Prisma is installed
npm install prisma @prisma/client

# Regenerate
npx prisma generate
```

**Issue:** Type errors during build

```bash
# Run locally first
npm run validate
npm run build
```

### Database Connection

**Issue:** Cannot connect to database

- Check `DATABASE_URL` format
- Verify database is accessible from deployment platform
- Check SSL requirements (add `?sslmode=require` if needed)

**Issue:** Migrations fail

```bash
# Check migration status
npx prisma migrate status

# Reset and re-run (CAUTION: data loss)
npx prisma migrate reset
```

### Authentication

**Issue:** Login/signup not working

- Verify `BETTER_AUTH_URL` matches your domain
- Check `BETTER_AUTH_SECRET` is at least 32 characters
- Ensure cookies are being set (check browser dev tools)

**Issue:** OAuth redirect error

- Update OAuth provider settings with production URLs
- Check callback URLs match exactly

### Health Check Failing

**Issue:** `/api/health` returns error

- Check database connection
- Verify environment variables are set
- Check application logs for errors

## Verification Checklist

- [ ] Environment variables set correctly
- [ ] Database accessible and migrated
- [ ] `/api/health` returns `{"status":"ok"}`
- [ ] Signup flow works
- [ ] Login flow works
- [ ] Password reset email sends (if configured)
- [ ] OAuth providers work (if configured)
- [ ] Error tracking receives events (if configured)
- [ ] SSL/HTTPS working
- [ ] Custom domain configured (if applicable)

## Usage Examples

**Deploy to Vercel:**

```
User: "Deploy this to Vercel"
Assistant: [Provides Vercel-specific setup, environment variables, build config]
```

**Self-hosted Docker:**

```
User: "How do I deploy this on my own server?"
Assistant: [Provides docker-compose setup, Nginx config, SSL instructions]
```

**Railway with database:**

```
User: "Set up on Railway with PostgreSQL"
Assistant: [Provides Railway config, environment variable setup with Railway references]
```
