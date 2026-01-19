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
{ "status": "ok", "database": { "connected": true } }
```

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

## Related Documentation

- [Docker Documentation](https://docs.docker.com/)
- [Nginx Documentation](https://nginx.org/en/docs/)
- [Let's Encrypt](https://letsencrypt.org/docs/)
- [Deployment Overview](../overview.md)
