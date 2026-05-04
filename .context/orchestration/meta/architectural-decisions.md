# Orchestration Architectural Decisions

A plain-language record of the major technical and architectural choices behind Sunrise's agent orchestration layer. Each decision first explains the concept in everyday terms, then states what was chosen, lists the alternatives that were rejected, gives the rationale, and points to where the decision lives in the codebase.

**Last updated:** 2026-05-03

---

## How to read this document

**Audience.** This document is written for a mixed audience: engineers onboarding to the platform, product leads scoping new agentic features, business stakeholders evaluating the platform commercially, and partners trying to understand whether Sunrise fits their problem. Every decision is therefore explained twice: once in plain language for the concept itself, and once in concrete terms for the choice made.

**Companion docs.** This document focuses on **why**. For **what** the system does, see `functional-specification.md`. For **how it compares** to alternatives in the market, see `maturity-analysis.md`. For **commercial use cases**, see `business-applications.md`.

**Entry format.** Every decision uses the same five-block layout so the document can be skimmed:

| Block                 | Purpose                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| **What is it?**       | Plain-language definition of the underlying technical concept                                  |
| **What we chose**     | One-sentence statement of the actual choice                                                    |
| **Alternatives**      | Table of options that were rejected, with concrete reasons (cost, ops, lock-in, latency, etc.) |
| **Why this approach** | The argument for the chosen option                                                             |
| **Where it lives**    | File paths, modules, and other docs to read for engineering detail                             |

**Reading the alternatives tables.** A "Why not" cell is concrete (mentions latency, cost, lock-in, ops complexity, browser support, scaling cost). It is never simply "this is better" — every rejection is rooted in a property the chosen option provides.

**The dependency-minimalism stance.** Several "Why not" cells say _"a fork can add this later"_ or _"the same artifact wraps in [X]"_ rather than rejecting an option outright. That phrasing is deliberate — it reflects the foundational principle in §1.6: ship the smallest sensible default, keep architectural seams narrow, and leave downstream developers free to layer in the libraries and infrastructure their use cases demand. When you read those cells, the door is open; the default is just not bundled.

**Acknowledged gaps.** Section 10 collects decisions that explicitly accept a current-state limitation (in-memory state, no distributed tracing, partial checkpoint recovery). These are not omissions — they are choices, with the trade-off named.

---

## 1. Foundations

These are the outermost decisions: what kind of system Sunrise is, what runtime it sits on, and how the orchestration layer relates to the rest of the application.

### 1.1 Custom orchestration engine vs an external framework

**What is it?** An "agent orchestration engine" is the component that decides what an AI agent does next: which model to call, which tool to invoke, what to do when something fails, when to stop. Frameworks such as LangGraph, CrewAI, AutoGen, and OpenAI Agents SDK each ship one. Managed cloud services such as AWS Bedrock Agents and Azure AI Foundry ship another, hosted for you.

**What we chose:** A purpose-built TypeScript orchestration engine, embedded inside Sunrise, sharing types and validation with the rest of the application.

**Alternatives**

| Option                             | Why not                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| LangGraph (Python)                 | Different runtime; would force a polyglot deployment and a separate type system from the rest of the app |
| CrewAI / AutoGen (Python)          | Same polyglot problem; weaker DAG and budget-enforcement primitives than what we need                    |
| OpenAI Agents SDK (TypeScript)     | Single-vendor model assumption; no first-class fallback chains, budget caps, or admin surface            |
| AWS Bedrock Agents / Azure Foundry | Managed lock-in; opaque cost model; can't be self-hosted; limits where data flows                        |

**Why this approach**

- The orchestration engine, the auth layer, the admin UI, the consumer API, and the embed widget all share the same TypeScript types and Zod schemas — no integration tax, no schema drift.
- Cost enforcement, provider resilience, and approval gates are first-class engine primitives rather than user code bolted on top.
- The system is self-hostable end to end; data, models, and configuration never have to leave the customer's environment.

**Where it lives:** `lib/orchestration/` (engine), `app/api/v1/orchestration/` (admin and consumer routes), `.context/orchestration/overview.md`.

### 1.2 Platform-agnostic core

**What is it?** "Platform-agnostic" here means the orchestration code does not import anything from the host web framework. Web framework code (Next.js in our case) handles HTTP requests, headers, cookies, and streaming responses. Orchestration code is plain TypeScript that takes inputs and produces outputs.

**What we chose:** A hard architectural rule that `lib/orchestration/` contains zero Next.js imports. The web layer (`app/api/v1/`) handles HTTP, then delegates to the orchestration core.

**Alternatives**

| Option                                        | Why not                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| Mix Next.js and orchestration code freely     | Couples the engine to the host framework; tests would need a server runtime       |
| Build orchestration as a separate npm package | Premature factoring; loses fast iteration with the rest of the app                |
| Run orchestration in a separate service       | Network hop, separate deploy, separate auth — solves none of the problems we have |

**Why this approach**

- The engine is testable in pure Node.js — no need to spin up a Next.js server in unit tests.
- If we ever need to host the engine somewhere else (a worker, a separate service, a different web framework), the move is a routing change, not a rewrite.
- The architectural rule is grep-checkable: an import of `next/*` inside `lib/orchestration/` is a code-review failure.

**Where it lives:** `lib/orchestration/**/*.ts` (the rule applies to every file). HTTP concerns live in `app/api/v1/orchestration/`.

### 1.3 API-first design

**What is it?** "API-first" means every capability the system has is exposed through a public-shaped HTTP API, and the admin UI consumes the same endpoints any external client would. There is no private query path that only the admin pages can use.

**What we chose:** All admin and consumer features are reachable through the documented `app/api/v1/` routes. The admin UI calls these routes the same way an MCP client or a third-party integration would.

**Alternatives**

| Option                                   | Why not                                                           |
| ---------------------------------------- | ----------------------------------------------------------------- |
| Direct database access from server pages | Two code paths to maintain; behaviour drifts between UI and API   |
| GraphQL with a private internal schema   | Two query languages; loses the simplicity of REST + SSE           |
| Server actions only (no API surface)     | Locks third-party integrators out; can't be consumed by MCP/embed |

**Why this approach**

- A new feature is only "shipped" when it has an API endpoint, not when the UI works.
- Third-party integrators, MCP clients, and the embed widget consume the same surface the admin UI does; if it works in one place, it works everywhere.
- API responses use a single shape (`{ success, data, error }`) enforced by helper utilities, so error handling is consistent across all consumers.

**Where it lives:** `app/api/v1/` (130+ admin routes, 8 consumer chat routes, 2 approval routes, 2 embed routes, 1 MCP route). Response helpers in `lib/api/responses.ts`. Documentation in `.context/api/orchestration-endpoints.md`.

### 1.4 Next.js 16 + App Router + React Server Components

**What is it?** Next.js 16 is the latest major release of the React-based full-stack framework. Its "App Router" replaces the older "Pages Router" with a file-based routing model that supports React Server Components — components that run on the server, return HTML, and never ship their JavaScript to the browser.

**What we chose:** Next.js 16 with App Router, Server Components by default, with `'use client'` only added when interactivity actually requires it.

**Alternatives**

| Option                    | Why not                                                                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stick with Next.js 14/15  | Older Cache Components story; missing React 19 features we use                                                                                                                                                          |
| Remix / TanStack Start    | Both are capable; Next.js 16 was the cleanest fit for the streaming SSR + RSC story we wanted. TanStack Router and TanStack Query can still be layered inside a Next.js fork if a downstream team wants them — see §1.6 |
| SvelteKit / Nuxt          | Different language ecosystem; would lose TypeScript-everywhere shared types with the orchestration core                                                                                                                 |
| Plain Express + React SPA | Loses streaming SSR, React Server Components, and the routing/layout abstraction                                                                                                                                        |

**Why this approach**

- Server Components ship far less JavaScript to the browser, which matters for a chat widget and for admin pages that render large tables.
- Streaming SSR pairs naturally with the SSE chat handler — both push tokens to the browser as soon as they are ready.
- Sunrise is offered as a starter template; downstream forks benefit from the largest current React ecosystem.

**Where it lives:** `app/` (route tree), `next.config.ts` (Cache Components configuration), `package.json` (Next.js 16, React 19).

### 1.5 Single-artifact Docker deployment

**What is it?** A "single-artifact" deployment ships the whole application — admin UI, API, orchestration engine, embed widget loader — as one Docker container. There are no per-feature services to orchestrate, no message bus, no worker pool to deploy separately.

**What we chose:** One Next.js process plus a PostgreSQL database. Optional Ollama container for local LLM. Everything else runs in the Next.js process.

**Alternatives**

| Option                                                | Why not                                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Microservices (separate engine, chat, admin services) | Premature; adds operational cost without solving any problem we have                                                                                                                 |
| Serverless functions per route                        | Cold starts hurt SSE streaming; budget mutex and circuit breaker need shared memory                                                                                                  |
| Kubernetes-native deploy from day one                 | The same Docker artifact runs in k8s when scale demands it — k8s is a wrapper, not a fork. We default to docker-compose because the most common deployment is a single VM (see §1.6) |

**Why this approach**

- A small team can deploy Sunrise on a single VM with `docker-compose up` and have everything working — including the agent runtime, knowledge base, and admin UI.
- Larger deployments can horizontally scale the same artifact behind a load balancer; the open question (covered in Section 10) is shared state for circuit breakers and budget mutexes.
- One artifact means one set of versions to keep in lockstep — no "the engine is on v2 but the admin UI is on v1.7" failure mode.

**Where it lives:** `Dockerfile`, `docker-compose.yml`, `.context/architecture/` for deployment topology.

### 1.6 Dependency minimalism — open to future architectural decisions

**What is it?** Modern web stacks are deep. A typical SaaS app pulls in a global state library, a data-fetching library, a form library, a charting library, a feature-flag SDK, a monitoring SDK, an analytics SDK, an error reporter, a queue client, a search vendor, and several utility belts. Each addition is reasonable in isolation; in aggregate they're irreversible — every downstream fork inherits all of them.

**What we chose:** Ship the smallest dependency set that delivers the functional spec, and design every architectural seam so that a downstream developer can layer in the libraries they actually want without rewriting the platform. Sensible default in the box; the door open behind it.

**What is bundled (the lean baseline):** Next.js, React, Prisma, `better-auth`, Tailwind 4, shadcn-pattern components on Radix primitives, Zod, `cron-parser`, `lucide-react`, `@xyflow/react`. That is roughly the floor.

**What is not bundled (deliberately):** state management library (no Redux/Zustand/Jotai), data-fetching library (no TanStack Query/SWR), form library (no Formik), router beyond Next.js App Router, monitoring SDK, analytics SDK, queue client (no Bull/BullMQ/Sidekiq), distributed cache, dedicated vector database, OpenTelemetry, e2e framework. Each of these can be added in a fork when the use case appears.

**Alternatives**

| Option                                                     | Why not                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Maximal stack from day one                                 | Forces downstream choices on every fork; doubles the surface area to keep up to date |
| No defaults at all                                         | Pushes too much onto the downstream developer; nothing works out of the box          |
| Vendor-coupled stack (one cloud, one observability vendor) | Couples the platform to one host; forks lose deployment flexibility                  |

**Why this approach**

- Every downstream fork starts from the same lean baseline; teams add what they actually need rather than removing what we forced on them.
- Several existing decisions in this document are concrete applications of this principle: the platform-agnostic core (§1.2), the Postgres + Prisma boundary (§7.1), the auth-guard abstraction (§6.2), the in-memory caches that swap to Redis later (§7.5, §10.2), and the absence of OpenTelemetry today (§9.1).
- **How this shows up in alternatives tables:** when a "Why not" cell says "you can add this later" or "wraps the same artifact," that's this principle. The alternative isn't wrong — it just isn't the default we ship.

**Where it lives:** `package.json` (the lean dependency list), `CLAUDE.md` ("search before creating" rule). The principle is reinforced anywhere a contained boundary lives over a swappable implementation — see §1.2, §6.2, §7.1, §7.5, §10.2.

### 1.7 React Server Components, Suspense, and streaming SSR

**What is it?** A browser app traditionally renders one of two ways: entirely on the server (SSR — every navigation reloads HTML) or entirely on the client (SPA — JavaScript renders everything). React Server Components (RSC) is a third mode: components run on the server, return HTML directly, and never ship their JavaScript to the browser. Suspense lets parts of a page stream in independently as their data resolves. Streaming SSR puts these together — the browser receives the first byte of HTML quickly and the rest streams as the server can produce it. Cache Components (Next.js 16) layer caching primitives on top so that fragments of the page can be cached, revalidated, or streamed independently.

**What we chose:** Server Components by default. `'use client'` is added only when interactivity actually demands it (form state, click handlers, browser APIs). Suspense boundaries wrap data-dependent regions. Streaming SSR is the default render path. Cache Components are configured per-route where caching helps.

**Alternatives**

| Option                                                                | Why not                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| All client-rendered (SPA)                                             | Ships every component's JavaScript to the browser; slower first paint, larger bundles |
| All server-rendered (no client islands)                               | Loses interactive admin UI affordances (drag-and-drop builder, live form validation)  |
| Pages router instead of App Router                                    | App Router's RSC and streaming integration are the reason we picked Next.js 16 (§1.4) |
| Add a separate streaming layer (e.g. WebSockets to push UI fragments) | Streaming SSR + SSE already covers the streaming use cases we have                    |

**Why this approach**

- Admin pages with large tables ship far less JavaScript when the table renders on the server.
- Streaming SSR pairs naturally with the SSE chat handler (§2.1) — both push tokens to the browser as they're ready.
- Suspense lets the chat conversation list and the agent list render before a slow knowledge-base query finishes.
- Cache Components let frequently-read pages (the dashboard, the model registry view) cache fragments without giving up streaming behaviour for the rest of the page.

**Where it lives:** `app/**/*.tsx` (Server Components by default; `'use client'` files explicit), `next.config.ts` (Cache Components configuration), `.context/architecture/`.

---

## 2. Communication: transport and protocols

This section covers how parts of the system talk to each other and to the outside world: how chat tokens reach the browser, how outside services receive notifications, how external systems sign approvals, and how internal components fan out events.

A short primer first: HTTP is request/response — the client asks, the server answers, and the connection ends. **Streaming** keeps the connection open so the server can push more data as it becomes available. **Push** transports (SSE, WebSockets) keep a connection open so the server can send messages whenever it wants. **Pull** transports (polling) repeatedly ask for updates. **Signed payloads** use a shared secret to compute a tag that proves the payload was not tampered with, without requiring a session.

