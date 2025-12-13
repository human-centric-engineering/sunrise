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
- NextAuth.js v5 for authentication
- Tailwind CSS + shadcn/ui components

**Production Ready:**
- Docker containerization
- Email with Resend + React Email
- Zod validation throughout
- Security headers, rate limiting, CORS
- Comprehensive API layer

## Project Status

🚧 **Under Development** - Currently implementing the core foundation. See [`.instructions/SUNRISE-BUILD-PLAN.md`](./.instructions/SUNRISE-BUILD-PLAN.md) for the complete build roadmap.

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
