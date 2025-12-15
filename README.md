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

🚧 **Under Development** - Core foundation in progress. See [`.instructions/SUNRISE-BUILD-PLAN.md`](./.instructions/SUNRISE-BUILD-PLAN.md) for the complete build roadmap.

**Completed:**
- ✅ **Phase 1.1** - Project Initialization (Next.js 16, TypeScript, Tailwind CSS 4, ESLint 9)
- ✅ **Phase 1.2** - Styling Setup (shadcn/ui, dark mode, theme system)
- ✅ **Phase 1.3** - Database Layer (Prisma + PostgreSQL)
- ✅ **Phase 1.4** - Authentication System (better-auth with email/password & Google OAuth)

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
2. **Type-Safe** - TypeScript strict mode everywhere, Zod for runtime validation
3. **Well-Documented** - Code is temporary, decisions are permanent
4. **AI-Optimized** - Structured for AI code generation while remaining human-readable
5. **Fork-Friendly** - Take what you need, customize what you want

## Quick Start

*(Coming soon - setup instructions will be added once core features are implemented)*

## License

MIT

---

Built with ☕ and ⚡ for developers who ship.