### 2.1 Server-Sent Events (SSE) for streaming

**What is it?** Server-Sent Events (SSE) is a browser-native protocol for one-way streaming over HTTP. The server keeps the connection open and writes lines of text in a small framing format (`event: ...`, `data: ...`); the browser reassembles them into events. It runs over plain HTTP, works through proxies and CDNs, and is debuggable with `curl`.

**What we chose:** SSE for the consumer chat stream, the admin agent test chat, the workflow execution event stream, the embed widget chat, and MCP notifications.

**Alternatives**

| Option                     | Why not                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| WebSockets                 | Bidirectional channel we don't need; harder to authenticate per-message; more ops cost behind reverse proxies and CDNs |
| Long polling               | Higher latency, more reconnect churn, harder to correlate with structured event types                                  |
| gRPC streaming             | Browser support requires a proxy; loses `curl`-debuggable framing                                                      |
| Plain JSON returned at end | Defeats the user-experience benefit of seeing tokens appear as the model generates them                                |

**Why this approach**

- The chat handler emits a structured stream of typed events (`start`, `content`, `status`, `capability_result`, `citations`, `done`, `error`); SSE matches that shape exactly.
- Reverse proxies, CDNs, and load balancers handle SSE as ordinary HTTP — no special configuration.
- A single `sseResponse()` helper applies the same framing, sanitization, keepalives, and abort handling everywhere the platform streams.

**Where it lives:** `lib/api/sse.ts` (the bridge), `lib/orchestration/chat/` (chat handler), `lib/orchestration/engine/` (execution event stream), `.context/api/sse.md` and `.context/orchestration/chat.md`.

### 2.2 JSON-RPC 2.0 over Streamable HTTP for the MCP server

**What is it?** Model Context Protocol (MCP) is the protocol Anthropic defined for letting AI clients (Claude Desktop, IDE extensions, other agents) discover and invoke tools and resources on a remote server. "Streamable HTTP" means the client uses ordinary HTTP requests for calls and an SSE stream for asynchronous notifications. JSON-RPC 2.0 is a small request/response protocol where every call has a `method` name, parameters, and an `id` for correlation.

**What we chose:** A full MCP server implementation using JSON-RPC 2.0 over Streamable HTTP — POST for requests, GET for the notification stream, DELETE for session termination. Up to 20 batched JSON-RPC requests per call, 1 MB max body.

**Alternatives**

| Option                                     | Why not                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Custom REST protocol                       | Loses interoperability with Claude Desktop, IDE extensions, and other MCP clients   |
| WebSocket transport                        | More ops complexity; the MCP spec standardizes on Streamable HTTP                   |
| stdio transport (used by some MCP servers) | Requires a local process; doesn't work for a hosted multi-tenant deployment         |
| Skip MCP entirely                          | Closes off a fast-growing ecosystem of clients that already know how to talk to MCP |

**Why this approach**

- Any MCP client — Claude Desktop, an IDE, another agent platform — can connect to Sunrise without bespoke client code.
- HTTP transport works through corporate proxies and is debuggable with `curl`.
- Sessions are bounded per-key (`maxSessionsPerKey`), so a noisy client cannot exhaust the server.

**Where it lives:** `lib/orchestration/mcp/` (server, session manager, resource handlers), `app/api/v1/orchestration/mcp/` (the route), `.context/orchestration/mcp.md`.

### 2.3 Outbound webhooks with retry

**What is it?** A "webhook" is a configurable HTTP request the platform sends to an external URL when something happens (a workflow paused, a conversation ended, a budget threshold tripped). The receiver is just an ordinary HTTPS endpoint; it does not need any special client library.

**What we chose:** DB-backed webhook subscriptions filtered by event type, signed with HMAC-SHA256, delivered with three retry attempts on exponential backoff (10s / 60s / 300s), and tracked in a delivery log.

**Alternatives**

| Option                               | Why not                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| Message queue (Kafka, RabbitMQ, SQS) | Adds an external dependency; receivers would still need a consumer; loses simplicity  |
| WebSocket push to subscribers        | Receivers would need persistent connections; harder for serverless and small services |
| Email or Slack only                  | Not programmable; doesn't fit the "let other services react" use case                 |
| Fire once, never retry               | Network blips during delivery would silently drop notifications                       |

**Why this approach**

- An HTTPS endpoint is the lowest-common-denominator integration point — every framework, every language, and every iPaaS tool supports it.
- HMAC signing means receivers can verify the payload came from Sunrise without TLS client certs or API keys.
- The delivery log (`AiWebhookDelivery`) records every attempt; failed deliveries can be retried manually from the admin UI.

**Where it lives:** `lib/orchestration/webhooks/`, `app/api/v1/orchestration/webhooks/` (admin), `.context/orchestration/hooks.md`.

### 2.4 In-process event hooks alongside outbound webhooks

**What is it?** "Event hooks" are like webhooks but for handlers that live inside the same Node.js process — they run synchronously during the request that triggered them (or fire-and-forget afterwards), without going over HTTP. They are useful for cross-cutting reactions like updating analytics, refreshing a cache, or notifying an internal subscriber.

**What we chose:** A separate hook system (`AiEventHook`, `emitHookEvent`) that coexists with outbound webhooks. Hooks support filter criteria, custom headers, HMAC signing, and the same retry strategy as webhooks; their delivery is tracked in `AiEventHookDelivery`. A 60-second registry cache reduces DB lookups for high-frequency events.

**Alternatives**

| Option                           | Why not                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Use webhooks for everything      | Forces every internal reaction through an HTTP loopback — slow and harder to test                                                           |
| Use hooks for everything         | External services can't subscribe; loses durable retry for over-the-network calls                                                           |
| Build a single unified mechanism | Tried; the in-process and over-the-network use cases have different semantics (latency, retry, observability) and merging them blurred both |

**Why this approach**

- In-process handlers (analytics aggregation, cache invalidation, internal notifications) skip the HTTP roundtrip and run with full type safety against the same TypeScript codebase.
- External handlers (Slack bots, email services, third-party iPaaS) get the durable retry and signing they need.
- The `workflow.paused_for_approval` event is a good example: the in-process hook runs the approval queue badge update; the outbound webhook posts to the customer's Slack so an admin can approve from chat.

**Where it lives:** `lib/orchestration/hooks/` (dispatch, registry cache), `lib/orchestration/webhooks/` (outbound), `.context/orchestration/hooks.md`.

### 2.5 HMAC-SHA256 signed tokens for stateless external approvals

**What is it?** When a workflow pauses for human approval, somebody needs to approve or reject it from outside the admin UI — typically by clicking a link in a Slack message or an email. A "signed token" carries everything needed to identify the approval and proves it came from Sunrise, without requiring the clicker to log in. HMAC-SHA256 is a common message authentication algorithm that produces a tag verifiable with a shared secret.

**What we chose:** Stateless HMAC-SHA256 signed tokens embedded in approve/reject URLs. The token itself is the auth — no session cookie required. The public approval endpoints (`/api/v1/orchestration/approvals/:id/{approve,reject}`) verify the token, check expiry, then delegate to the same `executeApproval()` / `executeRejection()` functions the admin UI uses.

**Alternatives**

| Option                           | Why not                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| Require admin login to approve   | Defeats the point of approving from Slack/email/SMS                                    |
| Store one-time tokens in the DB  | Round-trip on every approval click; harder to embed in pre-baked notification payloads |
| JWTs                             | Heavier than we need; HMAC over a fixed payload format is simpler and equally secure   |
| Long-lived API keys per approver | Approver onboarding overhead; key rotation pain                                        |

**Why this approach**

- The Slack bot, email service, or webhook receiver can build the approval UI from the payload — Sunrise pre-signs the URLs and includes them in the `workflow.paused_for_approval` hook event.
- No session cookies cross domain boundaries; the approval flow works from any channel.
- Both admin (session-authenticated) and external (token-authenticated) endpoints share the same approval logic, so behaviour cannot drift between channels.

**Where it lives:** `lib/orchestration/engine/` (approval execution), `app/api/v1/orchestration/approvals/` (token-authenticated routes), `.context/admin/orchestration-approvals.md`.

### 2.6 Fire-and-forget for cost logging and hook dispatch

**What is it?** "Fire-and-forget" means a side-effect (writing a log row, dispatching a webhook) is started but its outcome is not awaited; if it fails, the user-facing operation still succeeds. The opposite is a synchronous side-effect, where a failure to write the log fails the whole request.

**What we chose:** Cost logging, event hook dispatch, and webhook dispatch all run fire-and-forget. The chat handler returns a response even if the cost row fails to insert; an LLM call returns even if the post-call hook can't be delivered.

**Alternatives**

| Option                                    | Why not                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Synchronous logging                       | A DB hiccup would fail user-facing chat responses                   |
| Background queue (Bull, BullMQ, etc.)     | Adds Redis or another broker; heavier than we need at current scale |
| Fire-and-forget with no delivery tracking | Loses the audit trail for cost and webhook delivery                 |

**Why this approach**

- The user-visible operation (chat response, workflow step) does not stall on observability or notifications.
- Delivery tracking (`AiCostLog`, `AiWebhookDelivery`, `AiEventHookDelivery`) records the outcome separately, so the audit trail survives even when the synchronous response was already returned.
- Failures are visible in the admin UI; manual retry is one click.

**Where it lives:** `lib/orchestration/llm/` (cost logging), `lib/orchestration/hooks/` (hook dispatch), `lib/orchestration/webhooks/` (webhook dispatch).

### 2.7 MCP session lifecycle and eviction

**What is it?** When an MCP client connects to Sunrise, the server tracks a session in memory for that client — notification queue, active subscriptions, last-seen timestamp. Letting sessions accumulate forever leaks memory; expiring them too aggressively breaks long-running clients that are simply idle between tool calls.

**What we chose:** A 1-hour idle TTL on every session, plus a `maxSessionsPerKey` cap that rejects new sessions for an API key already at the limit. Sessions are reaped on creation attempts (the manager prunes expired entries before counting toward the cap).

**Alternatives**

| Option                        | Why not                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| Unlimited sessions            | A noisy client leaks memory until the process is restarted              |
| Per-IP cap only               | Misses the real attribution unit — multiple keys behind one IP          |
| Persistent session store (DB) | Adds DB load to every notification; sessions are inherently per-process |

**Why this approach**

- Idle sessions reclaim within an hour; active clients refresh their TTL on every interaction.
- The per-key cap fails closed — a runaway client cannot exhaust the server by opening sessions.
- State is in-memory and per-process; the multi-instance trade-off is covered in Section 10.2.

**Where it lives:** `lib/orchestration/mcp/session-manager.ts`, `.context/orchestration/mcp.md`.

---

## 3. The Agent Engine

This section covers how an agent actually executes — the structure of a workflow, the lifecycle of a tool call, the rules around mutable state, and the interaction with the LLM during a streaming response.

### 3.1 DAG workflows + the autonomous orchestrator step

**What is it?** A "DAG" (Directed Acyclic Graph) is a flowchart of steps where each step has explicit inputs and outputs and the graph cannot loop back on itself. It is the structured end of the agent spectrum — predictable, auditable, easy to test. The opposite end is "agentic autonomy," where the LLM decides what to do next at each turn. Sunrise supports both modes: DAG workflows for repeatable processes, and an `orchestrator` step inside a workflow for cases where the next step really should be decided by an LLM at runtime.

**What we chose:** Workflows are DAGs with 15 step types, validated for cycles and connectivity at save time. One of those step types — `orchestrator` — invokes a planner LLM that picks the next step from a configured set. This puts autonomous reasoning under a budget cap and a step-type allowlist instead of letting it run unbounded.

**Alternatives**

| Option                               | Why not                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| Pure agentic autonomy (no workflows) | Hard to audit, hard to budget, hard to certify for regulated use cases                  |
| Pure workflows (no autonomy)         | Forces every dynamic decision into hand-crafted branches; can't handle open-ended tasks |
| Behaviour trees / state charts       | More complex than the DAG model; teams have to learn another formalism                  |
| Code-only orchestration (no DSL)     | Loses the visual builder, the import/export, and the non-developer admin surface        |

**Why this approach**

- 80% of business automations are inherently DAG-shaped: do A, then B, then maybe C or D; merge; respond. The DAG model fits.
- For the remaining 20% — open-ended research, complex troubleshooting — the `orchestrator` step adds dynamic planning while keeping budget caps, capability bindings, and audit trails intact.
- Save-time validation catches cycles and disconnected steps before runtime, so a broken workflow can never reach production.

**Where it lives:** `lib/orchestration/workflows/` (DAG validator, step types, templates), `lib/orchestration/engine/executors/` (one executor per step type), `.context/orchestration/workflows.md`, `.context/orchestration/autonomous-orchestration.md`.

### 3.2 Seven-stage capability dispatch pipeline

**What is it?** A "capability" (or "tool") is something an agent can do beyond generating text — search the knowledge base, call an external API, write to user memory, escalate to a human. A "dispatch pipeline" is the set of checks every capability invocation passes through before it actually runs.

**What we chose:** Every capability call passes through seven stages in order: (1) registry lookup by name, (2) binding check that the capability is attached to this agent, (3) per-capability rate limit (sliding window), (4) optional human approval gate, (5) Zod argument validation, (6) execution with a timeout, (7) cost logging.

**Alternatives**

| Option                                     | Why not                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| Direct function call (no dispatcher)       | No rate limit, no approval gates, no audit trail, no validation             |
| Single dispatcher with all checks combined | Hard to extend; new check types would require touching the central function |
| LLM-driven middleware chain                | Adds non-determinism to security-critical checks                            |

**Why this approach**

- Each stage has a single responsibility; new behaviour (a new validator, a new rate-limit type) is one new stage.
- Approval gates can be added to any capability without touching its handler.
- Cost logging happens after execution so it sees both the LLM costs the tool generated internally and the wall-clock time the tool took.

**Where it lives:** `lib/orchestration/capabilities/` (dispatcher, built-in tools), `.context/orchestration/capabilities.md`.

### 3.3 Default-allow dispatch + default-deny LLM visibility

**What is it?** There are two questions about which tools an agent can use: (a) "is the platform willing to execute this tool for this agent?" and (b) "should the LLM be told about this tool?" These are surprisingly different. A tool may need to be programmatically invocable (by a workflow step) without confusing the chat model that has no business calling it.

**What we chose:** A deliberate split — **default-allow on dispatch**: any registered capability bound to the agent can be called; **default-deny on LLM visibility**: the LLM only sees the capabilities explicitly listed in its tool definitions for that agent.

**Alternatives**

