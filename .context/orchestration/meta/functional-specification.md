# Orchestration Layer — Functional Specification

A comprehensive specification of the AI agent orchestration system built into the Sunrise platform.

**Last updated:** 2026-05-02

---

## Executive Summary

Sunrise ships a **full-stack AI agent orchestration platform** embedded within a production-grade Next.js 16 / TypeScript application. Unlike standalone orchestration libraries (LangGraph, CrewAI) or managed cloud services (AWS Bedrock, Azure Foundry), Sunrise delivers the orchestration engine, admin interface, consumer API, security layer, and deployment infrastructure as a single typed codebase.

The orchestration layer comprises **116 TypeScript source files** across 19 modules, backed by **29 Prisma models**, exposed through **133 API route files** (120 admin + 2 public approval + 8 consumer chat + 2 embed + 1 MCP), and managed via a **20+ page admin dashboard**.

This is not a wrapper around a third-party AI library. It is a purpose-built orchestration engine with cost enforcement, provider resilience, multi-format knowledge retrieval, DAG workflow execution, and production security — all sharing types, validation schemas, and authentication with the application layer beneath it.

---

## Foundation: The Sunrise Platform

The orchestration layer builds on Sunrise's production-grade application foundation:

| Layer              | Technology            | Role                                            |
| ------------------ | --------------------- | ----------------------------------------------- |
| **Runtime**        | Next.js 16 / React 19 | Server Components, App Router, SSE streaming    |
| **Language**       | TypeScript (strict)   | End-to-end type safety, shared validation       |
| **Database**       | PostgreSQL + Prisma 7 | Schema migrations, vector extensions (pgvector) |
| **Authentication** | better-auth           | Session management, admin/consumer roles        |
| **Security**       | Multi-layer           | Rate limiting, CORS, CSP, input sanitisation    |
| **Logging**        | Structured logger     | Request context, log levels, audit trails       |
| **Deployment**     | Docker Compose        | Single-artifact deployment                      |

The orchestration layer inherits all of this — authentication, rate limiting, structured logging, database migrations, and type-safe API responses — without reimplementing any of it. A new orchestration endpoint gets auth guards, rate limiting, Zod validation, and structured error responses by following the existing pattern.

---

## Architectural Boundaries

```
lib/orchestration/           ← Platform-agnostic core (NO Next.js imports)
├── analytics/               ← Usage analytics, popular topics, engagement
├── audit/                   ← Immutable config change logging
├── backup/                  ← Export/import configuration
├── capabilities/            ← Tool dispatcher, built-in tools, rate limiting
│   └── built-in/            ← System capabilities (knowledge search, memory, etc.)
├── chat/                    ← Streaming handler, context builder, guards
├── engine/                  ← Runtime executor, event stream
│   └── executors/           ← 15 step type executors
├── evaluations/             ← Evaluation session completion
├── hooks/                   ← Event hook dispatch, delivery tracking
├── knowledge/               ← Document ingestion, chunking, embeddings, search
│   └── parsers/             ← Multi-format document parsers
├── llm/                     ← Provider abstraction, model registry, cost tracking
├── mcp/                     ← Model Context Protocol server
│   └── resources/           ← MCP resource handlers
├── scheduling/              ← Cron schedules, maintenance tick
├── utils/                   ← Shared orchestration utilities
├── webhooks/                ← Webhook subscriptions, delivery, retry
└── workflows/               ← DAG validation, step types, templates
```

**Hard architectural rule:** `lib/orchestration/` contains zero Next.js imports. The core is pure TypeScript — testable without a server runtime, portable to other host frameworks. The API layer (`app/api/v1/`) handles HTTP concerns (auth, request parsing, SSE formatting) and delegates to the core.

---

## 1. Agent Management

### 1.1 Agent Configuration

An agent is the primary deployment unit: a configured AI persona with model selection, behaviour parameters, attached capabilities, knowledge scope, and budget constraints.

