# Implementation Checklist

Sequenced checklists for each complexity tier. Follow top-to-bottom — order matters.

## Simple Tier

- [ ] **Provider** — verify Anthropic provider exists (`GET /providers`)
- [ ] **Embedding provider** — create Voyage AI provider if using RAG
- [ ] **Agent** — create with Haiku/Sonnet, set `monthlyBudgetUsd`
- [ ] **Built-in capabilities** — bind `search_knowledge_base` if using RAG
- [ ] **Knowledge base** — upload documents, set categories
- [ ] **Embeddings** — generate (`POST /knowledge/embed`)
- [ ] **Agent scoping** — set `knowledgeCategories` on agent
- [ ] **Test** — verify via Test Chat tab
- [ ] Done — no workflow needed

## Moderate Tier

- [ ] **Provider** — verify exists
- [ ] **Embedding provider** — if using RAG
- [ ] **Agents** — create each with appropriate model/temperature
- [ ] **Custom capabilities — code**
  - [ ] TypeScript class in `lib/orchestration/capabilities/built-in/`
  - [ ] Zod schema + OpenAI function definition (semantically equivalent)
  - [ ] Register in `registry.ts`
- [ ] **Custom capabilities — DB**
  - [ ] Create `AiCapability` rows via API
  - [ ] Bind to agents via `POST /agents/{id}/capabilities`
- [ ] **Built-in capabilities** — bind as needed (don't recreate)
- [ ] **Knowledge base** — if using RAG: upload, embed, scope
- [ ] **Workflow**
  - [ ] Start from built-in template if possible
  - [ ] Customise steps and prompts
  - [ ] Set error strategies per-step
  - [ ] Set `budgetLimitUsd`
  - [ ] Validate (`validateWorkflow` + `semanticValidateWorkflow`)
- [ ] **Test** — agent Test Chat + workflow execution
- [ ] **Harden** — rate limits, approval gates on sensitive operations

## Complex Tier

- [ ] **Provider** — verify primary exists
- [ ] **Fallback provider** — create secondary for resilience
- [ ] **Embedding provider** — create for RAG
- [ ] **Agents** — create all (router, specialists, reviewer)
  - [ ] Model selection by role (Haiku for routing, Sonnet for work)
  - [ ] Temperature by task type
  - [ ] `monthlyBudgetUsd` per agent
  - [ ] `knowledgeCategories` scoping
- [ ] **Custom capabilities — code**
  - [ ] TypeScript classes (one per tool)
  - [ ] Zod schemas + function definitions
  - [ ] Registry entries
- [ ] **Custom capabilities — DB + bindings**
  - [ ] `AiCapability` rows
  - [ ] Agent bindings with `customRateLimit` where needed
  - [ ] `requiresApproval: true` for sensitive operations
- [ ] **Built-in capabilities** — bind to relevant agents
- [ ] **Knowledge base**
  - [ ] Upload documents with category structure
  - [ ] Generate embeddings
  - [ ] Verify search returns relevant results
- [ ] **Workflow**
  - [ ] Start from template
  - [ ] Add routing, approval gates, guard steps
  - [ ] Configure parallel branches
  - [ ] Set per-step error strategies
  - [ ] Set `budgetLimitUsd`
  - [ ] Validate both structural and semantic
- [ ] **Test**
  - [ ] Each agent individually via Test Chat
  - [ ] Workflow with representative inputs
  - [ ] Edge cases (empty input, long input, adversarial input)
  - [ ] Approval flow end-to-end
  - [ ] Budget enforcement (does it stop at limit?)
- [ ] **Production hardening**
  - [ ] Rate limits on all capabilities
  - [ ] Approval gates on write operations
  - [ ] Output guards on customer-facing responses
  - [ ] Fallback provider configured
  - [ ] Budget alerts configured
  - [ ] Monitoring dashboards checked
