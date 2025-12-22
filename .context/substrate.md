# Sunrise Context Substrate

**Project**: Sunrise
**Version**: 1.0.0
**Stack**: Next.js 16 (App Router), TypeScript, PostgreSQL, Prisma 7, better-auth
**Architecture**: Monolithic with API routes, server/client component separation
**Last Updated**: 2025-12-15

## Overview

Sunrise is a production-ready Next.js starter template optimized for rapid application development with AI assistance. This substrate documents the system's architecture, patterns, and implementation details to provide both human developers and AI systems with comprehensive context.

The project follows a monolithic architecture with clear separation of concerns: server components for data fetching, client components for interactivity, API routes for external access, and Prisma for database operations. This structure enables fast development while maintaining type safety and scalability.

## Purpose & Methodology

This `.context/` substrate implements **Documentation as Code as Context** - a methodology that organizes project knowledge into domain-specific, AI-optimized modules. Each domain is versioned with the codebase, ensuring documentation evolves alongside implementation.

**Key Benefits:**

- **AI Context Precision**: Structured domains enable targeted context loading for LLM operations
- **Human Onboarding**: New developers understand architecture decisions and patterns quickly
- **Decision Capture**: Trade-offs and rationale are documented, preventing architectural drift
- **Implementation Focus**: Actionable patterns and examples, not theoretical concepts

## Domain Structure

### 📐 [Architecture](./architecture/overview.md)

System design, component boundaries, and architectural patterns. Includes:

- [Overview](./architecture/overview.md) - High-level system architecture with Mermaid diagrams
- [Dependencies](./architecture/dependencies.md) - Dependency injection and management patterns
- [Patterns](./architecture/patterns.md) - Code organization, error handling, and conventions

**Use When**: Understanding system structure, adding major features, making architectural decisions, organizing route groups

**Route Organization**: See overview.md for how to use `(auth)`, `(protected)`, and `(public)` route groups

### 🔐 [Authentication](./auth/overview.md)

Authentication and authorization implementation with better-auth. Includes:

- [Overview](./auth/overview.md) - Authentication flows and session management
- [Integration](./auth/integration.md) - Next.js App Router integration patterns
- [Security](./auth/security.md) - Security model, threats, and mitigations

**Use When**: Implementing auth features, securing endpoints, managing sessions, adding OAuth providers

### 🌐 [API](./api/endpoints.md)

RESTful API design and implementation patterns. Includes:

- [Endpoints](./api/endpoints.md) - API reference with all route handlers
- [Headers](./api/headers.md) - HTTP headers, CORS, and middleware
- [Examples](./api/examples.md) - Client implementations and usage patterns

**Use When**: Building API routes, integrating with external clients, handling requests

### 💾 [Database](./database/schema.md)

PostgreSQL schema, Prisma models, and data patterns. Includes:

- [Schema](./database/schema.md) - Database design with ERD diagrams
- [Models](./database/models.md) - Prisma models and validation patterns
- [Migrations](./database/migrations.md) - Migration strategy and workflow

**Use When**: Modifying database schema, creating models, running migrations

### ⚙️ [Environment](./environment/overview.md)

Environment variable configuration, validation, and management. Includes:

- [Overview](./environment/overview.md) - Setup guide, patterns, and troubleshooting
- [Reference](./environment/reference.md) - Complete variable documentation with examples

**Use When**: Setting up new environments, configuring deployment, adding new variables, troubleshooting configuration issues

**Key Features**: Zod validation, type-safe access, fail-fast startup behavior

### 🚀 [Deployment](./deployment/overview.md)

Deployment strategies, Docker configuration, and platform-specific guides. Includes:

- [Overview](./deployment/overview.md) - Deployment workflows, Docker setup, platform comparison

**Use When**: Deploying to production, setting up Docker, configuring CI/CD, troubleshooting deployments

**Key Features**: Multi-stage Docker builds, migration workflow, health checks, platform guides

### 📋 [Guidelines](./guidelines.md)

Development workflow, testing, deployment, and operational procedures.

**Use When**: Setting up development environment, deploying, following team conventions

## AI Usage Patterns

### For Code Generation

```
Load context from .context/[domain]/ for specific features:
- Authentication feature → load .context/auth/
- API endpoint → load .context/api/
- Database model → load .context/database/
```

### For Architectural Decisions

```
Reference .context/architecture/overview.md for:
- Component placement (server vs client)
- API vs direct database access
- Caching and performance strategies
```

### For Security Review

```
Cross-reference .context/auth/security.md and .context/api/headers.md for:
- Authentication verification
- Authorization checks
- Input validation
- Rate limiting
```

## Navigation Quick Reference