| Option                                | Why not                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Single allowlist for both             | Either the LLM sees too many tools (and gets confused), or workflows can't call admin tools  |
| LLM sees everything, dispatcher gates | LLM hallucinates calls to tools it shouldn't use; rate-limit budget burned on rejected calls |
| Per-call permission prompts           | UX disaster for chat; also doesn't help workflow steps                                       |

**Why this approach**

- A capability like `apply_audit_changes` should run from the model-audit workflow but not from a chat — the LLM never sees it, but the workflow step can call it directly.
- Reducing the LLM's tool surface lowers hallucination and reduces the prompt size sent to the provider.
- A misbinding fails closed: an unbound capability cannot be dispatched at all.

**Where it lives:** `lib/orchestration/capabilities/` (dispatcher), `lib/orchestration/chat/` (LLM tool definitions), `.context/orchestration/capabilities.md`.

### 3.4 Frozen context snapshots for executors

**What is it?** When the engine runs a workflow, every step needs to read state from earlier steps — the chat history, the user's input, the outputs of previous nodes. The simple approach is to share one mutable object that every step can write to. The careful approach is to give each step a frozen snapshot it cannot mutate; new state goes into a return value.

**What we chose:** Step executors receive `Readonly<ExecutionContext>`. They cannot mutate it. State updates flow back through the executor's return value, which the engine merges into the next step's snapshot.

**Alternatives**

| Option                                | Why not                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| Shared mutable context                | Race conditions in parallel branches; hard to reason about which step changed what |
| Immutable context, each step rebuilds | More allocation than necessary; slows large workflows                              |
| Database-only state                   | Round-trip per step; defeats the in-memory parallel branch advantage               |

**Why this approach**

- Parallel branches cannot accidentally race against each other on a shared object.
- A step's output is exactly what it returns — making testing, replay, and debugging straightforward.
- TypeScript's `Readonly` enforces the discipline at compile time, not runtime.

**Where it lives:** `lib/orchestration/engine/orchestration-engine.ts`, `lib/orchestration/engine/executors/`, `.context/orchestration/engine.md`.

### 3.5 Tool loop with budget check before every LLM call

**What is it?** The "tool loop" is the cycle inside the chat handler: the LLM responds with either text (done) or a tool call (run the tool, feed the result back in, ask the LLM again). It can iterate several times before the LLM produces a final answer. Each iteration costs another LLM call.

**What we chose:** Before every LLM call inside the loop, the budget is checked. If the agent's monthly budget is exceeded, the loop stops mid-conversation and returns a budget warning to the user.

**Alternatives**

| Option                                        | Why not                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| Check budget once at the start of the request | A single chat request can rack up many tool calls and far exceed the budget |
| Daily/hourly budget reconciliation            | Doesn't stop overspend in real time                                         |
| External billing dashboard only               | Customers see overage after it has already happened                         |

**Why this approach**

- Budget caps are enforced where the spend actually happens — inside the loop — not in a downstream report.
- A long, expensive chat that crosses the threshold mid-stream is stopped immediately, not after the fact.
- The budget mutex serializes concurrent chat requests on the same agent so two simultaneous calls cannot each see "$0.95 of $1.00 used" and both proceed.

**Where it lives:** `lib/orchestration/chat/` (chat handler tool loop), `lib/orchestration/llm/` (cost tracking, budget enforcement), `.context/orchestration/chat.md`.

### 3.6 Mid-stream provider failover

**What is it?** During a streaming response, the upstream LLM provider can fail partway through — connection drops, rate limit hit, transient 5xx. Most platforms simply error out. "Mid-stream failover" means switching to a fallback provider in the middle of generating a response, ideally without the user noticing more than a brief pause.

**What we chose:** When the chat handler detects a stream failure, it consults the agent's fallback chain, switches providers, optionally restarts the LLM call with the partial response carried forward, and emits a `content_reset` event so the client knows to start the assistant message over.

**Alternatives**

| Option                       | Why not                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| Error out on stream failure  | User-hostile for transient provider issues; no opportunity to recover  |
| Retry the same provider      | If the provider is genuinely down, retries don't help and waste budget |
| Fail over only between calls | Doesn't help the case where the failure is mid-token-stream            |

**Why this approach**

- Users on long responses stay productive even when the primary provider is having a bad minute.
- Operations teams get observability into how often failover fires (per-provider error rate, circuit breaker state).
- The fallback chain is per-agent, so a regulated agent restricted to one provider can opt out.

**Where it lives:** `lib/orchestration/chat/` (handler), `lib/orchestration/llm/provider-manager.ts` (`getProviderWithFallbacks()`), `lib/orchestration/llm/circuit-breaker.ts`, `.context/orchestration/resilience.md`.

### 3.7 Provider selector task-intent heuristic

**What is it?** An agent can be wired to a single hard-coded model, or it can pick a model at runtime based on the task at hand — "be fast", "think hard", "must run privately", "embed this". The latter needs a "selector": a function that takes a task intent and returns the best-fit model from the configured catalog.

**What we chose:** A task-based selector that maps intents (`thinking`, `doing`, `fast_looping`, `high_reliability`, `private`, `embedding`) to tier-roles, with secondary scoring on reasoning, cost, latency, and reliability. Selections are cached for 60 seconds.

**Alternatives**

| Option                     | Why not                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| One pinned model per agent | Loses cost/quality flexibility; admin must re-wire every agent on a model launch |
| Round-robin / load balance | Ignores fitness — a cheap fast model gets reasoning tasks                        |
| LLM-driven model selection | Adds an LLM call per turn; cost and latency penalty                              |

**Why this approach**

- Admins describe what they want ("private high-reliability") rather than which specific model.
- Models added to the registry are picked up by intent automatically — no agent re-wiring on a launch day.
- The 60-second cache prevents per-call DB lookups without holding stale routes long enough to surprise an admin who just changed the catalog.

**Where it lives:** `lib/orchestration/llm/provider-selector.ts`, `.context/orchestration/provider-selection-matrix.md`.

### 3.8 User memory: per-user-per-agent persistent facts

**What is it?** Conversations end and start; the same user often returns days later. "User memory" is a key-value store that lets an agent remember things across conversations — a user's name, their preferences, the topic they care about — without including every prior conversation in the prompt.

**What we chose:** `AiUserMemory` rows keyed on the `(userId, agentId, key)` tuple. Two separate capabilities — `read_user_memory` and `write_user_memory` — let the agent retrieve and persist facts. Reads are bounded to the 50 most-recent memories per call.

**Alternatives**

| Option                                   | Why not                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| Single global memory store across agents | Leaks identities across separate agent contexts                                 |
| Memory only per conversation             | Defeats the point — facts evaporate at the end of every chat                    |
| Vector-search over message history       | Captures facts mentioned in passing; misses facts the agent decided to remember |

**Why this approach**

- The (userId, agentId, key) tuple isolates one agent's memory from another's, even for the same user.
- Read and write are separate capabilities, so an agent can be granted read-only memory access.
- The 50-row read cap prevents unbounded prompt growth on power users.

**Where it lives:** `lib/orchestration/capabilities/built-in/user-memory.ts`, `prisma/schema.prisma` (`AiUserMemory`).

### 3.9 Workflow templates and dry-run mode

**What is it?** Building a workflow from a blank canvas is intimidating. New admins want a starting point — "give me a customer-support pattern," "give me a content-review pipeline." A _template_ is a pre-built workflow they can clone and adapt. A _dry-run mode_ lets them execute the workflow with mocked LLM and tool calls so they can verify the flow without spending budget.

**What we chose:** Workflows and templates share one table (`AiWorkflow`). Built-in templates are workflows with `isTemplate: true, templateSource: 'builtin'` (currently 11 of them, covering routing, RAG, content review, escalation, scheduled summaries, and other common patterns). Custom user-created templates use `templateSource: 'custom'`. The list endpoint supports filtering by source and category. Every workflow exposes a dry-run endpoint that walks the DAG with stubbed step outputs so the admin can see the path, the parallelism, and the conditional branches without paying for it.

**Alternatives**

| Option                                 | Why not                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| Templates as code only (in source)     | Locks the catalog to deploys; admins can't curate organisation-specific patterns |
| Templates as JSON files in a directory | Loses the admin UX (search, filter, clone); curation requires a developer        |
| No dry-run mode                        | Workflow authors find layout bugs only by spending real budget                   |
| Replay a real execution to test        | Mocked dry-run is faster, free, and doesn't leave junk in the executions list    |

**Why this approach**

- Templates and live workflows share one table — the admin UX is the same; cloning a template is a copy.
- Custom templates let an organisation curate its own pattern library without code changes.
- Dry-run lets a workflow author iterate cheaply — the path is verified before any LLM call is made for real.

**Where it lives:** `lib/orchestration/workflows/` (validator, semantic checker, template scanner), `app/api/v1/admin/orchestration/workflows/templates/` (list endpoint), `app/api/v1/admin/orchestration/workflows/[id]/dry-run/` (dry-run endpoint), `.context/orchestration/workflows.md`.

---

## 4. Resilience and Cost Control

These four decisions are the operational backbone: keeping a working system working when providers misbehave, and keeping spending under control.

### 4.1 Circuit breaker for LLM providers

**What is it?** A "circuit breaker" is a software pattern borrowed from electrical engineering. After a configured number of failures in a sliding window, the breaker "opens" and stops sending traffic to the failing dependency for a cooldown period. This prevents pile-up requests from making the situation worse and gives the dependency time to recover. After the cooldown, a single probe request is allowed; success closes the breaker, failure re-opens it.

**What we chose:** A per-provider circuit breaker with the default thresholds 5 failures / 60-second window / 30-second cooldown. State is exposed through admin API and the providers list in the UI. Manual reset is available.

**Alternatives**

| Option                               | Why not                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| No breaker, retry every request      | A failing provider gets hammered with retries that add latency and burn budget    |
| Hard-disable provider on first error | A single transient failure would manually require an admin to re-enable           |
| Breaker on the load balancer instead | Loses the per-provider granularity; doesn't know about LLM-specific failure types |

**Why this approach**

- A flaky provider gets routed around within seconds of the first burst of failures.
- Admins see breaker state in the UI and can trigger a manual reset when they know the provider is back.
- The breaker pairs naturally with fallback chains (Section 4.2): an open breaker triggers fallback selection automatically.

**Where it lives:** `lib/orchestration/llm/circuit-breaker.ts`, `.context/orchestration/resilience.md`. Per-instance in-memory state — see Section 10.2 for the multi-instance trade-off.

### 4.2 Per-agent ordered fallback chains

**What is it?** A "fallback chain" is an ordered list of LLM providers an agent will try in sequence if the primary fails. Most platforms support automatic retry against the same provider; far fewer support routing to a _different_ provider. Sunrise allows up to 5 fallbacks per agent.

**What we chose:** Each agent stores a `fallbackProviders` ordered array. On failure, providers are attempted sequentially. The fallback decision is sensitive to the circuit breaker state, so a known-failing provider is skipped without a wasted call.

**Alternatives**

| Option                                 | Why not                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| Single primary provider, no fallback   | A provider outage takes the agent down                                              |
| Random selection from a pool           | Cost and quality differ between providers; agents need control of preference order  |
| Fallback at the gateway, not per-agent | Some agents (e.g. regulated/PII-constrained) cannot fail over to a public cloud LLM |

**Why this approach**

- Production agents stay up through individual provider outages.
- Cost-sensitive agents can specify "Anthropic Sonnet, then Haiku, then Mistral Small" — quality first, then cheaper.
- Compliance-sensitive agents can specify a single private provider with no fallback at all.

**Where it lives:** `lib/orchestration/llm/provider-manager.ts`, agent configuration in `prisma/schema.prisma` (`AiAgent.fallbackProviders`), `.context/orchestration/resilience.md`.

### 4.3 Budget enforcement inside the execution loop

**What is it?** "Budget enforcement" means stopping LLM spending when a configured cap is reached. Most platforms enforce this asynchronously — they tally usage in a separate report, and overage is detected after the fact. Sunrise enforces it synchronously, inside the tool loop, so a chat that would exceed the cap is stopped _before_ the cap is exceeded.

**What we chose:** Per-agent monthly budget in USD with an 80% warning threshold and a hard 100% block. Global monthly budget across all agents. Budget is verified inside the chat tool loop and inside the workflow engine before each LLM call.

**Alternatives**

| Option                          | Why not                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| External billing dashboard      | Overage detected after the fact; no automatic stop                 |
| Daily reconciliation            | A bad day can blow the monthly budget by lunchtime                 |
| Block at the LLM provider level | Provider quotas are coarse and shared across all agents on the key |

**Why this approach**

- Customers can offer fixed-price agent deployments without unbounded spend risk.
- Budget warnings at 80% give admins time to react before service stops.
- The budget mutex (currently in-memory; see Section 10.2) prevents concurrent requests on the same agent from racing through the cap.

**Where it lives:** `lib/orchestration/llm/` (cost tracking, mutex), `lib/orchestration/chat/` (tool loop check), `.context/admin/orchestration-costs.md`.

### 4.4 Three-mode safety guards

**What is it?** "Safety guards" are checks on input or output that detect things like prompt injection, PII, off-topic responses, or hallucinated citations. Most platforms run them in a single mode: detect-and-block. That is too aggressive for many production deployments — false positives stop legitimate work — and too lax for others, where logging without blocking is useless.

**What we chose:** Three configurable modes for every guard: `log_only` (default), `warn_and_continue`, `block`. Per-agent and global precedence so high-risk agents can be stricter than the platform default.

**Alternatives**

| Option                               | Why not                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| Single binary block/allow            | False-positive costs are too high; no observability path                        |
| Block for all input; pass all output | Asymmetric in the wrong direction — output-side risks (PII leak) need attention |
| LLM-only filtering                   | Adds another LLM call per turn; cost and latency unacceptable for high-volume   |

**Why this approach**

- Operations teams roll out a new guard in `log_only` first to measure false-positive rate before tightening to `block`.
- Each guard (input, output, citation) has its own setting, so PII detection can be strict while topic boundaries are advisory.
- Guard hits are logged into the audit trail regardless of mode, so even `log_only` produces visibility.

**Where it lives:** `lib/orchestration/chat/input-guard.ts`, `lib/orchestration/chat/output-guard.ts` (and citation guard), `.context/orchestration/output-guard.md`.

### 4.5 Per-step timeout wrapper

**What is it?** An LLM call, an external API call, or a long-running tool can hang. Without a timeout, a single misbehaving step holds the whole workflow hostage. A "timeout wrapper" gives every step a deadline; if it doesn't finish in time, the engine cancels it and applies the configured error strategy (retry, fallback, skip, fail).

