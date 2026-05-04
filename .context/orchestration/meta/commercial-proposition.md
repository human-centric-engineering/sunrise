# What Sunrise Offers

Sunrise is a platform for building AI agents that do real work — not just generate text, but use tools, follow multi-step processes, look things up in your documents, and operate within budget and safety constraints you define. It ships as a single TypeScript codebase: the orchestration engine, a 20-page admin interface, consumer-facing chat, 133 API endpoints, a PostgreSQL database with 29 models, and Docker deployment configuration. You own and modify the entire stack. It is not a library you wire into your own application, and it is not a managed service you rent from a cloud provider. It is the application.

---

## Why this exists

Building an AI-powered product today typically means assembling a stack from parts. You pick an orchestration engine for chaining LLM calls, then build everything else around it — authentication, admin dashboard, API layer, cost tracking, deployment pipeline, safety guards. That integration work routinely exceeds the orchestration work itself.

Sunrise removes that assembly step. Orchestration is one layer within a complete, typed application — sharing authentication, validation, error handling, and deployment with everything else. A change to the agent configuration schema propagates from the database through the API to the admin form without manual synchronisation. You start with a working product and customise it, rather than starting with a library and building a product around it.

---

## What you get

### Your agents stay within bounds

Every agent has a monthly budget. When it hits 80%, you get a warning. At 100%, the budget is enforced — no surprise bills, no runaway spending discovered after the fact. This check happens inside the execution loop itself, not in a billing dashboard you review next week. On top of that: input guards detect prompt injection attempts, output guards enforce topic boundaries and filter sensitive information, and rate limiting operates at the IP, user, agent, and individual tool level. You can deploy agents to real users with confidence that costs and behaviour stay predictable.

### It keeps working when things break

When your primary LLM provider has an outage, a circuit breaker trips after five failures and your agent switches to the next provider in its fallback chain — automatically, without your users noticing. When the provider recovers, traffic routes back. Each agent can have up to five fallback providers. Your users experience continuity; you don't get paged at 2am.

If the orchestration engine itself crashes mid-execution, the failure is captured rather than swallowed: the execution row is marked failed and a webhook fires immediately, instead of leaving a "stuck" record for an internal reaper to find later. Background workflows fail loudly, not silently — and you can poll a lightweight status endpoint to track any in-flight execution without paying for a full trace read.

### Humans stay in the loop

For anything consequential — processing a refund, publishing content, submitting an application — a workflow can pause for human approval before the agent acts. Approvals work through the admin dashboard, but also through external channels: a Slack bot or email notification with signed approve/reject links, no login required. You can delegate approval authority to specific team members. There is a dedicated approval queue with a badge count in the sidebar so pending items don't get lost. This matters for trust, for compliance, and for the kinds of high-stakes applications where full automation is not yet appropriate.

### One codebase, one stack

116 TypeScript source files across 19 modules. End-to-end type safety from database schema through API validation to admin interface. One deployment artifact. The orchestration engine itself contains zero framework-specific imports — it is pure TypeScript, testable without a server runtime, portable if your needs change. When you modify something, the types catch the ripple effects. When you deploy, it is one thing to ship.

### It goes where your users are

A single `<script>` tag on any website creates an isolated chat interface connected to one of your agents — Shadow DOM prevents style conflicts with the host page. The same agents are callable through a REST API for mobile apps, a streaming SSE endpoint for web clients, and a Model Context Protocol server for AI-native tools like Claude Desktop and IDE extensions. You build the agent once and reach users wherever they are — your own app, a partner's website, a developer's IDE, or a native mobile client.

### Your agents know your domain

Agents are not limited to their training data. You upload your own documents — product manuals, policy guides, knowledge articles, EPUB books, Word documents, scanned PDFs, and CSV exports (where each row becomes individually searchable) — and the platform chunks, embeds, and indexes them for semantic search. Agents retrieve relevant content at query time, grounding their responses in your actual information rather than general knowledge. You control which categories of knowledge each agent can access, so a customer support agent and an internal operations agent draw from different document sets even though they share the same platform.

### Your agents back up their answers

When an agent uses your knowledge base, the response carries inline numbered citations — `[1]`, `[2]` — and a sources panel below the message showing the document name, section, and a verifiable excerpt for each. The citations flow through the API, the embed widget, and the conversation trace viewer, so you and your users can see exactly where every claim came from. You can opt the citation guard into warning or blocking mode so the platform flags responses that don't cite their retrieved sources or that reference sources that don't exist — useful for compliance-heavy domains (legal, financial, health) where ungrounded answers are a liability.

### Your agents remember your users

Each user gets a persistent memory that their agent can read and write to across conversations. A financial advisor agent remembers that a user is self-employed and has two children. A customer support agent remembers a user's previous orders and preferences. This is not conversation history — it is structured, persistent knowledge about individual people that survives across sessions. The agent gets better at helping someone the more they interact with it, without the user having to repeat themselves.

### Test, measure, and improve

You can clone any agent and run A/B experiments — compare two models, two sets of instructions, or two temperature settings against each other with traffic splitting. Built-in analytics show you which topics are most popular, which questions your agents could not answer well, and where your knowledge base has gaps. Evaluation sessions let you assess response quality systematically. Each completed session is scored by a separate judge model on three named metrics — faithfulness (do cited claims actually follow from the cited sources), groundedness (are claims traceable to retrieved evidence), and relevance (does the answer address the question) — with the per-message reasoning shown alongside each score so a domain expert can judge whether the judge itself was right. After a knowledge-base update or prompt change, re-score a past session to see whether quality moved. A per-agent quality trend chart visualises the three metrics over time. You are not guessing whether your agents are good enough — you have data.