| Task                  | Primary Context          | Supporting Context                              |
| --------------------- | ------------------------ | ----------------------------------------------- |
| Add new page          | architecture/overview.md | architecture/patterns.md                        |
| Build API endpoint    | api/endpoints.md         | api/headers.md, database/models.md              |
| Modify database       | database/schema.md       | database/migrations.md                          |
| Add auth provider     | auth/integration.md      | auth/security.md                                |
| Configure environment | environment/overview.md  | environment/reference.md                        |
| Deploy application    | deployment/overview.md   | environment/overview.md, database/migrations.md |
| Set up Docker         | deployment/overview.md   | environment/overview.md                         |
| Configure CI/CD       | deployment/overview.md   | guidelines.md                                   |

## Technology Stack

**Core Framework:**

- Next.js 14+ with App Router (React Server Components)
- TypeScript 5+ in strict mode
- React 18+ (server/client components)

**Data Layer:**

- PostgreSQL 15+ (relational database)
- Prisma ORM (type-safe query builder)
- Zod (runtime validation)

**Authentication:**

- better-auth (authentication framework, official NextAuth successor)
- bcrypt (password hashing, handled by better-auth)
- Session management with nanostore (no provider wrapper needed)

**UI/Styling:**

- Tailwind CSS 3+ (utility-first styling)
- shadcn/ui (accessible component library)
- Lucide React (icon library)

**Email:**

- Resend (email delivery API)
- React Email (email templates)

**Infrastructure:**

- Docker (containerization)
- Nginx (reverse proxy for production)
- Node.js 20+ Alpine (runtime)

## Decision History & Trade-offs

### Monolithic Architecture

**Decision**: Single Next.js application with API routes vs. separate backend service
**Rationale**:

- Reduces deployment complexity (single Docker container)
- Simplifies development (no API version sync issues)
- Faster initial development (shared types, no network overhead)
- Scales adequately for expected load (vertical scaling sufficient)

**Trade-offs**: Less flexibility for independent service scaling, harder to split later if needed

### Prisma ORM

**Decision**: Prisma vs. raw SQL or TypeORM
**Rationale**:

- Type-safe queries with full TypeScript support
- Excellent migrations workflow
- Developer experience (Prisma Studio, autocomplete)
- Prevents SQL injection by design

**Trade-offs**: Additional abstraction layer, slightly reduced query flexibility for complex operations

### better-auth

**Decision**: better-auth vs. NextAuth.js v5 or custom auth
**Rationale**:

- Official recommendation from NextAuth team for new projects
- Built specifically for Next.js App Router
- Simpler architecture (no provider wrapper, uses nanostore)
- Open source, no vendor lock-in
- Flexible (credentials + OAuth support)
- Self-hosted (data ownership, no per-user costs)
- Native Prisma 7 support

**Trade-offs**: More setup than SaaS solutions (Auth0/Clerk), requires security knowledge to configure properly, smaller community than NextAuth.js

### App Router (Server Components)

**Decision**: App Router vs. Pages Router
**Rationale**:

- Future of Next.js (long-term support)
- Better performance (server components reduce client JS)
- Improved data fetching patterns
- Streaming and Suspense support

**Trade-offs**: Steeper learning curve, some community libraries not yet compatible

## Versioning & Maintenance

This substrate follows semantic versioning tied to the application codebase:

- **Major version**: Breaking architectural changes (e.g., database migration, auth system swap)
- **Minor version**: New features or domains added (e.g., new API endpoints, new patterns)
- **Patch version**: Documentation improvements, clarifications, example updates

**Update Frequency**: Document changes should be committed alongside code changes that affect architecture, APIs, or data models.

**Review Schedule**: Architecture documents should be reviewed quarterly to ensure alignment with implementation.

## Getting Started

**For Human Developers:**

1. Read [Architecture Overview](./architecture/overview.md) for system understanding
2. Review [Guidelines](./guidelines.md) for development setup
3. Reference domain-specific docs as needed during development

**For AI Systems:**

1. Load `.context/substrate.md` for project overview
2. Load specific domains based on task context
3. Cross-reference related domains for complete context
4. Follow patterns in code examples exactly

## Contributing to Documentation

When updating this substrate:

- Keep code examples realistic and tested
- Include decision rationale for architectural choices
- Update Mermaid diagrams when system structure changes
- Maintain 400-800 word target per domain file
- Cross-reference related sections
- Update version and last-updated date

## Support

For questions about this documentation:

- Check [Guidelines](./guidelines.md) for development workflows
- Review build plan in `.instructions/HCE-BASE-BUILD-PLAN.md`
- See `CLAUDE.md` for AI-specific development guidance
