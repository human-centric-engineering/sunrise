# Docker Testing Guide

This guide walks you through testing the Docker setup for Sunrise in your local development environment.

## Prerequisites

1. **Start Docker Desktop** (if on macOS/Windows) or ensure Docker daemon is running
2. **Verify Docker is ready:**
   ```bash
   docker --version
   docker-compose --version
   docker ps  # Should return without errors
   ```

---

## Test 1: Development Environment

### 1.1 Clean Start

First, ensure no containers are running:

```bash
docker-compose down -v
```

### 1.2 Start Development Environment

Start the development environment (Next.js + PostgreSQL):

```bash
docker-compose up
```

**What to look for:**
- ✅ PostgreSQL container starts and shows "ready to accept connections"
- ✅ Web container builds successfully (may take 2-3 minutes first time)
- ✅ Dependencies install via `npm ci`
- ✅ Prisma client generates
- ✅ Next.js dev server starts on port 3000
- ✅ No error messages in the logs

**Expected output (last few lines):**
```
sunrise-db-dev   | ... ready to accept connections
sunrise-dev      | ✓ Ready in 2.5s
sunrise-dev      | ○ Compiling / ...
sunrise-dev      | ✓ Compiled / in 1.2s
```

### 1.3 Verify Services Are Running

Open a **new terminal** and check container status:

```bash
docker-compose ps
```

**Expected output:**
```
NAME                IMAGE                  STATUS
sunrise-db-dev      postgres:15-alpine     Up (healthy)
sunrise-dev         sunrise-dev            Up
```

Both containers should be "Up" and database should show "(healthy)".

### 1.4 Test Application Access

**In your browser, test these URLs:**

1. **App homepage:** http://localhost:3000
   - Should load the Sunrise landing page
   - No errors in browser console

2. **Health check:** http://localhost:3000/api/health
   - Should return JSON with `status: "ok"` and database connection info

   **Expected response:**
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

3. **API test:** http://localhost:3000/api/v1/users
   - Should return 405 (Method Not Allowed) with proper error format
   - This confirms API routing is working

### 1.5 Test Hot Reload

1. **Edit a file:** Open `app/(public)/page.tsx`
2. **Make a visible change:** Change some text in the landing page
3. **Save the file**
4. **Refresh browser:** Changes should appear immediately

**What's happening:**
- Source code is mounted as a volume: `.:/app`
- Next.js Fast Refresh detects changes
- Browser auto-reloads with new code

### 1.6 Test Database Connection

**Run Prisma Studio inside the container:**

```bash
docker-compose exec web npx prisma studio
```

- Should open Prisma Studio at http://localhost:5555
- You should see the database schema (User, Account, Session, etc.)
- Try viewing the User table

**Or access PostgreSQL directly:**

```bash
docker-compose exec db psql -U postgres -d sunrise
```

Then run:
```sql
\dt  -- List tables
SELECT * FROM "User";  -- View users
\q   -- Quit
```

### 1.7 View Logs

**In the first terminal** (where docker-compose up is running):
- You should see live logs from both containers
- Try navigating pages in the browser and watch the logs

**Or in a separate terminal:**
```bash
docker-compose logs -f web      # Follow app logs
docker-compose logs -f db       # Follow database logs
docker-compose logs --tail=50   # Last 50 lines from all services
```

### 1.8 Stop Development Environment

```bash
docker-compose down
```

**What happens:**
- Containers stop gracefully
- Network is removed
- **Data persists** in volumes (database data is preserved)

**To remove data as well:**
```bash
docker-compose down -v  # Remove volumes (deletes database data)
```

---

## Test 2: Production Build

### 2.1 Build Production Image

```bash
docker build -t sunrise:latest .
```

**What to look for:**
- ✅ Multi-stage build completes (deps → builder → runner)
- ✅ No errors during `npm ci`
- ✅ Prisma client generates successfully
- ✅ `npm run build` completes successfully
- ✅ Next.js standalone output is created
- ✅ Build completes in ~3-5 minutes

**Expected output (final lines):**
```
 => [runner 6/6] COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
 => exporting to image
 => => naming to docker.io/library/sunrise:latest
```

### 2.2 Check Image Size

```bash
docker images sunrise:latest
```

**Expected:**
- Image size should be **~150-200MB**
- If it's over 500MB, something went wrong (likely .dockerignore issue)

### 2.3 Test Production Container

**Create a temporary .env file for testing:**

```bash
cat > .env.test << 'EOF'
DATABASE_URL="postgresql://postgres:postgres@db:5432/sunrise"
BETTER_AUTH_URL="http://localhost:3001"
BETTER_AUTH_SECRET="test-secret-min-32-characters-long-for-testing-only"
NEXT_PUBLIC_APP_URL="http://localhost:3001"
NODE_ENV="production"
EOF
```