| Property                    | Purpose                                             |
| --------------------------- | --------------------------------------------------- |
| `name` / `slug`             | Human and machine identifiers                       |
| `systemInstructions`        | Persona, behaviour rules, domain context            |
| `model` / `provider`        | LLM model and provider selection                    |
| `temperature` / `maxTokens` | Generation parameters                               |
| `monthlyBudgetUsd`          | Per-agent spend cap with 80% warning threshold      |
| `fallbackProviders`         | Ordered failover chain (up to 5 providers)          |
| `knowledgeCategories`       | Scoped knowledge base access                        |
| `capabilities`              | Attached tools the agent can invoke                 |
| `visibility`                | Access control: `internal`, `public`, `invite_only` |

### 1.2 Agent Lifecycle

- **Versioning**: Instruction changes create `AiAgentVersion` records — full history with diff capability
- **Cloning**: Duplicate an agent with all configuration for A/B experimentation
- **Export/Import**: JSON serialisation for backup, migration, or sharing between environments
- **Bulk operations**: Multi-agent export, comparison between agents
- **System agents**: Protected agents (`isSystem: true`) that cannot be deleted or deactivated

### 1.3 Agent Visibility & Access Control

Three visibility modes control who can interact with an agent:

| Mode          | Access                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| `internal`    | Admin users only (testing, development)                                |
| `public`      | Anyone with the chat endpoint                                          |
| `invite_only` | Token holders only — `AiAgentInviteToken` with expiry and usage limits |

Embed tokens (`AiAgentEmbedToken`) provide separate auth for widget deployments with CORS origin restrictions.

---

## 2. LLM Provider Management

### 2.1 Multi-Provider Abstraction

The provider layer abstracts across LLM vendors with a unified interface:

- **8+ provider types supported**: Anthropic, OpenAI, Google, Mistral, Cohere, Voyage AI, Ollama, custom/OpenAI-compatible
- **Model registry**: `AiProviderModel` records with tier classification (economy, standard, premium, enterprise), context window sizes, and capability flags
- **Credential management**: API keys stored in `AiProviderConfig`, resolved from environment variables at runtime, never exposed to LLM context or client responses

### 2.2 Provider Resilience

| Mechanism               | Behaviour                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------- |
| **Circuit breaker**     | 5 failures within 60s triggers 30s cooldown; auto-recovers                          |
| **Fallback chains**     | Per-agent ordered list of fallback providers; tried sequentially on primary failure |
| **Health monitoring**   | Provider status tracked; unhealthy providers skipped in selection                   |
| **Mid-stream failover** | Chat handler can switch providers during a streaming response on failure            |

### 2.3 Provider Selection

A task-based selection heuristic recommends models by use case:

| Task Type    | Selection Criteria                           |
| ------------ | -------------------------------------------- |
| `routing`    | Fast, cheap — economy tier                   |
| `chat`       | Balanced quality/cost — standard tier        |
| `reasoning`  | Maximum capability — premium/enterprise tier |
| `embeddings` | Dimension-compatible embedding model         |

Selection profiles are configurable per-agent and at global settings level.

---

## 3. Cost & Budget Enforcement

### 3.1 Cost Tracking

Every LLM call logs cost to `AiCostLog`:

- Input/output token counts
- Computed cost (per-model pricing)
- Associated agent, conversation, and user
- Provider and model used
- Fire-and-forget logging (never blocks user response)

### 3.2 Budget Controls

| Level                   | Enforcement                                                               |
| ----------------------- | ------------------------------------------------------------------------- |
| **Per-agent monthly**   | 80% threshold triggers warning; 100% blocks further calls                 |
| **Global monthly**      | Hard cap across all agents combined                                       |
| **Mid-execution check** | Budget verified inside the tool loop — stops mid-conversation if exceeded |

### 3.3 Cost API

- **Breakdown endpoint**: Per-agent, per-model, per-day cost attribution
- **Summary endpoint**: Monthly totals, trends, savings from fallback routing
- **Alerts**: Budget threshold notifications

---

## 4. Capability (Tool) System

### 4.1 Capability Registry

Capabilities are DB-backed tool definitions (`AiCapability`) with:

