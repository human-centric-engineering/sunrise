# Agent Orchestration Layer — Context for Claude Code

## What This Is

We are building an Agent Orchestration Layer into the Sunrise admin dashboard.
This allows admins to design, configure, execute, and monitor AI agent systems
using 21 agentic design patterns.

## Key Reference Documents

- `.claude/skills/agent-architect/` — Architectural decision-making skill

## Architecture Decisions

- All orchestration services go in lib/orchestration/ (platform-agnostic)
- All new Prisma models go in prisma/schema.prisma following existing conventions
- All new API routes go under app/api/v1/admin/orchestration/\*
- All new admin pages go under app/admin/orchestration/\*
- All new components go under components/admin/orchestration/\*
- All new validation schemas go in lib/validations/orchestration.ts
- All new types go in types/orchestration.ts
- The vector DB uses pgvector extension on PostgreSQL
- SSE (Server-Sent Events) for streaming agent responses to clients
- LLM provider abstraction supporting Anthropic, OpenAI, Ollama, and any OpenAI-compatible provider

## Critical: Platform-Agnostic Core

lib/orchestration/ MUST be pure TypeScript. It must NEVER import from
'next/server', 'next/headers', 'next/cache', or any Next.js-specific module.

The separation is:

- lib/orchestration/\* — pure TypeScript core. Chat handler returns
  AsyncIterable<ChatEvent> (typed plain objects), NOT HTTP responses.
- app/api/v1/admin/orchestration/\* — thin Next.js wrappers (~30 lines each)
  that handle auth, request parsing, SSE formatting, and delegate to the core.

## API-First Rule

Every capability must be API-accessible before any UI is built.
All API endpoints are built in Phase 3. All UI is built in Phase 4+.

## Multi-Tenant Note

Scope all agent data by userId. Organisation scoping can be added later.