### Connect to your existing systems

Workflows can run on cron schedules — automated, unattended, recurring. When things happen inside the platform, outbound webhooks and event hooks notify your other systems: Slack, email services, CRMs, monitoring tools. Delivery is tracked with retry on failure. Workflows can also call external APIs as a step type, so an agent can check inventory in your ERP, create a ticket in your helpdesk, or trigger a payment in your billing system. Self-service API keys with scoped permissions let partners or customers call specific agents programmatically without sharing admin credentials.

Cron-driven maintenance is non-blocking — the platform's tick endpoint acknowledges scheduled work as soon as it is claimed, so external schedulers with short HTTP timeouts can drive the platform reliably without orchestrating around long-running cleanup tasks.

### Portable between environments

Your entire agent configuration — agents, workflows, provider settings, capability definitions — can be exported as JSON and imported into another environment. Move from development to staging to production. Back up before a major change. Share configurations across teams. Import handles conflicts and reports success or failure per entity. Credentials are excluded from exports automatically.

### You can see what happened and why

Every configuration change is logged in an immutable audit trail — who changed what, when, and the before/after state. Agent instructions are versioned so you can see how a persona evolved over time. Costs are attributed per agent, per model, per day. Webhook deliveries have receipts. When something behaves unexpectedly, you have the data to understand why, not just the outcome.

---

## Who this is for

**Strong fit:** Teams building products where AI is one capability among many — customer support tools, internal platforms, SaaS products with intelligent features. Small teams that need to ship fast without assembling infrastructure from scratch. Organisations that need to self-host for data residency, compliance, or control. Entrepreneurs exploring AI-powered services who want a production-grade foundation, not a prototype they will have to rebuild. TypeScript and Next.js teams — the platform speaks their language natively.

**Less natural fit:** Pure AI research or rapid experimentation where a lightweight Python notebook is the right tool. Enterprises already deeply invested in a specific cloud provider's managed AI services. Teams whose primary need is breadth of pre-built integrations rather than depth of platform control.

---

## How it works

You configure agents in the admin dashboard — give them a persona, select an LLM model, attach the tools they can use, set a monthly budget, and load documents into their knowledge base. Those agents are immediately available through chat, the embed widget, or the API. The embed widget itself is brandable per agent — colours, fonts, header and footer copy, conversation-starter chips — so the same starter template can ship into a housing-association tenant portal, a broker microsite, and a council planning page without any of them looking like the same product. Non-technical team members can update agent instructions, manage knowledge documents, and monitor costs through the same dashboard without touching code.

For processes more complex than a conversation, you compose workflows: multi-step sequences with branching logic, parallel execution, error recovery, and human approval gates. Fifteen step types cover LLM calls, tool invocations, conditional routing, external API calls, knowledge retrieval, and more. A visual builder lets you design these as directed graphs; validation catches structural problems before you run anything. Eleven built-in workflow templates give you starting points for common patterns — customer support, content pipeline, research agent, conversational learning, citation-grounded knowledge advisor, scheduled source monitoring, and more — and a dry-run mode lets you test a workflow with mocked LLM calls before committing to real provider costs.

If you are not sure where to start, a built-in design patterns library covers 21 agentic patterns — routing, chaining, reflection, planning, multi-agent coordination, and more — with an interactive explorer and an advisor chatbot that recommends patterns based on your use case.

For vendor integrations — sending transactional email, charging customers, posting to a chat platform, creating a calendar event, rendering a PDF — Sunrise takes a deliberate stance: rather than bundling SDKs for every vendor, you get one sharpened generic outbound-HTTP capability plus a comprehensive recipes cookbook that documents how to wire it for each common pattern (with worked examples for two or three vendors per pattern). The trade-off versus a "thousand integrations" framework is honest: Sunrise stays dependency-light and version-stable; the integrations you actually wire up are documented end-to-end and unbiased to a specific vendor; anything not covered by a recipe is a documented short walk away via the capability builder.

The platform supports eight LLM provider types — Anthropic, OpenAI, Google, Mistral, Cohere, Voyage AI, Ollama, and any OpenAI-compatible endpoint. You can start with a local model for development, deploy with a commercial provider, and add fallbacks across vendors. Switching or adding providers does not require code changes.

---

## What you can build with this

Sunrise is designed for products where an AI agent needs to be more than a chatbot — where it needs to act, to know things, and to operate safely within defined boundaries.

A few patterns that the platform supports well: customer-facing assistants grounded in your documentation. Internal tools that automate multi-step processes with human oversight at critical points. Domain-expert agents that combine specialist knowledge with the ability to look up records, call APIs, and take actions. Embeddable advisors deployed on partner websites. Workflow automation where AI handles the judgment calls and humans handle the exceptions.

The `business-applications.md` companion document explores thirty concrete opportunities across ten categories — from planning application assistants to tenant rights advisors to garden planning companions — each with a realistic starting point and expansion path.

---

## Getting started

Sunrise is a Next.js 16 application. Clone the repository, configure environment variables for your LLM providers and database, run migrations, and start the dev server. A setup wizard walks through initial configuration — provider credentials, default model selection, basic safety settings. From there, you create your first agent in the admin dashboard and it is callable through the API within minutes. The codebase is TypeScript throughout — if you can read a Next.js application, you can read and modify Sunrise.

---

**Last updated:** 2026-05-03

For the full technical specification, see `functional-specification.md`. For competitive positioning and known gaps, see `maturity-analysis.md`. For concrete use cases and go-to-market examples, see `business-applications.md`.