- JSON Schema parameter definitions (Zod-validated)
- Execution handlers
- Rate limits (per-capability sliding window)
- Approval gates (human-in-the-loop before execution)
- Category classification
- Usage statistics

### 4.2 Dispatch Pipeline (7 Stages)

Every capability invocation passes through:

1. **Registry lookup** — resolve capability by name from DB
2. **Binding check** — verify capability is attached to the requesting agent
3. **Rate limit** — per-capability sliding window enforcement
4. **Approval gate** — pause for human approval if configured
5. **Argument validation** — Zod schema validation on tool arguments
6. **Execution with timeout** — run handler with configurable timeout
7. **Cost logging** — record any LLM calls made during execution

### 4.3 Visibility Model

A deliberate split between dispatch and LLM awareness:

- **Default-allow dispatch**: Any registered capability can be called if bound to the agent
- **Default-deny LLM visibility**: The LLM only sees capabilities explicitly listed in its tool definitions

This prevents the LLM from being confused by tools it shouldn't use while maintaining flexibility for programmatic invocation.

### 4.4 Built-in Capabilities

| Capability               | Function                                                                |
| ------------------------ | ----------------------------------------------------------------------- |
| `search_knowledge_base`  | Semantic search across ingested documents; produces a citation envelope |
| `estimate_workflow_cost` | Pre-execution cost estimation for workflows                             |
| `get_pattern_detail`     | Retrieve agentic design pattern information                             |
| `read_user_memory`       | Access user-specific memory store                                       |
| `write_user_memory`      | Persist user-specific information                                       |

System capabilities are protected (`isSystem: true`) — they cannot be deleted or deactivated.

---

## 5. Workflow Engine

### 5.1 DAG Execution

Workflows are directed acyclic graphs of steps, validated at save time and executed by the `OrchestrationEngine`. The engine provides:

- **Parallel execution**: Multiple branches execute concurrently
- **Frozen context snapshots**: Executors receive `Readonly<ExecutionContext>` — no shared state mutation
- **Cancellation**: Dual-path (client disconnect + DB flag) for reliable stop
- **Event streaming**: Real-time execution events for UI feedback
- **Template interpolation**: Dynamic prompts with variable substitution

### 5.2 Step Types (15)

| Step Type          | Purpose                                    |
| ------------------ | ------------------------------------------ |
| `llm_call`         | Generate text from an LLM                  |
| `tool_call`        | Invoke a registered capability             |
| `condition`        | Branch based on expression evaluation      |
| `parallel`         | Execute multiple branches concurrently     |
| `loop`             | Repeat steps with exit conditions          |
| `transform`        | Data transformation between steps          |
| `human_approval`   | Pause for human review and approval        |
| `agent_call`       | Delegate to another agent                  |
| `orchestrator`     | Planner LLM decides next steps dynamically |
| `external_call`    | HTTP request to external service           |
| `knowledge_search` | Query the knowledge base                   |
| `code_eval`        | Evaluate expressions                       |
| `wait`             | Timed delay                                |
| `notify`           | Send notification/webhook                  |
| `aggregate`        | Combine results from parallel branches     |

### 5.3 Error Strategies

Each step can define its own error handling:

| Strategy   | Behaviour                                    |
| ---------- | -------------------------------------------- |
| `retry`    | Retry with configurable attempts and backoff |
| `fallback` | Execute alternative step on failure          |
| `skip`     | Mark as skipped, continue execution          |
| `fail`     | Halt entire workflow execution               |

### 5.4 Workflow Lifecycle

- **Validation**: DAG structure validated at save time (cycle detection, connectivity)
- **Dry-run**: Execute with mocked LLM calls to verify flow
- **Definition history**: Versioned workflow definitions with revert capability
- **Templates**: 5 built-in templates as starting points
- **Scheduling**: Attach cron schedules for automated execution

### 5.5 Execution Management

