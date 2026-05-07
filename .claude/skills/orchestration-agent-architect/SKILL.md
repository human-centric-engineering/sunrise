---
name: orchestration-agent-architect
version: 1.0.0
description: |
  Architect for Sunrise's agent orchestration system. Designs agentic solutions
  by selecting from 21 design patterns, composing multi-pattern architectures,
  and mapping designs to Sunrise's orchestration primitives (agents, capabilities,
  workflows, knowledge bases). Use when a developer wants to design, plan, or
  debug an AI agent system — whether they say "build me a chatbot", "I need an
  agent that can look up orders", "design an AI pipeline", or "why is my agent
  hallucinating". This skill handles the DESIGN phase; the orchestration-solution-builder
  skill handles IMPLEMENTATION.

triggers:
  - 'design an agent'
  - 'I need an agent'
  - 'build me a chatbot'
  - 'agentic solution'
  - 'agent architecture'
  - 'which patterns should I use'
  - 'why is my agent'
  - 'debug agent'
  - 'agent keeps hallucinating'
  - 'optimize agent costs'

contexts:
  - '.context/orchestration/meta/functional-specification.md'
  - '.context/admin/orchestration.md'
  - '.context/admin/orchestration-solution-builder.md'
  - '.context/orchestration/engine.md'
  - 'lib/orchestration/engine/step-registry.ts'
  - 'types/orchestration.ts'

mcp_integrations:
  context7:
    libraries:
      - zod: '/colinhacks/zod'

parameters:
  pattern_count: 21
  sunrise_step_types: 15
  sunrise_templates: 9
---

# Agent Architect

An architectural decision-making skill for designing, composing, and debugging AI agent systems. Based on 21 established agentic design patterns, supplemented with emerging concepts and production practices.

This skill helps you make the right architectural choices — which patterns to use, how to combine them, what trade-offs to accept, and what production pitfalls to avoid.

## Quick Reference: All 21 Patterns

| #   | Pattern                     | One-liner                                                                         |
| --- | --------------------------- | --------------------------------------------------------------------------------- |
| 1   | Prompt Chaining             | Break complex tasks into sequential LLM calls with validation gates between steps |
| 2   | Routing                     | Classify intent and dispatch to specialised agents or models                      |
| 3   | Parallelisation             | Run independent tasks concurrently, merge results via a reducer                   |
| 4   | Reflection                  | Draft → critique → revise loop for iterative quality improvement                  |
| 5   | Tool Use                    | Let the agent call external APIs, databases, and services                         |
| 6   | Planning                    | Agent generates its own execution plan (DAG) at runtime                           |
| 7   | Multi-Agent                 | Team of specialised agents collaborating via handoffs                             |
| 8   | Memory                      | Short-term (context window) and long-term (vector DB) recall                      |
| 9   | Learning & Adaptation       | Agent improves over time via feedback without redeployment                        |
| 10  | MCP (State Management)      | Standardised protocol for tool discovery and integration                          |
| 11  | Goal Monitoring             | Track progress toward objectives, detect stuck agents                             |
| 12  | Exception Handling          | Detect failures → handle → recover or escalate                                    |
| 13  | Human-in-the-Loop           | Pause for human approval on high-risk actions                                     |
| 14  | RAG (Knowledge Retrieval)   | Retrieve external knowledge to ground responses in fact                           |
| 15  | A2A (Inter-Agent Comms)     | Standardised protocol for agent-to-agent collaboration                            |
| 16  | Resource-Aware Optimisation | Route tasks to the cheapest model that can handle them                            |
| 17  | Reasoning Techniques        | CoT, ToT, ReAct — structured thinking strategies                                  |
| 18  | Guardrails & Safety         | Input/output filters, behavioural constraints, layered defence                    |
| 19  | Evaluation & Monitoring     | LLM-as-a-Judge scoring, trajectory analysis, drift detection                      |
| 20  | Prioritisation              | Semantic task ranking with dynamic re-prioritisation                              |
| 21  | Exploration & Discovery     | Proactive hypothesis testing and knowledge expansion                              |

