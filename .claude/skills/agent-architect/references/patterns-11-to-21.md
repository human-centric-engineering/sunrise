# Patterns 11–21: Detailed Reference

Each pattern includes: definition, when to use, key mechanism, common mistake, pseudocode, and cross-references.

---

## Pattern 11: Goal Setting & Monitoring

**Definition:** Mechanisms for agents to define objectives, break them into trackable sub-goals, and monitor progress. The agent checks: "Am I closer to the goal than 5 minutes ago?"

**When to use:** Long-running or autonomous workflows where you need to prevent infinite loops, detect stalled progress, or ensure convergence.

**Key mechanism:** A monitoring agent periodically evaluates semantic progress (not just system metrics). When progress stalls, it triggers replanning. Requires "metacognition" — thinking about thinking.

**Common mistake:** Monitoring too frequently (wasting tokens) or too infrequently (missing stuck agents). Calibrate frequency to expected step duration.

**Pseudocode:**

```
status = monitorAgent.evaluate(
  criteria="Is the report complete and accurate?",
  context=agent.getState()
)
if status === "INCOMPLETE": agent.plan.update("Gather more data")
if status === "NO_PROGRESS": triggerDoomLoopEscape()
```

**Relates to:** Planning (6) for the plans being monitored, Reflection (4) for self-assessment, Exception Handling (12) for responding to failures.

---

## Pattern 12: Exception Handling & Recovery

**Definition:** Three-phase resilience: Detection (validate outputs, check error codes, timeouts) → Handling (retry, fallback, degrade, notify) → Recovery (self-correct or escalate to human).

**When to use:** Any production agent system. Without it, agents are brittle. Real-world APIs fail, LLMs hallucinate, tools return unexpected results.

**Key distinction from traditional try-catch:** Agentic recovery is semantic. The agent reasons about why something failed and tries a different strategy ("Google Search failed, I'll try Wikipedia") rather than retrying the exact same operation.

**Common mistake:** Building only retry logic without alternative strategies. If a tool fails three times, retrying a fourth won't help. Design fallback paths.

**Pseudocode:**

```
response = tool.call()
if response.hasError:
  planB = agent.think("Tool A failed. Try Wikipedia instead.")
  planB.execute()
  if planB.failed: escalateToHuman()
```

**Relates to:** HITL (13) for escalation, Guardrails (18) for preventing dangerous recovery, Tool Use (5) for tool failure scenarios.

---

## Pattern 13: Human-in-the-Loop

**Definition:** Human oversight at critical decision points. The agent pauses and requests input from a human "tool." Requires well-defined escalation policies.

**When to use:** High-stakes actions (financial transactions, data deletion, public communications), safety-critical decisions, or situations requiring domain expertise.

**Escalation triggers:** Confidence thresholds, risk levels, policy requirements, action type (any write above a threshold value).

**Common mistake:** Requiring human approval for every action — creates a bottleneck that defeats automation. Define clear escalation policies so only genuinely high-risk actions need approval.

**Pseudocode:**

```
if action.riskLevel > threshold:
  decision = humanTool.ask("Delete production DB. Proceed?")
  if decision === "approved": execute()
  else: agent.abort("User rejected action")
```

**Trade-off:** Massive latency (human speed vs machine speed). Use async notifications (Slack/webhook) rather than blocking. Inherently unscalable — design policies to minimise escalation volume.

**Relates to:** Guardrails (18) for automated safety reducing HITL need, Exception Handling (12) for escalation on recovery failure, Tool Use (5) for write-action safety.

---

## Pattern 14: Knowledge Retrieval (RAG)

**Definition:** Retrieval-Augmented Generation. Three stages: Retrieve relevant documents from a knowledge base → Augment the prompt with retrieved context → Generate a grounded response.

**When to use:** Agent needs information beyond training data — proprietary documents, up-to-date data, domain-specific knowledge, verifiable citations. Primary mechanism for reducing hallucination.

**Four foundational concepts:**

