# Patterns 1–10: Detailed Reference

Each pattern includes: definition, when to use, key mechanism, common mistake, pseudocode, and cross-references.

---

## Pattern 1: Prompt Chaining

**Definition:** Decompose a complex task into a linear sequence of smaller LLM calls. Output of step N becomes input for step N+1. Validation gates between steps catch errors before they propagate.

**When to use:** Any task too complex for a single prompt — multiple stages of reasoning, extraction, transformation, or synthesis. The default starting pattern.

**Key mechanism:** Each step has a single focused objective. Enforce structured output (JSON/XML) between steps so downstream nodes receive unambiguous input. Assign distinct roles per step (e.g., "Analyst" for extraction, "Editor" for formatting).

**Five failure modes of monolithic prompts:** instruction neglect, contextual drift, error propagation, context window exhaustion, hallucination. Chaining addresses all five by constraining scope per step.

**Common mistake:** Building a single massive prompt that tries to handle everything. If your prompt exceeds ~500 words with multiple distinct tasks, break it into a chain.

**Pseudocode:**

```
chain(userQuery):
  context = llm.invoke("Extract entities and intent...", userQuery)
  if not validateStructure(context): retry or fail
  analysis = llm.invoke("Analyse sentiment and themes...", context)
  response = llm.invoke("Draft reply based on analysis...", analysis)
  return response
```

**Trade-off:** Latency is additive (sum of all steps). More steps = more reliable but slower. Optimise by reducing token count per step.

**Relates to:** Routing (2) for conditional branching, Guardrails (18) for validation gates, Reflection (4) for quality checks between steps.

---

## Pattern 2: Routing

**Definition:** Classify the intent of an input and dispatch to the most appropriate specialised agent, model, or processing path. A "Router" acts as a semantic switch.

**When to use:** System must handle diverse input types requiring different processing paths, models, or specialised agents.

**Four routing mechanisms:**

- **LLM-based:** Prompt the model to classify intent and output a category.
- **Embedding-based:** Convert input to a vector, compare against route vectors via similarity.
- **Rule-based:** Predefined if-else logic (fast, deterministic, less flexible).
- **ML Classifier:** Small trained model for routing decisions (fast, baked-in logic).

**Common mistake:** Using a frontier model for routing when a cheap classifier would suffice. Also: not evaluating router accuracy with a confusion matrix before production.

**Pseudocode:**

```
routeRequest(userQuery):
  intent = classificationAgent.classify(userQuery)  // cheap/fast model
  switch intent:
    "BILLING"  → billingAgent.run(userQuery)
    "SUPPORT"  → supportAgent.run(userQuery)
    "GENERAL"  → generalAgent.run(userQuery)
    "UNCLEAR"  → askUserToClarify()
```

**Trade-off:** Router is a single point of failure. Misclassification sends the user to the wrong agent. Evaluate with a confusion matrix.

**Relates to:** Resource-Aware (16) for cost-based model selection, Chaining (1) for sequential processing after routing.

---

## Pattern 3: Parallelisation

**Definition:** Execute multiple independent tasks simultaneously and aggregate results via a reducer. Also called Scatter-Gather or Voting.

**When to use:** Task decomposes into independent sub-tasks with no dependencies. Latency reduction is the primary benefit.

**Key mechanism:** Fork independent tasks → run concurrently → wait for all → reducer agent synthesises. The reducer is intelligent — it resolves conflicts and de-duplicates, not just concatenates.

**Common mistake:** Parallelising tasks that have hidden dependencies, producing contradictory outputs the reducer can't reconcile. Verify independence before parallelising.

**Pseudocode:**

```
parallelFlow(query):
  [research, legal, market] = await Promise.all([
    researchAgent.run(query),
    legalAgent.run(query),
    marketAgent.run(query)
  ])
  report = synthesisAgent.merge(research, legal, market)
  return report
```

**Trade-off:** Costs scale linearly with branches (5 branches = 5× tokens). Speed improves but budget increases proportionally. Handle stragglers (timeout + proceed with partial results, or fail-all).

**Relates to:** Multi-Agent (7) for structured parallel teams, Resource-Aware (16) for cost management.

---

## Pattern 4: Reflection

