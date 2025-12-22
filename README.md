# Sunrise 🌅

A production-ready Next.js starter template designed for rapid application development with AI assistance.

## What is Sunrise?

Sunrise is a modern full-stack starter that gets you from zero to production-ready application in minutes, not days. Built with best practices baked in, it's optimized for both human developers and AI-assisted development workflows.

## Why Sunrise?

Most starter templates are either too minimal (just a scaffold) or too opinionated (locked into specific patterns). Sunrise strikes the balance: comprehensive yet customizable, production-ready yet approachable.

**Built for:**

- Teams shipping MVPs quickly
- Solo developers who want to focus on features, not infrastructure
- Projects that need production-grade auth, database, and APIs from day one
- AI-assisted development (Claude, GitHub Copilot, etc.)

## Tech Stack

**Core:**

- Next.js 16 (App Router) with TypeScript
- PostgreSQL + Prisma ORM
- better-auth for authentication
- Tailwind CSS + shadcn/ui components

**Production Ready:**

- Docker containerization
- Email with Resend + React Email
- Zod validation throughout
- Security headers, rate limiting, CORS
- Comprehensive API layer

## Project Status

🚧 **Under Development** - Core foundation complete, production features in progress. See [`.instructions/SUNRISE-BUILD-PLAN.md`](./.instructions/SUNRISE-BUILD-PLAN.md) for the complete build roadmap and [`.instructions/BUILD-PROGRESS-TRACKER.md`](./.instructions/BUILD-PROGRESS-TRACKER.md) for detailed progress tracking

## Documentation

- **[CLAUDE.md](./CLAUDE.md)** - Quick reference for AI-assisted development
- **[.context/substrate.md](./.context/substrate.md)** - Comprehensive architecture and implementation docs
- **[Build Plan](./.instructions/SUNRISE-BUILD-PLAN.md)** - Detailed implementation roadmap

## AI-Assisted Development

This project is optimized for AI-assisted development with Claude Code. To get the most out of working with Claude and Next.js:

**Install the Next.js DevTools MCP server:**

```bash
claude mcp add next-devtools npx next-devtools-mcp@latest
```

Then restart your Claude session to enable:

- Real-time Next.js documentation access
- Runtime diagnostics and error detection
- Browser automation testing
- Cache Components migration tools
- Next.js 16 upgrade assistance

