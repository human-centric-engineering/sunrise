# Deployment Files - Quick Start

This directory contains everything you need to deploy your Next.js application to various platforms.

## 📁 Files Overview

| File | Purpose |
|------|---------|
| `Dockerfile` | Production Docker image (optimized multi-stage build) |
| `Dockerfile.dev` | Development Docker image (with hot reload) |
| `.dockerignore` | Excludes unnecessary files from Docker builds |
| `docker-compose.yml` | Local development with all services |
| `docker-compose.prod.yml` | Production deployment with all services |
| `nginx.conf` | Nginx reverse proxy configuration |
| `next.config.js` | Next.js configuration (enables standalone output) |
| `.env.example` | Template for environment variables |
| `DEPLOYMENT.md` | Comprehensive deployment guide for all platforms |

## 🚀 Quick Start Options

### Option 1: Deploy to Vercel (Easiest)
```bash
# 1. Push to GitHub
git push origin main

# 2. Go to vercel.com and import your repo
# 3. Done! ✨
```

### Option 2: Docker Locally
```bash
# 1. Copy environment file
cp .env.example .env
# Edit .env with your values

# 2. Run with Docker Compose
docker-compose up

# Visit http://localhost:3000
```

### Option 3: Production Docker
```bash
# 1. Set up environment
cp .env.example .env
# Edit with production values

# 2. Build and run
docker-compose -f docker-compose.prod.yml up -d

# 3. View logs
docker-compose -f docker-compose.prod.yml logs -f
```

### Option 4: Deploy to Railway/Render
```bash
# 1. Push to GitHub
git push origin main

# 2. Connect repo in Railway/Render dashboard
# 3. Platform auto-detects Dockerfile and deploys
```

## 🔧 Configuration Checklist

Before deploying, ensure you have:

- [ ] Updated `next.config.js` with your domains for images
- [ ] Created `.env` file from `.env.example`
- [ ] Generated secure secrets (`openssl rand -base64 32`)
- [ ] Set up your database
- [ ] Configured authentication providers (if using)
- [ ] Updated CORS allowed origins
- [ ] Set up monitoring/error tracking

## 📝 Environment Variables

### Required
```bash
DATABASE_URL="postgresql://..."
NEXTAUTH_URL="https://yourdomain.com"
NEXTAUTH_SECRET="your-secret-here"
```

### Optional (based on your needs)
```bash
# Email
SMTP_HOST=
SMTP_USER=
SMTP_PASSWORD=

# OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Storage
S3_BUCKET=
AWS_ACCESS_KEY_ID=

# See .env.example for complete list
```

## 🏗️ Architecture

### Development
```
Developer → Local Port 3000 → Next.js Dev Server
                             ↓
                          PostgreSQL
                             ↓
                          Redis (optional)
```

### Production (with Nginx)
```
Internet → Port 443 (HTTPS) → Nginx → Next.js Container → PostgreSQL
                              (SSL)     (Port 3000)         Redis
```

### Production (without Nginx)
```
Internet → Port 3000 → Next.js Container → PostgreSQL
                         (Direct)           Redis
```

## 🛠️ Common Commands

### Docker Compose (Development)
```bash
# Start all services
docker-compose up

# Start in background
docker-compose up -d

# Rebuild after changes
docker-compose up --build

# Stop all services
docker-compose down

# View logs
docker-compose logs -f web

# Execute commands in container
docker-compose exec web npm run db:migrate
```

### Docker Compose (Production)
```bash
# Start production stack
docker-compose -f docker-compose.prod.yml up -d

# View logs
docker-compose -f docker-compose.prod.yml logs -f

# Restart service
docker-compose -f docker-compose.prod.yml restart web

# Update and redeploy
git pull
docker-compose -f docker-compose.prod.yml up -d --build

# Stop everything
docker-compose -f docker-compose.prod.yml down
```

### Docker Only
```bash
# Build production image
docker build -t my-app .

# Run container
docker run -p 3000:3000 --env-file .env my-app

# Run with specific variables
docker run -p 3000:3000 \
  -e DATABASE_URL="..." \
  -e NEXTAUTH_SECRET="..." \
  my-app
```

## 🐛 Troubleshooting

### Container won't start
```bash
# Check logs
docker-compose logs web

# Common issues:
# - Missing environment variables
# - Database not ready
# - Port already in use
```

### Database connection fails
```bash
# Check if database is running
docker-compose ps

# Test connection
docker-compose exec web npm run db:test

# Reset database
docker-compose down -v
docker-compose up
```

### Build fails
```bash
# Clear Docker cache
docker builder prune -a

# Rebuild without cache
docker-compose build --no-cache
```

### Out of memory
```bash
# Increase Docker memory limit (Docker Desktop settings)
# Or build with more memory:
docker build --memory=4g -t my-app .
```

## 📚 Full Documentation

For detailed deployment guides for specific platforms:
- **Read [DEPLOYMENT.md](DEPLOYMENT.md)** - comprehensive guide covering:
  - Vercel
  - Render
  - Railway
  - Fly.io
  - AWS ECS
  - DigitalOcean
  - Self-hosted VMs
  - Troubleshooting
  - CI/CD setup

## 🔒 Security Checklist

Before going to production:

- [ ] All secrets in environment variables (not in code)
- [ ] SSL/HTTPS enabled
- [ ] Database backups configured
- [ ] Rate limiting enabled
- [ ] CORS properly configured
- [ ] Security headers set (check nginx.conf)
- [ ] Error monitoring set up (Sentry, etc.)
- [ ] Health checks configured
- [ ] Strong passwords for database
- [ ] Updated dependencies

## 📊 Health Check

Your app includes a health check endpoint:

```bash
# Test locally
curl http://localhost:3000/api/health

# Test production
curl https://yourdomain.com/api/health

# Expected response:
{"status":"ok","timestamp":"2024-01-01T00:00:00.000Z"}
```

## 🚢 Deployment Workflow

1. **Develop locally** with `docker-compose up`
2. **Test thoroughly** in development
3. **Commit and push** to GitHub
4. **Deploy** using one of the methods in DEPLOYMENT.md
5. **Monitor** using health checks and error tracking
6. **Update** by pushing new commits (auto-deploys on most platforms)

## 💡 Tips

1. **Start simple**: Use Vercel or Railway for your first deployment
2. **Add complexity as needed**: Move to self-hosted only if you need specific features
3. **Always use environment variables**: Never hardcode secrets
4. **Set up monitoring early**: Know when things break
5. **Automate backups**: Especially for the database
6. **Use Docker for consistency**: Same environment everywhere

## 🆘 Need Help?

1. Check [DEPLOYMENT.md](DEPLOYMENT.md) for platform-specific guides
2. Check Docker/container logs: `docker-compose logs`
3. Check application logs in your platform's dashboard
4. Verify environment variables are set correctly
5. Test health endpoint: `/api/health`

## 📞 Support

- Documentation: See DEPLOYMENT.md
- Docker Docs: https://docs.docker.com
- Next.js Docs: https://nextjs.org/docs/deployment
- Platform-specific docs: Check each platform's documentation

---

**Remember**: Start with the simplest deployment that works for you. You can always migrate to more complex setups as your needs grow.
