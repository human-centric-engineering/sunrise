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

Option A: Add to build command

In Web Service > Settings > Build Command:

```bash
npm run build && npx prisma migrate deploy
```

Option B: Via Render Shell

1. Go to Web Service > Shell
2. Run: `npx prisma migrate deploy`

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
