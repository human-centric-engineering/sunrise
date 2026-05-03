# Patterns and steps

This document is the cohesive reference for how Sunrise relates the **21 Agentic Design Patterns** to its **15 workflow step types**. Read it once before authoring a new template or extending the step registry — it makes a small but important distinction explicit so the codebase stays internally consistent.

## The layered model

The two abstractions live at different levels:

- **Patterns are conceptual.** They are architectural approaches to building agentic systems — _Reflection_, _Routing_, _Multi-Agent Collaboration_, _RAG_. The 21 are sourced from Antonio Gullí's _Agentic Design Patterns_; the canonical seed data is `prisma/seeds/data/chunks/chunks.json` (loaded into the orchestration knowledge base) and the canonical TypeScript constant is `KNOWN_PATTERNS` in `types/orchestration.ts`. The two are kept in lockstep by `tests/unit/types/orchestration-patterns.test.ts`.
- **Steps are primitives.** They are concrete, executable units the engine knows how to run — `llm_call`, `parallel`, `agent_call`, `external_call`. The 15 are declared in `lib/orchestration/engine/step-registry.ts`.

The relationship is **many-to-many**, not one-to-one:

- One pattern usually requires several steps in concert. _Reflection_ is `llm_call` (draft) + `evaluate` (critique) + a conditional back-edge (revise loop).
- One step usually relates to several patterns. `agent_call` is the building block of both _Multi-Agent Collaboration_ (Pattern 7) when invoking same-system agents and _Inter-Agent Communication / A2A_ (Pattern 15) when crossing systems.
- Some steps don't map cleanly to any of the 21. `external_call` is generic outbound HTTP — it can support _A2A_ if the endpoint is another agent, but it's also used to call Stripe or Postmark. Honest answer: no related pattern. Likewise `send_notification`.

The platform's job is to provide step primitives **sufficient to implement every pattern**. The coverage matrix below is the audit that confirms it does.

## The 21 canonical patterns

| #   | Canonical name                  | Aliases accepted in templates  | What it's about                                                            |
| --- | ------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| 1   | Prompt Chaining                 | —                              | Sequential LLM calls where each step's output feeds the next.              |
| 2   | Routing                         | —                              | Classify the input and branch to different downstream paths.               |
| 3   | Parallelisation                 | —                              | Fan out to concurrent branches and join results.                           |
| 4   | Reflection                      | —                              | Self-critique loop — draft, evaluate, revise.                              |
| 5   | Tool Use                        | —                              | Invoke a registered capability (function call) instead of generating text. |
| 6   | Planning                        | —                              | Agent generates its own sub-plan from a goal.                              |
| 7   | Multi-Agent Collaboration       | Multi-Agent                    | Multiple agents working together — delegation, debate, blackboard.         |
| 8   | Memory Management               | Memory                         | Persist context across turns / sessions; recall on demand.                 |
| 9   | Learning & Adaptation           | —                              | Track outcomes; adjust strategy or prompts over time.                      |
| 10  | State Management (MCP)          | MCP                            | Externalise tool/state via the Model Context Protocol.                     |
| 11  | Goal Setting & Monitoring       | —                              | Watch a target state; alert when reality drifts from goal.                 |
| 12  | Exception Handling & Recovery   | —                              | Detect failure; retry, fallback, or compensate cleanly.                    |
| 13  | Human-in-the-Loop               | HITL                           | Pause for human review at high-stakes decision points.                     |
| 14  | Knowledge Retrieval (RAG)       | RAG                            | Retrieve relevant context before generation; ground answers in sources.    |
| 15  | Inter-Agent Communication (A2A) | A2A, Inter-Agent Communication | Cross-system messaging between independent agent services.                 |
| 16  | Resource-Aware Optimisation     | —                              | Route by cost / latency / complexity; pick the cheapest sufficient model.  |
| 17  | Reasoning Techniques            | —                              | Chain-of-thought, self-consistency, tree-of-thought prompting.             |
| 18  | Guardrails & Safety             | Guardrails                     | Enforce input / output policies; fail closed on violations.                |
| 19  | Evaluation & Monitoring         | Evaluation                     | Score outputs against a rubric; measure quality over time.                 |
| 20  | Prioritisation                  | —                              | Rank pending work; pick the highest-value next action.                     |
| 21  | Exploration & Discovery         | —                              | Open-ended autonomous search of a problem space.                           |