**What we chose:** Every workflow step is wrapped in an `AbortController` with a configured `timeoutMs`. The wrapper covers the entire step including its retries, so a chain of slow retries cannot run past the deadline. `external_call` defaults to a tighter bound than other step types.

**Alternatives**

| Option                            | Why not                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| No timeout                        | A hung step blocks the workflow indefinitely                                                 |
| Timeout per retry, not per step   | Three retries plus the original can run far past the apparent budget                         |
| Global request-level timeout only | Doesn't differentiate fast and slow step types; a fast step can starve while a slow one runs |

**Why this approach**

- Per-step deadlines give different step types appropriate budgets without one global cap.
- `AbortController` is the platform-native cancellation primitive; downstream `fetch`, LLM clients, and DB drivers honour it.
- The wrapper composes naturally with the error-classification layer (Section 4.6) — a timeout is treated as a retriable failure unless the step says otherwise.

**Where it lives:** `lib/orchestration/engine/orchestration-engine.ts` (`runStepWithStrategy`), `.context/orchestration/engine.md`.

### 4.6 `ExecutorError.retriable` classification

**What is it?** Some failures are worth retrying — a transient 503, a connection reset, an LLM rate limit. Others aren't — a 401 won't fix itself, and a malformed JSON response from a provider is permanent. Retrying the latter wastes budget and latency. A classification flag tells the engine which is which.

**What we chose:** A custom `ExecutorError` class carries a `retriable: boolean` field (default `true`). Step executors throw with an explicit classification; the engine's retry strategy consults the flag before scheduling another attempt.

**Alternatives**

| Option                           | Why not                                                  |
| -------------------------------- | -------------------------------------------------------- |
| Retry every error                | Burns budget and latency on permanent failures           |
| Retry only specific status codes | Doesn't generalise across LLM, HTTP, DB, and tool errors |
| LLM-driven retry decision        | Far too slow and expensive for an inner-loop concern     |

**Why this approach**

- Each executor knows its domain best — the LLM executor knows a token-budget error isn't retriable; the HTTP executor knows 503 is.
- The engine remains generic — it asks "is this retriable?" without needing to know the executor's domain.
- The default-true posture means a forgotten classification fails open (retries), which is usually safer than silently dropping a transient error.

**Where it lives:** `lib/orchestration/engine/errors.ts`, `lib/orchestration/engine/orchestration-engine.ts`.

### 4.7 Parallel branch aggregation: wait-all only

**What is it?** A workflow with parallel branches can wait for _all_ branches to finish, or stop as soon as the _first_ one succeeds, or wait for the first _N_. Each strategy fits different problems: wait-all for "do these three independent things"; first-success for "ask three providers and use whichever answers first"; first-N for "we need three opinions out of five".

**What we chose:** Wait-all is the only implemented mode. The parallel step config accepts a `stragglerStrategy` field that currently honours `wait-all`; `first-success` is named in the executor docstring as a future mode.

**Alternatives**

| Option                                    | Why not                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| Build all three modes from day one        | Premature; we don't yet have a workflow that needs first-success          |
| Block parallel steps entirely             | Loses the most common case (independent fan-out)                          |
| Hard-code `wait-all` with no config field | Creates a backwards-incompatible step the day someone needs first-success |

**Why this approach**

- The most common parallel pattern (independent work) is supported now.
- The config field is forward-compatible — adding first-success is an executor change, not a schema change.
- Unimplemented modes are explicitly named in the executor docstring, so a workflow author cannot silently use them and get unexpected behaviour.

**Where it lives:** `lib/orchestration/engine/executors/parallel.ts`, `.context/orchestration/workflows.md`. This is an explicit acknowledged gap — see also `improvement-priorities.md` and `maturity-analysis.md` for competitive context.

---

## 5. Knowledge and Retrieval

This section covers how documents become searchable, how an agent retrieves the right information at the right time, and how the resulting answer is grounded in real sources.

A short primer first: **RAG** (Retrieval-Augmented Generation) means giving the LLM relevant document snippets at request time so it can answer from real data instead of training-data memory. **Vector search** finds documents by _meaning_ — text is converted to a vector of numbers (an "embedding") and similar meanings produce nearby vectors. **BM25** is a classical keyword-matching algorithm that scores documents by how rare and frequent the query terms are in each document.

### 5.1 pgvector vs a dedicated vector database

**What is it?** A "vector database" stores embeddings and answers similarity queries. The market has many — Pinecone, Weaviate, Qdrant, Milvus — sold as managed services or self-hosted. PostgreSQL also supports vectors through the `pgvector` extension, which adds a `vector` column type and similarity operators.

**What we chose:** `pgvector` inside the PostgreSQL database that already holds the rest of the application's data. Embeddings live in `AiKnowledgeChunk.embedding` (`vector(1536)`).

**Alternatives**

| Option                                     | Why not                                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pinecone (managed)                         | Adds a third-party vendor and a per-vector cost; data leaves the customer's environment                                                                                               |
| Weaviate / Qdrant (self-hosted)            | Adds a service to deploy, monitor, and back up. A fork can introduce a dedicated vector store later when corpus size demands it; the search interface is narrow on purpose (see §1.6) |
| Elasticsearch with vector support          | Heavyweight for our scale; adds JVM ops cost                                                                                                                                          |
| Build vectors into Prisma without pgvector | Loses the indexed similarity operator; queries become full-table scans                                                                                                                |

**Why this approach**

- Backups, migrations, and access control all reuse the existing PostgreSQL toolchain.
- A document, its chunks, and its embeddings are joined in one query without crossing a network boundary.
- The performance ceiling of `pgvector` is well above the scale most Sunrise deployments need; teams that hit it can add a dedicated index without rearchitecting the application.

**Where it lives:** `lib/orchestration/knowledge/` (ingestion, embedding, search), `prisma/schema.prisma` (`AiKnowledgeChunk`), `.context/orchestration/knowledge.md`.

### 5.2 Hybrid BM25 + vector search

**What is it?** Pure vector search is great at meaning ("show me chunks about cancellation policy") but bad at exact terms ("show me chunks mentioning section 4.3.1"). Pure keyword search (BM25) is the opposite. Hybrid search runs both and blends the scores so each strategy catches what the other misses.

**What we chose:** Hybrid retrieval is the default. PostgreSQL's `ts_rank_cd` (a BM25-flavoured score) over a generated `tsvector` column with a GIN index, blended with `pgvector` cosine similarity using admin-tunable weights. Vector-only mode is preserved as the legacy fallback when hybrid is disabled.

**Alternatives**

| Option                     | Why not                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| Vector-only                | Misses domain-specific terms (legal references, product codes, regulation numbers) |
| Keyword-only               | Misses paraphrased queries that don't match the document's exact wording           |
| Re-ranker on top of vector | Adds a model call per query; latency and cost penalty                              |

**Why this approach**

- Compliance, legal, and financial domains are full of exact-string lookups (statute names, ticket IDs, SKUs); pure vector retrieval routinely loses these.
- A three-segment score breakdown is exposed through the API so admins can debug retrieval quality.
- Weights are tunable in admin settings (`vectorWeight`, `bm25Weight`) without a code change.

**Where it lives:** `lib/orchestration/knowledge/` (search), `prisma/schema.prisma` (`tsvector` generated column on `AiKnowledgeChunk`), `.context/orchestration/knowledge.md`.

### 5.3 Multi-format ingestion via parser-per-format

**What is it?** A document arrives as a file in a particular format — Markdown, plain text, CSV, EPUB, DOCX, PDF — and the platform has to extract its text and structure so it can be chunked and embedded. The straightforward approach is one big "extract everything" function. The structured approach is one parser per format, each with its own chunking shape, behind a common interface.

**What we chose:** A parser registry where every supported format has a dedicated parser module. New formats are a new parser plus registration; the rest of the pipeline doesn't change.

**Alternatives**

| Option                                 | Why not                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| One generic "extract text" function    | Each format has format-specific quirks (CSV headers, PDF layout, EPUB structure); generic extraction loses information |
| Outsource to a third-party parsing API | Sends documents to an external vendor; cost per page                                                                   |
| OCR everything                         | Loses native text where it exists; expensive and lossy                                                                 |

**Why this approach**

- Per-format parsers retain format-specific structure (CSV rows, EPUB chapters, PDF pages), which makes search results more useful.
- Adding a new format is bounded work — write a parser, register it, ship.
- Ingestion failures for one format don't risk a broken generic pipeline that affects the others.

**Where it lives:** `lib/orchestration/knowledge/parsers/`, `.context/orchestration/document-ingestion.md`.

### 5.4 CSV row-level chunking

**What is it?** "Chunking" splits a document into pieces small enough to embed and retrieve. The default chunking shape is paragraph-sized text. CSVs are fundamentally different — each row is a self-contained record, and a query like "show me the SKU for the product called X" wants to retrieve a single row, not a 5-row excerpt that happens to mention X.

**What we chose:** A dedicated `chunkCsvDocument` that emits one chunk per data row. Above 5,000 rows, batches of 10 rows per chunk cap the embedding cost. Re-chunking a CSV re-routes through the row-level chunker so the row-atomic shape survives across rebuilds.

**Alternatives**

| Option                                      | Why not                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| Treat CSV as plain text and paragraph-chunk | Splits rows across chunks; ruins per-row retrieval                              |
| Dump the whole CSV as one chunk             | Exceeds embedding model token limits for any non-tiny CSV; no per-row precision |
| Index CSV columns into Postgres directly    | Loses the natural-language query path                                           |

**Why this approach**

- A 50,000-row CSV becomes 50,000 retrievable records; queries surface single matching rows.
- Embedding cost is bounded for very large CSVs by the 10-row batching above 5,000 rows.
- Re-uploads, re-chunks, and re-embeds preserve row-atomic retrieval automatically.

**Where it lives:** `lib/orchestration/knowledge/parsers/` (CSV parser), `lib/orchestration/knowledge/` (chunker), `.context/orchestration/document-ingestion.md`.

### 5.5 PDF preview/confirm flow

**What is it?** PDF text extraction is famously messy. A scanned PDF may have no real text at all (just images of pages), tables may extract as garbled streams, and headers/footers may bleed into body text. If the platform silently ingests the result, low-quality text poisons search. The "preview/confirm" flow inserts a human checkpoint between parse and ingest.

**What we chose:** PDFs go through `pending` → `pending_review` → `processing` → `ready`. Between parse and ingest, the admin previews the extracted text, sees per-page text-density warnings for scanned ranges, and can opt into vector-grid table extraction that renders detected tables as fenced markdown pipe tables. A re-upload of the same PDF (matched by SHA-256) refreshes the existing `pending_review` row in place rather than creating a duplicate.

**Alternatives**

| Option                              | Why not                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| Auto-ingest with no review          | Bad OCR silently degrades search quality; nobody notices until users complain   |
| OCR-everything-including-text-PDFs  | Expensive; lossy; defeats native text extraction where it works                 |
| Reject PDFs without selectable text | Customers have legitimate scanned PDFs that they need ingested with a human eye |

**Why this approach**

- Bad extractions are caught at upload time, not at retrieval time.
- The per-page text-density check groups consecutive scanned pages into one warning per range, so the preview UI scales to large documents.
- The SHA-256-based dedup prevents parallel triage from clobbering each other's pending rows.

**Where it lives:** `lib/orchestration/knowledge/parsers/` (PDF parser, table extraction), `app/admin/orchestration/knowledge/` (preview UI), `.context/orchestration/document-ingestion.md`.

### 5.6 Citation envelope, `[N]` markers, and citation guard

**What is it?** When an agent answers from retrieved documents, the user often needs to know _which_ document supports each claim. The naive approach is to dump source URLs at the end of the response. The structured approach is to attach numbered citations to the response so the LLM can cite inline (`This is the case [1]; the alternative is [2].`) and the client can render a sources panel.

**What we chose:** Citation-producing tools (`search_knowledge_base`) return their results wrapped in a Citation envelope with monotonic `[N]` markers. The chat handler emits a single `citations` SSE event before `done`, persists the envelope on the assistant message metadata, and the admin chat / trace viewer / embed widget all render a sources panel. An opt-in citation guard validates that responses grounded in retrieved content actually cite — detecting "under-citation" (citations retrieved but no `[N]` marker in the response) and "hallucinated marker" (`[N]` appears that no citation produced).

**Alternatives**

| Option                                           | Why not                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| URLs at the end of the response                  | LLM can mismatch sources to claims; readers can't verify per-claim              |
| Footnotes generated post-hoc by another LLM call | Doubles the cost of every grounded response                                     |
| No citations at all                              | Critical for compliance-heavy verticals (legal, healthcare, financial planning) |

**Why this approach**

