# Sunrise — Positioning

Short, punchy companion to `commercial-proposition.md`. Same truths, marketing register. Read this when you need to explain Sunrise to a non-technical reader, draft a sales email, or write a landing-page hero. For the full prose pitch, see `commercial-proposition.md`.

**Last updated:** 2026-05-09

---

## One-line pitch

Sunrise is a Next.js application with a production-grade agent orchestration engine baked in — you build apps that _have_ real AI capabilities, not apps that _call_ an AI API.

---

## Three-line pitch

Building an AI-powered product today is mostly assembly. You stitch together an orchestration framework, an admin UI, an API layer, auth, cost tracking, safety guards, deployment plumbing, and an embed widget — and that integration work outweighs the agent design itself. Sunrise ships the assembled stack so you start with a working product and customise it.

---

## Pitch a friend at the pub

It basically lets you build an app with built-in intelligence. You configure agents inside your app — give them a job, attach the tools they're allowed to use, set a budget, and decide which knowledge they can search. You can chain those agents into multi-step workflows, or let an orchestrator agent design its own workflow on the fly. Agents can call your APIs, search the web, read documents you upload, or expose a chat window so people can talk to your app from a website, WhatsApp, Slack, or an IDE.

The dashboard handles the boring stuff — logins, security, multi-LLM provider config, cost comparisons, A/B tests across agents and models. And because the codebase ships with a full documentation substrate written for AI coding tools, when you ask Claude Code or Cursor to build a feature, it follows the established rules and produces something production-ready, rather than flaky.

---

## For whom

- **Indie founders and small teams** shipping an AI-powered product who want to skip three months of plumbing.
- **Internal-tools teams** adding intelligent features (search, triage, summarisation, approvals) to existing systems.
- **Agencies and venture studios** running multiple client deployments where the same template is rebranded per project.
- **Self-hosters** with data-residency, compliance, or cost reasons to keep the stack on infrastructure they control.

Less of a fit: pure AI research, rapid Python notebook experimentation, or organisations already deeply committed to a hyperscaler's managed AI stack.

---

## Sunrise is / is not

| Sunrise is                                                                | Sunrise is not                               |
| ------------------------------------------------------------------------- | -------------------------------------------- |
| A full-stack Next.js app with agents baked in                             | A library you embed in someone else's app    |
| Self-hosted, single-tenant per deployment                                 | A managed SaaS you rent                      |
| Provider-agnostic across 8 LLM families                                   | Vendor-locked to OpenAI / AWS / Azure        |
| Citation-grounded and budget-capped by default                            | A chatbot toolkit or no-code platform        |
| An MCP server with audit logging                                          | A mobile or on-device privacy runtime        |
| A substrate that makes AI-assisted coding produce production-grade output | A Python framework or research notebook tool |
| Open source under MIT — fork it, change it, own it                        | A closed-source product you only consume     |

---

## Why this beats the alternatives

Code-first frameworks like LangGraph or CrewAI give you an orchestration engine — you still need to build auth, admin UI, API, consumer chat, deployment, and database management around it. Managed services like AWS Bedrock or Azure Foundry hide the engine but lock you to a cloud. OpenAI AgentKit ships a hosted builder but the runtime is OpenAI's, not yours.

Sunrise occupies the gap: the engine _and_ the surrounding application, self-hosted, vendor-portable, and shaped specifically for teams who code with AI assistants. The depth of that integration is the differentiator — and the `.context/` substrate that ships with it means hundreds of subsequent AI-generated edits stay coherent instead of degrading into drift.

---

## The bigger picture

Sunrise is open source under the MIT licence. Not as a marketing tactic — because the kind of agentic systems we want to see in the world need to be inspectable, forkable, and shaped by the people who'll use them, rather than rented from a handful of foundation-model vendors.

We're building toward an ecosystem of builders. Engineers and business-domain experts collaborating side by side to put genuinely useful intelligence into the places where it can do the most good — across the long tail of domains that won't make it into a hyperscaler's roadmap. That collaboration — between people who know the technology and people who know the work — is the part most agent platforms skip, and it's where the real value lives.

The motivation, said plainly: AI's most important work over the next decade isn't replacing people; it's giving small teams and individual practitioners the leverage to do work that matters, without conceding privacy, ownership, or judgement to a handful of vendors. The more beautiful world our hearts know is possible — that one — gets built faster when the substrate for it is open, owned, and shaped by the people doing the building.

Contributions, forks, partner deployments, and domain-expert partnerships are all welcome. The repo is the meeting point.

---

## Where next

- **`commercial-proposition.md`** — the full prose pitch (this doc's deeper sibling).
- **`business-applications.md`** — thirty concrete commercial use cases across ten verticals.
- **`maturity-analysis.md`** — competitive matrices vs LangGraph, CrewAI, Bedrock, AgentKit, and eight others.
- **`hosting-requirements.md`** — what it actually takes to deploy.
- **`functional-specification.md`** — the canonical inventory of every capability.