`KNOWN_PATTERNS` in `types/orchestration.ts` is the machine-readable form. Use the canonical name in new code and docs; aliases exist so legacy templates don't have to rewrite their badges.

## Coverage matrix — pattern → Sunrise implementation

How each of the 21 is implemented using current step primitives. Templates listed are illustrative — most patterns appear in several templates beyond the example shown.

| #   | Pattern                         | Primary steps                                          | Typical workflow shape                                                             | Example template                                                 |
| --- | ------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Prompt Chaining                 | `llm_call` × N, `chain`                                | A → B → C, each consuming the previous output                                      | content-pipeline, saas-backend                                   |
| 2   | Routing                         | `route`                                                | Classify input → conditional branch on label                                       | customer-support, scheduled-source-monitor                       |
| 3   | Parallelisation                 | `parallel`                                             | Fan out to concurrent branches → join                                              | research-agent, code-review                                      |
| 4   | Reflection                      | `reflect`, or `llm_call` + `evaluate` + back-edge      | Draft → critique → revise loop, bounded by maxIterations                           | content-pipeline, code-review                                    |
| 5   | Tool Use                        | `tool_call`                                            | Agent invokes a registered capability with structured args                         | customer-support, cited-knowledge-advisor                        |
| 6   | Planning                        | `plan`, `orchestrator`                                 | LLM emits sub-plan → executor follows it                                           | content-pipeline, research-agent                                 |
| 7   | Multi-Agent Collaboration       | `agent_call` × N, `parallel`, `orchestrator`           | One workflow invokes multiple configured agents                                    | research-agent, autonomous-research                              |
| 8   | Memory Management               | `tool_call` to memory capability + LLM context build   | Persist user/session state; recall via dedicated tool                              | conversational-learning                                          |
| 9   | Learning & Adaptation           | `evaluate` + feedback loop + custom workflow           | Track outcomes; adjust prompts/routing over time                                   | conversational-learning (partial)                                |
| 10  | State Management (MCP)          | External MCP server + `tool_call`                      | Externalise tool definitions to MCP; agent uses them via tool calls                | See `lib/orchestration/mcp/` (no template; infrastructure-level) |
| 11  | Goal Setting & Monitoring       | Scheduled trigger + `external_call` + `evaluate`       | Watch source on cron; classify deviation from goal-state; alert on material change | scheduled-source-monitor                                         |
| 12  | Exception Handling & Recovery   | Workflow `errorStrategy` field + `guard` + retry edges | retry/fallback/skip/fail at workflow or step level                                 | data-pipeline (errorStrategy + guard)                            |
| 13  | Human-in-the-Loop               | `human_approval`                                       | Pause workflow; reviewer approves/rejects via admin queue                          | customer-support, outreach-safety                                |
| 14  | Knowledge Retrieval (RAG)       | `rag_retrieve`, `tool_call` to `search_knowledge_base` | Retrieve → ground generation in cited chunks                                       | cited-knowledge-advisor                                          |
| 15  | Inter-Agent Communication (A2A) | `external_call` to remote agent endpoint               | HTTP call to another agent service across systems                                  | No dedicated template; supported via `external_call` + auth      |
| 16  | Resource-Aware Optimisation     | `route` on cost/complexity → tier selection            | Cheap model first; escalate to expensive only when needed                          | saas-backend                                                     |
| 17  | Reasoning Techniques            | `llm_call` with chain-of-thought prompt + `reflect`    | Prompt-driven (CoT, self-consistency); no dedicated step type                      | Built into prompts; not a step type                              |
| 18  | Guardrails & Safety             | `guard`                                                | LLM or regex rule check; fail-closed on violation                                  | outreach-safety, cited-knowledge-advisor                         |
| 19  | Evaluation & Monitoring         | `evaluate`                                             | Score output against a rubric (1–10); threshold gates next step                    | data-pipeline, code-review                                       |
| 20  | Prioritisation                  | `route` + custom config; queue-based                   | Rank pending work; pick highest-value action                                       | No dedicated template; pattern is workflow-design level          |
| 21  | Exploration & Discovery         | `orchestrator` with broad agent set + `plan`           | Open-ended autonomous search; planner explores branches                            | autonomous-research (partial)                                    |

