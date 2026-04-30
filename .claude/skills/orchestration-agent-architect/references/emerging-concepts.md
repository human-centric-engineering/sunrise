# Emerging Patterns & Concepts

These concepts are gaining traction in 2026 but are not yet established as standalone patterns in the core 21. They are worth applying when the situation calls for them.

---

## Orchestrator-Worker Pattern

A refinement of Multi-Agent Collaboration (Pattern 7) where the orchestrator dynamically spawns, routes, and terminates workers based on the task — rather than having a fixed team. The team composition itself is dynamic. This is the architectural pattern underlying LangGraph and Microsoft's AutoGen.

**When to use:** Complex tasks where the number and type of sub-tasks isn't known upfront. The orchestrator assesses the goal and decides at runtime what workers to create.

**Distinction from Pattern 7:** In standard multi-agent, the team is predefined (Researcher + Writer + Reviewer). In orchestrator-worker, the orchestrator might spawn 2 workers for a simple task or 8 for a complex one, choosing specialisations dynamically.

---

## Blackboard Pattern

A shared workspace where multiple agents independently read, write, and refine a common problem state. Instead of point-to-point message passing, all agents interact through a central shared context — like consultants collaborating on a shared document.

**When to use:** Problems where multiple specialists need to contribute to the same evolving state, and the order of contributions isn't predetermined. Reduces inter-agent communication complexity and makes system state visible and debuggable.

**Origin:** Originally from speech recognition research, now revived for LLM multi-agent coordination.

---

## Evaluator-Optimiser Loop

A tight feedback loop between Evaluation (Pattern 19) and Learning (Pattern 9). A dedicated evaluator agent continuously scores performance and feeds results directly into prompt/context optimisation, closing the loop: evaluate → identify weakness → update instructions → re-evaluate.

**When to use:** Systems that need to improve autonomously over time. The ACE (Agentic Context Engineering) framework is a research implementation — it treats contexts as evolving playbooks that accumulate strategies through generation, reflection, and curation.

**Reference:** ACE Framework (arXiv:2510.04618)

---

## FinOps for Agents

Treating agent cost management as a first-class architectural concern — not just knowing costs, but actively managing them.

**Key practices:**

- Automatic budget caps per request (kill the agent if it exceeds $X)
- Cost dashboards per agent and per user
- Token usage alerts for anomalous spikes
- Plan-and-Execute cost pattern: capable model creates strategy, cheaper models execute (up to 90% cost reduction)
- Per-request cost logging for post-hoc analysis

**Architectural principle:** In 2026, agent cost optimisation is as essential as cloud cost management was in the microservices era. Treat it as a first-class concern from day one, not an afterthought.

---

## Agent Security

Production agent systems face security concerns beyond content guardrails (Pattern 18):

**Prompt injection defence:** Layered techniques to prevent malicious input from overriding system instructions. Strategies: input sanitisation, instruction hierarchy (system > user), separate input/instruction channels, output validation. This is the SQL injection of the AI age — treat all user input as untrusted.

**Tool sandboxing:** Prevent agents from executing dangerous operations. Apply principle of least privilege: restrict tool permissions, run tools in isolated environments (containers, sandboxes), separate read and write tool access.

**Multi-tenant isolation:** In SaaS applications, ensure agents cannot access data belonging to other users. Scope RAG retrieval, memory stores, and tool access to the current user's permissions. Never trust the agent to self-enforce access control — enforce it at the infrastructure level.

**API key management:** Store tool API credentials in secure vaults (not in prompts or environment variables). Rotate keys regularly. Log which tools are called with which credentials for audit trails.

**Supply chain risk:** MCP servers and third-party tools are external dependencies. Validate that MCP servers are trusted, monitor for unexpected behaviour, and have fallback strategies if a server is compromised.

---

## Structured Agent Tracing

Standardised recording of every step an agent takes — thoughts, tool calls, observations, decisions, errors — in a structured trace that can be replayed, debugged, and analysed.

**Why it matters:** Without tracing, debugging a multi-step agent failure is like debugging a distributed system with no logs. You need to answer: "What did the agent do, why did it do it, and where did it go wrong?"

**What to trace per step:**

- Step number and timestamp
- Agent identity (which agent in a multi-agent system)
- Action type (LLM call, tool call, decision, handoff)
- Input (what the agent received)
- Output (what the agent produced)
- Token count and cost for that step
- Latency for that step
- Error (if any)

**Tooling:** LangSmith, Arize, Trickle AI, and custom OpenTelemetry-based solutions. The equivalent of structured logging and distributed tracing for traditional microservices.

**Production use:** Traces feed into Evaluation (Pattern 19) for quality monitoring, FinOps for cost analysis, and debugging workflows for incident response.