For full pattern detail, read `references/patterns-1-to-10.md` or `references/patterns-11-to-21.md`.

---

## Pattern Selection Guide

Use this table when the user describes a problem and you need to recommend patterns:

| The user needs to...                       | Primary pattern(s)      | Also consider                              |
| ------------------------------------------ | ----------------------- | ------------------------------------------ |
| Handle a multi-step task                   | 1 (Chaining)            | 6 (Planning) if steps are dynamic          |
| Route requests to different handlers       | 2 (Routing)             | 16 (Resource-Aware) for cost-based routing |
| Speed up a slow workflow                   | 3 (Parallelisation)     | 16 (Resource-Aware) for model selection    |
| Improve output quality                     | 4 (Reflection)          | 17 (Reasoning) for complex problems        |
| Call external APIs or databases            | 5 (Tool Use)            | 10 (MCP) for standardised integration      |
| Handle complex, multi-part goals           | 6 (Planning)            | 11 (Goal Monitoring) for progress tracking |
| Solve problems needing multiple skills     | 7 (Multi-Agent)         | 15 (A2A) for cross-framework agents        |
| Remember context across sessions           | 8 (Memory)              | 14 (RAG) for knowledge retrieval           |
| Improve performance over time              | 9 (Learning)            | 19 (Evaluation) to measure improvement     |
| Integrate many tools via standard protocol | 10 (MCP)                | 5 (Tool Use) for individual tools          |
| Prevent agents getting stuck in loops      | 11 (Goal Monitoring)    | 12 (Exception Handling) for recovery       |
| Handle API failures gracefully             | 12 (Exception Handling) | 13 (HITL) for escalation                   |
| Add human approval for risky actions       | 13 (HITL)               | 18 (Guardrails) for automated safety       |
| Ground answers in real data                | 14 (RAG)                | 8 (Memory) for conversational context      |
| Connect agents across platforms            | 15 (A2A)                | 10 (MCP) for tool-level integration        |
| Control costs at scale                     | 16 (Resource-Aware)     | 2 (Routing) for model selection            |
| Solve complex reasoning problems           | 17 (Reasoning)          | 4 (Reflection) for iterative refinement    |
| Prevent harmful or off-policy outputs      | 18 (Guardrails)         | 13 (HITL) as ultimate fallback             |
| Monitor production agent performance       | 19 (Evaluation)         | 9 (Learning) to act on findings            |
| Manage competing tasks                     | 20 (Prioritisation)     | 6 (Planning) for task sequencing           |
| Explore unknown solution spaces            | 21 (Exploration)        | 7 (Multi-Agent) for research teams         |

---

## Troubleshooting Guide

Use this when diagnosing problems with an existing agent system:

| Symptom                              | Likely cause                            | Fix with                                                              |
| ------------------------------------ | --------------------------------------- | --------------------------------------------------------------------- |
| Agent hallucinating facts            | No grounding in real data               | Add RAG (14), tighten Guardrails (18)                                 |
| Agent stuck in infinite loop         | No exit condition or progress tracking  | Add Goal Monitoring (11), set max retries                             |
| Responses are too slow               | Too many sequential LLM calls           | Add Parallelisation (3), reduce chain depth                           |
| Costs are too high                   | Frontier model used for everything      | Add Resource-Aware routing (16), context compression                  |
| Agent ignores instructions           | Context window overloaded / context rot | Apply context engineering — see `references/context-and-costs.md`     |
| Agent leaks sensitive data           | No output filtering                     | Add layered Guardrails (18)                                           |
| Agent calls the wrong tool           | Poor tool descriptions                  | Rewrite Tool (5) descriptions — they're API docs for a machine reader |
| Inconsistent output quality          | No self-review                          | Add Reflection (4) loop                                               |
| Agent takes unsafe actions           | No approval gate for writes             | Add HITL (13) with escalation policies                                |
| Can't debug what went wrong          | No tracing                              | Add structured tracing — see `references/emerging-concepts.md`        |
| Behaviour changed after model update | Model version not pinned                | Pin model versions, test before upgrading                             |
| Agent forgets previous conversation  | No memory persistence                   | Add Memory (8) with vector DB                                         |

