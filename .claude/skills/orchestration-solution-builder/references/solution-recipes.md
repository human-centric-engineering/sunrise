# Solution Recipes

Five complete worked solutions from simple to complex. Each includes the full API payloads and implementation steps.

## Recipe A: Simple FAQ Chatbot

**Tier:** Simple | **Patterns:** RAG

**What you need:**

- 1 provider (Anthropic + Voyage AI for embeddings)
- 1 agent (Haiku, low temperature)
- 0 custom capabilities
- 1 built-in capability binding (`search_knowledge_base`)
- 0 workflows
- Knowledge base with documents

**Implementation:**

```json
// 1. Agent
POST /api/v1/admin/orchestration/agents
{
  "name": "FAQ Bot",
  "slug": "faq-bot",
  "description": "Answers questions about product documentation",
  "systemInstructions": "You are a helpful assistant. Answer questions using the knowledge base. Always cite the source document. If you don't know, say so — never guess.",
  "model": "claude-haiku-4-5",
  "provider": "anthropic",
  "temperature": 0.3,
  "maxTokens": 2048,
  "monthlyBudgetUsd": 10,
  "knowledgeCategories": ["product-docs"]
}

// 2. Bind search_knowledge_base
POST /api/v1/admin/orchestration/agents/{agentId}/capabilities
{ "capabilityId": "<search_knowledge_base id>", "isEnabled": true }

// 3. Upload docs + embed
POST /api/v1/admin/orchestration/knowledge/documents  (upload files)
POST /api/v1/admin/orchestration/knowledge/embed

// 4. Test via agent Test Chat tab
```

---

## Recipe B: Customer Support with Order Lookup

**Tier:** Moderate | **Patterns:** Routing, Tool Use, HITL, RAG, Guardrails

**What you need:**

- 1 provider (Anthropic)
- 2 agents (router + support)
- 2 custom capabilities (`lookup_order`, `process_refund`)
- 2 built-in capability bindings (`search_knowledge_base`, `escalate_to_human`)
- 1 workflow (from `tpl-customer-support` template)

**Implementation:**

```json
// 1. Router agent
POST /api/v1/admin/orchestration/agents
{
  "name": "Support Router",
  "slug": "support-router",
  "systemInstructions": "Classify customer intent into: order_query, refund_request, general_question, complaint. Respond with only the classification.",
  "model": "claude-haiku-4-5",
  "provider": "anthropic",
  "temperature": 0.0,
  "maxTokens": 100,
  "monthlyBudgetUsd": 5
}

// 2. Support agent
POST /api/v1/admin/orchestration/agents
{
  "name": "Support Agent",
  "slug": "support-agent",
  "systemInstructions": "You are a customer support agent. Use tools to look up orders and process refunds. Be professional and empathetic. Never share internal system details.",
  "model": "claude-sonnet-4-6",
  "provider": "anthropic",
  "temperature": 0.5,
  "maxTokens": 4096,
  "monthlyBudgetUsd": 50,
  "knowledgeCategories": ["support-docs", "faq"]
}

// 3. Custom capabilities (see capability-builder skill for full class code)
// lookup_order: internal, rateLimit: 30
// process_refund: internal, requiresApproval: true (for > $100), rateLimit: 5

// 4. Bind capabilities to support-agent
POST /agents/{supportAgentId}/capabilities
{ "capabilityId": "<lookup_order id>", "isEnabled": true }
{ "capabilityId": "<process_refund id>", "isEnabled": true }
{ "capabilityId": "<search_knowledge_base id>", "isEnabled": true }
{ "capabilityId": "<escalate_to_human id>", "isEnabled": true }

// 5. Workflow: start from tpl-customer-support template, customise
POST /api/v1/admin/orchestration/workflows
{
  "name": "Customer Support Pipeline",
  "slug": "customer-support",
  "workflowDefinition": { /* from template, customised */ },
  "patternsUsed": ["routing", "tool_use", "hitl", "rag", "guardrails"],
  "budgetLimitUsd": 2.00
}
```

---

## Recipe C: Content Generation Pipeline

**Tier:** Moderate | **Patterns:** Planning, Chaining, Reflection, Parallelisation