- **Embeddings:** Numerical vectors capturing semantic meaning.
- **Semantic Similarity:** Measuring meaning-likeness, not keyword match.
- **Chunking:** Breaking documents into focused retrieval units.
- **Vector Databases:** Stores optimised for embedding search (Pinecone, Weaviate, Chroma, pgvector).

**Retrieval strategies:** Vector search (semantic), BM25 (keyword), hybrid (both). GraphRAG uses knowledge graphs for multi-document synthesis. Agentic RAG adds a reasoning agent that validates source recency and reconciles conflicts.

**Common mistake:** Poor chunking — too large loses precision, too small loses context. Also: not evaluating retrieval and generation quality separately (the "RAG Triad").

**Pseudocode:**

```
docs = retriever.getRelevantDocuments("What is our pricing model?")
prompt = `Context: ${docs}\nQuestion: What is our pricing model?`
response = llm.generate(prompt)
```

**Relates to:** Memory (8) for long-term agent knowledge, Tool Use (5) for retrieval as a tool, Guardrails (18) for validating retrieved content.

---

## Pattern 15: Inter-Agent Communication (A2A)

**Definition:** Protocols for autonomous agents to exchange messages, tasks, and state. Google A2A is an emerging open HTTP-based standard.

**When to use:** Agents built on different frameworks need to collaborate. Prevents "Tower of Babel" in multi-agent systems.

**Key concepts:** Agent Cards (digital capability identifiers for auto-discovery), sync and streaming interaction patterns, multi-turn conversations with `input-required` state.

**A2A vs MCP:** A2A handles agent-to-agent orchestration (high-level task management). MCP handles agent-to-tool integration (low-level resource access). They are complementary, not competing.

**Common mistake:** Building custom agent communication when a standard protocol exists — creates integration debt.

**Relates to:** Multi-Agent (7) for the systems A2A connects, MCP (10) for the complementary tool-level protocol.

---

## Pattern 16: Resource-Aware Optimisation

**Definition:** Agents that are aware of token consumption, API costs, and compute limits, optimising strategies accordingly.

**When to use:** Any production system where cost, latency, or compute budgets matter. "Token economics" is a critical architectural constraint.

**Key techniques:**

- **Dynamic model selection:** Route simple tasks to cheap models, complex to frontier.
- **Adaptive tool use:** Select the most efficient tool for the task.
- **Context pruning:** Summarise or discard irrelevant context to reduce token count.
- **Graceful degradation:** Fall back to simpler approaches when resources are constrained.

**Tiered routing strategy:** 70% budget model ($0.10–0.60/M) + 20% mid-tier ($3/M) + 10% frontier ($5–25/M) reduces average cost by 60–80%.

**Common mistake:** Running all requests through the frontier model "just in case" — can cost 100× more than tiered routing.

**Pseudocode:**

```
model = (task.complexity === "LOW") ? cheapModel : frontierModel
response = model.generate(task.prompt)
```

**Relates to:** Routing (2) for the routing mechanism, Chaining (1) for optimising per-step.

---

## Pattern 17: Reasoning Techniques

**Definition:** Structured reasoning strategies that shape the model's internal processing for complex problems. Makes reasoning explicit and auditable.

**Key techniques:**

- **Chain-of-Thought (CoT):** Step-by-step reasoning, decomposing problems into sub-steps.
- **Tree-of-Thought (ToT):** Explore multiple reasoning branches, evaluate feasibility, expand the best.
- **ReAct:** Alternate between reasoning and acting with external tools. The core agent loop.
- **Chain of Debates:** Multiple agents argue competing perspectives to reduce bias.
- **Self-Correction:** Evaluate and improve own reasoning before execution.

**Scaling Inference Law:** Performance depends on allocated "thinking time," not just model size. More reasoning steps often beats a bigger model. Like giving someone 5 minutes with pen and paper vs 30 seconds to guess.

**Common mistake:** Applying CoT to every request regardless of complexity. Simple factual queries don't need multi-step reasoning — extra tokens increase cost for no quality gain.

**Relates to:** Reflection (4) for self-correction, Planning (6) for plan generation, Multi-Agent (7) for debate-based reasoning.

