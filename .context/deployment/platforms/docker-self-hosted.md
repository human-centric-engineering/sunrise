# Docker Self-Hosted Deployment Guide

**Platform:** Self-hosted (VPS, dedicated server, cloud VM)
**Best For:** Full control, privacy, cost optimization at scale
**Estimated Setup Time:** 30-60 minutes

## Prerequisites

- Linux server (Ubuntu 22.04+ recommended)
- Docker and Docker Compose installed
- Domain name (optional but recommended)
- SSH access to server

## Server Requirements

| Resource | Minimum       | Recommended   |
| -------- | ------------- | ------------- |
| RAM      | 1GB           | 2GB+          |
| CPU      | 1 core        | 2+ cores      |
| Storage  | 10GB          | 20GB+         |
| OS       | Ubuntu 20.04+ | Ubuntu 22.04+ |

## Deployment Steps

### 1. Server Setup

Connect to your server and install Docker:

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install Docker Compose
sudo apt install docker-compose-plugin -y

# Verify installation
docker --version
docker compose version
```

### 2. Clone Repository

```bash
# Clone your repository
git clone https://github.com/your-org/sunrise.git
cd sunrise
```

### 3. Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit with your production values
nano .env
```

**Required environment variables:**

```bash
# Database (Docker internal network)
DATABASE_URL="postgresql://postgres:your-secure-password@db:5432/sunrise"

# Authentication
BETTER_AUTH_SECRET="<generate with: openssl rand -base64 32>"
BETTER_AUTH_URL="https://yourdomain.com"
NEXT_PUBLIC_APP_URL="https://yourdomain.com"

# Environment
NODE_ENV="production"

# Docker database settings
DB_USER="postgres"
DB_PASSWORD="your-secure-password"
DB_NAME="sunrise"
```

**Optional (for email):**

```bash
RESEND_API_KEY="re_..."
EMAIL_FROM="noreply@yourdomain.com"
```

### 4. Build and Start

```bash
# Build and start in detached mode
docker compose -f docker-compose.prod.yml up -d --build

# View logs
docker compose -f docker-compose.prod.yml logs -f web
```

### 5. Run Database Migrations

```bash
docker compose -f docker-compose.prod.yml exec web npx prisma migrate deploy
```

### 6. Verify Deployment

```bash
curl http://localhost:3000/api/health
```

Expected response:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 12345,
  "timestamp": "2025-01-20T10:30:00.000Z",
  "services": {
    "database": { "status": "operational", "connected": true, "latency": 5 }
  }
}
```

**Note:** `services.database.status` is `operational`, `degraded` (latency > 500ms), or `outage`. Returns HTTP 503 when database is disconnected.

## SSL/HTTPS with Nginx and Let's Encrypt

### Install Nginx and Certbot

```bash
sudo apt install nginx certbot python3-certbot-nginx -y
```

### Configure Nginx

Create `/etc/nginx/sites-available/sunrise`:

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

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

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/sunrise /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Enable SSL with Certbot

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Certbot automatically:

- Obtains SSL certificate from Let's Encrypt
- Configures Nginx for HTTPS
- Sets up auto-renewal

### Verify SSL

```bash
curl https://yourdomain.com/api/health
```

## Database Backups

### Manual Backup

```bash
docker compose -f docker-compose.prod.yml exec db pg_dump -U postgres sunrise > backup_$(date +%Y%m%d_%H%M%S).sql
```

### Automated Daily Backups

Create `/opt/scripts/backup-sunrise.sh`:

```bash
#!/bin/bash
BACKUP_DIR="/opt/backups/sunrise"
mkdir -p $BACKUP_DIR

# Create backup
docker compose -f /path/to/sunrise/docker-compose.prod.yml exec -T db pg_dump -U postgres sunrise > $BACKUP_DIR/backup_$(date +%Y%m%d).sql

# Keep only last 7 days
find $BACKUP_DIR -name "backup_*.sql" -mtime +7 -delete
```

Add to crontab:

```bash
sudo crontab -e
# Add line:
0 2 * * * /opt/scripts/backup-sunrise.sh
```

### Restore from Backup

```bash
cat backup_20250119.sql | docker compose -f docker-compose.prod.yml exec -T db psql -U postgres sunrise
```

## Updating Deployments

### Standard Update

```bash
cd sunrise

# Pull latest changes
git pull origin main

# Rebuild and restart
docker compose -f docker-compose.prod.yml up -d --build

# Run any new migrations
docker compose -f docker-compose.prod.yml exec web npx prisma migrate deploy

# Verify
curl http://localhost:3000/api/health
```

### Zero-Downtime Update (Advanced)

Use rolling updates with Docker Swarm or Kubernetes for zero-downtime deployments.

## Monitoring

### View Logs

```bash
# All services
docker compose -f docker-compose.prod.yml logs -f