- Inline `[N]` markers map a specific claim to a specific source, which is auditable.
- The guard catches a common LLM failure mode (RAG-grounded response that doesn't actually cite) and can be set to `log_only`, `warn_and_continue`, or `block`.
- The citation envelope is a structural type carried end-to-end through the API, the chat handler, the SSE client, and the admin viewer — there is no parsing or string reconstruction.

**Where it lives:** `lib/orchestration/chat/` (citation handling), `lib/orchestration/capabilities/built-in/` (search_knowledge_base envelope), `lib/orchestration/chat/output-guard.ts` (citation guard), `.context/orchestration/chat.md`.

### 5.7 Agent-scoped knowledge categories

**What is it?** A common platform design has one global knowledge corpus shared by every agent. That works until a multi-tenant deployment has agents that should see legal docs but not HR docs, or until a customer-facing agent shouldn't see internal-only documents.

**What we chose:** Documents are tagged with categories. Agents declare a `knowledgeCategories` array. Search is scoped to the agent's categories — chunks outside those categories are not retrievable for that agent.

**Alternatives**

| Option                            | Why not                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| Single global corpus              | Agents leak knowledge across boundaries (customer-facing agent finds internal docs) |
| Separate vector indexes per agent | Storage and embedding cost duplication; rebuilding per agent is expensive           |
| Row-level ACLs at query time      | Adds DB-level access control; complex to administer                                 |

**Why this approach**

- A customer-support agent can be scoped to public docs while an internal IT agent has the broader corpus.
- Categories are admin-managed strings, not a complex permission tree.
- A document re-categorization automatically updates which agents can retrieve it without re-embedding.

**Where it lives:** `lib/orchestration/knowledge/` (search filter), `prisma/schema.prisma` (`AiAgent.knowledgeCategories`, `AiKnowledgeDocument.categories`), `.context/orchestration/knowledge.md`.

### 5.8 Conversation similarity via message embeddings

**What is it?** Embedding messages (Section 5.1) lets the platform answer "find me past conversations that touched on this topic" — useful for analytics, deduplication, surfacing prior context, and detecting unanswered-question patterns. The decision is whether to embed every message and where the embeddings live relative to the knowledge-base index.

**What we chose:** A separate `AiMessageEmbedding` table stores per-message embeddings used for conversation-level similarity. Embeddings are written asynchronously after the message is persisted, so they never block the chat response.

**Alternatives**

| Option                              | Why not                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| Embed nothing                       | Loses "find similar past conversations" and topic-frequency analytics                |
| Embed inline with the chat response | Adds embedding-call latency to the user-facing response                              |
| Reuse the knowledge-chunk index     | Conflates two corpora with very different governance, lifecycle, and retention rules |

**Why this approach**

- The chat response stays fast; embedding happens in the background.
- A separate table keeps message embeddings independent of knowledge chunks — different access controls, different retention, different lifecycle.
- Topic clustering, popular-topics analytics, and unanswered-question detection all draw from this index.

**Where it lives:** `lib/orchestration/chat/`, `prisma/schema.prisma` (`AiMessageEmbedding`), `.context/orchestration/analytics.md`.

### 5.9 Knowledge namespace scope: agent, not team

**What is it?** Knowledge categories (Section 5.7) scope what a single agent can retrieve. Multi-tenant deployments raise a different question: whether teams or organisations have their own knowledge namespaces, isolated from each other. Some platforms (LlamaIndex, Pinecone) ship per-namespace isolation as a first-class feature.

**What we chose:** Knowledge is shared across the deployment, scoped by category — not by team. Multi-tenant isolation is achieved by running separate Sunrise deployments, not by partitioning a single one.

**Alternatives**

| Option                                | Why not                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| Per-team namespaces in one deployment | Adds a permission layer to every search; complicates document upload and curation      |
| Per-user namespaces                   | Defeats the shared-knowledge use case (most teams want one curated corpus)             |
| Row-level ACLs at query time          | Heavyweight; few customers actually need it, and SQL-side filters cost on every search |

**Why this approach**

- The current customer base runs single-tenant deployments; agent-scoped categories are sufficient.
- Multi-tenant deployments are served by separate Docker instances, which is operationally simpler than a built-in namespace boundary.
- If single-deployment multi-tenancy becomes a customer requirement, the category model can be extended into a namespace tree without an incompatible schema change.

**Where it lives:** `lib/orchestration/knowledge/` (search filter), `prisma/schema.prisma` (`AiKnowledgeDocument.categories`), `.context/orchestration/knowledge.md`. Documented as a deliberate scope choice in `maturity-analysis.md`.

### 5.10 Embedding provider choice and the 1536-dimension ceiling

**What is it?** An "embedding model" turns text into a vector. The vector's dimensions and the model are coupled — Voyage's `voyage-3` produces 1024-dim vectors natively; OpenAI's `text-embedding-3-large` produces 3072 natively but accepts a `dimensions` parameter to truncate; some Ollama models produce 768 or 1024 dims. Once a database column stores vectors of one shape, changing the shape is a migration that re-embeds every chunk in the corpus.

**What we chose:** Pin the database column to `vector(1536)` (`AiKnowledgeChunk.embedding`). Support multiple embedding providers in the registry as long as the chosen model can produce 1536-dim output, either natively or via a `dimensions` / `output_dimension` parameter. Default recommended provider is Voyage AI (`voyage-3`); OpenAI `text-embedding-3-small` and `text-embedding-3-large` work via dimension truncation; Ollama models are supported for fully local deployments where data must not leave the host.

**Alternatives**

| Option                                                                 | Why not                                                                                 |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Native dim per provider (no truncation; one column shape per provider) | Mixing providers requires rebuilding the column; locks each corpus to one provider      |
| Larger ceiling (3072)                                                  | Bigger storage and slower search for a marginal quality lift on the models we evaluated |
| Smaller ceiling (768)                                                  | Sacrifices quality on most modern embedding models                                      |
| Hard-code one provider (Voyage only)                                   | Loses the "swap to local Ollama for compliance" deployment path                         |

**Why this approach**

- 1536-dim is a sweet spot most modern embedding models can produce, natively or via parameter.
- Mixing providers across documents (one corpus on Voyage, another on Ollama for compliance reasons) is a configuration choice, not a migration.
- Customers who need a different ceiling rebuild the column once at deployment time — the rest of the platform doesn't change.
- The provider list is open via the `AiProviderModel` registry — adding a new embedding provider is a registry entry plus a thin adapter, not a core change. (See §1.6 for the dependency-minimalism stance — we don't bundle every embedding vendor.)

**Where it lives:** `lib/orchestration/llm/embedding-models.ts` (registry, dimension compatibility flags), `lib/orchestration/llm/voyage.ts`, `lib/orchestration/llm/openai-compatible.ts`, `prisma/schema.prisma` (`AiKnowledgeChunk.embedding`).

---

## 6. Security and Trust

This section covers how untrusted input is contained, how authentication works across very different surfaces, and how the system avoids leaking data and credentials.

### 6.1 Zod validation at every boundary

**What is it?** "Zod" is a TypeScript schema library that validates data at runtime and produces a typed value. A "boundary" is anywhere data crosses from outside to inside — request bodies, query parameters, headers, environment variables, third-party API responses. Without runtime validation, TypeScript types are only a developer-time fiction; a malformed request can slip through and crash the server hours later.

**What we chose:** Every API route validates its inputs with Zod. The TypeScript codebase forbids `as` casts on external data and bans `any` types. Validation produces both a typed value and a structured error response.

**Alternatives**

| Option                                  | Why not                                                       |
| --------------------------------------- | ------------------------------------------------------------- |
| Trust TypeScript types for runtime data | Types disappear at runtime; an attacker can post anything     |
| Custom validators per endpoint          | Inconsistent error shapes; missed cases                       |
| OpenAPI-driven validation               | Schema lives separately from the typed code; drift inevitable |

**Why this approach**

- TypeScript type definitions are derived from Zod schemas — there is one source of truth, not two.
- Errors come back in a consistent shape, so API consumers handle them uniformly.
- The "no `as` on external data" rule is enforced by code review and called out explicitly in `CLAUDE.md`.

**Where it lives:** Zod schemas live next to their routes in `app/api/v1/`, alongside any shared schemas in `lib/orchestration/utils/` and `types/`.

### 6.2 Token vs session authentication

**What is it?** "Session" auth uses a cookie set after login; the server looks up the cookie in a session store. "Token" auth uses a string presented in a header (typically `Authorization: Bearer ...`) that proves identity without a session lookup. Different surfaces need different mechanisms — a browser admin page wants a cookie session; a CLI or third-party integration wants a bearer token.

**What we chose:** A surface-by-surface mix.

| Surface                        | Authentication                      |
| ------------------------------ | ----------------------------------- |
| Admin UI / admin API           | Session cookie (better-auth)        |
| Consumer chat (logged-in user) | Session cookie                      |
| Embed widget                   | Embed token + CORS origin allowlist |
| Invite-only agent access       | Invite token (`AiAgentInviteToken`) |
| External approvals             | HMAC-SHA256 signed token in URL     |
| MCP server                     | Bearer API key (`AiApiKey`)         |
| Third-party integration / CLI  | Bearer API key                      |
| Outbound webhook receivers     | HMAC-SHA256 signature on payload    |

**Alternatives**

| Option                 | Why not                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| Sessions everywhere    | Doesn't work for headless integrations or pre-signed approval URLs          |
| Tokens everywhere      | Worse UX for the admin UI; cookie-session for browsers is standard practice |
| OAuth on every surface | Heavy; doesn't suit short-lived approval URLs or per-widget embed tokens    |

**Why this approach**

- Each surface uses the lightest mechanism that works for it.
- Tokens have scoped permissions (per-agent, per-capability, per-origin) so a leaked token's blast radius is bounded.
- All token verification flows through a small set of helpers, so authentication logic isn't duplicated.

**Where it lives:** `lib/auth/guards.ts` (session guards), `lib/orchestration/` (token verification for embed/invite/approval/API key), `.context/orchestration/agent-visibility.md`, `.context/orchestration/api-keys.md`.

### 6.3 Ownership scoping returns 404 not 403

**What is it?** When user A asks for resource X but the resource belongs to user B, the server can respond either "forbidden" (403) or "not found" (404). Returning 403 confirms that the resource exists, which lets an attacker enumerate IDs by watching for the difference between 403 and 404.

**What we chose:** Cross-user lookups return 404. The server pretends the resource doesn't exist for users who shouldn't see it.

**Alternatives**

| Option                     | Why not                                                      |
| -------------------------- | ------------------------------------------------------------ |
| Return 403                 | Leaks the existence of resources the requester cannot access |
| Return 401                 | Misleading; the user is authenticated, just not authorised   |
| Return 200 with empty data | Hides errors; harder to debug genuine bugs                   |

**Why this approach**

- An attacker cannot enumerate other users' agents, conversations, or executions by walking the ID space.
- The behaviour is uniform across every ownership-scoped endpoint, so the API surface is predictable.
- Genuine permission errors (admin action denied to a non-admin) still return 403; only ownership mismatches downgrade to 404.

**Where it lives:** Ownership checks in `app/api/v1/` route handlers; helpers in `lib/auth/guards.ts` and `lib/api/responses.ts`.

### 6.4 Credentials only via environment variables

**What is it?** LLM API keys, webhook signing secrets, and other credentials are sensitive strings. They can be stored in the database (encrypted or otherwise), in environment variables, or in an external secret manager. Each option has different operational and audit characteristics.

**What we chose:** Credentials live only in environment variables, resolved at runtime. The DB stores the _name_ of the env var (`apiKeyEnvVar: "ANTHROPIC_API_KEY"`), never the value. Credentials never enter LLM context, never appear in logs, and never appear in API responses.

**Alternatives**

| Option                          | Why not                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| Encrypt and store in DB         | DB backups and exports become credential-bearing; key management gets complex |
| External secret manager (Vault) | Adds an external dependency; many deployments don't have one                  |
| Hard-code in source             | Not an option in any serious deployment                                       |

**Why this approach**

- Backups, configuration exports, and audit logs are credential-free by construction.
- Operators rotate keys by changing an env var and restarting — no DB migration.
- The "name not value" pattern lets multiple environments (dev, staging, prod) share the same configuration export with environment-specific secrets.

**Where it lives:** `lib/orchestration/llm/provider-manager.ts` (resolution at runtime), `prisma/schema.prisma` (`AiProviderConfig.apiKeyEnvVar`), `.context/orchestration/llm-providers.md`.

### 6.5 SSRF protection via host allowlist for `external_call`

**What is it?** "SSRF" stands for Server-Side Request Forgery. If an attacker can persuade the server to make HTTP requests to arbitrary URLs, they can reach internal services (cloud metadata endpoints, internal admin tools, private databases) that aren't supposed to be reachable from the public internet. Any feature that lets a workflow call an external URL is an SSRF risk.

**What we chose:** The `external_call` step type and the `call_external_api` capability both check the target host against a configured allowlist (`ORCHESTRATION_ALLOWED_HOSTS`). Per-agent `customConfig` adds optional `allowedUrlPrefixes` for tighter scoping. Outbound rate limits and response size caps apply on top.

**Alternatives**

| Option                       | Why not                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------- |
| Block private IP ranges only | Doesn't catch DNS rebinding or proxies on public IPs                             |
| Trust the workflow author    | A malicious or compromised workflow could be configured to hit `169.254.169.254` |
| Egress proxy with deny rules | Defence in depth — useful, but the allowlist is the first line                   |

**Why this approach**

- A workflow author cannot exfiltrate data to or import data from arbitrary destinations.
- Per-agent allowedUrlPrefixes (e.g. `https://api.stripe.com/v1/charges`) tightens the agent further than the platform allowlist.
- Response size caps (`maxResponseBytes`) prevent runaway responses from blowing up the engine.

**Where it lives:** `lib/orchestration/engine/executors/external-call.ts`, `lib/orchestration/capabilities/built-in/` (`call_external_api`), `.context/orchestration/external-calls.md`.

### 6.6 Three-guard pipeline: input, output, citation

**What is it?** Three different risks need three different checks. Input guard inspects the user's message for prompt-injection patterns. Output guard inspects the LLM's response for PII, off-topic content, and brand-voice violations. Citation guard verifies that responses grounded in retrieved documents actually cite their sources.

**What we chose:** All three guards run in parallel with the chat tool loop, share the same three-mode configuration (Section 4.4), and emit warnings as SSE events the client renders alongside the response. Per-agent + global precedence allows different agents to apply different strictness.

**Alternatives**

| Option                       | Why not                                                                    |
| ---------------------------- | -------------------------------------------------------------------------- |
| Single combined guard        | Conflates very different signals; tuning one knob affects unrelated checks |
| Output guard only            | Misses prompt-injection at the input stage                                 |
| LLM-based content moderation | Adds an LLM call per turn; cost and latency penalty                        |

**Why this approach**

- Each guard has its own scope and its own configuration.
- Three injection pattern types (`system_override`, `role_confusion`, `delimiter_injection`) catch most known attacks without an LLM call.
- Citation guard is opt-in and vacuous when no citations were produced, so non-RAG responses are never falsely flagged.

**Where it lives:** `lib/orchestration/chat/input-guard.ts`, `lib/orchestration/chat/output-guard.ts`, citation guard inside the same module, `.context/orchestration/output-guard.md`.

### 6.7 Multi-tier rate-limit topology

**What is it?** "Rate limiting" prevents a single client from overwhelming a server. The naïve design has one global limit. A multi-tier design has different limits keyed on different identifiers — IP for unauthenticated traffic, user ID for authenticated, API key for programmatic access, agent or capability for orchestration-internal calls — each with its own window.

**What we chose:** A set of pre-configured limiters in `lib/security/rate-limit.ts`, each created from the same sliding-window primitive but with different windows and identifiers.

| Limiter                                            | Default           | Keyed on            |
| -------------------------------------------------- | ----------------- | ------------------- |
| `authLimiter`                                      | tight, anti-brute | IP                  |
| `apiLimiter`                                       | 100 / min         | IP                  |
| `adminLimiter`                                     | 30 / min          | IP                  |
| `chatLimiter` (admin chat)                         | 20 / min          | user ID             |
| `consumerChatLimiter`                              | 10 / min          | user ID             |
| `embedChatLimiter`                                 | 10 / min          | embed token + IP    |
| `uploadLimiter`                                    | 10 / 15 min       | IP                  |
| `acceptInviteLimiter`                              | 5 / 15 min        | IP                  |
| `passwordResetLimiter`, `verificationEmailLimiter` | 3 / 15 min        | IP                  |
| Per-capability sliding window                      | configurable      | (agent, capability) |

**Alternatives**

| Option                     | Why not                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| Single global limit        | Either too tight for chat or too loose for password-reset                    |
| Per-route ad-hoc limits    | Inconsistent; hard to audit and reason about                                 |
| Cloud-edge rate limit only | Misses logical units (per agent, per capability) the application knows about |

**Why this approach**

- Each axis of abuse — brute-force login, runaway chat, capability flood — has its own bound.
- All limiters share one sliding-window primitive, so behaviour and observability are consistent.
- Constants live in one place (`SECURITY_CONSTANTS.RATE_LIMIT.LIMITS`), so retuning is a single-file change.

**Where it lives:** `lib/security/rate-limit.ts`, `lib/orchestration/capabilities/` (per-capability limiter), `.context/security/`.

### 6.8 Per-host outbound rate limiter with `Retry-After` respect

**What is it?** When a workflow calls an external API (`call_external_api`, `external_call`), the platform must not hammer that external service. RFC 7231 defines `Retry-After`, a response header an upstream service uses to say "please don't retry until this time". Most platforms ignore it and back off blindly.

**What we chose:** A per-host sliding-window outbound rate limiter (default 60 requests per minute per hostname). It records `Retry-After` directives from upstream responses (both seconds and HTTP-date formats) and refuses to send another request to that host until the deadline passes.

**Alternatives**

| Option                         | Why not                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| No outbound limiter            | A workflow loop becomes a DDoS source against an integration partner                   |
| Single global outbound limiter | One slow integration starves all the others                                            |
| Ignore `Retry-After`           | Defeats the upstream's polite back-pressure signal; risks the platform IP being banned |

**Why this approach**

- An integration partner asking us to back off is honoured automatically.
- Per-host scoping ensures one slow integration doesn't choke unrelated calls.
- Back-off decisions are logged, so operators can see when a host is constraining the platform.

**Where it lives:** `lib/orchestration/engine/outbound-rate-limiter.ts`, `.context/orchestration/external-calls.md`.

### 6.9 HTTP idempotency-key support on external calls

**What is it?** Some external APIs (Stripe is the canonical example) accept an "idempotency key" header. If a request with the same key is replayed, the upstream returns the original response instead of performing the action again. This makes safe retry possible — without it, retrying a `POST /charges` could double-bill a customer.

**What we chose:** The `external_call` step type and `call_external_api` capability support an `idempotencyKey` option. The platform either accepts an explicit key from the workflow or auto-generates a UUID and injects it as a header (configurable header name; defaults to `Idempotency-Key`).

**Alternatives**

| Option                               | Why not                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| No idempotency support               | Retries on transactional endpoints can double-execute                                    |
| Always auto-generate                 | Doesn't help when the workflow author wants a deterministic key tied to a business event |
| Idempotency at the engine level only | Misses upstream-supplied de-duplication where the upstream is the actual source of truth |

**Why this approach**

- Safe retry is opt-in but easy to enable.
- The header name is configurable to match the upstream's convention (`Idempotency-Key`, `X-Idempotency-Key`, vendor-specific names).
- A deterministic key derived from a business event ID makes the agent's behaviour idempotent at the workflow level too — a re-run of the same step against the same event produces the same upstream side-effect once.

**Where it lives:** `lib/orchestration/http/idempotency.ts`, `lib/orchestration/engine/executors/external-call.ts`, `.context/orchestration/external-calls.md`.

### 6.10 `better-auth` as the authentication substrate

**What is it?** Every web application needs authentication: signup, login, sessions, role checks, password reset, email verification. The market splits into hosted services (Auth0, Clerk, Supabase Auth, Cognito) and self-hosted libraries (NextAuth.js / Auth.js, Passport, Lucia, `better-auth`). Each option trades lock-in, cost, customisation, and where user data is stored.

**What we chose:** `better-auth` — a TypeScript-first, in-process, self-hosted authentication library. User and session tables live in the same Prisma database as the rest of the application. Session checks happen via `withAuth()` and `withAdminAuth()` guard helpers (§6.2), which means the rest of the codebase calls a thin abstraction rather than the auth library directly.

**Alternatives**

| Option                                  | Why not                                                                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth0 / Clerk / Supabase Auth / Cognito | Vendor lock-in; user data leaves the deployment; per-MAU costs at scale                                                                            |
| NextAuth.js / Auth.js                   | Capable; we picked `better-auth` for ergonomics and TypeScript-first design. The guard abstraction means swapping is a contained change (see §1.6) |
| Lucia                                   | Smaller scope; we wanted the broader feature surface (email verification, social, MFA) without writing it ourselves                                |
| Custom auth                             | Sessions, password storage, and CSRF are easy to get wrong; not worth the maintenance burden                                                       |

**Why this approach**

- User data and sessions never leave the deployment — important for compliance-sensitive customers (legal, healthcare, financial).
- The `withAuth` / `withAdminAuth` guard abstraction means swapping authentication libraries later is a contained change; most code touches the guards, not `better-auth` directly.
- TypeScript-first design fits the project's strict-typing posture (§6.1), and `better-auth` owns its Prisma tables so migrations are part of the same workflow as the rest of the schema.

**Where it lives:** `lib/auth/`, `lib/auth/guards.ts`, `prisma/schema.prisma` (User, Session, Account tables managed by `better-auth`), `.context/auth/`.

---

## 7. Persistence and Data Model

How long-lived state is stored, versioned, and audited.

### 7.1 PostgreSQL + Prisma 7

**What is it?** PostgreSQL is a mature open-source relational database with strong support for transactions, JSON, full-text search, and (via `pgvector`) vector similarity. Prisma is a TypeScript ORM that generates a typed client from a schema file and produces SQL migrations.

**What we chose:** PostgreSQL with Prisma 7 as the single primary datastore for the application and the orchestration layer. 29 Prisma models cover agents, capabilities, workflows, conversations, knowledge, costs, audit, providers, schedules, hooks, webhooks, experiments, evaluations, and admin settings.

**Alternatives**

| Option                                         | Why not                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MongoDB                                        | Loses transactions across related records; relational shape better fits the model                                                                                                                                                        |
| MySQL                                          | Similar fit, but Postgres has stronger JSON, full-text, and vector support                                                                                                                                                               |
| Mixed datastore (Postgres + Redis + vector DB) | More services to deploy and back up; integrity across stores becomes the operator's problem                                                                                                                                              |
| Drizzle / TypeORM instead of Prisma            | Both are capable; Prisma is the default for its typed-client and migration ergonomics. The Prisma surface is contained enough that a fork can swap to Drizzle if migration ergonomics matter more than the typed-client shape (see §1.6) |

**Why this approach**

- One database to deploy, monitor, back up, and migrate.
- Transactions span agent updates, audit log inserts, and version history rows in one atomic write.
- Prisma migrations are part of the typed codebase; schema and TypeScript drift can't happen.

**Where it lives:** `prisma/schema.prisma` (the schema), `prisma/migrations/` (versioned migrations), `.context/database/`.

### 7.2 Immutable audit log

**What is it?** An "audit log" is a record of who changed what, when, and how. An "immutable" audit log is one where rows are only ever appended — never updated, never deleted — so the trail is reliable evidence of what happened.

**What we chose:** `AiAdminAuditLog` records every configuration change with entity type, entity ID, action, before/after JSON diff, actor user ID, and timestamp. Rows are append-only; the admin UI provides filtered views but no edit or delete affordance.

**Alternatives**

| Option                | Why not                                                          |
| --------------------- | ---------------------------------------------------------------- |
| No audit log          | Compliance-disqualifying for regulated deployments               |
| Mutable audit log     | Defeats the point — anyone with write access can rewrite history |
| Application logs only | Logs are unstructured, expire, and aren't queryable by entity    |

**Why this approach**

- Compliance reviews, security incidents, and "who broke production" investigations have a single authoritative source.
- Before/after diffs let an admin replay or revert a change.
- The log is filterable by entity type, action, and date range so it stays useful at scale.

**Where it lives:** `lib/orchestration/audit/`, `prisma/schema.prisma` (`AiAdminAuditLog`), `.context/admin/orchestration-audit-log.md`.

### 7.3 Versioning for agent configuration (two layers)

**What is it?** An "agent" in Sunrise is a configured AI persona — its system instructions are the prompt that shapes its behaviour, and the rest of its configuration (model, temperature, attached capabilities, knowledge categories, fallback chain) shapes how it runs. Iterating on these is one of the most common admin activities, and "the version that worked yesterday" is often the right answer when today's version regresses.

**What we chose:** Two complementary versioning layers, each tuned to a different use case.

| Layer                               | Storage                                         | Purpose                                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AiAgent.systemInstructionsHistory` | Inline JSON array on the agent record           | Lightweight diff of instruction-only changes; powers the agent edit UI's "what did I change?" view                                                      |
| `AiAgentVersion`                    | Separate table with monotonic `version` numbers | Full agent-config snapshots; referenced by experiments via `AiExperimentVariant.agentVersionId` for traffic-splitting between historical configurations |

**Alternatives**

| Option                        | Why not                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| Overwrite without versioning  | "I made it worse, can I undo?" has no answer                                                  |
| Inline JSON only              | Doesn't capture model, temperature, or capability bindings; experiments have no stable handle |
| Separate table only           | Heavy for the common "what just changed in the prompt?" UI affordance                         |
| External git-style versioning | Adds another tool to the loop; non-developer admins won't use it                              |

**Why this approach**

- The inline JSON history is cheap to read and powers the admin UI's instruction diff without a join.
- The full-snapshot `AiAgentVersion` table holds everything an experiment variant needs to reproduce an old agent exactly — instructions plus model, temperature, and capability set.
- Reverting an instruction change is a one-row update against the inline history; reverting a full configuration is a snapshot restore from `AiAgentVersion`.

**Where it lives:** `prisma/schema.prisma` (`AiAgent.systemInstructionsHistory`, `AiAgentVersion`, `AiExperimentVariant.agentVersionId`), `app/admin/orchestration/agents/` (diff view).

### 7.4 Rolling summary for long conversations

**What is it?** LLM context windows are finite — even at 200K tokens, a long conversation eventually exceeds them. Two ways to deal with this: hard truncation (drop the oldest messages and hope nothing important was there), or rolling summary (replace older history with a concise LLM-generated summary that preserves the gist).

**What we chose:** Rolling summary. When the conversation exceeds the configured threshold, the chat handler asks the LLM to summarise older history into a few hundred tokens, then carries that summary forward in place of the dropped messages.

**Alternatives**

| Option                             | Why not                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| Hard truncation                    | Loses context the user expected the agent to remember (their name, the topic, etc.)          |
| Vector-search over message history | Adds retrieval cost per turn; less effective than a curated summary for narrative continuity |
| No history at all                  | Defeats multi-turn conversation                                                              |

**Why this approach**

- Long conversations stay coherent without exploding token costs.
- The summary itself can be inspected and audited.
- The handler emits explicit events so the client can show "summarised earlier conversation" cues if desired.

**Where it lives:** `lib/orchestration/chat/` (context builder, rolling summary), `.context/orchestration/chat.md`.

### 7.5 In-memory hook registry cache (60s TTL)

**What is it?** "Event hooks" (Section 2.4) are looked up from the database on every event emission — and some events fire many times per second. A "registry cache" stores the hook definitions in memory for a short time, so most lookups don't touch the DB. "TTL" (time-to-live) is how long an entry stays valid.

**What we chose:** A 60-second TTL on the in-process hook registry, invalidated on CRUD operations against hooks. Reads are served from memory; writes invalidate the cache.

**Alternatives**

| Option                               | Why not                                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No cache                             | DB query on every event; latency and load                                                                                                                |
| Long TTL (10+ minutes)               | A change takes a long time to propagate                                                                                                                  |
| Distributed cache (Redis) from day 1 | Adds Redis to the deployment for a relatively minor benefit at current scale; can be swapped in later when horizontal-scale demands it (see §1.6, §10.2) |

**Why this approach**

- High-frequency events skip the DB hit on most calls.
- A configuration change propagates within 60 seconds even on a single instance, immediately on the instance that changed it.
- Section 10.2 covers what changes when this needs to be coordinated across multiple instances.

**Where it lives:** `lib/orchestration/hooks/` (registry, cache), `.context/orchestration/hooks.md`.

### 7.6 Backup schema versioning + structured `ImportResult`

**What is it?** "Backup and restore" lets admins export a Sunrise configuration as JSON and import it elsewhere — for migration, environment promotion, or sharing between deployments. The format will evolve; old exports must remain importable into newer Sunrise versions. A "schema version" on the backup payload makes this explicit.

**What we chose:** Every backup carries a `schemaVersion` field (currently `1`). Imports check the version against the importer's supported range and adapt or reject as needed. The result of an import is a structured `ImportResult` listing per-entity created/updated counts and a `warnings` array.

**Alternatives**

| Option                             | Why not                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------- |
| No version field                   | Older exports break silently as the format changes                         |
| Just a Sunrise application version | Couples the backup format to the whole app version; complicates downgrades |
| Boolean success/failure            | Doesn't surface partial successes (5 of 6 agents imported, 1 conflict)     |

**Why this approach**

- The version field decouples the backup format from the application version.
- Per-entity counts and warnings let the admin UI show "imported 4 agents, 12 capabilities, 2 workflows; 1 warning: provider key not found" instead of an opaque success/failure.
- Forward and backward compatibility is bounded — the importer states which versions it supports, so a customer can plan upgrade or downgrade work deliberately.

**Where it lives:** `lib/orchestration/backup/schema.ts`, `lib/orchestration/backup/importer.ts`, `.context/orchestration/backup.md`.

---

## 8. Deployment and Embedding

How Sunrise reaches the user — directly, embedded into other sites, and across forks of the starter template.

### 8.1 Shadow DOM for the embed widget

**What is it?** The embed widget is a chat interface that runs on a _third-party_ website — a customer's marketing site, a partner's app — connected to a Sunrise agent. There are two common ways to inject UI into a host page: an iframe (a separate browser context, isolated by origin) or direct DOM injection (runs inside the host page, no isolation by default). "Shadow DOM" is a third option: a browser-native encapsulation primitive that creates a sub-tree with its own scoped CSS and DOM, inside the host page but not visible to it.

**What we chose:** A `<script>` tag loads `/api/v1/embed/widget.js`, which mounts a Shadow DOM root on the host page. The widget's CSS, components, and JavaScript run inside the Shadow DOM root, isolated from the host's styles.

**Alternatives**

| Option                            | Why not                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| iframe                            | Same-origin restrictions; harder to size dynamically; cross-frame messaging plumbing |
| Plain DOM injection               | Host CSS pollutes the widget; widget CSS pollutes the host                           |
| Web Components without Shadow DOM | Same CSS pollution problem in either direction                                       |

**Why this approach**

- The widget's appearance is unaffected by the host site's CSS, and vice versa.
- It runs in the host page's context, so size is dynamic and there is no postMessage plumbing.
- A single `<script>` tag is the entire integration; partners do not need a build step.

**Where it lives:** `app/api/v1/embed/widget.js/` (the loader route), `lib/orchestration/embed/` (widget code), `.context/orchestration/embed.md`.

### 8.2 Embed token + CORS origin allowlist

**What is it?** The embed widget makes API calls back to Sunrise from the host page. Two questions: (a) how does Sunrise know the request is from a legitimate widget, and (b) how does the browser's same-origin policy allow the cross-origin request? "CORS" (Cross-Origin Resource Sharing) is the browser mechanism for letting a server explicitly approve cross-origin requests from specific domains.

**What we chose:** Per-agent embed tokens (`AiAgentEmbedToken`) that carry a CORS origin allowlist. The token authenticates the request; the allowlist restricts which host domains can use it.

**Alternatives**

| Option                       | Why not                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------ |
| Open CORS                    | Anyone can embed any agent on any site                                         |
| API key per host             | Heavier; doesn't fit the "drop a script tag" deployment model                  |
| Sign every request with HMAC | Requires server-side code on the host page; widget should run client-side only |

**Why this approach**

- A token leak is bounded to the configured host origins — an attacker cannot use it from a different domain.
- Origins are admin-configurable per-token, so dev / staging / prod can be separate tokens.
- The browser enforces the CORS check; a misconfigured token simply doesn't work, which is observable in browser dev tools.

**Where it lives:** `prisma/schema.prisma` (`AiAgentEmbedToken`), `app/api/v1/embed/`, `.context/orchestration/embed.md`.

### 8.3 `@/` path alias enforced via ESLint

**What is it?** TypeScript's "path alias" feature lets `@/components/button` resolve to a fixed root, instead of using relative paths like `../../../components/button`. The `@/` alias is configured at the project root. The question is whether to use it consistently or allow relative imports for sibling files.

**What we chose:** `@/` everywhere — even between sibling files in the same folder. ESLint's `no-restricted-imports` rule enforces it.

**Alternatives**

| Option                                           | Why not                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Relative imports for siblings, alias for distant | Mixed convention; reviewers and tooling have to ask "is this local?" each time         |
| Relative imports everywhere                      | Renames and folder moves break imports silently; unfriendly to AI-assisted refactoring |
| Per-package aliases (`@/components`, `@/lib`)    | Makes Sunrise feel like a monorepo it isn't; harder for downstream forks               |

**Why this approach**

- Sunrise is shipped as a starter template; downstream forks copy folders, rename modules, and split capsules. `@/` survives those moves; `./` breaks silently.
- A single mechanical rule is grep-checkable by `/pre-pr` and `/code-review`.
- Removes the "is this local or cross-module?" judgment call from every import line.

**Where it lives:** `tsconfig.json` (path config), `.eslintrc` and `eslint.config.mjs` (the `no-restricted-imports` rule), `CLAUDE.md` (the rationale).

### 8.4 `shadcn/ui` + Tailwind 4 as the component model

**What is it?** Component libraries sit on a spectrum. At one end, libraries like MUI, Chakra, and Mantine ship pre-built components as an npm package — fast to install, hard to deeply customise, locked to upstream design decisions. At the other end, Radix UI ships behaviour primitives (a popover that handles focus, a dropdown with arrow-key navigation) but no visual design. `shadcn/ui` sits in between: a _recipe book_ of components that you copy-paste into your own codebase, built on Radix primitives and styled with Tailwind classes. The components live in your repo; you own them.

**What we chose:** `shadcn/ui`-style components copy-pasted into `components/ui/`, built on Radix UI primitives, styled with Tailwind 4. Tailwind 4 is the styling layer; components own their CSS via Tailwind class names rather than separate stylesheets. Icons via `lucide-react` (also tree-shakable).

**Alternatives**

| Option                                 | Why not                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| MUI / Chakra / Mantine                 | Hard to deeply customise; bundle size; design opinions not aligned with the project                      |
| Radix primitives only (no recipes)     | Every team rewrites the same buttons and inputs; inconsistent UX                                         |
| Pure custom components                 | More work; loses Radix's accessibility primitives (focus, keyboard, ARIA)                                |
| CSS-in-JS (styled-components, Emotion) | Runtime overhead; doesn't compose well with Server Components (§1.7)                                     |
| Tailwind 3                             | Tailwind 4's new syntax and config simplifies the setup; we'd be migrating soon anyway                   |
| Pre-built component package            | Loses the "you own the components" property — a fork can't change a `Button` without forking the package |

**Why this approach**

- Every component is editable in place. A downstream fork can change a `Button` without forking a package.
- Accessibility (focus management, keyboard navigation, ARIA) is inherited from Radix.
- Tailwind class names colocate styling with component code — the intent is obvious from the JSX.
- This is the §1.6 dependency-minimalism principle applied to the UI layer: a small set of headless primitives + utility CSS, and the consumer team owns the rest.

**Where it lives:** `components/ui/` (the shadcn-pattern components), `app/globals.css` (Tailwind base layers), Radix UI primitives in `package.json`, `lucide-react` for icons.

### 8.5 React Flow for the workflow visual builder

**What is it?** Workflows in Sunrise are DAGs of typed steps (§3.1). The admin UI exposes them through a visual editor — drag a node onto a canvas, connect nodes with edges, configure each step's properties in a side panel. Building that canvas from scratch is significant work (pan/zoom, edge routing, node selection, undo/redo, auto-layout, accessible drag-and-drop). Several libraries solve it: React Flow (now `@xyflow/react`), Mermaid (read-only diagrams), d3-dag, yFiles (commercial), tldraw.

**What we chose:** `@xyflow/react` (React Flow v12) as the canvas library. We supply the node types, the edge types, the palette, the property inspector, and the step registry; React Flow handles pan, zoom, drag, edge mechanics, selection, serialisation, and accessibility.

**Alternatives**

| Option                               | Why not                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| Custom SVG canvas                    | Several months of work to match React Flow's UX; reinvents accessible drag-and-drop |
| Mermaid                              | Read-only — wrong tool for an editor                                                |
| yFiles or other commercial libraries | License cost; vendor lock-in for what is essentially a non-differentiating feature  |
| Drag-and-drop list builders          | Loses the visual graph that the workflow shape demands (parallel branches, joins)   |
| tldraw                               | More general-purpose drawing tool; less DAG-specific affordance                     |

**Why this approach**

- The workflow builder gets professional UX (auto-layout, smart edge routing, accessible drag) without reinventing it.
- Step types register into the canvas via a small adapter — adding a new step type is one file.
- React Flow's serialisation maps cleanly to the JSON we persist as the workflow definition, so the round-trip is transparent.
- Single bundled dependency for a contained feature (the workflow builder); doesn't leak React Flow concepts into the rest of the codebase.

**Where it lives:** `components/admin/orchestration/workflow-builder/`, `lib/orchestration/workflows/` (validator, step registry on the engine side), `.context/admin/workflow-builder.md`. `@xyflow/react` v12 in `package.json`.

### 8.6 Per-agent widget customisation: scope and locale strategy

**What is it?** Every Sunrise widget that ships into a partner site (housing-association tenant portal, broker microsite, council planning page, B&B concierge, tattoo-studio enquiry form) needs to look like it belongs there. Branding requires colours, fonts, header/footer copy, conversation starters, and — for non-English deployments — a way to localise the chrome. The implementation question is _where_ that configuration lives (per-agent vs per-token), and _how_ localisation works (full i18n framework vs admin-typed copy overrides).

**What we chose:** A single nullable `widgetConfig` JSON column on `AiAgent`. Every embed token for that agent inherits the same skin. Localisation is handled by admin-typed copy overrides — header, subtitle, placeholder, send-button label, conversation starters, footer caption — plus the agent's system instructions for response language. No `locale` field, no translation tables, no i18n framework.

**Alternatives**

| Option                                    | Why not                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `widgetConfig` per-token                  | Adds a JSON column on `AiAgentEmbedToken`, more admin churn (configure tokens twice), and a flexibility most pilots never exercise     |
| Real i18n framework (translation tables)  | Bigger surface than the actual problem; only the widget chrome needs localisation, and copy fields already give admins direct control  |
| `locale` field passed to chat as a prompt | Two places to localise (UI fields + system prompt) instead of one; admins can already say "respond in Spanish" via system instructions |
| Hardcoded design tokens                   | Original Phase 1 — lost partner sign-off because every deployment looked identical to the same blue chat bubble                        |

**Why this approach**

- Per-agent matches the venture-studio worked examples — narrow-audience, single-instance pilots where two partner sites sharing one agent is a future problem, not a v1 problem. The schema is forward-compatible: a per-token override layer can be added later that defaults through to the agent column.
- Admin-typed copy is more direct than a translation framework. The same field that says "Type a message…" can become "Escribe un mensaje…" without introducing locale negotiation, fallback chains, or pluralisation rules.
- One JSON column keeps validation centralised: `widgetConfigSchema` (Zod) plus `resolveWidgetConfig(stored)` for defensive read-time merge with `DEFAULT_WIDGET_CONFIG`. Invalid stored data degrades to defaults; the widget never crashes a partner page.
- The widget loader assigns CSS custom properties on the Shadow DOM host (`--sw-primary`, `--sw-surface`, `--sw-text`, `--sw-font`, …) so a single property write cascades through the inline `<style>` block via `var()` — admins paint once, the cascade does the rest.
- All copy is rendered via `textContent` / `setAttribute('placeholder', …)`. Hex colours are regex-validated; font-family is allowlist-validated to block `{ } ; ( )` so a stored font value cannot escape its CSS declaration. Defence-in-depth at both the schema and DOM-API layers.

**Where it lives:** `prisma/schema.prisma` (`AiAgent.widgetConfig`), `lib/validations/orchestration.ts` (`widgetConfigSchema`, `DEFAULT_WIDGET_CONFIG`, `resolveWidgetConfig`), `app/api/v1/embed/widget-config/route.ts` (public, token-authed), `app/api/v1/admin/orchestration/agents/[id]/widget-config/route.ts` (admin GET/PATCH), `app/api/v1/embed/widget.js/route.ts` (loader + CSS-var assignment), `components/admin/orchestration/agents/widget-appearance-section.tsx` (admin form), `.context/orchestration/embed.md` (Widget customisation section).

---

## 9. Observability and Quality

How problems are detected, diagnosed, and prevented from reoccurring.

### 9.1 Structured logger with request context

**What is it?** A "structured logger" emits log entries as JSON objects with named fields (`{ level, message, requestId, agentId, ... }`), instead of plain text. "Request context" propagates fields like the request ID through every log line emitted while handling that request, so log lines for one request can be filtered out of a noisy production log.

**What we chose:** A custom logger module (`lib/logging`) used everywhere instead of `console`. Request context (request ID, user ID, agent ID) is set per request and applied to every log line.

**Alternatives**

| Option                     | Why not                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `console.log` everywhere   | No structure; can't filter; no context propagation; production parsing nightmare                                                                                                            |
| Pino / Winston / Bunyan    | Heavy; the project's needs are modest enough that a thin wrapper is sufficient. A fork can swap the logger module for any of these without changing call sites (see §1.6)                   |
| OpenTelemetry from day one | OTEL is the right answer at scale (Section 10) but premature for current deployments. The thin logger interface lets a fork wire OTEL when distributed tracing becomes necessary (see §1.6) |

**Why this approach**

- Every log line in a production deployment can be correlated by request ID without manually threading it through call sites.
- A simple, dependency-free module is easy to swap for a heavier alternative when the time comes.
- The "use logger not console" rule is enforced in `CLAUDE.md` and `/pre-pr`.

**Where it lives:** `lib/logging/`, `.context/logging/`.

### 9.2 Per-operation cost log

**What is it?** Every LLM call has a cost. Aggregating cost only at the agent or month level loses the per-conversation, per-step, per-provider detail that makes debugging and chargeback possible.

**What we chose:** `AiCostLog` records cost per LLM call: input tokens, output tokens, computed cost, agent, conversation, user, provider, model. Aggregation is built on top in the cost summary and breakdown endpoints.

**Alternatives**

| Option                                | Why not                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| Provider-side billing dashboards only | Aggregated at the API key level; can't attribute to a specific agent or conversation |
| Daily roll-ups only                   | Useful for trends, useless for "why did this conversation cost $50?"                 |
| In-memory counters                    | Lost on restart; not auditable                                                       |

**Why this approach**

- Customer chargeback, debugging cost spikes, and budget enforcement all draw from the same source of truth.
- Fire-and-forget insertion (Section 2.6) means a logging hiccup doesn't fail the user-facing call.
- The log feeds the cost breakdown UI, the savings-from-fallback metric, and the budget alerts.

**Where it lives:** `lib/orchestration/llm/` (cost tracking), `prisma/schema.prisma` (`AiCostLog`), `.context/admin/orchestration-costs.md`.

### 9.3 DB-backed experiments with traffic splitting

**What is it?** "A/B testing" for agents means running two configurations side by side and comparing how they perform — with real users, not synthetic benchmarks. An "experiment" packages this: the hypothesis, the variants, the lifecycle (draft → running → completed), the traffic split, and the result.

**What we chose:** `AiExperiment` with `AiExperimentVariant` rows. Variants vary model, temperature, instructions, or other agent fields. The experiment runner directs incoming traffic across variants according to the configured split.

**Alternatives**

| Option                                    | Why not                                                  |
| ----------------------------------------- | -------------------------------------------------------- |
| External A/B platform (LaunchDarkly etc.) | Adds a vendor; doesn't know about agent-specific metrics |
| Manual cloning of the agent               | Loses the structured comparison; no traffic split logic  |
| LLM evals only                            | Synthetic; doesn't measure real-user behaviour           |

**Why this approach**

- Variants are versioned alongside the agent they belong to.
- The experiment lifecycle is structured: draft, running, completed — with explicit promotion rules.
- Real-user metrics (engagement, completion, satisfaction) feed the comparison.

**Where it lives:** `lib/orchestration/` (experiment runner), `prisma/schema.prisma` (`AiExperiment`, `AiExperimentVariant`), `.context/orchestration/experiments.md`.

### 9.4 LLM-driven evaluation completion

**What is it?** "Evaluations" are structured assessments of agent quality: did the agent answer correctly, did it cite, did it stay on topic, did it follow the brand voice. The bottleneck is usually human reviewer time. An "LLM-driven completion handler" uses an LLM to score the evaluation against a rubric, leaving humans to spot-check rather than score every entry.

**What we chose:** Evaluation sessions with criteria defined up front. Log entries are scored by an LLM against the rubric; humans annotate where they disagree, which feeds future rubric refinement.

**Alternatives**

| Option                            | Why not                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure manual scoring               | Doesn't scale beyond a small sample                                                                                                             |
| Pure automated scoring (no human) | Misses subtle quality issues; no calibration                                                                                                    |
| Third-party eval platform         | Default eval lives in-process so data stays in the deployment; a fork can additionally export sessions to an external platform later (see §1.6) |

**Why this approach**

- Evaluation throughput is bounded by LLM calls, not human hours.
- Human annotations stay valuable — they calibrate the rubric and catch LLM-scoring blind spots.
- Sessions and logs feed back into the analytics surface (`unanswered_questions`, `coverage_gaps`).

**Where it lives:** `lib/orchestration/evaluations/`, `prisma/schema.prisma` (`AiEvaluationSession`, `AiEvaluationLog`), `.context/admin/orchestration-evaluations.md`.

---

## 10. Multi-Instance Deployment & Acknowledged Gaps

These three entries describe places where the current implementation deliberately accepts a limitation. Naming the trade-off explicitly is the point.

### 10.1 Optimistic locking + ticket-based overlap guard for the maintenance tick

**What is it?** Sunrise has a single periodic "maintenance tick" endpoint that processes due cron schedules, retries failed deliveries, and runs other background work. In a multi-instance deployment behind a load balancer, the same scheduled job could be picked up by two instances at once, doing the work twice. "Optimistic locking" reserves a row by atomically updating it with a check-and-set; "ticket-based overlap" ensures a late-finishing tick from instance A cannot release a guard that instance B has since claimed.

**What we chose:** Schedules are claimed with optimistic-lock updates so only one instance processes a given run. The maintenance tick uses monotonic ticket tokens so a slow tick on instance A does not interfere with a newer tick on instance B.

**Alternatives**

| Option                                 | Why not                                                             |
| -------------------------------------- | ------------------------------------------------------------------- |
| External job scheduler (Bull, Sidekiq) | Adds Redis; the database already has the locking primitives we need |
| Single-instance-only constraint        | Defeats horizontal scaling for the maintenance tick                 |
| No coordination                        | Schedules fire twice; deliveries duplicate                          |

**Why this approach**

- The current scaling model (multiple Next.js instances, single Postgres) supports horizontal scale for the request path without adding Redis.
- Optimistic locking is a property of the database and tested under concurrency.
- The tradeoff (in-memory state for circuit breaker / budget) lives in the next entry.

**Where it lives:** `lib/orchestration/scheduling/`, `.context/orchestration/scheduling.md`.

### 10.2 In-memory state for circuit breaker and budget mutex

**What is it?** Two pieces of in-memory state currently live per-instance: the circuit breaker (Section 4.1) and the budget mutex (Section 3.5, Section 4.3). On a single instance, this is fine. On multiple instances behind a load balancer, instance A may not know that instance B's circuit breaker is open, and instance A's budget mutex does not coordinate with instance B's.

**What we chose:** Accept the limitation for now. Each instance maintains its own circuit breaker and budget mutex; the failure modes are documented and bounded.

**Alternatives**

| Option                               | Why not                                                                                                                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add Redis for shared state           | Adds an external dependency before horizontal scaling is the bottleneck. Fork-and-add is the planned path when scale demands it — the boundary around in-memory state is narrow on purpose (see §1.6) |
| Sticky sessions on the load balancer | Works for budget mutex per agent; doesn't help the circuit breaker globally                                                                                                                           |
| Pretend it's not a problem           | Misleads operators planning a horizontal-scale deployment                                                                                                                                             |

**Why this approach**

- For single-instance deployments (the most common Sunrise topology today), the in-memory state is fine.
- For multi-instance deployments, the worst case is bounded: each instance independently rate-limits a failing provider; budget can be exceeded by approximately one concurrent request per instance.
- When customers reach the scale where this matters, swapping to Redis is a small, contained change — both are accessed through narrow interfaces.

**Where it lives:** `lib/orchestration/llm/circuit-breaker.ts`, `lib/orchestration/llm/` (budget mutex), `.context/orchestration/resilience.md`. The migration target is documented in `improvement-priorities.md`.

### 10.3 Checkpoint recovery limited to `human_approval` pauses

**What is it?** "Checkpoint recovery" means the orchestration engine can resume a workflow after a crash by replaying from a saved snapshot. LangGraph's gold-standard approach checkpoints state at every super-step. Sunrise currently only persists a recoverable state at one specific kind of pause — the `human_approval` step.

**What we chose:** Persist execution state when a workflow pauses for human approval; do not persist intermediate state across other steps. A crash mid-workflow loses in-flight state for that run; the run is marked failed and can be re-run.

**Alternatives**

| Option                                              | Why not                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| Full checkpoint at every step                       | DB write per step; slows the engine; complicates parallel branch semantics |
| No checkpoint at all                                | Approval flow could not resume across deploy or crash                      |
| Use an external checkpointer (LangGraph or similar) | Reintroduces the external-framework problem (Section 1.1)                  |

**Why this approach**

- Approval is the case where checkpointing is required — humans take days to respond, and the workflow must survive a deploy in the interim.
- For other steps, the engine prioritises throughput; a crash during a 30-second workflow is rare and the rerun is cheap.
- The `improvement-priorities.md` document tracks broader checkpointing as a future enhancement when use cases demand it.

**Where it lives:** `lib/orchestration/engine/`, `.context/orchestration/engine.md`, `improvement-priorities.md`.

### 10.4 Maintenance tick: 202 + background-chain with watchdog

**What is it?** The "maintenance tick" is a periodic endpoint that an external scheduler (cron, GitHub Action, an external pinger) calls to drive Sunrise's background work — processing due cron schedules, retrying failed webhook and hook deliveries, reaping stale executions, generating embeddings, applying retention policies, and resuming pending executions. The naïve design runs everything synchronously and returns when done — but a single tick can take minutes, well past most schedulers' HTTP timeout.

**What we chose:** The endpoint runs the time-critical step (`processDueSchedules`) synchronously, then fires the rest as a `Promise.allSettled()` background chain with a 5-minute watchdog, and returns HTTP 202 immediately. Long-running tasks finish after the response is already on the wire.

**Alternatives**

| Option                                  | Why not                                                     |
| --------------------------------------- | ----------------------------------------------------------- |
| Run everything synchronously            | Caller's HTTP client times out; partial work is invisible   |
| External worker queue                   | Adds Redis or SQS for what is fundamentally a periodic task |
| Spawn background tasks with no watchdog | A stuck task pins memory forever                            |

**Why this approach**

- Schedulers see a fast 202 and don't retry on timeout.
- The schedule-processing step still finishes before the response — so the caller knows whether the cron "succeeded" in the sense it cares about.
- The 5-minute watchdog bounds the worst case for a stuck task without requiring an external job runner.

**Where it lives:** `app/api/v1/admin/orchestration/maintenance/tick/route.ts`, `.context/orchestration/scheduling.md`.

### 10.5 Cron scheduling architecture

**What is it?** Some workflows should run on a recurring schedule — every weekday morning, every five minutes, the first of every month. The standard expression for "when" is _cron syntax_ (`0 9 * * 1-5` reads as "9am Monday through Friday"). The architectural questions are: where do schedules live, how is the next run computed, what process actually fires them, and how is double-firing prevented when multiple application instances are running.

**What we chose:**

| Concern              | Choice                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Storage**          | `AiWorkflowSchedule` rows linked to a workflow; each row stores the cron expression, the configured timezone, and the computed `nextRunAt` timestamp              |
| **Parsing**          | The `cron-parser` library (`CronExpressionParser.parse`) validates the expression at save time and computes the next run after each firing                        |
| **Execution**        | The maintenance tick endpoint (§10.4) runs `processDueSchedules`, finds rows with `nextRunAt <= now`, dispatches the linked workflow, and recomputes the next run |
| **Concurrency**      | Schedule claims use the optimistic-locking pattern from §10.1 — two instances cannot both fire the same schedule                                                  |
| **External trigger** | The maintenance tick is HTTP — any pinger (system cron, GitHub Actions, Cloud Run cron, an uptime monitor) can drive it                                           |

**Alternatives**

| Option                                             | Why not                                                                                                                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External job scheduler (Bull, Sidekiq, Temporal)   | Adds Redis or another broker for what fits in Postgres — `cron-parser` plus optimistic locks does the job. The boundary is small enough that a fork can introduce a job runner later (see §1.6) |
| OS-level cron                                      | Runs outside the application; loses observability, admin UX, and the audit trail                                                                                                                |
| In-process timers (`setInterval`)                  | Lost on restart; doesn't survive deploys; no multi-instance coordination                                                                                                                        |
| Vendor scheduler (Vercel Cron, GCP Scheduler) only | Couples the schedule logic to a host; data and audit leave the deployment                                                                                                                       |

**Why this approach**

- Schedules are first-class admin objects — viewable, editable, and auditable through the same UI as the workflows they drive.
- A single Postgres write claims a run; no external broker, no separate worker pool.
- The cron tick is HTTP-triggered, so any external pinger works. We don't couple the scheduler to one host.
- `cron-parser` handles every edge case of cron expressions (DST transitions, ranges, step values, list syntax) without us reimplementing it.

**Where it lives:** `lib/orchestration/scheduling/scheduler.ts`, `prisma/schema.prisma` (`AiWorkflowSchedule`), `app/api/v1/admin/orchestration/maintenance/tick/`, `.context/orchestration/scheduling.md`. `cron-parser` v5 in `package.json`.

---

## Appendix: Decision Index

Alphabetical index of every decision in this document, with section reference. Use this to jump straight to a concept (e.g. "What is SSE?") without scrolling.

| Decision                                                       | Section |
| -------------------------------------------------------------- | ------- |
| Agent-scoped knowledge categories                              | 5.7     |
| API-first design                                               | 1.3     |
| Backup schema versioning + structured `ImportResult`           | 7.6     |
| `better-auth` as the authentication substrate                  | 6.10    |
| Budget enforcement inside the execution loop                   | 4.3     |
| Checkpoint recovery limited to `human_approval` pauses         | 10.3    |
| Circuit breaker for LLM providers                              | 4.1     |
| Citation envelope, `[N]` markers, and citation guard           | 5.6     |
| Conversation similarity via message embeddings                 | 5.8     |
| Credentials only via environment variables                     | 6.4     |
| Cron scheduling architecture                                   | 10.5    |
| CSV row-level chunking                                         | 5.4     |
| Custom orchestration engine vs an external framework           | 1.1     |
| DAG workflows + the autonomous orchestrator step               | 3.1     |
| DB-backed experiments with traffic splitting                   | 9.3     |
| Default-allow dispatch + default-deny LLM visibility           | 3.3     |
| Dependency minimalism — open to future architectural decisions | 1.6     |
| Embed token + CORS origin allowlist                            | 8.2     |
| Embedding provider choice and the 1536-dimension ceiling       | 5.10    |
| `ExecutorError.retriable` classification                       | 4.6     |
| Fire-and-forget for cost logging and hook dispatch             | 2.6     |
| Frozen context snapshots for executors                         | 3.4     |
| HMAC-SHA256 signed tokens for stateless external approvals     | 2.5     |
| HTTP idempotency-key support on external calls                 | 6.9     |
| Hybrid BM25 + vector search                                    | 5.2     |
| Immutable audit log                                            | 7.2     |
| In-memory hook registry cache (60s TTL)                        | 7.5     |
| In-memory state for circuit breaker and budget mutex           | 10.2    |
| In-process event hooks alongside outbound webhooks             | 2.4     |
| JSON-RPC 2.0 over Streamable HTTP for the MCP server           | 2.2     |
| Knowledge namespace scope: agent, not team                     | 5.9     |
| LLM-driven evaluation completion                               | 9.4     |
| Maintenance tick: 202 + background-chain with watchdog         | 10.4    |
| MCP session lifecycle and eviction                             | 2.7     |
| Mid-stream provider failover                                   | 3.6     |
| Multi-format ingestion via parser-per-format                   | 5.3     |
| Multi-tier rate-limit topology                                 | 6.7     |
| Next.js 16 + App Router + React Server Components              | 1.4     |
| Optimistic locking + ticket-based overlap guard                | 10.1    |
| Outbound webhooks with retry                                   | 2.3     |
| Ownership scoping returns 404 not 403                          | 6.3     |
| Parallel branch aggregation: wait-all only                     | 4.7     |
| Path alias `@/` enforced via ESLint                            | 8.3     |
| PDF preview/confirm flow                                       | 5.5     |
| Per-agent ordered fallback chains                              | 4.2     |
| Per-agent widget customisation: scope and locale strategy      | 8.6     |
| Per-host outbound rate limiter with `Retry-After` respect      | 6.8     |
| Per-operation cost log                                         | 9.2     |
| Per-step timeout wrapper                                       | 4.5     |
| pgvector vs a dedicated vector database                        | 5.1     |
| Platform-agnostic core                                         | 1.2     |
| PostgreSQL + Prisma 7                                          | 7.1     |
| Provider selector task-intent heuristic                        | 3.7     |
| React Flow for the workflow visual builder                     | 8.5     |
| React Server Components, Suspense, and streaming SSR           | 1.7     |
| Rolling summary for long conversations                         | 7.4     |
| Server-Sent Events (SSE) for streaming                         | 2.1     |
| Seven-stage capability dispatch pipeline                       | 3.2     |
| `shadcn/ui` + Tailwind 4 as the component model                | 8.4     |
| Shadow DOM for the embed widget                                | 8.1     |
| Single-artifact Docker deployment                              | 1.5     |
| SSRF protection via host allowlist for `external_call`         | 6.5     |
| Structured logger with request context                         | 9.1     |
| Three-guard pipeline: input, output, citation                  | 6.6     |
| Three-mode safety guards                                       | 4.4     |
| Token vs session authentication                                | 6.2     |
| Tool loop with budget check before every LLM call              | 3.5     |
| User memory: per-user-per-agent persistent facts               | 3.8     |
| Versioning for agent configuration (two layers)                | 7.3     |
| Workflow templates and dry-run mode                            | 3.9     |
| Zod validation at every boundary                               | 6.1     |