- **Execution records**: `AiWorkflowExecution` tracks state, results, timing
- **Executions list**: Admin page (`/admin/orchestration/executions`) listing all executions with status filter, workflow filter, and links to step-by-step trace detail. Accessible from the Operate sidebar section.
- **Approval queue**: Admin page listing `paused_for_approval` executions with expandable rows showing approval prompt, cost summary, previous steps, and input data. Approve with optional notes or reject with required reason. Sidebar badge shows pending count; Operate subgroup auto-opens when approvals are pending.
- **Admin approval endpoints**: Session-authenticated approve/reject via admin API. Supports ownership check and approver delegation — non-owner admins can approve if their user ID is in the step's `approverUserIds` list.
- **External approval endpoints**: Token-authenticated public endpoints (`/api/v1/orchestration/approvals/:id/{approve,reject}`) using stateless HMAC-SHA256 signed tokens. No session cookies required — the token IS the auth. Rate limited.
- **Shared approval actions**: Both admin and external endpoints delegate to shared `executeApproval()` / `executeRejection()` functions for consistent DB updates, optimistic locking, and event emission.
- **Notification dispatcher**: When an execution pauses, a `workflow.paused_for_approval` hook event and `approval_required` webhook event are emitted with pre-signed approve/reject URLs and channel metadata. External consumers (Slack bots, email services) build approval UIs from these payloads.
- **Approver scoping**: Optional `approverUserIds` in `humanApprovalConfigSchema` enables delegation to specific admins beyond the execution owner.
- **Step retry**: Individual failed steps can be retried without re-running the workflow
- **Cancellation**: In-flight executions can be cancelled

---

## 6. Streaming Chat

### 6.1 Chat Handler

The chat handler is the primary consumer-facing interface — an SSE stream that supports multi-turn conversation with tool use:

- **SSE event types**: `start`, `content`, `status`, `capability_result`, `capability_results`, `warning`, `content_reset`, `citations`, `done`, `error`
- **Tool loop**: Iterative tool calling until the LLM produces a final response
- **Rolling summary**: Long conversations are summarised to fit context windows
- **Provider failover**: Mid-stream switch to fallback provider on failure
- **Budget check**: Verified before each LLM call in the tool loop
- **Citation envelope**: Citation-producing tools (currently `search_knowledge_base`) get their results augmented with monotonic `[N]` markers so the LLM can cite inline. The handler emits a single `citations` event before `done` and persists the envelope on the assistant message metadata.

### 6.2 Context Building

The context builder assembles the LLM prompt from:

- System instructions (from agent configuration)
- Conversation history (with rolling summary for long conversations)
- User memory (persistent per-user facts)
- Tool definitions (capabilities bound to the agent)
- Knowledge context (if RAG is triggered)

### 6.3 Input Guard

Prompt injection detection with three modes:

| Mode                | Behaviour                                  |
| ------------------- | ------------------------------------------ |
| `log_only`          | Detect and log, never interfere (default)  |
| `warn_and_continue` | Log + include warning in response metadata |
| `block`             | Reject the message entirely                |

Detects three injection pattern types: `system_override`, `role_confusion`, `delimiter_injection`.

### 6.4 Output Guard

Content filtering on LLM responses:

- **Topic boundaries**: Configurable allowed/disallowed topics
- **PII detection**: Flag or redact personal information in responses
- **Brand voice**: Enforce tone and terminology constraints

Same three modes as input guard: `log_only`, `warn_and_continue`, `block`.

### 6.4.1 Citation Guard

Opt-in companion to the output guard. Validates that responses grounded in retrieved knowledge include `[N]` markers matching the citation envelope. Detects two failure modes:

- **Under-citation**: citations were retrieved but no `[N]` marker appears in the response
- **Hallucinated marker**: a `[N]` marker appears that no citation produced

Vacuously passes when no citations were produced, so non-RAG responses are never flagged. Per-agent + global `citationGuardMode` field follows the same `log_only` / `warn_and_continue` / `block` precedence as input/output guards.

### 6.5 Message Controls

- **Per-user rate limiting**: 20 messages/min per user ID
- **Per-conversation caps**: Configurable maximum messages per conversation
- **Message embedding**: `AiMessageEmbedding` for conversation similarity search