# Web only
docker compose -f docker-compose.prod.yml logs -f web

# Database only
docker compose -f docker-compose.prod.yml logs -f db
```

### Health Check

Add to your monitoring system (UptimeRobot, Pingdom, etc.):

- **URL:** `https://yourdomain.com/api/health`
- **Method:** GET
- **Expected:** 200 OK with `"status":"ok"`

### Resource Monitoring

```bash
# Docker stats
docker stats

# System resources
htop
```

## Common Issues

### Container Won't Start

```bash
# Check logs
docker compose -f docker-compose.prod.yml logs web

# Common fixes:
# - Verify .env file exists and is correct
# - Check DATABASE_URL uses 'db' hostname (not localhost)
# - Ensure ports aren't in use
```

### Database Connection Refused

```bash
# Ensure database container is running
docker compose -f docker-compose.prod.yml ps

# Check database logs
docker compose -f docker-compose.prod.yml logs db

# Verify DATABASE_URL hostname is 'db' not 'localhost'
```

### Nginx 502 Bad Gateway

```bash
# Check if app is running
docker compose -f docker-compose.prod.yml ps

# Verify app is listening on port 3000
curl http://localhost:3000/api/health

# Check Nginx config
sudo nginx -t
```

### Out of Disk Space

```bash
# Clean up Docker resources
docker system prune -af

# Remove old images
docker image prune -af
```

## Security Checklist

Before going live:

- [ ] Strong `BETTER_AUTH_SECRET` (32+ characters)
- [ ] Strong database password
- [ ] SSL/HTTPS enabled
- [ ] Firewall configured (allow 80, 443, 22)
- [ ] SSH key authentication (disable password auth)
- [ ] Automated backups configured
- [ ] Monitoring/uptime checks configured
- [ ] Environment variables not in git

## Cost Considerations

| Provider      | Price Range | Notes                             |
| ------------- | ----------- | --------------------------------- |
| DigitalOcean  | $6-24/month | Droplets with Docker preinstalled |
| Hetzner       | $4-20/month | Great value, EU data centers      |
| Linode        | $5-20/month | Good performance                  |
| Vultr         | $5-20/month | Global locations                  |
| AWS Lightsail | $5-40/month | AWS ecosystem integration         |

## Dockerfile Details

The multi-stage Dockerfile is optimized for minimal image size and security.

### Base Image

- **`node:20-alpine`**: Alpine Linux base (~150-200MB final image)
- **`libc6-compat`**: Required for Node.js compatibility on Alpine Linux

### Build Stages

| Stage     | Purpose                                           |
| --------- | ------------------------------------------------- |
| `deps`    | Install dependencies with `.npmrc` configuration  |
| `builder` | Build Next.js application with standalone output  |
| `runner`  | Minimal production image with only required files |

### Key Configuration

**.npmrc handling:**

```dockerfile
COPY package.json package-lock.json* .npmrc ./
```

The `.npmrc` includes `legacy-peer-deps=true` for better-auth and Prisma 7 compatibility.

**Non-root user:**

```dockerfile
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
USER nextjs
```

Container runs as `nextjs:nodejs` (uid 1001) for security - never as root.

**Standalone output:**

Next.js traces dependencies and creates a minimal production server at `.next/standalone/`. Only required files are included in the final image.

**Health check:**

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', ...)"
```

- Checks `/api/health` every 30 seconds
- 10 second timeout per check
- 40 second grace period on startup
- 3 retries before marking unhealthy

## Docker Compose Production Details

### Service Configuration

**Restart policy:**

```yaml
restart: unless-stopped
```

Auto-restarts on failure but not if manually stopped with `docker compose down`.

**Dependency ordering:**

```yaml
depends_on:
  db:
    condition: service_healthy
```

Web service waits for database health check to pass before starting.

**Environment variables:**

| Method       | Usage                                                                    |
| ------------ | ------------------------------------------------------------------------ |
| `env_file`   | Runtime variables from `.env` file                                       |
| Build `args` | Build-time variables passed to Dockerfile (DATABASE*URL, BETTER_AUTH*\*) |

Build args are needed because Next.js embeds `NEXT_PUBLIC_*` variables and validates environment during build.

### Database Configuration

```yaml
environment:
  - POSTGRES_INITDB_ARGS=-E UTF8
```

Ensures UTF-8 encoding for proper character support.

### Networking

```yaml
networks:
  sunrise-network:
    driver: bridge
