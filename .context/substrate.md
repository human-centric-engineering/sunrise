# Context Substrate

Entry point for the `.context/` documentation system. Load specific domains based on your task.

**Project:** Sunrise — Next.js 16 starter template
**Stack:** Next.js 16, React 19, Prisma 7, Tailwind 4, better-auth
**Updated:** 2026-02-06

## How to Use

**AI assistants:** Load the domain file(s) relevant to your current task. Don't load everything.

**Humans:** Browse domains below, read overview files first, then drill into specifics.

## Domain Index

| Domain               | Path            | Use For                                         |
| -------------------- | --------------- | ----------------------------------------------- |
| **Architecture**     | `architecture/` | System design, route groups, component patterns |
| **Authentication**   | `auth/`         | better-auth, sessions, OAuth, guards, security  |
| **API**              | `api/`          | Endpoints, responses, headers, CORS             |
| **Database**         | `database/`     | Prisma schema, models, migrations               |
| **Environment**      | `environment/`  | Env vars, validation, per-category setup        |
| **Deployment**       | `deployment/`   | Docker, platforms, CI/CD                        |
| **Errors & Logging** | `errors/`       | Error handling, structured logging, Sentry      |
| **Security**         | `security/`     | CSP, CORS, rate limiting, sanitization          |
| **Monitoring**       | `monitoring/`   | Health checks, performance, observability       |
| **Testing**          | `testing/`      | Patterns, mocking, async, edge cases            |
| **UI Patterns**      | `ui/`           | Tabs, forms, marketing components               |
| **Admin**            | `admin/`        | Dashboard, user management, feature flags       |
| **Privacy**          | `privacy/`      | Cookie consent, GDPR                            |
| **Storage**          | `storage/`      | File uploads, S3/Vercel Blob                    |
| **Analytics**        | `analytics/`    | Event tracking, providers                       |
| **SEO**              | `seo/`          | Sitemap, robots.txt, metadata                   |
| **Email**            | `email/`        | React Email templates, sending                  |
| **Types**            | `types/`        | TypeScript patterns, conventions                |
| **Commands**         | `commands.md`   | All CLI commands reference                      |
| **Workflow**         | `workflow.md`   | Git, commits, PR process                        |

## Task Lookup

| Task                      | Start Here                    | Also See                   |
| ------------------------- | ----------------------------- | -------------------------- |
| **Add API endpoint**      | `api/endpoints.md`            | `api/headers.md`           |
| **Add protected page**    | `architecture/overview.md`    | `auth/integration.md`      |
| **Add database model**    | `database/schema.md`          | `database/migrations.md`   |
| **Add OAuth provider**    | `auth/oauth.md`               | `auth/security.md`         |
| **Protect a route**       | `auth/integration.md`         | `auth/sessions.md`         |
| **Add environment var**   | `environment/overview.md`     | `environment/reference.md` |
| **Deploy to production**  | `deployment/overview.md`      | `environment/overview.md`  |
| **Add error handling**    | `errors/overview.md`          | `errors/logging.md`        |
| **Add rate limiting**     | `security/overview.md`        | `auth/security.md`         |
| **Write tests**           | `testing/patterns.md`         | `testing/mocking.md`       |
| **Mock dependencies**     | `testing/mocking.md`          | `testing/async-testing.md` |
| **Add file uploads**      | `storage/overview.md`         | `security/overview.md`     |
| **Add analytics**         | `analytics/overview.md`       | `privacy/overview.md`      |
| **Build admin feature**   | `admin/overview.md`           | `api/admin-endpoints.md`   |
| **Add health checks**     | `monitoring/health-checks.md` | `monitoring/overview.md`   |
| **Create email template** | `email/overview.md`           | `ui/forms.md`              |
| **Add type patterns**     | `types/overview.md`           | `types/conventions.md`     |

## Architecture Decisions

Key decisions and rationale are documented in `architecture/decisions.md`:

- Monolithic vs microservices → monolith chosen for simplicity
- better-auth vs NextAuth.js → better-auth for App Router native support
- Prisma vs raw SQL → Prisma for type safety and DX
- App Router vs Pages Router → App Router for RSC and future support

## Related Files

- `CLAUDE.md` — AI assistant rules and quick reference
- `README.md` — Intro, overview, and getting started for humans
