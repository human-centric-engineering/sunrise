# Render Deployment Guide

**Platform:** Render
**Best For:** Good free tier, automatic deploys, simple PostgreSQL setup
**Estimated Setup Time:** 10-15 minutes

## Prerequisites

- Render account ([render.com](https://render.com))
- GitHub or GitLab repository with your Sunrise project

## Deployment Steps

### 1. Create PostgreSQL Database

1. Go to [dashboard.render.com](https://dashboard.render.com)
2. Click "New" > "PostgreSQL"
3. Configure:
   - **Name:** `sunrise-db`
   - **Region:** Choose closest to your users
   - **PostgreSQL Version:** 15+
   - **Plan:** Free (for testing) or Starter ($7/month)
4. Click "Create Database"
5. Copy the **Internal Database URL** (for web service connection)

### 2. Create Web Service

1. Click "New" > "Web Service"
2. Connect your GitHub/GitLab account
3. Select your Sunrise repository
4. Configure:
   - **Name:** `sunrise`
   - **Region:** Same as database
   - **Branch:** `main`
   - **Runtime:** Docker
   - **Plan:** Free (for testing) or Starter ($7/month)

### 3. Configure Environment Variables

In Web Service > Environment, add:

**Required:**

```
DATABASE_URL=<Internal Database URL from step 1>
BETTER_AUTH_SECRET=<generate with: openssl rand -base64 32>
BETTER_AUTH_URL=https://sunrise.onrender.com
NEXT_PUBLIC_APP_URL=https://sunrise.onrender.com
NODE_ENV=production
```

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
STORAGE_PROVIDER=s3  # Options: s3, vercel-blob, local
# See .env.example for full S3/Vercel Blob configuration
```

### 4. Configure Build & Deploy

In Web Service > Settings:

- **Docker Command:** Leave empty (uses Dockerfile CMD)
- **Health Check Path:** `/api/health`
- **Auto-Deploy:** Yes (deploys on push to main)

Render checks for HTTP 200 OK response. The app returns 503 if the database is disconnected, which Render treats as unhealthy. Note: On the free tier, services spin down after inactivity, which affects health check reliability until the service warms up.

### 5. Run Database Migrations

**Do not use Render's Pre-Deploy Command.** It runs inside the deployed image,
and the Sunrise runtime image contains no Prisma CLI — it ships only Next's
standalone trace (#583). The hook would fail and abort the deploy. That is at
least a loud failure rather than a silent unmigrated schema, but it is not a
migration strategy. Render also cannot build a specific Dockerfile stage — there
is no `--target` equivalent — so pointing a second Render service at the
`migrator` stage is not a way out either.

Two supported options:

**Option 1 (recommended) — migrate from CI, then trigger the deploy.**
Turn **Auto-Deploy off** and create a **Deploy Hook** (Settings → Deploy Hook).
In your deploy workflow, apply migrations against the database's **External
Connection String** — the internal one is only reachable from inside Render's
network — then `POST` the hook:

```yaml
- name: Apply migrations
  run: |
    docker build --target migrator -t sunrise-migrator:deploy .
    docker run --rm -e DATABASE_URL="${{ secrets.RENDER_DATABASE_EXTERNAL_URL }}" \
      sunrise-migrator:deploy
- name: Trigger Render deploy
  run: curl -fsS -X POST "${{ secrets.RENDER_DEPLOY_HOOK }}"
```

Migrations land before the new code, which is the ordering the Pre-Deploy hook
was giving you. Simpler variant, if you would rather not run Docker in CI:
`npm ci && npx prisma migrate deploy` with `DATABASE_URL` set to the same value.

**Option 2 — run the service on Render's Node environment instead of Docker.**
Set Environment to **Node**, Build Command `npm ci && npm run build`, Start
Command `npm run start`, Pre-Deploy Command `npm run db:migrate:deploy`.
Render's build workspace has the full `node_modules`, so the hook works. The
trade-off is losing Dockerfile parity with your self-hosted stack.

Write backward-compatible migrations (see [database/migrations.md](../../database/migrations.md)) so a failed deploy between migration and promotion is safe.

### 6. Deploy

Click "Manual Deploy" > "Deploy latest commit" or push to your main branch.

## Render-Specific Configuration

### render.yaml (Infrastructure as Code)

Create `render.yaml` in your project root only if you need Infrastructure as Code deployment. This file is **not included** in the starter template — create it when you need reproducible deployments or want to manage infrastructure via Git.

See [Render Blueprint Spec](https://render.com/docs/blueprint-spec) for the full schema reference.

**Example configuration:**

```yaml
services:
  - type: web
    name: sunrise
    runtime: docker
    repo: https://github.com/your-org/sunrise
    branch: main
    healthCheckPath: /api/health
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: sunrise-db
          property: connectionString
      - key: BETTER_AUTH_SECRET
        generateValue: true
      - key: BETTER_AUTH_URL
        sync: false
      - key: NEXT_PUBLIC_APP_URL
        sync: false
      - key: NODE_ENV
        value: production

databases:
  - name: sunrise-db
    plan: starter
    postgresMajorVersion: 15
```

Deploy with Blueprint:

1. Go to Render Dashboard
2. Click "New" > "Blueprint"
3. Select repository with `render.yaml`

### Environment Groups

For shared variables across services:

1. Go to Dashboard > Environment Groups
2. Create group (e.g., "sunrise-prod")
3. Add shared variables
4. Link to services

## Verifying Deployment

1. Wait for deployment to complete (check Logs tab)
2. Visit `https://your-project.onrender.com/api/health`
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

### Free Tier Spin-Down

- Free services spin down after 15 minutes of inactivity
- First request after spin-down takes 30-60 seconds
- Solution: Upgrade to Starter ($7/month) or use external uptime monitoring to keep alive

### Database Connection Fails

- Use **Internal Database URL** (not External)
- Ensure database and web service are in same region
- Check database is running in Render dashboard

### Build Fails

- Check build logs in Render dashboard
- Verify Dockerfile builds locally
- Ensure environment variables are set before build for `NEXT_PUBLIC_*` vars

### Slow First Load

- Free tier has cold starts
- Starter plan and above have faster spin-up
- Use health check endpoint to keep service warm

## Custom Domain Setup

1. Go to Web Service > Settings > Custom Domains
2. Click "Add Custom Domain"
3. Enter your domain (e.g., `app.yourdomain.com`)
4. Add DNS records as shown:
   - CNAME record pointing to `*.onrender.com`
5. SSL is automatically provisioned

## Cost Considerations

| Tier     | Web Service | Database  | Notes                         |
| -------- | ----------- | --------- | ----------------------------- |
| Free     | $0          | $0        | Spins down, limited resources |
| Starter  | $7/month    | $7/month  | Always on, more resources     |
| Standard | $25/month   | $20/month | Auto-scaling, more memory     |

**Free tier limitations:**

- 750 hours/month (enough for one always-on service)
- Spins down after 15 min inactivity
- 512MB RAM, 0.1 CPU
- 90-day database retention

## Render CLI Commands

```bash
# Install CLI
npm install -g render-cli

# Login
render login

# List services
render services list

# View logs
render logs --service sunrise

# Open shell
render shell --service sunrise
```

## Related Documentation

- [Render Docs](https://render.com/docs)
- [Render PostgreSQL](https://render.com/docs/databases)
- [Render Blueprints](https://render.com/docs/blueprint-spec)
- [Deployment Overview](../overview.md)
