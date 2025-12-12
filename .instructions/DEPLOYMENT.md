# Next.js Deployment Guide

This guide covers multiple deployment options for your Next.js application, from simple push-to-deploy platforms to self-hosted solutions.

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Quick Start - Vercel](#quick-start---vercel)
3. [Docker Deployment](#docker-deployment)
4. [Platform-Specific Guides](#platform-specific-guides)
   - [Render](#render)
   - [Railway](#railway)
   - [Fly.io](#flyio)
   - [AWS (ECS)](#aws-ecs)
   - [DigitalOcean](#digitalocean)
   - [Self-Hosted VM](#self-hosted-vm)
5. [Environment Variables](#environment-variables)
6. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- Node.js 18+ installed
- Docker installed (for Docker-based deployments)
- Git repository with your application

### Important Configuration

Ensure your `next.config.js` has `output: 'standalone'` enabled:

```javascript
module.exports = {
  output: 'standalone',
  // ... other config
}
```

This is required for Docker deployments and optimizes the production build.

---

## Quick Start - Vercel

**Easiest option - zero configuration required**

### Steps:
1. Push your code to GitHub/GitLab/Bitbucket
2. Go to [vercel.com](https://vercel.com)
3. Click "Import Project"
4. Select your repository
5. Click "Deploy"

That's it! Vercel automatically:
- Detects Next.js
- Installs dependencies
- Builds your app
- Deploys to a global CDN
- Sets up automatic deployments on git push

### Environment Variables:
Add them in the Vercel dashboard under Settings → Environment Variables

### Custom Domain:
Add in Settings → Domains

**Pros:** Zero config, instant, all Next.js features work perfectly
**Cons:** Vendor lock-in, can get expensive at scale

---

## Docker Deployment

Most flexible option - works everywhere Docker runs.

### Local Testing

1. **Build the production image:**
```bash
docker build -t my-nextjs-app .
```

2. **Run locally:**
```bash
docker run -p 3000:3000 \
  -e DATABASE_URL="your-db-url" \
  -e NEXTAUTH_SECRET="your-secret" \
  my-nextjs-app
```

3. **Test:** Visit http://localhost:3000

### Development with Docker Compose

```bash
# Start all services (app + database + redis)
docker-compose up

# Rebuild after dependency changes
docker-compose up --build

# Stop all services
docker-compose down

# View logs
docker-compose logs -f web
```

Your app runs at http://localhost:3000 with hot reload enabled.

---

## Platform-Specific Guides

### Render

**Difficulty: Easy | Cost: Free tier available**

#### Setup:
1. Create a new "Web Service" on [render.com](https://render.com)
2. Connect your repository
3. Configure:
   - **Environment:** Docker
   - **Dockerfile Path:** `Dockerfile`
   - **Plan:** Free or Starter

4. Add environment variables in the Render dashboard

5. Deploy!

**Pros:** Simple, auto-deploys on push, good free tier
**Cons:** Cold starts on free tier, slower than some alternatives

---

### Railway

**Difficulty: Easy | Cost: $5/month base**

#### Setup:
1. Go to [railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your repository
4. Railway auto-detects Next.js and configures everything

#### Add Database (optional):
```bash
# In Railway dashboard
New → Database → PostgreSQL
# Connection string automatically added to environment
```

5. Add environment variables in Settings → Variables

**Pros:** Very developer-friendly, includes databases, no cold starts
**Cons:** No free tier (but affordable)

---

### Fly.io

**Difficulty: Medium | Cost: Pay-as-you-go**

#### Setup:
1. Install flyctl:
```bash
# macOS
brew install flyctl

# Other platforms
curl -L https://fly.io/install.sh | sh
```

2. Login and initialize:
```bash
flyctl auth login
flyctl launch
```

3. Follow the prompts (it will detect your Dockerfile)

4. Set environment variables:
```bash
flyctl secrets set DATABASE_URL="your-db-url"
flyctl secrets set NEXTAUTH_SECRET="your-secret"
```

5. Deploy:
```bash
flyctl deploy
```

#### Custom fly.toml example:
```toml
app = "my-nextjs-app"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "3000"

[[services]]
  internal_port = 3000
  protocol = "tcp"

  [[services.ports]]
    handlers = ["http"]
    port = 80

  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443
```

**Pros:** Global edge network, excellent performance, good pricing
**Cons:** Requires CLI knowledge, more configuration

---

### AWS ECS

**Difficulty: Hard | Cost: Variable (can be optimized)**

#### Prerequisites:
- AWS Account
- AWS CLI installed and configured
- ECR repository created

#### Steps:

1. **Build and push to ECR:**
```bash
# Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com

# Build for production
docker build -t my-nextjs-app .

# Tag for ECR
docker tag my-nextjs-app:latest \
  YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/my-nextjs-app:latest

# Push
docker push YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/my-nextjs-app:latest
```

2. **Create ECS Task Definition:**
```json
{
  "family": "my-nextjs-app",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "containerDefinitions": [
    {
      "name": "nextjs",
      "image": "YOUR_ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/my-nextjs-app:latest",
      "portMappings": [
        {
          "containerPort": 3000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "NODE_ENV",
          "value": "production"
        }
      ],
      "secrets": [
        {
          "name": "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:region:account:secret:name"
        }
      ]
    }
  ]
}
```

3. **Create ECS Service with Application Load Balancer**

4. **Configure auto-scaling** (optional)

**Better option:** Use **AWS Copilot** or **SST** to simplify this process significantly.

**Pros:** Full AWS integration, scales infinitely, production-grade
**Cons:** Complex setup, requires AWS expertise, can be expensive if not optimized

---

### DigitalOcean

**Difficulty: Medium | Cost: $4/month and up**

#### Option 1: App Platform (Easy)

1. Go to [cloud.digitalocean.com](https://cloud.digitalocean.com)
2. Create → Apps → Deploy from GitHub
3. Select your repository
4. Choose "Dockerfile" as build method
5. Add environment variables
6. Deploy

#### Option 2: Droplet (More control, see Self-Hosted section)

**Pros:** Simple, affordable, good documentation
**Cons:** Less features than some competitors

---

### Self-Hosted VM

**Difficulty: Hard | Cost: Variable ($5-50/month typically)**

For any VPS (DigitalOcean, Linode, Vultr, AWS EC2, etc.)

#### Initial Setup:

1. **SSH into your server:**
```bash
ssh root@your-server-ip
```

2. **Update system:**
```bash
apt update && apt upgrade -y
```

3. **Install Docker:**
```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Install Docker Compose
apt install docker-compose -y
```

4. **Set up your application:**
```bash
# Create app directory
mkdir -p /opt/myapp
cd /opt/myapp

# Clone your repo
git clone https://github.com/yourusername/your-repo.git .

# Create .env file
nano .env
# Add your environment variables

# Build and run
docker-compose -f docker-compose.prod.yml up -d
```

5. **Set up Nginx reverse proxy:**
```bash
apt install nginx -y

# Create nginx config
nano /etc/nginx/sites-available/myapp
```

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
# Enable site
ln -s /etc/nginx/sites-available/myapp /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

6. **Set up SSL with Let's Encrypt:**
```bash
apt install certbot python3-certbot-nginx -y
certbot --nginx -d yourdomain.com
```

7. **Set up automatic deployments (optional):**
```bash
# Create deploy script
nano /opt/myapp/deploy.sh
```

```bash
#!/bin/bash
cd /opt/myapp
git pull
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml up -d --build
```

```bash
chmod +x /opt/myapp/deploy.sh

# Set up webhook or cron for auto-deploy
```

#### Production Docker Compose (`docker-compose.prod.yml`):
```yaml
version: '3.8'

services:
  web:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    env_file:
      - .env
    depends_on:
      - db

  db:
    image: postgres:15-alpine
    restart: unless-stopped
    environment:
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=myapp
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

**Pros:** Full control, cost-effective at scale, no vendor lock-in
**Cons:** You're responsible for everything (security, updates, monitoring, backups)

---

## Environment Variables

### Required Variables:
```bash
# Database
DATABASE_URL="postgresql://user:password@host:5432/dbname"

# Authentication (if using NextAuth)
NEXTAUTH_URL="https://yourdomain.com"
NEXTAUTH_SECRET="generate-with-openssl-rand-base64-32"

# Node Environment
NODE_ENV="production"
```

### Optional Variables:
```bash
# Email (if using)
SMTP_HOST="smtp.gmail.com"
SMTP_PORT="587"
SMTP_USER="your-email@gmail.com"
SMTP_PASSWORD="your-app-password"

# S3/Storage (if using)
S3_BUCKET="your-bucket"
AWS_ACCESS_KEY_ID="your-key"
AWS_SECRET_ACCESS_KEY="your-secret"

# Analytics
NEXT_PUBLIC_GA_ID="G-XXXXXXXXXX"
```

### How to Set Environment Variables:

**In Vercel/Render/Railway:**
- Use the dashboard UI

**In Docker:**
```bash
docker run -e VAR_NAME="value" ...
```

**In docker-compose:**
```yaml
environment:
  - VAR_NAME=value
# Or use env_file:
env_file:
  - .env
```

**In self-hosted:**
- Create `.env` file (never commit this!)
- Or set system environment variables

---

## Troubleshooting

### Build Fails

**Problem:** Docker build fails with memory errors
**Solution:** Increase Docker memory limit or use swap:
```bash
docker build --memory=4g -t my-app .
```

### Application Won't Start

**Problem:** Container exits immediately
**Solution:** Check logs:
```bash
docker logs container-name
```

Common issues:
- Missing environment variables
- Database connection fails
- Port already in use

### Database Connection Issues

**Problem:** Can't connect to database
**Solution:**
1. Check `DATABASE_URL` format
2. Ensure database service is running
3. Check network connectivity
4. For Docker: use service name, not `localhost`
   - ✅ `postgres://user:pass@db:5432/myapp`
   - ❌ `postgres://user:pass@localhost:5432/myapp`

### Images Not Loading

**Problem:** Images return 404 or don't optimize
**Solution:** 
1. Check `next.config.js` image configuration
2. For self-hosted, you might need `unoptimized: true`
3. Ensure images are in `/public` directory

### Environment Variables Not Working

**Problem:** App can't read environment variables
**Solution:**
1. Variables starting with `NEXT_PUBLIC_` are embedded at build time
2. Server-side variables are read at runtime
3. Rebuild after adding new `NEXT_PUBLIC_` variables
4. Check if variable is properly passed to container

### Performance Issues

**Problem:** App is slow
**Solutions:**
1. Enable output file tracing: `output: 'standalone'`
2. Use CDN for static assets
3. Enable caching headers
4. Check database query performance
5. Monitor memory usage

---

## Health Checks

Add a health check endpoint in your app:

```typescript
// app/api/health/route.ts
export async function GET() {
  return Response.json({ 
    status: 'ok',
    timestamp: new Date().toISOString()
  });
}
```

Use in Docker:
```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"
```

---

## CI/CD Pipeline Example

### GitHub Actions (`.github/workflows/deploy.yml`):

```yaml
name: Deploy to Production

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Build and push Docker image
      run: |
        echo ${{ secrets.DOCKER_PASSWORD }} | docker login -u ${{ secrets.DOCKER_USERNAME }} --password-stdin
        docker build -t username/my-app:latest .
        docker push username/my-app:latest
    
    - name: Deploy to server
      uses: appleboy/ssh-action@master
      with:
        host: ${{ secrets.HOST }}
        username: ${{ secrets.USERNAME }}
        key: ${{ secrets.SSH_KEY }}
        script: |
          cd /opt/myapp
          docker-compose pull
          docker-compose up -d
```

---

## Monitoring Recommendations

### Essential Monitoring:
1. **Uptime monitoring:** [UptimeRobot](https://uptimerobot.com) (free)
2. **Error tracking:** [Sentry](https://sentry.io)
3. **Performance:** [Vercel Analytics](https://vercel.com/analytics) or [Plausible](https://plausible.io)
4. **Logs:** Built-in platform logs or [Logflare](https://logflare.app)

### For Self-Hosted:
- **Server monitoring:** [Netdata](https://www.netdata.cloud) (free, open-source)
- **Logs:** [Loki](https://grafana.com/oss/loki/) + [Grafana](https://grafana.com)
- **Backups:** Set up automated database backups

---

## Quick Comparison Table

| Platform | Difficulty | Cost | Best For |
|----------|-----------|------|----------|
| Vercel | ⭐ Easy | $$ | Quickest deployment, best DX |
| Railway | ⭐ Easy | $ | Balance of simplicity and features |
| Render | ⭐⭐ Easy | $ | Good free tier |
| Fly.io | ⭐⭐ Medium | $ | Performance, global edge |
| DigitalOcean | ⭐⭐ Medium | $ | Simple, affordable |
| AWS | ⭐⭐⭐ Hard | $$-$$$ | Enterprise, full AWS integration |
| Self-Hosted | ⭐⭐⭐ Hard | $ | Maximum control, privacy |

---

## Next Steps

1. **Choose your deployment platform** based on your needs
2. **Set up monitoring** from day one
3. **Configure automatic backups** for your database
4. **Set up CI/CD** for automatic deployments
5. **Add SSL certificate** (automatic on most platforms)
6. **Configure custom domain**

Need help? Check the troubleshooting section or platform-specific documentation.