---

## 7. Knowledge Base (RAG)

### 7.1 Document Ingestion

Multi-format document processing pipeline:

- **Supported formats**: Markdown (`.md`), plain text (`.txt`), with parser architecture for extension
- **Size limit**: 10 MB per document
- **Lifecycle**: `pending` → `processing` → `ready` (or `failed`)
- **PDF preview flow**: Upload → parse preview → confirm → ingest (unique to Sunrise)

### 7.2 Chunking & Embedding

- **Semantic chunking**: Content split at natural boundaries (paragraphs, sections)
- **Vector embeddings**: Stored in `AiKnowledgeChunk` with pgvector (`vector(1536)`)
- **Embedding providers**: Voyage AI (recommended), OpenAI, Ollama
- **Category tagging**: Documents assigned categories for agent-scoped retrieval

### 7.3 Search

- **Vector similarity**: pgvector cosine similarity search
- **Agent scoping**: `knowledgeCategories` on agent restricts which chunks are searchable
- **Search configuration**: Tunable via global settings (vector weight, result count)
- **Knowledge graph**: Relationship mapping between documents and concepts

### 7.4 Knowledge API (10 routes)

Document CRUD, search testing, seeding, embedding management, retry for failed documents, and pattern-based knowledge operations.

---

## 8. MCP Server (Model Context Protocol)

Sunrise implements a **full MCP server** — exposing its capabilities to external MCP clients (Claude Desktop, IDE extensions, other agents):

### 8.1 Transport

- **Protocol**: Streamable HTTP (JSON-RPC 2.0)
- **Methods**: POST (requests), GET (SSE notification stream), DELETE (session termination)
- **Batch support**: Up to 20 JSON-RPC requests per batch
- **Size limit**: 1 MB max request body

### 8.2 Features

| Feature                | Implementation                                                               |
| ---------------------- | ---------------------------------------------------------------------------- |
| **Tools**              | Dynamic exposure from registered capabilities, scoped to agent config        |
| **Resources**          | Agent details, capabilities, system information                              |
| **Authentication**     | Bearer token (MCP API keys), not session cookies                             |
| **Session management** | In-memory sessions with `maxSessionsPerKey` limit                            |
| **Rate limiting**      | IP-level + per-key enforcement                                               |
| **Audit logging**      | Every request logged: method, response code, duration, client IP, user agent |

### 8.3 Admin Interface (7 pages)

Settings, tools browser, resources browser, sessions, audit log, API key management, and connection testing.

---

## 9. Scheduling & Event System

### 9.1 Cron Scheduling

- DB-backed schedule definitions (`AiWorkflowSchedule`) with cron expressions
- Unified maintenance tick endpoint processes due schedules
- Schedule ↔ workflow binding

### 9.2 Webhook Subscriptions

Outbound webhook notifications for orchestration events:

- CRUD for subscriptions with event type filtering
- HMAC-SHA256 signature on payloads
- Delivery tracking (`AiWebhookDelivery`): `pending` → `delivered` / `failed` → `exhausted`
- 3 retry attempts with exponential backoff (10s, 60s, 300s)
- Admin: delivery history, manual retry

### 9.3 Event Hooks

In-process event dispatch for internal and external handlers:

- DB-backed hook definitions with event type + filter criteria
- Fire-and-forget dispatch via `emitHookEvent()`
- Custom headers per hook, HMAC signing
- Separate delivery tracking (`AiEventHookDelivery`)
- Hook registry with 60s cache TTL + invalidation on CRUD
- Same retry strategy as webhooks
- `workflow.paused_for_approval` event emitted when execution pauses, with pre-signed approve/reject URLs and channel metadata for external approval flows

---

## 10. Analytics & Observability

### 10.1 Client Analytics

- **Popular topics**: Frequency analysis of conversation topics
- **Unanswered questions**: Messages where agents couldn't provide useful responses
- **Engagement metrics**: Conversation length, return rate, satisfaction signals
- **Coverage gaps**: Topics where knowledge base lacks relevant content

### 10.2 Observability Dashboard

