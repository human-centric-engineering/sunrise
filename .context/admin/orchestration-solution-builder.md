# Building Agentic Solutions — End-to-End Guide

"I have a business problem — now what?" This guide walks you from problem description to running agentic solution using the Sunrise orchestration layer.

## The Process

1. **Describe the problem** — what inputs, outputs, actions, and decisions are involved?
2. **Select patterns** — which of the 21 agentic design patterns apply?
3. **Create agents** — one per distinct role (router, specialist, reviewer, etc.)
4. **Create capabilities** — one per tool/action the agents need
5. **Compose the workflow** — wire steps into a DAG using the 12 step types
6. **Test** — use the embedded chat and workflow executor
7. **Deploy** — configure budgets, rate limits, and approval gates
8. **Monitor** — check costs, traces, and evaluations in the dashboard

## Five Worked Examples

### Example A: Simple FAQ Chatbot

**Problem:** "We want a chatbot that answers questions about our agentic design patterns documentation."

**Patterns:** RAG (14)

**Why just RAG?** The chatbot doesn't need routing (one topic), tools (no external actions), or human approval (read-only responses). RAG gives it access to the knowledge base for accurate, sourced answers.

**Agent config:**

```json
{
  "name": "FAQ Bot",
  "slug": "faq-bot",
  "description": "Answers questions about agentic design patterns",
  "systemInstructions": "You are a helpful assistant specialising in agentic design patterns. Answer questions using the knowledge base. Always cite the pattern number and name. If you don't know, say so.",
  "model": "claude-haiku-4-5",
  "provider": "anthropic",
  "temperature": 0.3,
  "maxTokens": 2048,
  "monthlyBudgetUsd": 10
}
```

**Capabilities:** Attach the built-in `search_knowledge_base` capability. No custom capabilities needed.

**Workflow:** None — this is a single-agent chat, no DAG needed. The agent uses `search_knowledge_base` as a tool call during conversation.

**Setup steps:**

1. Seed the knowledge base: `POST /knowledge/seed`
2. Add an embedding provider — **Voyage AI** (free tier) is the recommended starting point: create a provider with `providerType: 'voyage'` and env var `VOYAGE_API_KEY`
3. Generate embeddings: `POST /knowledge/embed`
4. Create the agent via API or UI
5. Attach `search_knowledge_base` via `POST /agents/{id}/capabilities`
6. Test via the agent's Test Chat tab

---

### Example B: Customer Support with Order Lookup

**Problem:** "We need to handle customer enquiries — look up orders, process simple refunds, and escalate complex issues to humans."

**Patterns:** Routing (2) + Tool Use (5) + Human-in-the-Loop (13) + RAG (14) + Guardrails (18)

**Why these patterns?**

- **Routing** classifies intent (order query, refund, complaint, general) to pick the right path
- **Tool Use** calls order lookup and refund processing APIs
- **HITL** ensures a human reviews before sending responses or processing refunds > $100
- **RAG** retrieves help docs for general questions
- **Guardrails** prevent PII leakage in responses

**Agents:**

| Agent            | Model             | Temperature | Purpose                        |
| ---------------- | ----------------- | ----------- | ------------------------------ |
| `support-router` | claude-haiku-4-5  | 0.0         | Classify intent — cheap, fast  |
| `support-agent`  | claude-sonnet-4-6 | 0.5         | Generate responses, call tools |

**Capabilities:**

| Capability              | Type     | Approval?    | Rate limit |
| ----------------------- | -------- | ------------ | ---------- |
| `lookup_order`          | internal | No           | 30/min     |
| `process_refund`        | internal | Yes (> $100) | 5/min      |
| `search_knowledge_base` | built-in | No           | 30/min     |

**Workflow:** Use the built-in `tpl-customer-support` template, which implements:

```
classify (route) → [self-serve branch] retrieve docs → search KB → draft response
                  → [human branch] escalate
                  → human approval → send
```

**Key config:** Set `errorStrategy: "fallback"` so a failed order lookup falls back to asking the customer for more details rather than crashing the workflow.

---

### Example C: Content Generation Pipeline

**Problem:** "We need to generate blog posts: research a topic, draft content, review quality, and polish the final version."

**Patterns:** Planning (6) + Prompt Chaining (1) + Parallelisation (3) + Reflection (4)

**Why these patterns?**

- **Planning** breaks the brief into stages (research, outline, draft, polish)
- **Parallelisation** runs research and audience analysis simultaneously
- **Chaining** sequences outline → draft → polish
- **Reflection** loops draft → critique → revise until quality bar is met

**Agent:**

```json
{
  "name": "Content Writer",
  "slug": "content-writer",
  "systemInstructions": "You are a professional content writer. Follow the plan stages precisely. Write in a clear, engaging style. When critiquing, be specific about what needs improvement.",
  "model": "claude-sonnet-4-6",
  "provider": "anthropic",
  "temperature": 0.7,
  "maxTokens": 8192,
  "monthlyBudgetUsd": 100
}
```