**What you need:**

- 1 provider (Anthropic)
- 1 agent (Sonnet, higher temperature)
- 0 custom capabilities
- 1 workflow (from `tpl-content-pipeline` template)

**Implementation:**

```json
// 1. Writer agent
POST /api/v1/admin/orchestration/agents
{
  "name": "Content Writer",
  "slug": "content-writer",
  "systemInstructions": "You are an expert content writer. Produce engaging, well-structured blog posts. Follow the brand voice guide.",
  "model": "claude-sonnet-4-6",
  "provider": "anthropic",
  "temperature": 0.7,
  "maxTokens": 8192,
  "monthlyBudgetUsd": 30
}

// 2. Workflow from template
// plan → parallel(research, audience) → outline → draft → reflect(3 iterations)
POST /api/v1/admin/orchestration/workflows
{
  "name": "Content Pipeline",
  "slug": "content-pipeline",
  "workflowDefinition": { /* from tpl-content-pipeline */ },
  "patternsUsed": ["planning", "chaining", "reflection", "parallelisation"],
  "budgetLimitUsd": 3.00
}
```

---

## Recipe D: Multi-Agent Research System

**Tier:** Complex | **Patterns:** Planning, RAG, Parallelisation, Multi-Agent, Reflection

**What you need:**

- 1 provider (Anthropic + Voyage AI)
- 2 agents (planner + synthesiser)
- 1 built-in capability binding (`search_knowledge_base`)
- 1 workflow
- Knowledge base with research documents

**Implementation:**

```json
// 1. Planner agent
POST /api/v1/admin/orchestration/agents
{
  "name": "Research Planner",
  "slug": "research-planner",
  "systemInstructions": "You are a research planner. Break down research questions into specific sub-questions. Identify what information sources to consult.",
  "model": "claude-sonnet-4-6",
  "provider": "anthropic",
  "temperature": 0.3,
  "maxTokens": 4096,
  "monthlyBudgetUsd": 20,
  "knowledgeCategories": ["research"]
}

// 2. Synthesiser agent
POST /api/v1/admin/orchestration/agents
{
  "name": "Research Synthesiser",
  "slug": "research-synthesiser",
  "systemInstructions": "You synthesise research findings into coherent, well-cited reports. Identify gaps and contradictions across sources.",
  "model": "claude-sonnet-4-6",
  "provider": "anthropic",
  "temperature": 0.5,
  "maxTokens": 8192,
  "monthlyBudgetUsd": 30,
  "knowledgeCategories": ["research"]
}

// 3. Bind search_knowledge_base to both agents
// 4. Upload research docs + embed
// 5. Workflow:
// plan → rag_retrieve → parallel(specialist_1, specialist_2, specialist_3) → synthesise → reflect
POST /api/v1/admin/orchestration/workflows
{
  "name": "Research Pipeline",
  "slug": "research-pipeline",
  "workflowDefinition": { /* from tpl-research-agent, customised */ },
  "patternsUsed": ["planning", "rag", "parallelisation", "multi_agent", "reflection"],
  "budgetLimitUsd": 10.00
}
```

---

## Recipe E: Full Autonomous Workflow

**Tier:** Complex | **Patterns:** All major patterns composed

**What you need:**

- 1 provider (Anthropic + Voyage AI)
- 3+ agents (router, specialists, reviewer)
- Multiple custom + built-in capabilities
- Multi-branch workflow with approval gates
- Knowledge base

**Architecture:**

```
intake → route → [simple: RAG answer]
               → [complex: plan → parallel(tool calls) → synthesise]
               → [urgent: escalate to human]
         → guard(safety check) → reflect → respond
```

**Key configuration:**

- Router: Haiku, temperature 0.0
- Specialists: Sonnet, temperature 0.5
- Reviewer: Sonnet, temperature 0.1
- Human approval on write operations
- Output guard on all responses
- Budget: $5/execution, $100/month agent budget
- Fallback provider configured
- Error strategy: `fallback` on tool calls, `fail` on guard steps

See the `tpl-autonomous-research` template as a starting point and extend with custom steps.