---

## Pattern 18: Guardrails & Safety

**Definition:** Architectural safeguards preventing harmful actions, PII leakage, or policy deviation. The "firewall" of the AI age.

**When to use:** Mandatory for any production agent interacting with users, handling sensitive data, performing writes, or operating in regulated environments.

**Five guardrail layers (layered defence):**

1. **Input validation:** Filter harmful or out-of-scope prompts.
2. **Output filtering:** Scan for PII, toxicity, policy violations.
3. **Behavioural prompting:** System-level constraints on agent behaviour.
4. **Tool use restrictions:** Limit which tools and under what conditions.
5. **External moderation:** Separate LLM as "censor" evaluating outputs.

**Common mistake:** Relying on a single technique (e.g., only system prompt constraints). Prompts can be jailbroken. Use layered defence — multiple independent guardrails.

**Pseudocode:**

```
response = agent.generate()
safetyCheck = guardrailModel.check(response)
if safetyCheck.containsPii || safetyCheck.isToxic:
  return "<response filtered>"
return response
```

**Relates to:** HITL (13) for ultimate escalation, Tool Use (5) for write restrictions, Evaluation (19) for tracking guardrail effectiveness.

---

## Pattern 19: Evaluation & Monitoring

**Definition:** Frameworks for measuring agent performance and monitoring behaviour in production. Goes beyond output accuracy to include agent trajectories.

**When to use:** Any production system. Essential for detecting drift, A/B testing, compliance audits, and ongoing reliability.

**Key concepts:**

- **Agent trajectories:** The sequence of steps taken, compared against ideal paths. Reveals inefficiency even when final output is correct (e.g., agent searched for hotels when asked to book a flight).
- **LLM-as-a-Judge:** Separate LLM scoring qualitative aspects (correctness, hallucination, tone) that deterministic assertions can't measure.
- **Contracts:** Formal specs defining verifiable deliverables — agents negotiate, clarify, and self-validate.

**Common mistake:** Only evaluating final output without examining trajectory. A correct answer via an inefficient/unsafe path will cause problems at scale.

**Relates to:** Learning (9) for detecting drift, Guardrails (18) for safety compliance, Reflection (4) for self-assessment.

---

## Pattern 20: Prioritisation

**Definition:** Agent ranks tasks by urgency, importance, and constraints, managing its own backlog. Includes dynamic re-prioritisation as conditions change.

**When to use:** Agents managing multiple concurrent tasks in autonomous loops, deciding what to work on next based on changing conditions.

**Key mechanism:** Priority is determined by semantic understanding of task content ("This email looks angry, prioritise it") not just a numerical flag. Operates at strategic (which goal matters most?) and tactical (which next action?) levels.

**Common mistake:** Static priority rankings that never update. Build dynamic re-prioritisation, not just initial ranking.

**Relates to:** Goal Monitoring (11) for tracking prioritised goals, Planning (6) for task sequencing, Resource-Aware (16) for cost-priority balance.

---

## Pattern 21: Exploration & Discovery

**Definition:** Agents proactively seeking new information, testing hypotheses, and expanding knowledge — rather than just reacting to prompts. The essence of truly agentic behaviour.

**When to use:** Open-ended domains where the solution space is unknown, hypothesis testing is required, or knowledge must expand autonomously.

**Real-world implementations:** Google Co-Scientist (autonomous hypothesis generation/debate), Agent Laboratory (agentic hierarchy mimicking human research teams).

**Common mistake:** Letting exploration run without resource boundaries — unbounded exploration burns tokens and can enter unsafe territory. Always set token budgets, time limits, and scope constraints.

**Pseudocode:**

```
while not hypothesis.proven():
  experiment = scientistAgent.designExperiment()
  result = labTool.run(experiment)
  scientistAgent.learn(result)
  scientistAgent.refineHypothesis()
// Safety: enforce token budget, time limit, scope constraints
```

**Relates to:** Learning (9) for incorporating discoveries, Planning (6) for structuring exploration, Multi-Agent (7) for research team structures.