```

Bridge network isolates containers while allowing inter-container communication via service names (`web`, `db`).

### Volumes

| Volume               | Purpose                     |
| -------------------- | --------------------------- |
| `postgres_prod_data` | PostgreSQL data persistence |
| `nginx_cache`        | Nginx proxy cache           |

## Nginx Security Configuration

The `nginx.conf` includes security hardening for production deployments.

### Rate Limiting

```nginx
limit_req_zone $binary_remote_addr zone=general:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;
```

| Zone      | Rate  | Burst | Applied To         |
| --------- | ----- | ----- | ------------------ |
| `general` | 10r/s | 50    | All non-API routes |
| `api`     | 30r/s | 20    | `/api/*` endpoints |

### Security Headers

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "no-referrer-when-downgrade" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
```

| Header                    | Value                      | Purpose                                |
| ------------------------- | -------------------------- | -------------------------------------- |
| X-Frame-Options           | SAMEORIGIN                 | Prevents clickjacking                  |
| X-Content-Type-Options    | nosniff                    | Prevents MIME-type sniffing            |
| X-XSS-Protection          | 1; mode=block              | Legacy XSS filter (for older browsers) |
| Referrer-Policy           | no-referrer-when-downgrade | Controls referrer information          |
| Strict-Transport-Security | max-age=31536000 (1 year)  | Enforces HTTPS for all requests        |

### Let's Encrypt Support

```nginx
location /.well-known/acme-challenge/ {
    root /var/www/certbot;
}
```

Allows Certbot to verify domain ownership for SSL certificate issuance and renewal.

### SSL/TLS Configuration

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers HIGH:!aNULL:!MD5;
ssl_session_cache shared:SSL:10m;
ssl_session_timeout 10m;
```

- Only TLS 1.2 and 1.3 (no legacy SSL or TLS 1.0/1.1)
- Secure cipher suites, excludes weak algorithms
- 10MB shared session cache for performance

### Health Endpoint

```nginx
location /api/health {
    proxy_pass http://nextjs;
    access_log off;
}
```

Health checks bypass rate limiting and access logging to reduce noise.

## Nginx Performance Configuration

### Gzip Compression

```nginx
gzip on;
gzip_comp_level 6;
gzip_types text/plain text/css text/xml text/javascript
           application/json application/javascript application/xml+rss
           application/rss+xml font/truetype font/opentype
           application/vnd.ms-fontobject image/svg+xml;
```

Level 6 compression balances CPU usage and compression ratio. Applies to text, JSON, JavaScript, fonts, and SVG.

### Static Asset Caching

```nginx
location /_next/static {
    proxy_pass http://nextjs;
    add_header Cache-Control "public, max-age=31536000, immutable";
}

location /_next/image {
    proxy_pass http://nextjs;
    add_header Cache-Control "public, max-age=31536000, immutable";
}
```

| Path            | Cache Duration | Notes                              |
| --------------- | -------------- | ---------------------------------- |
| `/_next/static` | 1 year         | JS/CSS bundles with content hashes |
| `/_next/image`  | 1 year         | Optimized images from Next.js      |

The `immutable` directive tells browsers these files never change (Next.js uses content hashes in filenames).

### Upload Limit

```nginx
client_max_body_size 10M;
```

Maximum request body size of 10MB. Increase if you need larger file uploads.

### Upstream Configuration

```nginx
upstream nextjs {
    server web:3000;
}
```

Uses Docker service name `web` from `docker-compose.prod.yml` for container-to-container communication.

## SSL/HTTPS Options

Two approaches for SSL termination:

### Option A: External Nginx (Recommended)

Install Nginx on the host OS, use Certbot for certificate management.

**Advantages:**

- Easier certificate management with Certbot auto-renewal
- Simpler debugging (Nginx outside containers)
- Standard Linux administration patterns

**Setup:**

```bash
sudo apt install nginx certbot python3-certbot-nginx -y
sudo certbot --nginx -d yourdomain.com
```

Certbot automatically configures Nginx and sets up renewal cron job.

### Option B: Containerized Nginx

Use the nginx service in `docker-compose.prod.yml` with mounted certificates.

**Advantages:**

- Fully containerized deployment
- Consistent across environments
- All configuration in version control

**Setup:**

1. Obtain certificates (manually or via Certbot on host)
2. Place in `./ssl/` directory:
   - `./ssl/fullchain.pem`
   - `./ssl/privkey.pem`
3. Uncomment the SSL volume mount in `docker-compose.prod.yml`:

```yaml
volumes:
  - ./nginx.conf:/etc/nginx/nginx.conf:ro
  - ./ssl:/etc/nginx/ssl:ro # Uncomment this line
```

4. Update `nginx.conf` with your domain name

**Certificate renewal:** You must manually update certificates or set up a renewal script that copies new certs to `./ssl/` and restarts the nginx container.

## Related Documentation

- [Docker Documentation](https://docs.docker.com/)
- [Nginx Documentation](https://nginx.org/en/docs/)
- [Let's Encrypt](https://letsencrypt.org/docs/)
- [Deployment Overview](../overview.md)