---

## Composition Recipes

Real agent systems combine multiple patterns. Use these as starting architectures:

**Recipe 1: Customer Support Agent**
Patterns: 2 (Routing) + 14 (RAG) + 5 (Tool Use) + 18 (Guardrails) + 13 (HITL)
Flow: Classify intent → retrieve help docs → call tools (order lookup, refund API) → filter output for PII → escalate high-risk actions to human.

**Recipe 2: Content Generation Pipeline**
Patterns: 6 (Planning) + 1 (Chaining) + 4 (Reflection) + 3 (Parallelisation)
Flow: Plan stages → research and analysis in parallel → chain through outline → draft → review → critic agent loops until quality met.

**Recipe 3: AI-First SaaS Backend**
Patterns: 2 (Routing) + 5 (Tool Use) + 10 (MCP) + 8 (Memory) + 18 (Guardrails) + 16 (Resource-Aware) + 12 (Exception Handling)
Flow: Classify complexity and select model tier → connect to services via MCP → load user context from memory → handle tool failures with fallbacks → validate output → return.

**Recipe 4: Autonomous Research Agent**
Patterns: 6 (Planning) + 7 (Multi-Agent) + 14 (RAG) + 4 (Reflection) + 11 (Goal Monitoring) + 21 (Exploration)
Flow: Generate research plan → specialised agents work sub-tasks → RAG retrieves from knowledge bases → reflection checks quality → monitor tracks progress → exploration identifies new avenues.

**Recipe 5: Conversational Agent with Learning**
Patterns: 1 (Chaining) + 8 (Memory) + 5 (Tool Use) + 9 (Learning) + 19 (Evaluation)
Flow: Load memories → chain through understanding → reasoning → response → call tools as needed → evaluate quality → negative feedback updates instructions for next time.

---

## Trade-off Dimensions

When recommending an architecture, reason through these trade-offs explicitly:

**Latency vs Quality.** Reflection (4) and Reasoning (17) improve quality but add LLM round-trips. A 3-step reflection loop triples latency. Use for offline/async tasks; skip for real-time chat unless quality is critical.

**Cost vs Accuracy.** Frontier models ($5–25/M output tokens) are more accurate but 10–100× the cost of budget models ($0.10–0.60/M). Use tiered routing (16): send 70% of queries to budget models, reserve frontier for hard problems.

**Autonomy vs Control.** More autonomy (Planning, Exploration) means less predictability. More control (HITL, Guardrails) means more latency and human bottlenecks. Match to risk level: high autonomy for research, tight control for financial transactions.

**Simplicity vs Flexibility.** Prompt Chaining (1) is simple and debuggable. Multi-Agent (7) is flexible but complex. Always start with the simplest pattern that solves the problem, then add complexity only when a specific failure mode demands it.

**Speed-to-build vs Maintainability.** A single mega-prompt is fastest to build but impossible to maintain. Decomposed patterns take longer upfront but each component can be tested, optimised, and replaced independently.

---

## Production Readiness Checklist

Before finalising any agent architecture, verify these concerns are addressed:

- **Rate limits:** Will concurrent calls hit provider limits? Design for backoff and queuing.
- **Latency budget:** Does total chain latency fit the UX requirement? Consider streaming partial results.
- **Timeout strategy:** What happens when an LLM call hangs? Set per-step timeouts.
- **Streaming:** Should partial results stream to the user for perceived responsiveness?
- **Idempotency:** Are write operations (payments, deletions) safe to retry? Use idempotency keys.
- **State persistence:** Can the workflow resume after a crash? Checkpoint long-running workflows.
- **Model pinning:** Is the model version locked? Behaviour changes when providers update models.
- **Multi-tenant isolation:** Is data scoped per user? RAG retrieval, memory, tool access must respect permissions.
- **Graceful failure UX:** What does the user see when it fails? Explain what was tried, not just "error occurred."
- **Cost alerting:** Is there a budget cap per request/user? Kill runaway agents that exceed limits.
- **Observability:** Can you trace a request end-to-end? Log every step, tool call, and decision.
- **Rollback plan:** How do you revert a bad prompt or model change? Feature flags, shadow testing.