**Definition:** An agent critiques its own output (or another agent's output) to identify errors, hallucinations, or quality issues, then iteratively refines. Core loop: Draft → Critique → Revise → repeat.

**When to use:** Output quality is paramount and latency is acceptable. Tasks requiring accuracy, nuance, or adherence to complex instructions.

**Key mechanism:** Producer-Critic separation is more effective than self-reflection. Use a separate agent/prompt for critique. Set maximum retry limits to prevent infinite loops. Use a cheaper model for drafting, stronger model for critique.

**Common mistake:** Letting the same model critique its own output without a separate critic prompt. Also: not setting max retries, causing infinite revision loops ("degeneracy").

**Pseudocode:**

```
reflectiveGenerate(spec):
  draft = coderAgent.run(spec)
  for i in range(MAX_RETRIES):
    critique = reviewerAgent.evaluate(draft)
    if critique.approved: return draft
    draft = coderAgent.run(spec, feedback=critique.comments)
  throw MaxRetriesExceeded
```

**Trade-off:** Doubles or triples latency per reflection cycle. Each cycle adds cost. Worth it for high-stakes output; overkill for simple queries.

**Relates to:** Evaluation (19) for measuring reflection effectiveness, Reasoning (17) for self-correction.

---

## Pattern 5: Tool Use

**Definition:** Extend the LLM by letting it call external APIs, databases, calculators, or services. Transforms the LLM from text generator into system controller.

**When to use:** Agent needs real-time data, calculations, database queries, or any action beyond its training data.

**Key mechanism:** Tools are defined with descriptions and parameters. The LLM reads the description to decide when/how to call. The quality of the tool description is the primary determinant of reliability — you are writing API documentation for a machine reader.

**Inversion of Control:** The developer defines the interface; the agent decides when to call it. This is IoC at the logic level — like dependency injection, but the agent decides the execution path at runtime.

**Read vs Write safety:** Read-only tools (GET) are generally safe. Write tools (POST/DELETE) require Guardrails (18) and HITL (13) validation.

**Common mistake:** Writing poor tool descriptions. Vague descriptions cause misuse or failure to call. Test with: "Would a new developer understand when and how to call this from the description alone?"

**Pseudocode:**

```
weatherTool = {
  name: "get_weather",
  description: "Get current weather for a city. Input: city name string.",
  func: callWeatherApi
}
agent = initAgent(tools=[weatherTool], llm=llm)
result = agent.run("What should I wear in Tokyo today?")
// Agent internally: Think → Select tool → Call → Observe → Answer
```

**Relates to:** MCP (10) for standardised tool interfaces, Guardrails (18) for write safety, Exception Handling (12) for tool failure recovery.

---

## Pattern 6: Planning

**Definition:** Agent breaks a high-level goal into executable steps (a plan/DAG) at runtime, then executes while tracking progress. Can dynamically replan when steps fail or new information emerges.

**When to use:** Multi-step tasks where the sequence cannot be fully predetermined. Bridges human intent and automated execution.

**Key mechanism:** The agent builds its own DAG at runtime based on the specific request. Unlike static workflows (Airflow, Step Functions), agentic plans are dynamic — handling novel situations the programmer didn't foresee. Replanning capability is critical.

**Common mistake:** Trusting the generated plan without validation. Agents can produce plans that skip prerequisites, contain circular dependencies, or include impossible steps. Always validate plan logic before execution.

**Pseudocode:**

```
plan = plannerAgent.generatePlan(goal="Handle return for damaged item")
// Dynamic plan: 1. Request photo → 2. Verify purchase → 3. Generate label → 4. Refund
for step in plan:
  result = executorAgent.execute(step)
  if result.failed: plan = plannerAgent.replan(step, result.error)
```

**Trade-off:** Planning adds upfront latency ("Time to First Token" is high). Balance planning depth with responsiveness. Validate plan safety before execution.

**Relates to:** Goal Monitoring (11) for tracking plan execution, Reflection (4) for plan quality assessment.

---

## Pattern 7: Multi-Agent Collaboration

**Definition:** A team of specialised agents (Researcher, Writer, Reviewer, Coder) collaborate via handoffs and communication to solve complex problems through role specialisation.

**When to use:** Task is too complex or multi-domain for a single agent. Problem naturally decomposes into sub-problems requiring different tools, data, or reasoning.

**Collaboration topologies:**

- **Sequential:** Agent A completes → passes to Agent B.
- **Parallel:** Multiple agents work simultaneously.
- **Debate:** Agents argue competing perspectives to reach consensus.
- **Hierarchical:** Coordinator delegates to and supervises workers.

**Key distinction from traditional microservices:** Microservices communicate via rigid APIs (syntactic contracts). Agents communicate via natural language (semantic contracts). The handshake involves negotiation, not just data transfer.

**Common mistake:** Defaulting to multi-agent when prompt chaining would suffice. Multi-agent adds significant complexity, latency, and cost. Use only when the problem genuinely requires distinct specialisations.

**Pseudocode:**

```
researcher = Agent(role="Researcher", goal="Find facts", tools=[...])
writer = Agent(role="Writer", goal="Draft content", tools=[...])
workflow = new Workflow()
workflow.addEdge(researcher, writer)
workflow.run("Write a blog post about Agentic AI")
```

**Trade-off:** High latency (multiple round-trips). Debugging is exponentially harder. Token costs multiply with each conversation round. Cost management is critical.

**Relates to:** A2A (15) for standardised protocols, Parallelisation (3) for concurrent agents, Planning (6) for task decomposition.

---

## Pattern 8: Memory Management

**Definition:** Mechanisms for agents to store, index, and retrieve information over time. Two types: short-term (context window) and long-term (vector DB/persistent store).

**When to use:** Agent needs conversational context within a session, user preferences across sessions, or knowledge not in the current prompt.

**Short-term memory** = context window contents (recent messages, tool results, reflections). Limited capacity. Degrades with overloading — mirrors how humans can hold ~7 items in working memory.

**Long-term memory** = external vector databases. Information converted to embeddings, retrieved via semantic similarity. Probabilistic retrieval (getting "relevant" memories) vs exact retrieval (getting "row ID 123").

**Common mistake:** Stuffing everything into the context window instead of using retrieval. Long context windows are expensive and quality degrades when overloaded.

**Pseudocode:**

```
memories = vectorDb.similaritySearch(currentInput)
// Returns semantically related memories even if wording differs
agent.run(input=currentInput, context=memories)
```

**Trade-off:** Context window is not persistent — lost when session ends. Design for explicit persistence from the start. Balance memory relevance against token cost.

**Relates to:** RAG (14) for structured long-term retrieval, Learning (9) for storing learned behaviours.

---

## Pattern 9: Learning & Adaptation

**Definition:** Agent improves over time based on feedback, without full model retraining. Includes in-context learning (updating few-shot examples) and knowledge base updates.

**When to use:** Environments that change, require personalisation, or must improve without redeployment.

**Two levels of adaptation:**

- **Instructional:** Refine prompts, few-shot examples, context — change behaviour without changing code.
- **Architectural:** Agent rewrites its own code/structure — higher reward, higher risk.

**Common mistake:** Allowing learning from all feedback without guardrails. Adversarial feedback can poison behaviour. Always validate learned changes against safety constraints.

**Pseudocode:**

```
if userFeedback === "Bad response":
  memory.addNegativeExample(lastInteraction)
  optimiser.updatePromptInstructions("Avoid passive voice.")
  // Next run uses updated instructions — no redeployment
```

**Trade-off:** "Drift" is a major risk — an agent adapting to bad feedback degrades quickly. Need version control for learned behaviours and continuous evaluation.

**Relates to:** Evaluation (19) for detecting drift, Memory (8) for storing knowledge, Guardrails (18) for preventing harmful learning.

---

## Pattern 10: State Management (MCP)

**Definition:** Model Context Protocol — a standardised interface for LLMs to discover, communicate with, and use external resources. Universal translator between LLM and tools.

**When to use:** Integrating multiple tools/data sources in a standardised, reusable way. Essential when building for multiple LLM providers or when tool discovery must happen dynamically.

**Three MCP primitives:** Resources (static data), Tools (executable functions), Prompts (interaction templates).

**MCP vs Function Calling:** Function calling is direct, one-to-one, proprietary. MCP provides dynamic discovery, interoperability, and reusability. Function calling = giving the AI a specific wrench. MCP = creating a universal power outlet system.

**Critical warning:** Wrapping legacy APIs in MCP without redesigning for agent consumption is insufficient. APIs must return agent-friendly formats (text/Markdown not PDF), support filtering, and keep responses token-efficient.

**Common mistake:** Wrapping legacy APIs that return 10,000 unsorted records — useless to an agent regardless of protocol wrapping.

**Pseudocode:**

```
client.connect(server="github-mcp-server")
client.connect(server="slack-mcp-server")
tools = client.listTools()  // auto-discovered
agent.bind(tools)
```

**Relates to:** Tool Use (5) for the function calling it standardises, A2A (15) for agent-level protocol, Guardrails (18) for centralised security.