Admin dashboard with:

- Active agent count and health
- Request volume and latency
- Error rates by provider and agent
- Cost trends
- Recent execution status

### 10.3 Audit Logging

Immutable configuration change log (`AiAdminAuditLog`):

- Entity type and ID
- Action performed
- Before/after state (JSON diff)
- Actor (admin user)
- Timestamp
- Filterable by entity type, action, date range

---

## 11. Experiments (A/B Testing)

### 11.1 Experiment Structure

- **Experiments** (`AiExperiment`): Named test with hypothesis and lifecycle
- **Variants** (`AiExperimentVariant`): Different configurations to compare (model, temperature, instructions)
- **Lifecycle**: `draft` → `running` → `completed`

### 11.2 Experiment API (6 handlers)

List, create, get, update, delete, and run experiments. Traffic splitting and result comparison for data-driven agent optimisation.

---

## 12. Evaluations

### 12.1 Evaluation Sessions

Structured quality assessment of agent responses:

- Session creation with evaluation criteria
- Log entries (`AiEvaluationLog`) tracking individual assessments
- LLM-driven completion handler for automated evaluation
- Annotation support for human review

### 12.2 Evaluation API (4 routes)

CRUD for sessions, log retrieval, and AI-assisted completion scoring.

---

## 13. Backup & Restore

### 13.1 Export

Full configuration export as JSON:

- Agents (with capabilities, instructions, settings)
- Workflows (with step definitions)
- Provider configurations (credentials excluded)
- Knowledge base metadata (content excluded for size)

### 13.2 Import

Configuration import with conflict resolution:

- Schema versioning for forward compatibility
- `ImportResult` with success/failure per entity
- Merge or overwrite modes

---

## 14. Embeddable Chat Widget

### 14.1 Widget Architecture

- **JavaScript loader**: Served as API route (`/api/v1/embed/widget.js`)
- **Shadow DOM isolation**: Prevents CSS/JS conflicts with host page
- **Streaming**: SSE chat via `/api/v1/embed/chat/`
- **Authentication**: Embed tokens with CORS origin restrictions
- **Visibility modes**: Respect agent visibility settings

### 14.2 Deployment Model

A single `<script>` tag on any website creates an isolated chat interface connected to a configured agent. No iframe — the widget runs in the host page's context but within Shadow DOM for style isolation.

---

## 15. Consumer Chat API

Separate from the admin API — purpose-built for end-user consumption:

### 15.1 Endpoints (8 routes)

- Stream endpoint (SSE)
- Agent listing (respects visibility)
- Conversation management (create, list, read, delete)
- Message history
- User memory operations

### 15.2 Access Control

- Public agents: accessible to any authenticated user
- Invite-only agents: require valid `AiAgentInviteToken`
- Internal agents: admin-only access
- Per-user rate limiting (20/min)
- Per-user conversation/message scoping

---

## 16. Self-Service API Keys

### 16.1 Key Management

- `AiApiKey` with scoped permissions
- Key generation and revocation via admin API
- Per-key rate limiting
- Key resolution at request time (bearer token → scope check)

### 16.2 Scopes

Keys can be scoped to specific agents, capabilities, or operations — providing fine-grained access control for third-party integrations and MCP clients.

---

## 17. Security Model

### 17.1 Defence in Depth

| Layer              | Mechanism                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| **Network**        | Rate limiting (IP-level: 30/min, per-user: 20/min, per-capability: configurable)                        |
| **Authentication** | Session-based (admin), token-based (API keys, embed tokens, invite tokens, HMAC approval tokens)        |
| **Authorisation**  | Role-based (admin/consumer), ownership scoping (404 not 403), approver delegation via `approverUserIds` |
| **Input**          | Zod validation at every boundary, injection detection (3 pattern types)                                 |
| **Output**         | Content filtering, PII detection, topic boundaries                                                      |
| **External calls** | SSRF protection via host allowlist, timeout enforcement                                                 |
| **Credentials**    | Environment variable resolution, never in LLM context, redacted in audit                                |
| **Data isolation** | All user data scoped by `userId`, cross-user lookups return 404                                         |