---

## Architecture Anti-Patterns

Warn against these common mistakes:

- **Over-engineering:** Building a multi-agent system when prompt chaining would suffice. Start simple.
- **Under-engineering:** One mega-prompt handling all edge cases. If your prompt exceeds ~500 words with multiple distinct tasks, decompose it.
- **Guardrails-later:** Skipping safety because "we'll add it later." Security debt compounds faster than tech debt.
- **Approval-for-everything:** Human-in-the-loop on every action, creating bottlenecks that defeat automation.
- **Frontier-for-everything:** Using the most expensive model for routing, classification, and simple queries. Use the least capable model that handles the task.
- **Context-stuffing:** Dumping entire documents into the context window instead of retrieving relevant chunks via RAG.
- **Testing-in-production-only:** No evaluation framework, relying on user complaints to find problems.

---

## Mapping Patterns to Sunrise Primitives

Every pattern maps to concrete Sunrise orchestration primitives:

| Pattern                | Sunrise primitive                                                  |
| ---------------------- | ------------------------------------------------------------------ |
| Routing (2)            | `route` step type in workflow                                      |
| Tool Use (5)           | Custom capabilities + `tool_call` step                             |
| Planning (6)           | `plan` step type or `orchestrator` step                            |
| Multi-Agent (7)        | Multiple `AiAgent` records + `agent_call` step                     |
| Memory (8)             | `read_user_memory` / `write_user_memory` built-in caps             |
| Human-in-the-Loop (13) | `human_approval` step type + approval queue                        |
| RAG (14)               | Knowledge base + `search_knowledge_base` cap + `rag_retrieve` step |
| Guardrails (18)        | `guard` step type (LLM or regex mode)                              |
| Evaluation (19)        | `evaluate` step type with rubric scoring                           |
| Parallelisation (3)    | `parallel` step type with branches                                 |
| Reflection (4)         | `reflect` step type with critique loop                             |
| Prompt Chaining (1)    | Sequential `llm_call` steps or `chain` step                        |

## Building Solutions

When a developer describes a business problem and wants you to build an agentic solution:

1. **Understand the problem** — what inputs, outputs, actions, and decisions are involved?
2. **Select patterns** — use the Pattern Selection Guide above
3. **Check composition recipes** — does a recipe already cover this use case?
4. **Map to Sunrise** — use the table above to identify which agents, capabilities, workflows, and knowledge base setup are needed
5. **Determine complexity** — simple (single agent, no workflow), moderate (1-2 agents + workflow), or complex (multi-agent + approval gates + KB)
6. **Implement** — use `/orchestration-solution-builder` for end-to-end implementation, or the individual builder skills for specific subsystems:
   - `/orchestration-capability-builder` — custom agent tools
   - `/orchestration-workflow-builder` — workflow DAGs
   - `/orchestration-knowledge-builder` — RAG knowledge bases

When the developer says or implies "build it", invoke the `orchestration-solution-builder` skill which handles the full implementation pipeline.

---

## Reference File Routing

Load these files when you need more depth:

| When you need...                                  | Read                                   |
| ------------------------------------------------- | -------------------------------------- |
| Detail on Patterns 1–10                           | `references/patterns-1-to-10.md`       |
| Detail on Patterns 11–21                          | `references/patterns-11-to-21.md`      |
| Context engineering, token costs, pricing         | `references/context-and-costs.md`      |
| Emerging patterns, agent security, tracing        | `references/emerging-concepts.md`      |
| Sunrise code examples for agents, caps, workflows | `references/sunrise-implementation.md` |