**Run production container on a different port:**

```bash
docker run --rm -p 3001:3000 --env-file .env.test sunrise:latest
```

**Note:** This will fail to connect to the database (because we're not running the db container), but it confirms the build is valid.

**Expected:**
- Container starts
- Next.js server starts on port 3000 (mapped to 3001 on host)
- May show database connection errors (expected, since db isn't running)

Press `Ctrl+C` to stop.

### 2.4 Test Full Production Stack

```bash
# Copy environment template
cp .env.example .env

# Edit .env with actual values (at minimum, set BETTER_AUTH_SECRET)
# Generate secret: openssl rand -base64 32

# Start production stack
docker-compose -f docker-compose.prod.yml up -d --build
```

**Check service health:**

```bash
docker-compose -f docker-compose.prod.yml ps
```

**Expected:**
```
NAME            STATUS
sunrise-web     Up (healthy)
sunrise-db      Up (healthy)
sunrise-nginx   Up
```

**Run migrations:**

```bash
docker-compose -f docker-compose.prod.yml exec web npx prisma migrate deploy
```

**Test health endpoint:**

```bash
curl http://localhost:3000/api/health
```

**View production logs:**

```bash
docker-compose -f docker-compose.prod.yml logs -f web
```

**Stop production stack:**

```bash
docker-compose -f docker-compose.prod.yml down
```

---

## Test 3: Verification Checklist

After completing the tests above, verify:

### Development Environment ✓
- [ ] Containers start without errors
- [ ] App accessible at http://localhost:3000
- [ ] Health endpoint returns 200 OK
- [ ] Hot reload works when editing files
- [ ] Database connection successful
- [ ] Prisma Studio works
- [ ] Logs show no errors

### Production Build ✓
- [ ] Production image builds successfully
- [ ] Image size is ~150-200MB
- [ ] No .env files copied to image (security check)
- [ ] Standalone output created correctly

### Production Stack ✓
- [ ] All services start and show (healthy) status
- [ ] Migrations run successfully
- [ ] Health endpoint returns 200 OK
- [ ] App accessible via nginx (if enabled)

---

## Common Issues & Solutions

### Issue: "Cannot connect to Docker daemon"

**Solution:**
- Start Docker Desktop (macOS/Windows)
- Or start Docker service: `sudo systemctl start docker` (Linux)

### Issue: "Port 3000 already in use"

**Solution:**
```bash
# Stop local dev server if running
# Or change port in docker-compose.yml:
ports:
  - "3001:3000"  # Use port 3001 instead
```

### Issue: "Database connection failed"

**Check:**
1. Database container is healthy: `docker-compose ps`
2. Health check passed (wait 30 seconds after start)
3. DATABASE_URL uses service name `db` not `localhost`

### Issue: Hot reload not working

**Check:**
1. Volume mounts are correct in docker-compose.yml
2. You're editing files in the mounted directory
3. File system watching is enabled in Docker Desktop settings

### Issue: Build fails with "npm ci" errors

**Solution:**
```bash
# Rebuild without cache
docker-compose build --no-cache
```

### Issue: "version is obsolete" warning

**Note:** This is safe to ignore. Docker Compose v2 no longer requires the `version` field, but it doesn't cause issues if present. You can optionally remove the first line (`version: '3.8'`) from docker-compose.yml files.

---

## Performance Benchmarks

**Expected performance:**

| Metric | Expected Value |
|--------|----------------|
| First build time | 3-5 minutes |
| Rebuild time (with cache) | 30-60 seconds |
| Container startup | 10-20 seconds |
| Hot reload time | 1-2 seconds |
| Production image size | 150-200MB |
| Dev image size | 800MB-1GB |
| Memory usage (dev) | ~500MB |
| Memory usage (prod) | ~200MB |

---

## Next Steps

Once all tests pass:

1. **Stop all containers:**
   ```bash
   docker-compose down
   ```

2. **Clean up test files:**
   ```bash
   rm .env.test DOCKER-TESTING.md  # Optional
   ```

3. **Ready for deployment!** The Docker setup is production-ready.

---

## Quick Reference

```bash
# Development
docker-compose up              # Start dev environment
docker-compose down            # Stop dev environment
docker-compose logs -f web     # View logs
docker-compose restart web     # Restart app

# Production
docker build -t sunrise:latest .
docker-compose -f docker-compose.prod.yml up -d
docker-compose -f docker-compose.prod.yml down

# Maintenance
docker system prune -f         # Clean up unused resources
docker-compose exec web sh     # Access container shell
```

---

**Happy testing! 🚀**

If you encounter any issues not covered here, check the main documentation or the troubleshooting section in the build plan.