### 17.2 OWASP Agentic Coverage

Covers approximately 6/10 OWASP Agentic Application Top 10 categories natively:

- Prompt injection (input guard)
- Data leakage (output guard, credential management)
- Insecure output (content filtering)
- Excessive permissions (capability binding, rate limits)
- Rate limiting (multi-layer)
- Logging and monitoring (audit log, cost tracking)

---

## 18. Admin Dashboard

### 18.1 Scope

20+ pages covering complete lifecycle management:

| Section             | Pages                         | Functions                                        |
| ------------------- | ----------------------------- | ------------------------------------------------ |
| **Agents**          | List, Create, Edit (6 tabs)   | CRUD, capabilities, instructions, budget, export |
| **Capabilities**    | List, Create, Edit            | CRUD, category filter, usage stats               |
| **Providers**       | Card grid, Create, Edit       | CRUD, connection test, health status             |
| **Provider Models** | Matrix view, Form             | Model configuration, tier assignment             |
| **Workflows**       | List, Visual Builder          | React Flow canvas, palette, step registry        |
| **Knowledge**       | Document list, Upload, Search | Document management, search testing              |
| **Conversations**   | List, Trace viewer            | Review, tagging, export                          |
| **Costs**           | Summary, Trends, Settings     | Budget configuration, cost breakdown             |
| **Analytics**       | Usage, Topics, Gaps           | Engagement metrics, coverage analysis            |
| **Observability**   | Dashboard                     | Health, latency, errors                          |
| **Evaluations**     | Runner, Annotations           | Quality assessment, completion                   |
| **Experiments**     | List, Run                     | A/B testing management                           |
| **Executions**      | List, Detail (trace)          | Browse runs, filter by status/workflow, inspect  |
| **Approvals**       | Queue page                    | Browse, approve/reject pending executions        |
| **Audit Log**       | Filterable list               | Config change history                            |
| **MCP**             | 7 sub-pages                   | Tools, resources, sessions, audit, keys          |
| **Learning**        | Pattern explorer, Quiz        | 21 patterns, advisor chatbot                     |
| **Settings**        | Global config                 | Defaults, guards, search tuning                  |
| **Setup Wizard**    | 5-step flow                   | Guided initial configuration                     |

### 18.2 Design Patterns

- **Contextual help**: `<FieldHelp>` popovers on non-trivial form fields
- **Workflow builder**: React Flow-based visual DAG editor with drag-and-drop palette
- **Real-time feedback**: SSE streaming in chat interfaces and execution monitoring
- **Bulk operations**: Multi-select export, comparison, deletion

---

## 19. Data Model

### 19.1 Schema (29 Models)

| Model                     | Purpose                                   |
| ------------------------- | ----------------------------------------- |
| `AiAgent`                 | Agent configuration and parameters        |
| `AiAgentVersion`          | Instruction version history               |
| `AiAgentInviteToken`      | Access tokens for invite-only agents      |
| `AiAgentEmbedToken`       | Authentication for embedded widget        |
| `AiCapability`            | Tool definitions and configuration        |
| `AiAgentCapability`       | Agent ↔ capability binding (many-to-many) |
| `AiWorkflow`              | Workflow definitions (DAG structure)      |
| `AiWorkflowSchedule`      | Cron schedule bindings                    |
| `AiWorkflowExecution`     | Execution state and results               |
| `AiConversation`          | Chat conversation records                 |
| `AiMessage`               | Individual messages within conversations  |
| `AiMessageEmbedding`      | Message vector embeddings                 |
| `AiUserMemory`            | Per-user persistent memory                |
| `AiEventHook`             | Event hook definitions                    |
| `AiEventHookDelivery`     | Hook delivery tracking                    |
| `AiKnowledgeDocument`     | Ingested document metadata                |
| `AiKnowledgeChunk`        | Chunked content with vector embeddings    |
| `AiEvaluationSession`     | Evaluation session records                |
| `AiEvaluationLog`         | Individual evaluation entries             |
| `AiCostLog`               | Per-operation cost records                |
| `AiWebhookSubscription`   | Outbound webhook configurations           |
| `AiWebhookDelivery`       | Webhook delivery tracking                 |
| `AiProviderConfig`        | LLM provider credentials and settings     |
| `AiProviderModel`         | Model registry entries                    |
| `AiApiKey`                | Self-service API keys                     |
| `AiOrchestrationSettings` | Global singleton settings                 |
| `AiAdminAuditLog`         | Immutable config change log               |
| `AiExperiment`            | A/B test definitions                      |
| `AiExperimentVariant`     | Experiment variant configurations         |

