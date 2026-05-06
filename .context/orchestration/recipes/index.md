# Capability Recipes

Comprehensive worked examples for the most common shapes of agent integrations — transactional email, payments, chat notifications, calendar events, document rendering. Every recipe builds on the **`call_external_api` capability** + the orchestration HTTP module. **No vendor SDKs are bundled.**

Recipes are pattern-named (`payment-charge.md`), not vendor-named (`stripe.md`). Each recipe uses one or more vendors as worked illustrations but the structure generalises — a recipe for payment charging works whether you wire Stripe, Adyen, Mollie, or your in-house billing service.

## Why recipes instead of vendor capabilities

The original plan for "expanded built-in capability library" envisioned shipping `StripeCapability`, `PostmarkCapability`, `SlackCapability`, `GoogleCalendarCapability`, etc. We deliberately don't, for two reasons:

1. **Dependency bloat.** Each vendor SDK adds a transitive dependency tree, version-pin burden, and security surface. Sunrise is a starter template that downstream forks copy — extra deps compound the cost.
2. **Vendor lock-in by naming.** Naming a capability after a vendor ships a product opinion. Different forks pick different vendors for the same shape (Postmark vs SendGrid; Stripe vs Adyen; Google Calendar vs Microsoft Graph). The recipe shape is the durable contract; the vendor underneath is replaceable.

The trade-off — versus LangChain's "1000+ integrations" — is honest: Sunrise ships **one curated outbound-HTTP primitive plus documented patterns** for the integrations developers actually wire up. The `/orchestration-capability-builder` skill provides the same delivery mechanism developers would use to add anything not covered by a recipe.

## What every recipe covers

Each recipe follows the same 12-section template so they're scannable side-by-side:

1. **When to use this recipe** — what shape of problem this addresses
2. **What you ship** — deliverables (env vars, capability binding, agent assignment)
3. **Allowlist hosts** — exact `ORCHESTRATION_ALLOWED_HOSTS` entries to add per vendor variant
4. **Credential setup** — env var names + format per vendor
5. **Capability binding** — full JSON `customConfig` to attach to `AiAgentCapability`
6. **Agent prompt guidance** — what to add to the system instructions so the LLM reaches for the capability
7. **Worked example** — LLM tool-call args → HTTP request → response → final agent reply
8. **Vendor variants** — config diff for each illustrated vendor
9. **Common variants** — pagination, async polling, rate-limit handling specific to the pattern
10. **Anti-patterns** — what NOT to do (with reasons)
11. **Test plan** — how to verify the recipe works end-to-end
12. **Related** — cross-links to other recipes and core docs

## How to apply a recipe

1. **Add the host(s)** to `ORCHESTRATION_ALLOWED_HOSTS` in `.env.local` and your deployment env
2. **Set the credential env vars** named in the recipe — never put secret values in DB or capability config
3. **Bind the capability** to your target agent. Easiest path: admin UI → Agents → \[your agent] → Capabilities → enable `call_external_api` → paste the recipe's `customConfig` JSON. API path: `POST /api/v1/admin/orchestration/agents/{agentId}/capabilities` with `capabilityId` and `customConfig`
4. **Update the agent's system instructions** with the prompt guidance from the recipe
5. **Verify** in a chat with the agent — the recipe's test plan walks the e2e check

## Recipes

| Pattern                             | File                                               | Vendors illustrated                        |
| ----------------------------------- | -------------------------------------------------- | ------------------------------------------ |
| Send a transactional email          | [transactional-email.md](./transactional-email.md) | Postmark, SendGrid, Resend, AWS SES        |
| Charge / refund / capture a payment | [payment-charge.md](./payment-charge.md)           | Stripe-shaped, Adyen-shaped, Mollie-shaped |
| Post a message to a chat platform   | [chat-notification.md](./chat-notification.md)     | Slack, Discord, Microsoft Teams            |
| Create a calendar event             | [calendar-event.md](./calendar-event.md)           | Google Calendar, Microsoft Graph, CalDAV   |
| Render a PDF / HTML document        | [document-render.md](./document-render.md)         | DocRaptor, PDFShift, Gotenberg             |
| In-chat user approval before action | [in-chat-approval.md](./in-chat-approval.md)       | (none — uses `run_workflow` capability)    |

## When to write a new recipe

Write a recipe when:

- A pattern shows up in two or more pilot conversations / customer requests
- The integration requires non-obvious config (HMAC signing, OAuth refresh, idempotency, multi-step flows)
- A naïve implementation would silently misuse the API (e.g. payment without idempotency)

Don't write a recipe for:

- A one-off integration with a single vendor that nobody else has asked for — bind directly without documenting
- Something already covered by an existing recipe with a vendor variant — extend the existing recipe
- A pattern that would be better delivered as a dedicated capability class because it has stateful or multi-step semantics — use the `/orchestration-capability-builder` skill to make a proper capability instead

## Conventions

- **No vendor SDKs.** Recipes only ever use `call_external_api`. If a recipe needs something that's hard via raw HTTP, that's a signal the pattern wants a dedicated capability class, not a recipe
- **Pattern-named, not vendor-named.** The filename describes the shape of the problem; vendors appear inside as illustrations
- **Show the JSON.** Every recipe includes the full `customConfig` JSON developers can copy-paste — no "you'll figure out the rest" gaps
- **Spell out anti-patterns.** Each recipe ends with the mistakes that the test plan won't catch — secret leakage, missing idempotency on retries, etc.
- **Cross-link.** Recipes link to each other and to core docs so readers can navigate without bouncing back to this index

## Related Documentation

- [Capability Dispatcher](../capabilities.md) — how `call_external_api` fits into the dispatch pipeline
- [External Calls (workflow step)](../external-calls.md) — the `external_call` workflow step shares the same HTTP foundation; useful when you need outbound HTTP outside of an agent conversation
- [Orchestration Capability Builder skill](../../../.claude/skills/orchestration-capability-builder/SKILL.md) — for integrations that are too stateful or multi-step to fit a recipe
