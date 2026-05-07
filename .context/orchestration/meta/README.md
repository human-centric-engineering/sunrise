# Orchestration Meta — Specification & Analysis

Canonical reference set for the orchestration layer. These docs describe **what the system does**, **why** it was designed that way, **how it compares** to alternatives, and **where** it should run. They are deliberately separate from the day-to-day engineering docs in `.context/orchestration/*.md` (which describe individual modules) and from the admin landing page in `.context/admin/orchestration.md` (which orients an operator).

If you need to know "does Sunrise have X?" or "how many step types are there?" or "what was the rationale for Y?" — start here.

## Files

| File                                                                         | Audience                                          | Purpose                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`functional-specification.md`](./functional-specification.md)               | Engineers, product, anyone scoping work           | **Source of truth for what the system does.** Inventory of every capability, step type, capability, route group, schema model, and integration point. The doc to update when capabilities change.                      |
| [`architectural-decisions.md`](./architectural-decisions.md)                 | Engineers, technical leads, partners              | **Why we made the choices we did.** Each decision has a plain-language concept, the chosen option, the rejected alternatives with concrete reasons, and pointers to where it lives in the codebase.                    |
| [`maturity-analysis.md`](./maturity-analysis.md)                             | Technical leads, evaluators                       | **How Sunrise compares to 11 other platforms.** Capability matrices vs LangGraph, CrewAI, AutoGen, Bedrock, Foundry, Dify, Flowise, n8n, Haystack, OpenAI Agents SDK, Google ADK.                                      |
| [`improvement-priorities.md`](./improvement-priorities.md)                   | Engineering planners                              | **The actual roadmap.** Tier 1–4 prioritisation against the deployment profile Sunrise targets (single-tenant, single-instance, small teams), with status flags. Re-prioritised against `maturity`.                    |
| [`hosting-requirements.md`](./hosting-requirements.md)                       | Engineers, ops, anyone choosing a deployment host | **What it takes to run in production.** Terms-of-art glossary, runtime requirements, platform comparison (Vercel / Render / Railway / Docker / VPS), gotchas that bite first.                                          |
| [`business-applications.md`](./business-applications.md)                     | Product, founders, venture-studio teams           | **Real-world commercial opportunities.** Paradigm shifts, subcategories, and worked examples for where the agentic platform can be deployed to create value.                                                           |
| [`commercial-proposition.md`](./commercial-proposition.md)                   | Sales, partners, executive readers                | **What Sunrise offers, in prose.** Plain-English description of the platform's value without architectural detail — a starting point for non-technical conversations.                                                  |
| [`functional-robustness-test-plan.md`](./functional-robustness-test-plan.md) | QA, engineers running acceptance tests            | **Inventory of scenarios for end-to-end manual + automated validation.** Use / Abuse / Edge sub-sections per capability area, with four verification methods (Claude code-trace, Claude live-exec, manual, automated). |

## How these relate to the rest of the docs

| Question                                                       | Where to look                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| "What does the system do?"                                     | [`functional-specification.md`](./functional-specification.md)            |
| "Why was X chosen?"                                            | [`architectural-decisions.md`](./architectural-decisions.md)              |
| "How do I implement / use feature Y?"                          | `.context/orchestration/<topic>.md` (engineering docs, one per module)    |
| "How do I drive the admin UI?"                                 | `.context/admin/orchestration.md` and `.context/admin/orchestration-*.md` |
| "What are the architectural rules I follow when writing code?" | `.claude/docs/agent-orchestration.md`                                     |

The four anchor docs have distinct audiences and stay slim by linking here for inventory facts rather than restating them.
