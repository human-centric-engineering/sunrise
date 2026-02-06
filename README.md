# Sunrise - build production apps faster

A production-ready Next.js 16 starter template designed for rapid application development with AI assistance.

## Why Sunrise?

- **Production-ready from day one** — Auth, database, APIs, security headers, rate limiting all configured
- **Just ask Claude** — Documentation written as AI context; ask questions, get answers, start building
- **Balanced** — Comprehensive yet customizable; not too minimal, not too opinionated
- **Fork-friendly** — Take what you need, customize what you want

## Tech Stack

| Layer          | Technology                           |
| -------------- | ------------------------------------ |
| Framework      | Next.js 16 (App Router) + TypeScript |
| Database       | PostgreSQL + Prisma 7                |
| Authentication | better-auth                          |
| Styling        | Tailwind CSS 4 + shadcn/ui           |
| Email          | Resend + React Email                 |
| Validation     | Zod throughout                       |
| Deployment     | Docker-ready                         |

## Quick Start

### Prerequisites

- Node.js 20.19+ (or 22.12+, 24+)
- PostgreSQL 15+ (local, Docker, or hosted)

### Setup

```bash
# Clone and install
git clone https://github.com/human-centric-engineering/sunrise.git
cd sunrise
npm install

# Configure environment
cp .env.example .env.local
# Edit .env.local with your DATABASE_URL and BETTER_AUTH_SECRET

# Set up database
npm run db:migrate

# Start development
npm run dev
```

Open http://localhost:3000 to see the app.

### Using Docker

```bash
docker-compose up                                    # Start app + database
docker-compose exec web npx prisma migrate dev       # Run migrations (first time)
```

### Test Accounts (after `npm run db:seed`)

- **User**: test@example.com / password123
- **Admin**: admin@example.com / password123

## Essential Commands

```bash
npm run dev              # Start dev server
npm run validate         # Type-check + lint + format + tests
npm run db:studio        # Open Prisma Studio
npm test                 # Run tests
```

Full command reference: [`.context/commands.md`](./.context/commands.md)

## Optional Features

These work without configuration in development and can be enabled for production:

- **Email** — Console logging in dev; configure Resend for production. See [`.context/email/`](./.context/email/)
- **Analytics** — Console provider in dev; configure PostHog/GA4/Plausible for production. See [`.context/analytics/`](./.context/analytics/)
- **File Storage** — Local filesystem in dev; configure S3/R2/Vercel Blob for production. See [`.context/storage/`](./.context/storage/)

## Documentation

- [**CUSTOMIZATION.md**](./CUSTOMIZATION.md) — Adapt Sunrise for your project
- [**.context/substrate.md**](./.context/substrate.md) — Full architecture and reference docs

## Just Ask Claude

Sunrise includes comprehensive documentation in `.context/` written specifically as AI context. Instead of reading through docs, just ask Claude:

- _"How do I set up S3 for file uploads?"_
- _"What are the password validation rules?"_
- _"Add a new API endpoint for user preferences"_
- _"How does authentication work in this project?"_

Clone the repo, start Claude Code, and start building. Claude already knows how Sunrise works.

### Enhanced Capabilities

Install the Next.js DevTools MCP server for real-time diagnostics and browser automation:

```bash
claude mcp add next-devtools npx next-devtools-mcp@latest
```

See the [Next.js DevTools MCP docs](https://github.com/vercel/next-devtools-mcp) for details.

## License

MIT

---

Built with ☕ and ⚡ for developers who ship.
