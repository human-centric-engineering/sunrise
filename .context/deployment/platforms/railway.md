# Railway Deployment Guide

**Platform:** Railway
**Best For:** Developer-friendly, built-in PostgreSQL, simple scaling
**Estimated Setup Time:** 10-15 minutes

## Prerequisites

- Railway account ([railway.app](https://railway.app))
- GitHub repository with your Sunrise project

## Deployment Steps

### 1. Create New Project

1. Go to [railway.app/new](https://railway.app/new)
2. Click "Deploy from GitHub repo"
3. Select your Sunrise repository
4. Railway auto-detects Dockerfile and starts deployment

### 2. Add PostgreSQL Database

1. In your Railway project, click "New"
2. Select "Database" > "PostgreSQL"
3. Railway provisions database and adds `DATABASE_URL` automatically

### 3. Configure Environment Variables

Click on your web service > Variables tab, add:

**Required (DATABASE_URL auto-added):**

```
BETTER_AUTH_SECRET=<generate with: openssl rand -base64 32>
BETTER_AUTH_URL=https://<your-service>.up.railway.app
NEXT_PUBLIC_APP_URL=https://<your-service>.up.railway.app
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

### 4. Run Database Migrations

Option A: Via Railway CLI

```bash
railway run npx prisma migrate deploy
```

Option B: Add to Dockerfile (recommended)

The production Dockerfile already includes migrations directory. Add a deploy command:

```bash
# In Railway dashboard > Service > Settings > Deploy
# Set Start Command to:
npx prisma migrate deploy && node server.js
```

### 5. Generate Domain

1. Click on your web service
2. Go to Settings > Domains
3. Click "Generate Domain" for a `.up.railway.app` URL
4. Or add a custom domain

### 6. Deploy

Push to your connected branch:

```bash
git push origin main
```

Railway automatically rebuilds and deploys.

## Railway-Specific Configuration

### Build Settings

Railway auto-detects:

- **Dockerfile:** Uses production Dockerfile
- **Build:** Multi-stage build runs automatically
- **Start:** Uses CMD from Dockerfile

### Health Checks

Railway supports custom health check configuration. Configure in service settings:

- **Path:** `/api/health`
- **Interval:** 30 seconds (recommended)
- **Timeout:** 10 seconds

The app returns HTTP 200 when healthy and HTTP 503 when the database is disconnected. Railway will automatically mark the service as unhealthy on 503 responses.

### Environment Groups

For multiple environments (staging, production):

1. Create Environment Group in project settings
2. Add shared variables
3. Link to services

## Verifying Deployment

1. Check deployment logs in Railway dashboard
2. Visit `https://<your-service>.up.railway.app/api/health`
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

- Verify `DATABASE_URL` is set (auto-populated by Railway)
- Check PostgreSQL service is running
- View database logs for connection errors

### Build Fails

- Check build logs in Railway dashboard
- Verify Dockerfile builds locally: `docker build -t sunrise .`
- Ensure all dependencies are in `package.json`

### Environment Variables Not Available

- Variables set after deployment need a redeploy
- Use "Redeploy" button after adding variables
- `NEXT_PUBLIC_*` vars require rebuild

### Out of Memory

- Railway hobby plan has 512MB RAM limit
- Monitor memory in Metrics tab
- Upgrade plan or optimize app

## Custom Domain Setup

1. Go to Service > Settings > Domains
2. Click "Add Custom Domain"
3. Enter your domain (e.g., `app.yourdomain.com`)
4. Add DNS records as shown:
   - CNAME record pointing to Railway
5. SSL is automatically provisioned

## Cost Considerations

| Tier       | Price        | Includes                     |
| ---------- | ------------ | ---------------------------- |
| Hobby      | $5/month     | 512MB RAM, $5 usage included |
| Pro        | $20/month    | 8GB RAM, team features       |
| PostgreSQL | ~$5-15/month | Based on storage and compute |

## Railway CLI Commands

```bash
# Install CLI
npm install -g @railway/cli

# Login
railway login

# Link to project
railway link

# Run commands in Railway environment
railway run npx prisma migrate deploy
railway run npx prisma db seed

# View logs
railway logs

# Open dashboard
railway open
```

## Related Documentation

- [Railway Docs](https://docs.railway.app/)
- [Railway PostgreSQL](https://docs.railway.app/databases/postgresql)
- [Railway CLI Reference](https://docs.railway.app/develop/cli)
