# Autonomous Multi-Agent Orchestration

AI-driven coordination where a planner LLM dynamically selects agents,
delegates tasks, and adapts strategy based on intermediate results.

## Workflows vs Autonomous Orchestration

Sunrise offers two orchestration paradigms within the same workflow engine.
Both use the same execution infrastructure, cost tracking, and admin UI —
the difference is how control flow is determined.

| Dimension           | Workflow (DAG)                      | Orchestrator Step                     |
| ------------------- | ----------------------------------- | ------------------------------------- |
| Control flow        | Pre-defined graph of steps          | Emergent, AI-decided per round        |
| Agent selection     | Fixed per step at authoring time    | Dynamic — planner picks at runtime    |
| Adaptability        | Follows edges regardless of results | Replans based on intermediate results |
| Determinism         | High — same input follows same path | Low — planner reasoning varies        |
| Complexity          | Author must anticipate all paths    | Planner discovers paths dynamically   |
| Transparency        | Full DAG visible before execution   | Planner reasoning logged per round    |
| Cost predictability | Estimable from step count           | Variable (bounded by budget config)   |
| Best for            | Known processes, compliance flows   | Open-ended problems, exploration      |

### When to use Workflows

- The process is well-defined with known decision points
- Regulatory or compliance requirements demand auditable fixed paths
- Cost predictability matters more than adaptability
- You want deterministic behavior across runs
- The number of agents and their responsibilities is known upfront

### When to use the Orchestrator

- The problem is open-ended or poorly defined upfront
- Different inputs may require fundamentally different agent combinations
- Intermediate results should inform which agents to involve next
- You want the system to discover optimal collaboration patterns
- The task benefits from multi-round refinement across specialists

### Emergence, Complexity, and Adaptability

Traditional workflows require the author to anticipate every decision
path and agent handoff at design time. When the problem space is complex
or unpredictable, this leads to brittle over-specification or incomplete
coverage.

The orchestrator step enables **emergent behavior**: the planner LLM sees
agent results after each round and can:

- **Recruit specialists** it didn't initially plan to use
- **Reroute** when an agent reports unexpected findings
- **Synthesize partial answers** from multiple agents into a coherent whole
- **Adapt depth** — simple tasks resolve in one round, complex tasks get
  multiple rounds of delegation

This behavior is not authored into a DAG — it **emerges** from the
planner's reasoning about intermediate results, the available agent
roster, and the original task description.

## Architecture

The `orchestrator` is a standard workflow step type, registered alongside
`llm_call`, `route`, `agent_call`, etc. It runs within the existing
`OrchestrationEngine` DAG walker.

```
┌─────────────────────────────────────────────────────┐
│                  Workflow DAG                        │
│                                                     │
│  [entry] → [rag_retrieve] → [orchestrator] → [end]  │
│                                    │                │
│                     ┌──────────────┼───────────┐    │
│                     ▼              ▼           ▼    │
│              ┌─────────┐   ┌──────────┐  ┌───────┐ │
│              │ Agent A  │   │ Agent B  │  │Agent C│ │
│              └─────────┘   └──────────┘  └───────┘ │
│                     │              │           │    │
│                     └──────────────┼───────────┘    │
│                                    ▼                │
│                          [planner replans           │
│                           or returns answer]        │
└─────────────────────────────────────────────────────┘
```

### Execution flow

1. Engine reaches the `orchestrator` step
2. Executor loads configured agents from the database
3. Builds a system prompt with agent descriptions for the planner LLM
4. **Planning loop** (bounded by `maxRounds`):
   a. Calls planner LLM with task + accumulated results
   b. Planner returns JSON: delegations and/or a final answer
   c. If final answer → stop, return synthesized result
   d. For each delegation → calls `executeAgentCall` (reuses existing executor)
   e. Collects results, checks budget, loops back to planner
5. Returns structured output with rounds, delegations, costs, and stop reason