The MCP server provides Claude with direct access to your running Next.js dev server, latest documentation, and specialized tooling for Next.js development. See [the official docs](https://github.com/vercel/next-devtools-mcp) for detailed usage instructions.

## Route Organization

The app uses Next.js 14+ route groups for clean separation of concerns:

- **`(auth)`** - Authentication pages (login, signup, password reset) with minimal layout
- **`(protected)`** - All authenticated routes requiring login
  - Currently includes: `dashboard/`, `settings/`, `profile/`
  - Add new protected features here as directories (e.g., `(protected)/analytics/`)
- **`(public)`** - All public routes (marketing, landing page, etc.)
  - Add new public pages here (e.g., `(public)/about/`, `(public)/pricing/`)

### Adding New Pages

**Same layout as existing section?** Add as a subdirectory

- Protected feature with dashboard UI → `app/(protected)/analytics/page.tsx`
- Public page with marketing UI → `app/(public)/pricing/page.tsx`

**Different layout needed?** Create a new route group

- Admin panel with different UI → `app/(admin)/layout.tsx` + `app/(admin)/users/page.tsx`
- Documentation site → `app/(docs)/layout.tsx` + `app/(docs)/getting-started/page.tsx`

**Examples:**

- Blog with same marketing UI: `(public)/blog/` ✓
- Admin panel with different UI: `(admin)/` with custom layout ✓
- Customer portal: `(protected)/portal/` if same dashboard UI, or `(portal)/` if different ✓

See [`.context/architecture/overview.md`](./.context/architecture/overview.md) for detailed architecture patterns.

## Styling & Theming

**Theme System:**

- Dark mode toggle available via `<ThemeToggle />` component
- Toggles between light and dark modes
- On first visit: detects system preference, saves to localStorage, defaults to light
- Theme persisted to localStorage
- Modify theme variables in `app/globals.css` (HSL-based color system)

**UI Components:**

- **shadcn/ui** - Pre-built, customizable components in `components/ui/`
  - Add more components: `npx shadcn-ui@latest add [component-name]`
  - Customize components directly in `components/ui/` - they're your code
- **Lucide React** - Icon library available throughout the app
  - Import icons: `import { IconName } from 'lucide-react'`
  - Browse icons: [lucide.dev](https://lucide.dev)

## Database Setup

**Quick Start:**

1. Set your PostgreSQL connection string in `.env`:
   ```bash
   DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=public"
   ```
2. Run migrations to create the database schema:
   ```bash
   npm run db:migrate
   ```
3. (Optional) Seed with test data:
   ```bash
   npm run db:seed
   ```
4. Verify connection: Visit http://localhost:3000/api/health

**Database Scripts:**

- `npm run db:migrate` - Create and apply migrations
- `npm run db:push` - Push schema changes without migration (development)
- `npm run db:studio` - Open Prisma Studio (database GUI)
- `npm run db:seed` - Populate database with test users
- `npm run db:generate` - Regenerate Prisma client after schema changes

**Note:** This project uses Prisma 7 with PostgreSQL. The database schema includes User, Account, Session, and Verification models ready for better-auth authentication.

## Philosophy

1. **Production-First** - Security, performance, and reliability are not afterthoughts
2. **API-First** - Every UI capability is accessible via API for maximum interoperability with AI agents and external systems
3. **Type-Safe** - TypeScript strict mode everywhere, Zod for runtime validation
4. **Well-Documented** - Code is temporary, decisions are permanent
5. **AI-Optimized** - Structured for AI code generation while remaining human-readable
6. **Fork-Friendly** - Take what you need, customize what you want

## Quick Start

### Prerequisites

- Node.js 18+ and npm
- PostgreSQL 15+ (local or hosted)
- Git

### Setup

1. **Clone and install dependencies:**

   ```bash
   git clone https://github.com/human-centric-engineering/sunrise.git
   cd sunrise
   npm install
   ```

2. **Set up environment variables:**

   ```bash
   cp .env.example .env.local
   ```

   Edit `.env.local` and configure the required variables:

   ```bash
   # Database (Required)
   DATABASE_URL="postgresql://user:password@localhost:5432/sunrise"

   # Authentication (Required)
   BETTER_AUTH_SECRET="your-32-character-secret-here"  # Generate: openssl rand -base64 32
   BETTER_AUTH_URL="http://localhost:3000"
   NEXT_PUBLIC_APP_URL="http://localhost:3000"

   # OAuth (Optional)
   GOOGLE_CLIENT_ID="your-google-client-id"
   GOOGLE_CLIENT_SECRET="your-google-client-secret"
   ```

   **📖 For detailed configuration:** See [Environment Configuration](./.context/environment/overview.md) for:
   - Complete variable reference and descriptions
   - Environment-specific setup (development vs. production)
   - Troubleshooting guide
   - Security best practices

3. **Set up the database:**

   ```bash
   npm run db:migrate    # Create database schema
   npm run db:seed       # (Optional) Add test users
   ```

4. **Start the development server:**

   ```bash
   npm run dev
   ```

5. **Open your browser:**
   - App: http://localhost:3000
   - Health check: http://localhost:3000/api/health

### Quick Start with Docker

If you prefer Docker, the entire development environment (Next.js + PostgreSQL) is containerized and ready to use:

1. **Clone the repository:**

   ```bash
   git clone https://github.com/human-centric-engineering/sunrise.git
   cd sunrise
   ```

2. **Start the development environment:**

   ```bash
   docker-compose up
   ```

   The Docker setup:
   - ✅ Installs all dependencies automatically
   - ✅ Sets up PostgreSQL database
   - ✅ Starts Next.js dev server with hot-reload
   - ✅ Handles all port mapping

3. **Run database migrations** (in a new terminal, first time only):

   ```bash
   docker-compose exec web npx prisma migrate dev
   ```

   This creates the database tables. Run this:
   - On first setup
   - After pulling database schema changes
   - When you modify `prisma/schema.prisma`

4. **(Optional) Seed with test data:**

   ```bash
   docker-compose exec web npm run db:seed
   ```

5. **Access the application:**
   - App: http://localhost:3000
   - Database: localhost:5432 (postgres/postgres/sunrise)
   - Health check: http://localhost:3000/api/health

**Daily development commands:**

```bash
docker-compose up              # Start dev environment
docker-compose down            # Stop all services
docker-compose logs -f web     # View app logs
```

**Note:** The Docker development environment uses volume mounts, so changes to your code trigger hot-reload just like `npm run dev` locally.

- Database GUI: `npm run db:studio`

### Test Accounts (after seeding)

- **User**: test@example.com / password123
- **Admin**: admin@example.com / password123

### Development Commands

```bash
npm run dev           # Start dev server
npm run build         # Build for production
npm run lint          # Run ESLint
npm run type-check    # Run TypeScript checks
npm run validate      # Run all checks (type + lint + format)
npm run db:studio     # Open Prisma Studio
```

### Docker Setup (Optional)

```bash
docker-compose up     # Start app + database
docker-compose down   # Stop all services
```

For detailed deployment instructions, see [`.instructions/DEPLOYMENT.md`](./.instructions/DEPLOYMENT.md)

## License

MIT

---

Built with ☕ and ⚡ for developers who ship.
