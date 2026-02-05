# Architecture Decisions

Key architectural decisions and their rationale. Reference this when making similar decisions or understanding why things are built a certain way.

## Monolithic Architecture

**Decision:** Single Next.js application with API routes vs. separate backend service

**Chosen:** Monolith

**Rationale:**

- Reduces deployment complexity (single Docker container)
- Simplifies development (no API version sync issues)
- Faster initial development (shared types, no network overhead)
- Scales adequately for expected load (vertical scaling sufficient)

**Trade-offs:**

- Less flexibility for independent service scaling
- Harder to split later if needed
- All code deploys together (no independent releases)

**When to reconsider:** If specific services need independent scaling, different tech stacks, or separate team ownership.

---

## better-auth

**Decision:** better-auth vs. NextAuth.js v5 vs. custom auth vs. SaaS (Auth0/Clerk)

**Chosen:** better-auth

**Rationale:**

- Official recommendation from NextAuth team for new projects
- Built specifically for Next.js App Router
- Simpler architecture (no provider wrapper, uses nanostore)
- Open source, no vendor lock-in
- Flexible (credentials + OAuth support)
- Self-hosted (data ownership, no per-user costs)
- Native Prisma 7 support

**Trade-offs:**

- More setup than SaaS solutions (Auth0/Clerk)
- Requires security knowledge to configure properly
- Smaller community than NextAuth.js (for now)

**When to reconsider:** If you need enterprise SSO (SAML), don't want to manage auth infrastructure, or need advanced features like MFA out of the box.

---

## Prisma ORM

**Decision:** Prisma vs. raw SQL vs. TypeORM vs. Drizzle

**Chosen:** Prisma 7

**Rationale:**

- Type-safe queries with full TypeScript support
- Excellent migrations workflow
- Developer experience (Prisma Studio, autocomplete)
- Prevents SQL injection by design
- Large ecosystem and community

**Trade-offs:**

- Additional abstraction layer
- Slightly reduced query flexibility for complex operations
- Larger bundle size than raw SQL
- Some advanced PostgreSQL features require raw queries

**When to reconsider:** If you need maximum query performance, complex SQL that Prisma doesn't support well, or minimal dependencies.

---

## App Router (Server Components)

**Decision:** App Router vs. Pages Router

**Chosen:** App Router with React Server Components

**Rationale:**

- Future of Next.js (long-term support)
- Better performance (server components reduce client JS)
- Improved data fetching patterns
- Streaming and Suspense support
- Nested layouts

**Trade-offs:**

- Steeper learning curve
- Some community libraries not yet compatible
- More complex mental model (server vs. client components)

**When to reconsider:** This is the clear direction for Next.js; Pages Router is maintenance mode.

---

## Tailwind CSS 4

**Decision:** Tailwind vs. CSS Modules vs. styled-components vs. CSS-in-JS

**Chosen:** Tailwind CSS 4

**Rationale:**

- Utility-first approach speeds development
- No context switching between files
- Excellent with component-based architecture
- Small production bundle (purges unused styles)
- Works well with shadcn/ui

**Trade-offs:**

- Verbose class names in JSX
- Learning curve for utility classes
- v4 is significantly different from v3 (breaking changes)

**When to reconsider:** If team strongly prefers traditional CSS, or project has complex custom design system.

---

## PostgreSQL

**Decision:** PostgreSQL vs. MySQL vs. SQLite vs. NoSQL

**Chosen:** PostgreSQL 15+

**Rationale:**

- Robust, battle-tested relational database
- Excellent JSON support for flexible data
- Strong TypeScript integration via Prisma
- Free and open source
- Widely supported by hosting providers

**Trade-offs:**

- Requires separate database server (not embedded like SQLite)
- More setup than serverless databases

**When to reconsider:** If you need serverless database (PlanetScale, Neon), document-oriented storage (MongoDB), or embedded database (SQLite).

---

## Docker for Deployment

**Decision:** Docker vs. serverless vs. platform-native

**Chosen:** Docker with multi-stage builds

**Rationale:**

- Consistent environment across dev/staging/prod
- Platform-agnostic (works anywhere Docker runs)
- Reproducible builds
- Small production images (~150MB)

**Trade-offs:**

- More infrastructure setup than Vercel/Netlify
- Requires Docker knowledge
- Need to manage container orchestration for scale

**When to reconsider:** If deploying to Vercel (use their native build), or need true serverless scaling.

---

## Database Migrations at Deploy Time

**Decision:** Run migrations during deployment vs. during Docker build

**Chosen:** Migrations run as deployment step (after container starts)

**Rationale:**

- Database doesn't exist during `docker build`
- Migrations modify state, not build artifacts
- Industry standard pattern
- Migration files are included in image, execution happens at deploy time

**Trade-offs:**

- Requires explicit migration step in deployment workflow
- Can't be fully automated in Dockerfile

**When to reconsider:** This is the standard approach; no reason to change.

---

## Adding New Decisions

When making architectural decisions, document them here with:

1. **Decision:** What choice was made
2. **Alternatives considered:** What else was evaluated
3. **Chosen:** The final choice
4. **Rationale:** Why this choice (bullet points)
5. **Trade-offs:** What we gave up
6. **When to reconsider:** Conditions that would change this decision
