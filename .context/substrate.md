# Sunrise Context Substrate

**Project**: Sunrise
**Version**: 1.0.0
**Stack**: Next.js 16 (App Router), TypeScript, PostgreSQL, Prisma 7, better-auth
**Architecture**: Monolithic with API routes, server/client component separation
**Last Updated**: 2026-01-19

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

### 🛡️ [Error Handling & Logging](./errors/overview.md)

Comprehensive error handling, structured logging, and error tracking. Includes:

- [Overview](./errors/overview.md) - Four-layer error architecture, error boundaries, distributed tracing
- [Logging Best Practices](./errors/logging.md) - Structured logging guidelines, log levels, performance

**Use When**: Implementing error handling, adding logging, debugging production issues, setting up error tracking

**Key Features**: Structured logging (JSON/colored), request ID tracing, Sentry integration, user-friendly messages, automatic PII sanitization

### 🔒 [Security](./security/overview.md)

Application-wide security utilities and configuration. Includes:

- [Overview](./security/overview.md) - CSP, CORS, rate limiting, input sanitization, security headers

**Use When**: Configuring security headers, setting up CORS, implementing rate limiting, sanitizing user input

**Key Features**: Environment-specific CSP, configurable CORS via env vars, LRU-based rate limiting, XSS prevention utilities

**Note**: For authentication-specific security (passwords, sessions, OAuth), see [Auth Security](./auth/security.md)

### 📊 [Monitoring & Observability](./monitoring/overview.md)

Production-ready monitoring, performance tracking, and observability. Includes:

- [Overview](./monitoring/overview.md) - Monitoring architecture, quick start guide
- [Performance](./monitoring/performance.md) - Performance measurement utilities
- [Health Checks](./monitoring/health-checks.md) - Health endpoint configuration
- [Sentry Setup](./monitoring/sentry-setup.md) - Error tracking integration
- [Log Aggregation](./monitoring/log-aggregation.md) - DataDog, CloudWatch, Grafana setup
- [Web Vitals](./monitoring/web-vitals.md) - Frontend performance monitoring

**Use When**: Setting up monitoring, tracking performance, configuring health checks, integrating with external services

**Key Features**: Performance measurement (`measureAsync`, `trackDatabaseQuery`), enhanced health checks with service status, status page components, Sentry integration, log aggregation guides

### 🎨 [UI Patterns](./ui/overview.md)

Reusable UI patterns and component conventions. Includes:

- [Overview](./ui/overview.md) - URL-persistent tabs, form patterns, state management
- [Marketing](./ui/marketing.md) - Landing page components, hero sections, pricing displays

**Use When**: Building tabbed interfaces, landing pages, marketing sections, URL state management

**Key Patterns**: `useUrlTabs` hook for URL-synced tabs, marketing component library (Hero, Features, Pricing, FAQ, CTA, Section)

### 🛠️ [Admin](./admin/overview.md)

Admin dashboard for system management and user administration. Includes:

- [Overview](./admin/overview.md) - Admin architecture, role-based access, dashboard features

**Use When**: Building admin features, managing users, viewing system logs, configuring feature flags

**Key Features**: System statistics dashboard, user management (list, view, edit, invite), log viewer with filtering, feature flag management (CRUD operations)

### 🔒 [Privacy & Consent](./privacy/overview.md)

Cookie consent system and GDPR compliance. Includes:

- [Overview](./privacy/overview.md) - Consent management, conditional scripts, configuration

**Use When**: Implementing cookie banners, loading analytics conditionally, GDPR compliance

**Key Features**: `ConsentProvider` context, `useConsent` hook, `ConditionalScript` for optional scripts, localStorage persistence

### 🔍 [SEO & Discovery](./seo/overview.md)

Search engine optimization, sitemaps, and social sharing. Includes:

- [Overview](./seo/overview.md) - robots.txt, sitemap, metadata patterns

**Use When**: Adding public pages, configuring social sharing, improving search visibility

**Key Features**: Dynamic sitemap generation, robots.txt configuration, OpenGraph and Twitter Card patterns

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
Cross-reference .context/security/overview.md and .context/auth/security.md for:
- CSP and security headers → security/overview.md
- CORS configuration → security/overview.md
- Rate limiting → security/overview.md
- Input sanitization → security/overview.md
- Authentication security → auth/security.md
- Session management → auth/security.md
```

## Navigation Quick Reference

| Task                       | Primary Context               | Supporting Context                              |
| -------------------------- | ----------------------------- | ----------------------------------------------- |
| Add new page               | architecture/overview.md      | architecture/patterns.md                        |
| Build API endpoint         | api/endpoints.md              | api/headers.md, database/models.md              |
| Modify database            | database/schema.md            | database/migrations.md                          |
| Add auth provider          | auth/integration.md           | auth/security.md                                |
| Configure environment      | environment/overview.md       | environment/reference.md                        |
| Deploy application         | deployment/overview.md        | environment/overview.md, database/migrations.md |
| Set up Docker              | deployment/overview.md        | environment/overview.md                         |
| Configure CI/CD            | deployment/overview.md        | guidelines.md                                   |
| Add error handling         | errors/overview.md            | errors/logging.md                               |
| Debug production           | errors/logging.md             | errors/overview.md, api/endpoints.md            |
| Set up error tracking      | errors/overview.md            | environment/overview.md                         |
| Add tabbed interface       | ui/overview.md                | architecture/patterns.md                        |
| URL state management       | ui/overview.md                | architecture/patterns.md                        |
| Build landing pages        | ui/marketing.md               | ui/overview.md                                  |
| Configure cookie consent   | privacy/overview.md           | security/overview.md                            |
| Configure SEO/sitemap      | seo/overview.md               | deployment/overview.md                          |
| Add contact form           | api/endpoints.md              | email/overview.md                               |
| Configure CSP/headers      | security/overview.md          | api/headers.md                                  |
| Set up CORS                | security/overview.md          | environment/overview.md                         |
| Add rate limiting          | security/overview.md          | auth/security.md                                |
| Sanitize user input        | security/overview.md          | api/endpoints.md                                |
| Secure auth flows          | auth/security.md              | security/overview.md                            |
| Add performance monitoring | monitoring/performance.md     | monitoring/overview.md                          |
| Configure health checks    | monitoring/health-checks.md   | deployment/overview.md                          |
| Set up Sentry              | monitoring/sentry-setup.md    | errors/overview.md                              |
| Configure log aggregation  | monitoring/log-aggregation.md | monitoring/overview.md                          |
| Add status page            | monitoring/health-checks.md   | monitoring/overview.md                          |
| Build admin dashboard      | admin/overview.md             | architecture/overview.md, api/endpoints.md      |
| Manage users (admin)       | admin/overview.md             | database/schema.md, api/endpoints.md            |
| Add feature flags          | admin/overview.md             | database/schema.md, api/endpoints.md            |
| View system logs           | admin/overview.md             | errors/logging.md                               |

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