**Coverage assessment.** All 21 patterns are implementable with the current 15 step primitives. Patterns 1–7, 13–14, 18–19 have multiple worked-example templates. Patterns 8, 10, 11, 15, 16 are supported but have only one (or zero) dedicated templates. Patterns 9, 12, 17, 20, 21 are implementable but live more at the workflow-design / prompting layer than the step layer — they don't need a dedicated step type, and templates can demonstrate them by composing existing primitives.

If a future requirement reveals a pattern that genuinely cannot be expressed with current steps, that's a signal to add a new step type — not to twist the existing ones. Document the gap here first; ship the new step second.

## Author guidance

### I'm authoring a new template — which patterns should I declare in `patterns[]`?

A template's `patterns[]` array tells learners **which canonical patterns the template demonstrates**. Three rules:

1. **Use canonical names or registered aliases** — both must come from `KNOWN_PATTERNS` (the test will catch you if not).
2. **List patterns the template strongly demonstrates**, not every pattern any step happens to be used in. A `route` step doesn't automatically mean the template is a Routing exemplar — it does if the routing is central to the demonstration.
3. **Don't list step types as patterns** — "External Call", "Orchestrator", "Agent Delegation" are step concepts, not patterns. If the template uses `external_call` to fetch a URL, that's just the step; the pattern being demonstrated is whatever the workflow does with the result (Goal Monitoring, RAG, Tool Use, etc.).

3–7 patterns is a healthy range for a substantive template. A focused 4-step template demonstrating one pattern (e.g. _Reflection_) is also fine.

### I'm adding a new step type — how do I set `relatedPatterns`?

`StepRegistryEntry.relatedPatterns?: number[]` lists the canonical patterns the step most strongly enables.

- **Single value** is fine when the step is a faithful primitive of one pattern (`reflect` → `[4]`, `rag_retrieve` → `[14]`).
- **Multi-value** is fine and often more truthful (`agent_call` → `[7, 15]`, `orchestrator` → `[6, 7]`).
- **Empty array `[]`** is the right answer when no canonical pattern fits — `external_call` is HTTP, not an agentic pattern; `send_notification` is delivery, not strategy. Don't stretch.
- The Phase A drift test rejects any number not in `KNOWN_PATTERNS` — you can't typo this.

### I want a pattern that doesn't appear in `KNOWN_PATTERNS` — what do I do?

The 21 are fixed (sourced from the book). Don't extend the canonical list.

- If you're using a short-form name (e.g. `'Memory'` for `'Memory Management'`), propose adding it as an `aliases` entry on the matching `KNOWN_PATTERNS` row in `types/orchestration.ts`. The drift test will accept it the moment the alias is registered.
- If your concept doesn't fit any of the 21, it's probably not an agentic design pattern. It might be:
  - **A step type** — declare it in the registry and ship the executor in `lib/orchestration/engine/executors/`.
  - **An application pattern** — describe it in the template's `useCases[]` field instead. Application patterns ("scheduled monitoring → alert", "intake → triage → human review") are how design patterns combine to solve real problems; they're not themselves design patterns.

## Cross-references

- `types/orchestration.ts` — `KNOWN_PATTERNS`, `KnownPattern`, `WorkflowTemplatePattern`, `isValidPatternReference()`
- `prisma/seeds/data/chunks/chunks.json` — canonical pattern seed data
- `lib/orchestration/engine/step-registry.ts` — the 15 step types
- `tests/unit/types/orchestration-patterns.test.ts` — drift catcher + template + registry validation
- `.claude/skills/orchestration-agent-architect/references/patterns-1-to-10.md`, `patterns-11-to-21.md` — long-form pattern descriptions used by the agent-architect skill
- `.context/admin/orchestration-workflows-guide.md` — author guide for workflows (step types, error strategies, templates)
- `.context/admin/workflow-builder.md` — admin UI reference for the React Flow builder