### Key reuse points

| Component          | Reused from     | Purpose                                             |
| ------------------ | --------------- | --------------------------------------------------- |
| `executeAgentCall` | `agent-call.ts` | Agent loading, provider resolution, tool loops      |
| `runLlmCall`       | `llm-runner.ts` | Planner LLM calls with cost tracking                |
| `ExecutionContext` | `context.ts`    | Budget checks, step outputs, abort signal           |
| Recursion guard    | `agent-call.ts` | `MAX_AGENT_CALL_DEPTH = 3` prevents infinite chains |

## Configuration Reference

| Field                    | Type                 | Default         | Description                                             |
| ------------------------ | -------------------- | --------------- | ------------------------------------------------------- |
| `plannerPrompt`          | string               | (required)      | System instructions for the planner LLM                 |
| `availableAgentSlugs`    | string[]             | (required)      | Agent slugs the planner can delegate to                 |
| `selectionMode`          | `'auto' \| 'all'`    | `'auto'`        | Auto: planner picks agents. All: fan out to every agent |
| `maxRounds`              | number (1-10)        | `3`             | Maximum plan-delegate-replan cycles                     |
| `maxDelegationsPerRound` | number (1-20)        | `5`             | Maximum agent calls per round                           |
| `modelOverride`          | string               | system default  | Override the planner's model                            |
| `temperature`            | number (0-2)         | `0.3`           | Planner LLM temperature                                 |
| `timeoutMs`              | number (5000-600000) | `120000`        | Hard timeout for the entire step                        |
| `budgetLimitUsd`         | number               | workflow budget | Step-level budget cap                                   |

## Examples

### Research task

A planner coordinates three specialist agents to research a topic:

```
Planner prompt: "You are a research coordinator. Break the research
question into sub-topics, delegate to specialist agents, and synthesize
a comprehensive report."

Available agents: [market-analyst, tech-researcher, competitor-scout]
Max rounds: 3
```

Round 1: Planner delegates "market size analysis" to market-analyst and
"technology landscape" to tech-researcher.

Round 2: Based on their findings, planner delegates "competitor
positioning" to competitor-scout with specific context from round 1.

Round 3: Planner synthesizes all results into a final report.

### Customer issue triage

```
Planner prompt: "Analyze the customer issue. Determine which specialist
can best resolve it. If the first specialist can't fully resolve it,
escalate to additional specialists."

Available agents: [billing-agent, technical-support, account-manager]
Max rounds: 2
```

Round 1: Planner routes to billing-agent based on issue keywords.

Round 2: Billing-agent reports this is actually a technical issue.
Planner re-delegates to technical-support with billing context.

## Constraints and Guards

- **Recursion**: `MAX_AGENT_CALL_DEPTH = 3` — inherited from `agent_call`.
  An orchestrator calling an agent that runs a workflow with another
  orchestrator will hit this limit.
- **Budget**: Step-level `budgetLimitUsd` + workflow-level `budgetLimitUsd`.
  Checked between rounds. Returns partial results on exceed.
- **Timeout**: Configurable per step, propagates via `AbortSignal`.
  Returns partial results on timeout.
- **Max rounds/delegations**: Configurable caps prevent runaway loops.
- **Planner JSON validation**: Response validated with Zod schema.
  Invalid JSON retried once with clarifying prompt, then fails the round.

## Source files

| File                                                   | Purpose                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| `lib/orchestration/engine/executors/orchestrator.ts`   | Executor implementation                                          |
| `lib/orchestration/engine/step-registry.ts`            | FE registry entry (orchestration category)                       |
| `lib/validations/orchestration.ts`                     | `orchestratorConfigSchema` + `orchestratorPlannerResponseSchema` |
| `components/.../block-editors/orchestrator-editor.tsx` | Config editor UI                                                 |
| `types/orchestration.ts`                               | `KNOWN_STEP_TYPES` includes `'orchestrator'`                     |
