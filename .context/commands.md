# Command Reference

Complete list of commands for the Sunrise project.

## Development

```bash
npm run dev              # Start development server (port 3000)
npm run build            # Build for production
npm run start            # Start production server
npm run lint             # Run ESLint
npm run lint:fix         # Fix linting issues
npm run format           # Format code with Prettier
npm run format:check     # Check formatting
npm run type-check       # Run TypeScript compiler
npm run validate         # Run type-check + lint + format check (use before commits)
```

## Database (Prisma)

```bash
npm run db:migrate       # Create and apply new migration
npm run db:push          # Push schema changes without migration (dev only)
npm run db:studio        # Open Prisma Studio GUI
npm run db:seed          # Run seed script
npx prisma generate      # Regenerate Prisma client after schema changes
npx prisma validate      # Validate schema syntax
```

## Testing

```bash
npm run test             # Run tests with Vitest
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage report
```

## Email

```bash
npm run email:dev        # Preview email templates at localhost:3001
```

## Docker — Development

```bash
# Lifecycle
docker-compose up                    # Start all services
docker-compose up --build            # Rebuild and start
docker-compose up -d                 # Start in background (detached)
docker-compose down                  # Stop all services
docker-compose down -v               # Stop and remove volumes (resets database)

# Logs
docker-compose logs -f web           # View app logs
docker-compose logs -f db            # View database logs

# Database operations in container
docker-compose exec web npx prisma migrate dev  # Run migrations
docker-compose exec web npx prisma studio       # Open Prisma Studio
docker-compose exec db psql -U postgres -d sunrise  # Access database CLI

# Maintenance
docker-compose restart web           # Restart app without rebuilding
```

## Docker — Production

```bash
# Build
docker build -t sunrise:latest .     # Build production image
docker images sunrise:latest         # Check image size (should be ~150-200MB)

# Lifecycle
docker-compose -f docker-compose.prod.yml up -d --build  # Build and start
docker-compose -f docker-compose.prod.yml down            # Stop stack

# Operations
docker-compose -f docker-compose.prod.yml exec web npx prisma migrate deploy  # Run migrations
docker-compose -f docker-compose.prod.yml logs -f web     # View logs
docker-compose -f docker-compose.prod.yml ps              # Check service health

# Cleanup
docker system prune -f               # Clean up unused Docker resources
```

## Health Check

```bash
curl http://localhost:3000/api/health  # Test health endpoint
```

## Git Hooks

The project has pre-configured git hooks:

**Pre-commit** (automatic):

- Runs `lint-staged` on staged files
- Formats with Prettier
- Fixes ESLint issues

**Pre-push** (automatic):

- Runs TypeScript type-check

**Bypass (emergency only):**

```bash
git commit --no-verify -m "emergency fix"
git push --no-verify
```