---

## 20. Design Patterns Library

21 agentic design patterns inform agent and workflow composition:

- **Routing** — classify and direct to specialised handlers
- **Chaining** — sequential multi-step processing
- **Reflection** — self-critique and improvement loops
- **Planning** — decompose complex tasks into sub-steps
- **Multi-agent** — coordination between specialised agents
- **RAG** — retrieval-augmented generation from knowledge base
- **Tool use** — structured capability invocation
- **Summarisation** — progressive distillation
- **Evaluation** — quality scoring and feedback
- **Guard rails** — input/output safety constraints
- And 11 additional patterns covering orchestration, delegation, memory, and autonomy

The Learning UI provides interactive exploration, an advisor chatbot for pattern recommendations, and quizzes for team education.

---

## 21. Integration Points

### 21.1 Inbound

| Interface          | Protocol               | Authentication                   |
| ------------------ | ---------------------- | -------------------------------- |
| Admin API          | REST (130 routes)      | Session (admin role)             |
| Consumer Chat API  | REST + SSE (8 routes)  | Session (any authenticated user) |
| Approval endpoints | REST (2 routes)        | HMAC-SHA256 signed token         |
| MCP Server         | JSON-RPC 2.0 over HTTP | Bearer token (API key)           |
| Embed Widget       | SSE                    | Embed token + CORS               |
| Webhooks (inbound) | HTTP POST              | HMAC-SHA256 signature            |
| Cron triggers      | Internal tick          | Maintenance endpoint             |

### 21.2 Outbound

| Interface                 | Protocol | Security                        |
| ------------------------- | -------- | ------------------------------- |
| LLM providers             | HTTPS    | API key (env var resolved)      |
| External calls (workflow) | HTTPS    | Host allowlist, SSRF protection |
| Webhook deliveries        | HTTPS    | HMAC-SHA256 signed payload      |
| Event hook dispatch       | HTTPS    | HMAC-SHA256 + custom headers    |

---

## Summary of Differentiators

1. **Integrated platform** — orchestration + auth + admin + API + deployment as one typed codebase; no integration tax
2. **Budget enforcement in the execution loop** — the only platform that stops mid-conversation when budget is exceeded
3. **Provider resilience** — circuit breaker + fallback chains + mid-stream failover is ahead of every evaluated framework
4. **7-stage capability dispatch** — structured pipeline from registry to cost logging with rate limiting and approval gates
5. **MCP server with audit** — one of very few platforms exposing capabilities via MCP (not just consuming); full audit trail
6. **Triple safety guards** — input injection detection, output content filtering, and citation hygiene (under-citation / hallucinated-marker), all configurable per-agent
7. **Inline citation pipeline** — RAG-grounded responses carry structured `Citation` envelopes from search through to the SSE client and persisted message metadata; the LLM cites via `[N]` markers, the admin chat / trace viewer / embed widget render a sources panel for verification
8. **Platform-agnostic core** — zero Next.js imports in `lib/orchestration/`; testable and portable
9. **Immutable audit trails** — config changes, instruction versions, and MCP requests all logged
10. **Embeddable deployment** — Shadow DOM widget deployable on any website with a single script tag
11. **Complete admin surface** — 20+ pages managing the full agent lifecycle without touching code

---

## Specification Status

This document describes the implemented system as of May 2026. For competitive positioning and identified gaps, see `maturity-analysis.md`. For commercial application opportunities, see `business-applications.md`.