**Workflow:** Use the built-in `tpl-content-pipeline` template:

```
plan → parallel(research, audience analysis) → outline → draft → reflect(critique loop, max 3 iterations)
```

**Key config:**

- Reflect step: `maxIterations: 3` to prevent infinite revision loops
- Parallel step: `stragglerStrategy: "wait-all"` to ensure both branches complete
- Error strategy: `retry` with `retryCount: 2` for transient LLM failures

---

### Example D: Multi-Agent Research System

**Problem:** "We need to research a topic from multiple angles — historical context, current state, and future outlook — then synthesise a comprehensive report."

**Patterns:** Planning (6) + Multi-Agent (7) + RAG (14) + Parallelisation (3) + Reflection (4)

**Why these patterns?**

- **Planning** generates a research plan with sub-goals
- **Multi-Agent** uses three specialist prompts (history, current, future) for depth
- **RAG** retrieves prior art from the knowledge base
- **Parallelisation** runs all three specialists simultaneously
- **Reflection** critiques the final synthesis

**Agents:**

| Agent                  | System instructions focus                        | Model             |
| ---------------------- | ------------------------------------------------ | ----------------- |
| `research-planner`     | Generate structured research plans               | claude-sonnet-4-6 |
| `research-synthesiser` | Combine specialist outputs into coherent reports | claude-sonnet-4-6 |

**Workflow:** Use the built-in `tpl-research-agent` template:

```
plan → retrieve prior art (RAG) → parallel(history specialist, current specialist, future specialist) → synthesise → reflect
```

The three "specialists" are `llm_call` steps with different prompts, not separate agents — this keeps it simple while still getting multi-perspective analysis.

---

### Example E: Full Autonomous Workflow

**Problem:** "We need an end-to-end system: intake customer requests, route them, gather context, execute actions, get approval for risky ones, generate responses, and monitor quality."

**Patterns:** Routing (2) + Planning (6) + Tool Use (5) + Parallelisation (3) + RAG (14) + Reflection (4) + HITL (13) + Guardrails (18)

**Architecture:**

```
                    ┌─────────────┐
                    │  Intake     │ (route step)
                    │  & Classify │
                    └──────┬──────┘
                  ┌────────┼────────┐
                  ▼        ▼        ▼
             [simple]  [complex] [urgent]
                  │        │        │
                  ▼        ▼        ▼
              RAG only   Plan    Escalate
                  │        │     (HITL)
                  │        ▼        │
                  │   Parallel:     │
                  │   - Research    │
                  │   - Tools       │
                  │        │        │
                  │        ▼        │
                  │    Execute      │
                  │   (approval     │
                  │    for writes)  │
                  │        │        │
                  └────────┼────────┘
                           ▼
                       Synthesise
                           │
                           ▼
                       Reflect
                           │
                           ▼
                       Respond
```

**Agents:** 2 — a router (haiku, temp 0.0) and a worker (sonnet, temp 0.5)

**Capabilities:** Domain-specific (order lookup, CRM update, email send, etc.) — each marked with appropriate `requiresApproval` and `rateLimit` settings.

**Key configs:**

- `fallbackProviders: ["openai"]` for resilience
- `monthlyBudgetUsd: 200` with 80% warning
- `errorStrategy: "fallback"` at workflow level
- Per-step `errorStrategy: "retry"` for tool calls
- `human_approval` step before any write operations

---

## Using the Advisor

The Learning UI at `/admin/orchestration/learn` includes an **Advisor chatbot** that can help you design solutions:

1. Open the **Advisor** tab
2. Describe your business problem in plain language
3. The advisor suggests relevant patterns and explains why
4. Ask follow-up questions about trade-offs
5. When satisfied, the advisor can generate a workflow definition

The advisor uses the same knowledge base of 21 patterns and has access to all built-in templates as starting points.

## Using Claude Code CLI

You can use Claude Code with the `/agent-architect` skill to build solutions directly from the terminal:

1. Describe your problem: _"I need a customer support system that handles order queries, refunds, and escalations"_
2. Claude Code loads the agent-architect skill and selects patterns
3. It designs the architecture using composition recipes
4. Say _"build it"_ and Claude Code reads `sunrise-implementation.md` to:
   - Create agent configs via the API
   - Write custom capability handlers
   - Compose the workflow DAG
   - Register everything in the database
5. Test via the admin UI or `scripts/smoke/chat.ts`

**Tip:** Be specific about your constraints — budget, latency requirements, which actions need human approval, and what model tier to use. This helps the architect make better trade-off decisions.

## Related Documentation

- [Orchestration overview](./orchestration.md)
- [Capabilities guide](./orchestration-capabilities-guide.md)
- [Workflows guide](./orchestration-workflows-guide.md)
- [Learning UI](./orchestration-learn.md)
- [Agent architect skill](../../.claude/skills/agent-architect/SKILL.md)
