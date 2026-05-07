# Sunrise - build production apps faster

A production-ready Next.js 16 starter template designed for rapid application development with AI assistance — now with a complete AI agent orchestration layer baked in.

## Why Sunrise?

- **Production-ready from day one** — Auth, database, APIs, security headers, rate limiting all configured
- **Agent-ready** — Production AI agent orchestration: agents, tools, workflows, knowledge bases (RAG), evaluations, observability
- **Just ask Claude** — Documentation written as AI context; ask questions, get answers, start building
- **Balanced** — Comprehensive yet customizable; not too minimal, not too opinionated
- **Fork-friendly** — Take what you need, customize what you want
- **API-first** — Actions accessible via versioned API endpoints, MCP server, and agent capabilities — ready for agents and integrations

## Tech Stack

| Layer            | Technology                                              |
| ---------------- | ------------------------------------------------------- |
| Framework        | Next.js 16 (App Router) + TypeScript                    |
| Database         | PostgreSQL + Prisma 7 (pgvector for semantic search)    |
| Authentication   | better-auth                                             |
| Styling          | Tailwind CSS 4 + shadcn/ui                              |
| Email            | Resend + React Email                                    |
| Validation       | Zod throughout                                          |
| Deployment       | Docker-ready                                            |
| AI Orchestration | Multi-LLM agents, workflows, RAG, MCP server            |
| LLM Providers    | Anthropic, OpenAI (extensible via provider abstraction) |

## Agent Orchestration

Sunrise ships with a complete AI agent orchestration layer. Admins design, configure, execute, and monitor AI agent systems from `/admin/orchestration`; consumer-facing chat is exposed via `/api/v1/chat` and an embeddable widget.

What's included:

- **Agents** — Configured AI personas with system instructions, model selection, temperature, budgets, and attached capabilities
- **Capabilities (tools)** — Function-calling tools that agents invoke; ships with built-ins (knowledge search, memory, pattern lookup) and a 4-step pipeline for adding custom tools
- **Workflows (DAGs)** — Multi-step pipelines with 15 step types: routing, chaining, parallel branches, RAG retrieval, human approval gates, error strategies, templating
- **Knowledge bases (RAG)** — Document ingestion (MD, PDF, EPUB, DOCX), chunking, embeddings, and pgvector semantic search scoped per agent
- **Multi-LLM providers** — Provider abstraction with fallback chains, model registry, and cost tracking
- **MCP server** — Model Context Protocol integration so Claude Code (or any MCP client) can use your agents and tools
- **Embed widget** — Token-authenticated, CORS-aware chat widget loadable into any site
- **Scheduling & webhooks** — Cron-scheduled autonomous runs and event-driven triggers
- **Evaluations & A/B experiments** — Named-metric scoring (faithfulness, groundedness, relevance) and variant lifecycle
- **Observability** — Execution tracing (OTEL plug-in), conversation export, audit log, approval queue, dashboard analytics

Built on the 21 agentic design patterns from _Agentic Design Patterns_ by Antonio Gullí.

Docs:

- [`.context/orchestration/meta/functional-specification.md`](./.context/orchestration/meta/functional-specification.md) — What the system does (canonical)
- [`.context/admin/orchestration.md`](./.context/admin/orchestration.md) — Admin operator landing, quick start
- [`.context/orchestration/meta/`](./.context/orchestration/meta/) — Architectural decisions, hosting, roadmap, commercial proposition

## Quick Start

### Prerequisites

- Node.js 20.19+ (or 22.12+, 24+)
- PostgreSQL 15+ (local, Docker, or hosted)

### Setup

```bash
# Clone and install
git clone https://github.com/human-centric-engineering/sunrise.git
cd sunrise

# Create environment file
cp .env.example .env.local

## Generate BETTER_AUTH_SECRET
openssl rand -base64 32

# Edit .env.local with:
#  - your DATABASE_URL
#  - your BETTER_AUTH_SECRET

# Install dependencies (will error if the database url isn't valid)
npm install

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
- [**.context/orchestration/meta/functional-specification.md**](./.context/orchestration/meta/functional-specification.md) — Agent orchestration: full system inventory and capability spec

## Just Ask Claude

Sunrise includes comprehensive documentation in `.context/` written specifically as AI context. Instead of reading through docs, just ask Claude:

- _"How do I set up S3 for file uploads?"_
- _"What are the password validation rules?"_
- _"Add a new API endpoint for user preferences"_
- _"How does authentication work in this project?"_
- _"Build me an agent that searches my knowledge base"_
- _"Add a capability so my agent can call the Stripe API"_

Clone the repo, start Claude Code, and start building. Claude already knows how Sunrise works.

### Enhanced Capabilities

Install the Next.js DevTools MCP server for real-time diagnostics and browser automation:

```bash
claude mcp add next-devtools npx next-devtools-mcp@latest
```

See the [Next.js DevTools MCP docs](https://github.com/vercel/next-devtools-mcp) for details.

## Acknowledgements

The 21 design patterns referenced throughout the orchestration learning area are adapted from _Agentic Design Patterns_ by Antonio Gullí.

## License

MIT

---

Built with ☕ and ⚡ for developers who ship.
