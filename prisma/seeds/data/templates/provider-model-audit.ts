/**
 * Recipe 10: Provider Model Audit
 *
 * Patterns: Prompt Chaining (1) + Routing (2) + Parallelisation (3) +
 * Reflection (4) + Tool Use (5) + Multi-Agent Collaboration (7) +
 * Human-in-the-Loop (13) + Guardrails (18) + Evaluation (19).
 *
 * This template serves a dual purpose:
 *
 * 1. **Genuinely useful** — AI-powered evaluation of provider model
 *    entries for accuracy and freshness, plus discovery of new models
 *    released by providers. Proposes changes and additions for admin
 *    review via human-in-the-loop approval. Optionally enriches
 *    analysis with live web search results via external API call.
 *
 * 2. **Framework reference implementation** — exercises 11 of 15
 *    step types end-to-end, proving that the orchestration engine,
 *    approval queue, capability dispatch, agent delegation, external
 *    HTTP calls, budget enforcement, and SSE streaming all work
 *    together. FieldHelp annotations in the trigger UI explain which
 *    framework capability each step tests.
 *
 * Flow: load models from input → search web for current provider info
 * (optional enrichment, skipped if no API key) → route by model
 * capability type (chat vs embedding vs dual) → fan out parallel LLM
 * analysis per model + delegate new model discovery to the
 * provider-model-auditor agent → validate proposed changes against
 * enum schemas → refine findings via reflection loop → score
 * confidence against rubric → pause for human approval → apply
 * accepted changes via capability → add approved new models →
 * deactivate deprecated models → compile a consolidated report via
 * the audit-report-writer agent → notify admin with report.
 *
 * On validation failure the producers are retried up to twice with
 * the prior failure reason injected via {{vars.__retryContext}} so
 * each retry is informed by the last attempt's complaint. Once the
 * retry budget is exhausted the engine routes to a sibling fail
 * edge (no maxRetries) which sends a "validation failed after
 * retries" notification and terminates — never silently halting.
 *
 * Step types NOT exercised (by design — not relevant to this use case):
 * chain (layout marker), plan (runtime DAG generation),
 * rag_retrieve (KB has no model data), orchestrator (multi-agent
 * coordination).
 */

import type { WorkflowTemplate } from '@/prisma/seeds/data/templates/types';

// `validate_proposals` ran in LLM mode through 2026-05-19. It listed
// every enum from `lib/orchestration/model-audit/enums.ts` as a JSON
// block in its rules prompt, told the model to re-read the block
// before judging each proposal, and STILL hallucinated three times
// in five days (dropped `bestRole` from `field`, dropped
// `infrastructure` from `tierRole`, and rejected `vision` from
// `capabilities`). It now runs in schema mode against the
// `audit-proposals` Zod schema registered in
// `lib/orchestration/schemas/audit-proposals.ts`, which imports the
// enum constants directly — no prompt-embedding step, no drift.

// Provenance contract spelled out once and inlined into every producer
// prompt. The audit workflow injects {{search_provider_info.output}} as
// raw context but the model can ignore it and confabulate against
// training knowledge — that's how Qwen2.5-72B was being miscategorised
// as an embedding engine. Forcing attribution per claim, with explicit
// confidence-downgrade rules for training-only claims, turns "looks like
// an embedding model" into a checkable signal the admin can reject.
//
// The shape matches `lib/orchestration/provenance/types.ts` so the
// engine lifts `output.sources` onto each step's trace entry and the
// approval UI renders it as source pills. The guard step's Rule 8
// (below) enforces presence.
const SOURCES_INSTRUCTIONS = `
**Source attribution (REQUIRED on every change, every new model, every deactivation).**

Each proposal MUST carry a non-empty \`sources\` array. Each entry attributes the claim to one of:

- \`{ "source": "web_search", "confidence": "high" | "medium", "reference": "<URL from the numbered search result>", "snippet": "<≤200 chars from the result's description>", "note": "<one line: what the result said that supports the claim>" }\`
- \`{ "source": "training_knowledge", "confidence": "medium" | "low", "note": "<one line: why your prior knowledge supports the claim>" }\` — NEVER \`"high"\` for training-only claims, no exceptions. If you are inferring from a model's name pattern (e.g. assuming "Qwen2.5-72B" is an embedding model because of the size suffix), that is \`training_knowledge\` with \`"low"\` confidence and the note must say so explicitly.
- \`{ "source": "prior_step", "confidence": "high", "stepId": "load_models", "reference": "output.models[i].field", "note": "value already in the registry" }\` — for claims that come directly from the input data.

The change's own \`confidence\` field is the minimum confidence across its sources. If you have only a training-only "low" source, the change confidence is "low".

If you have NO source that supports a proposed change, DO NOT emit the change. Silence is preferable to confabulation.
`.trim();

// Pre-rendered helper: take the brave search transform output (an array
// of { title, url, description } or null) and produce a numbered block
// the LLM can cite by \`[N]\`. Lives in the prompt template via
// {{#each}}-style rendering — the LLM sees concrete numbered rows it can
// reference, mirroring the chat-citations [N] pattern.
const SEARCH_RESULTS_BLOCK = `
**Available web search results (cite each by [N] in your sources).** May be empty if the search step was skipped.

\`\`\`
{{search_provider_info.output}}
\`\`\`

When citing \`[N]\` set \`reference\` to the URL of result [N] and \`snippet\` to a ≤200-char excerpt from its description.
`.trim();

export const PROVIDER_MODEL_AUDIT_TEMPLATE: WorkflowTemplate = {
  slug: 'tpl-provider-model-audit',
  name: 'Provider Model Audit',
  shortDescription:
    'AI-powered evaluation of provider model entries for accuracy and freshness, plus new model discovery and deprecation detection. Exercises 11 step types as a framework reference implementation.',
  patterns: [
    { number: 1, name: 'Prompt Chaining' },
    { number: 2, name: 'Routing' },
    { number: 3, name: 'Parallelisation' },
    { number: 4, name: 'Reflection' },
    { number: 5, name: 'Tool Use' },
    { number: 7, name: 'Multi-Agent Collaboration' },
    { number: 13, name: 'Human-in-the-Loop' },
    { number: 18, name: 'Guardrails' },
    { number: 19, name: 'Evaluation' },
  ],
  flowSummary:
    'Load selected model entries → search the web for current provider model information (optional enrichment — skipped gracefully if no API key is configured) → route by capability type (chat/embedding/dual) so analysis prompts are tailored → fan out parallel LLM analysis per model + delegate new model discovery to the provider-model-auditor agent → validate proposed enum values against the schema → refine findings through a draft-critique-revise loop → score confidence against a quality rubric → pause for admin approval with a diff-style review → apply accepted changes via the apply_audit_changes capability → add approved new models via the add_provider_models capability → deactivate deprecated models via the deactivate_provider_models capability → compile a consolidated audit report via the audit-report-writer agent → send a notification with the report.',
  useCases: [
    {
      title: 'Quarterly provider registry review',
      scenario:
        'Run a full audit of all model entries to catch stale ratings, deprecated models, and missing new releases. The workflow evaluates each model against current provider data, proposes updates, and identifies new models to add.',
    },
    {
      title: 'Post-launch model assessment',
      scenario:
        'After a provider launches new models, audit the affected entries to ensure tier classification, cost efficiency ratings, and capability flags are accurate. The workflow also discovers and proposes the new releases for addition to the registry.',
    },
    {
      title: 'Framework integration validation',
      scenario:
        'Exercise 11 step types end-to-end to verify the orchestration engine, approval queue, capability dispatch, agent delegation, external HTTP calls, and budget enforcement all work together. Use as a smoke test after engine upgrades.',
    },
  ],
  workflowDefinition: {
    entryStepId: 'load_models',
    errorStrategy: 'retry',
    steps: [
      // ─── Step 1: llm_call (Pattern 1 — Prompt Chaining) ───────────
      // Tests: Basic LLM completion with structured JSON output,
      // template interpolation ({{input}}).
      {
        id: 'load_models',
        name: 'Parse input and load model data',
        description:
          'Parses the audit-trigger input into a structured model list (IDs, names, providers, current field values) that downstream analysis steps and the report writer consume.',
        type: 'llm_call',
        config: {
          prompt:
            'You are a data preparation assistant. Parse the following input and produce a structured JSON summary of the models to audit.\n\nInput:\n{{input}}\n\nRespond with a JSON object containing:\n- "modelIds": array of model IDs to audit\n- "modelCount": total number of models\n- "scope": "all" if auditing everything, "subset" if specific models were selected\n\nIf the input contains model data objects, extract the key fields (name, modelId, providerSlug, tierRole, capabilities, costEfficiency, reasoningDepth, latency, contextLength, toolUse, bestRole) for each model into a "models" array.\n\nRespond with ONLY the JSON object, no markdown fencing.',
          temperature: 0.1,
        },
        nextSteps: [{ targetStepId: 'search_provider_info' }],
      },

      // ─── Step 2: external_call ─────────────────────────────────────
      // Tests: External HTTP call with custom header auth, response
      // transformation (jmespath), per-step error strategy override.
      // Optional enrichment — gracefully skipped if BRAVE_SEARCH_API_KEY
      // is not set or api.search.brave.com is not in
      // ORCHESTRATION_ALLOWED_HOSTS. Downstream prompts treat the
      // output as optional context.
      //
      // Brave Search requires the API key in an `X-Subscription-Token`
      // header — NOT `Authorization: Bearer <key>`. Sending bearer auth
      // returns HTTP 422 with `{"loc":["header","x-subscription-token"],
      // "msg":"Field required"}`. Use `authType: 'api-key'` with the
      // `apiKeyHeaderName` override to match Brave's contract.
      {
        id: 'search_provider_info',
        name: 'Search web for current provider model info',
        description:
          'Single Brave Search call with a generic AI-news query. The five result URLs are injected into each analysis step as a numbered citation block so proposed changes can attribute to a URL rather than rely on training knowledge alone. Skipped silently when BRAVE_SEARCH_API_KEY is unset.',
        type: 'external_call',
        config: {
          // Static query — Brave caps the `q` param at 400 characters, and
          // interpolating `{{load_models.output}}` (a JSON dump of the parsed
          // model registry) blew straight past that limit with `HTTP 422 —
          // Search query must be at most 400 characters` (2026-05-16). The
          // downstream LLM steps already receive the full registry as
          // context; this call only needs to surface recent news, so a
          // generic search term is fine.
          url: 'https://api.search.brave.com/res/v1/web/search?q=AI+model+releases+updates+deprecations+2026&count=5',
          method: 'GET',
          authType: 'api-key',
          apiKeyHeaderName: 'X-Subscription-Token',
          authSecret: 'BRAVE_SEARCH_API_KEY',
          timeoutMs: 10000,
          maxResponseBytes: 524288,
          responseTransform: {
            type: 'jmespath' as const,
            expression: 'web.results[0:5].{title: title, url: url, description: description}',
          },
          errorStrategy: 'skip',
          // Downstream prompts treat `{{search_provider_info.output}}` as
          // optional context — a missing BRAVE_SEARCH_API_KEY or absent
          // allowlist entry is part of the happy path, not a failure. This
          // flag tells the trace viewer to render the skip in muted slate
          // styling so genuine failures stand out.
          expectedSkip: true,
        },
        nextSteps: [{ targetStepId: 'classify_models' }],
      },

      // ─── Step 3: route (Pattern 2 — Routing) ──────────────────────
      // Tests: LLM-driven classification branching, conditional edges,
      // template interpolation ({{load_models.output}}).
      // Note: All three routes converge on the same parallel step by
      // design. The classification output flows downstream via
      // {{classify_models.output}}, letting each analysis prompt tailor
      // its evaluation criteria to the model type.
      {
        id: 'classify_models',
        name: 'Route by model capability type',
        description:
          'LLM-driven routing pass that labels the audit batch as chat-only, embedding-only, or mixed so the parallel analysis stage runs the right prompts.',
        type: 'route',
        config: {
          classificationPrompt:
            'Classify the models being audited based on their primary capability type. Look at the model data:\n\n{{load_models.output}}\n\nClassify as:\n- "chat" if models are primarily chat/completion models\n- "embedding" if models are primarily embedding models\n- "mixed" if the set contains both chat and embedding models\n\nRespond with ONLY one of: chat, embedding, mixed',
          routes: [
            { label: 'chat', value: 'chat' },
            { label: 'embedding', value: 'embedding' },
            { label: 'mixed', value: 'mixed' },
          ],
        },
        nextSteps: [
          { targetStepId: 'audit_models', condition: 'chat' },
          { targetStepId: 'audit_models', condition: 'embedding' },
          { targetStepId: 'audit_models', condition: 'mixed' },
        ],
      },

      // ─── Step 4: parallel (Pattern 3 — Parallelisation) ───────────
      // Tests: Concurrent branch execution, fan-out across models,
      // independent error handling per branch, result merging.
      // All route branches converge here. Three parallel branches run
      // concurrently: chat analysis, embedding analysis, and new model
      // discovery (via agent delegation).
      {
        id: 'audit_models',
        name: 'Analyse models and discover new ones in parallel',
        description:
          'Parallel fan-out point — kicks off chat analysis, embedding analysis, and new-model discovery concurrently with a 120-second cap.',
        type: 'parallel',
        config: {
          branches: ['analyse_chat', 'analyse_embedding', 'discover_new_models'],
          stragglerStrategy: 'wait-all',
          timeoutMs: 120000,
        },
        nextSteps: [
          { targetStepId: 'analyse_chat' },
          { targetStepId: 'analyse_embedding' },
          { targetStepId: 'discover_new_models' },
        ],
      },
      {
        id: 'analyse_chat',
        name: 'Analyse chat/completion models',
        description:
          'Evaluates every chat/completion model in scope and proposes field-level changes (tier role, latency, cost-efficiency, context length, tool use, deployment profiles) with per-claim source attribution.',
        type: 'llm_call',
        config: {
          prompt: `{{#if vars.__retryContext}}**Previous attempt failed schema validation.** Reason: {{vars.__retryContext.failureReason}} (attempt {{vars.__retryContext.attempt}} of {{vars.__retryContext.maxRetries}}). Re-evaluate the data, fix the specific issues identified above, and produce corrected output. Pay particular attention to enum values — they must match the allowed lists exactly, every change MUST carry a non-empty \`sources\` array, and every change's \`reason\` MUST explicitly reference the model's current value.

{{/if}}You are an AI model evaluation expert. Analyse the chat and completion model entries and propose corrections where the data appears inaccurate or outdated. Also identify any models that have been deprecated or discontinued by their provider.

Model data:
{{load_models.output}}

Routing context (capability type):
{{classify_models.output}}

${SEARCH_RESULTS_BLOCK}

${SOURCES_INSTRUCTIONS}

**Two orthogonal classifications.** \`tierRole\` describes what the model is *for* (its capability tier); \`deploymentProfiles\` describes where it *runs*. These are independent — a model can be \`tierRole: 'thinking'\` AND \`deploymentProfiles: ['sovereign']\` simultaneously. Never propose a tier role change because a model "is a chat model" or "runs locally" — those are capability and deployment-locus facts, not tier signals.

For each chat/completion model, evaluate:
1. **Tier role** — what is the model FOR? (thinking, worker, infrastructure, control_plane)
   - \`thinking\` = expensive, sparse use; complex reasoning, planning, decomposition
   - \`worker\` = cheap parallel work; tool execution, summarisation, transformation
   - \`infrastructure\` = workhorse default for general chat
   - \`control_plane\` = routing, fallback, compliance gates
2. **Deployment profiles** — where does it RUN? Array of one or more: hosted, sovereign
   - \`hosted\` = vendor-managed API (default for Anthropic, OpenAI, Google, etc.)
   - \`sovereign\` = runs on the operator's own infrastructure (Ollama, vLLM, self-hosted)
   - A model can carry both if it's available via vendor API AND for self-hosting
3. **Reasoning depth** — Accurate? (very_high, high, medium, none)
4. **Latency** — Correct categorisation? (very_fast, fast, medium)
5. **Cost efficiency** — Still accurate? (very_high, high, medium, none)
6. **Context length** — Current? (very_high, high, medium, n_a)
7. **Tool use** — Correct? (strong, moderate, none)
8. **Best role** — Still the right summary?
9. **Description** — Accurate and current?
10. **Deprecated/discontinued** — Has this model been deprecated, sunset, or replaced by a newer version from the same provider?

**Rationale rule.** Every change's \`reason\` field MUST explicitly reference the model's \`currentValue\` for that field. "This is a chat model" is not a valid reason when the current tier is \`worker\` — explain why \`worker\` should change. Generic framings get rejected by the validator.

Respond with a JSON object containing two arrays:

1. "models" — models needing field changes:
[
  {
    "model_id": "<id>",
    "modelName": "<name>",
    "providerSlug": "<provider>",
    "changes": [
      {
        "field": "<field_name>",
        "currentValue": "<current>",
        "proposedValue": "<proposed>",
        "reason": "<one-line human summary>",
        "confidence": "high" | "medium" | "low",
        "sources": [ { "source": "...", "confidence": "...", "reference": "...", "snippet": "...", "note": "..." } ]
      }
    ],
    "overallConfidence": "high" | "medium" | "low",
    "reasoning": "<overall assessment>"
  }
]

2. "deactivateModels" — models that should be removed from the active registry:
[
  {
    "modelId": "<id>",
    "reason": "Model deprecated by <provider> on <date> — replaced by <successor>",
    "sources": [ { "source": "...", "confidence": "...", "reference": "...", "snippet": "...", "note": "..." } ]
  }
]

Only include models that need changes or deactivation. If no deactivations are needed, use an empty array.
Respond with ONLY the JSON object, no markdown fencing.`,
          temperature: 0.2,
        },
        nextSteps: [{ targetStepId: 'validate_proposals' }],
      },
      {
        id: 'analyse_embedding',
        name: 'Analyse embedding models',
        description:
          'Evaluates embedding models specifically — dimensions, quality tier, deployment profiles — and flags any that have been deprecated or superseded.',
        type: 'llm_call',
        config: {
          prompt: `{{#if vars.__retryContext}}**Previous attempt failed schema validation.** Reason: {{vars.__retryContext.failureReason}} (attempt {{vars.__retryContext.attempt}} of {{vars.__retryContext.maxRetries}}). Re-evaluate the data, fix the specific issues identified above, and produce corrected output. Pay particular attention to enum values — they must match the allowed lists exactly, every change MUST carry a non-empty \`sources\` array, and every change's \`reason\` MUST explicitly reference the model's current value.

{{/if}}You are an AI model evaluation expert specialising in embedding models. Analyse the embedding model entries and propose corrections where the data appears inaccurate or outdated. Also identify any models that have been deprecated or discontinued by their provider.

**In-scope models only.** A model belongs in this analysis when its capabilities array contains \`'embedding'\`. If you find a row whose capabilities do NOT include embedding (e.g. it's a chat/reasoning LLM that the router mis-classified), emit NO changes for it — the chat analyser handles it. Do not propose tier or capability edits to argue it isn't an embedding model; just skip it.

Model data:
{{load_models.output}}

Routing context (capability type):
{{classify_models.output}}

${SEARCH_RESULTS_BLOCK}

${SOURCES_INSTRUCTIONS}

For each in-scope embedding model, evaluate:
1. **Tier role** — Should be \`embedding\` (the dedicated tier for vector-embedding models)
2. **Deployment profiles** — where does it run? Array of one or more: hosted, sovereign
3. **Dimensions** — Correct vector dimensions for this model?
4. **Quality** — Accurate? (high, medium, budget)
5. **Cost efficiency** — Still accurate? (very_high, high, medium, none)
6. **Context length** — Current? (very_high, high, medium, n_a)
7. **Best role** — Still the right summary?
8. **Description** — Accurate and current?
9. **Deprecated/discontinued** — Has this model been deprecated, sunset, or replaced by a newer version from the same provider?

**Rationale rule.** Every change's \`reason\` field MUST explicitly reference the model's \`currentValue\` for that field. Generic framings get rejected by the validator.

Respond with a JSON object containing two arrays:

1. "models" — models needing field changes:
[
  {
    "model_id": "<id>",
    "modelName": "<name>",
    "providerSlug": "<provider>",
    "changes": [
      {
        "field": "<field_name>",
        "currentValue": "<current>",
        "proposedValue": "<proposed>",
        "reason": "<one-line human summary>",
        "confidence": "high" | "medium" | "low",
        "sources": [ { "source": "...", "confidence": "...", "reference": "...", "snippet": "...", "note": "..." } ]
      }
    ],
    "overallConfidence": "high" | "medium" | "low",
    "reasoning": "<overall assessment>"
  }
]

2. "deactivateModels" — models that should be removed from the active registry:
[
  {
    "modelId": "<id>",
    "reason": "Model deprecated by <provider> on <date> — replaced by <successor>",
    "sources": [ { "source": "...", "confidence": "...", "reference": "...", "snippet": "...", "note": "..." } ]
  }
]

Only include models that need changes or deactivation. If no deactivations are needed, use an empty array.
Respond with ONLY the JSON object, no markdown fencing.`,
          temperature: 0.2,
        },
        nextSteps: [{ targetStepId: 'validate_proposals' }],
      },

      // ─── Step 5b: agent_call (Pattern 7 — Multi-Agent Collaboration) ──
      // Tests: Agent delegation with tool access, agent slug lookup,
      // system prompt resolution, provider fallback, cost tracking
      // for delegated calls. Runs in parallel with analyse_chat and
      // analyse_embedding. Delegates to the provider-model-auditor
      // agent whose specialist system instructions guide evaluation.
      {
        id: 'discover_new_models',
        name: 'Identify new models from providers (agent)',
        description:
          'Delegates to the provider-model-auditor agent to scan for recently released models that are missing from the registry, proposing full new-model entries with capability tags and source attribution.',
        type: 'agent_call',
        config: {
          agentSlug: 'provider-model-auditor',
          message: `{{#if vars.__retryContext}}**Previous attempt failed schema validation.** Reason: {{vars.__retryContext.failureReason}} (attempt {{vars.__retryContext.attempt}} of {{vars.__retryContext.maxRetries}}). Re-evaluate and produce a corrected new-model proposal set. Pay particular attention to enum values — they must match the allowed lists exactly, and every proposed model MUST carry a non-empty \`sources\` array.

{{/if}}You are an AI model landscape expert. Your task is to identify models missing from the registry and propose complete entries for admin review.

## Output contract

Respond with ONLY this JSON object (no markdown fencing):

\`\`\`json
{
  "newModels": [...],
  "reasoning": "≤3 sentences summarising what was found and the strength of evidence."
}
\`\`\`

If nothing is missing, respond with \`{ "newModels": [], "reasoning": "All known models are already registered" }\`.

Each entry in \`newModels\`:
- \`name\`: Human-readable name (e.g. "Claude Sonnet 4.5")
- \`slug\`: Lowercase letters / digits / hyphens only, prefixed with the provider (e.g. "anthropic-claude-sonnet-4-5")
- \`providerSlug\`: Must match an existing provider slug from the registry
- \`modelId\`: API model identifier in **canonical short form** — the bare id the provider's API accepts, WITHOUT date suffixes. Match the format the registry already uses. Examples: \`claude-opus-4\` (NOT \`claude-opus-4-20250514\`), \`gpt-5\` (NOT \`gpt-5-2026-01-15\`), \`o3-mini\`.
- \`description\`: Brief — purpose and strengths in one sentence.
- \`capabilities\`: array of one or more of: \`chat\`, \`reasoning\`, \`embedding\`, \`audio\`, \`image\`, \`moderation\`, \`vision\`, \`documents\`. Use these exact tokens — do not invent values like \`multimodal\` or \`pdf\`. \`image\` = image generation; \`vision\` = image input to a chat model.
- \`tierRole\`: one of \`thinking\` / \`worker\` / \`infrastructure\` / \`control_plane\` / \`embedding\` (the model's capability tier).
- \`deploymentProfiles\`: array of one or more of \`hosted\` / \`sovereign\` (\`hosted\` for vendor API, \`sovereign\` for self-hosted like Ollama/vLLM; both if available either way). NEVER omit.
- \`reasoningDepth\`: \`very_high\` / \`high\` / \`medium\` / \`none\`
- \`latency\`: \`very_fast\` / \`fast\` / \`medium\`
- \`costEfficiency\`: \`very_high\` / \`high\` / \`medium\` / \`none\`
- \`contextLength\`: \`very_high\` / \`high\` / \`medium\` / \`n_a\`
- \`toolUse\`: \`strong\` / \`moderate\` / \`none\`
- \`bestRole\`: One-line summary of the optimal slot (≤8 words).
- For embedding models also include: \`dimensions\` (int), \`quality\` (\`high\` / \`medium\` / \`budget\`), \`schemaCompatible\` (bool).
- \`sources\`: non-empty array per the rules below.

${SOURCES_INSTRUCTIONS}

## Worked example

Suppose the registry contains only \`claude-sonnet-4\` (anthropic). Web search result [2] reads "Claude Sonnet 4.5 released October 2025" at https://anthropic.com/news/sonnet-4-5 with description "Anthropic announces Claude Sonnet 4.5, available via API from October 2025." A well-formed proposal looks like this:

\`\`\`json
{
  "name": "Claude Sonnet 4.5",
  "slug": "anthropic-claude-sonnet-4-5",
  "providerSlug": "anthropic",
  "modelId": "claude-sonnet-4-5",
  "description": "Anthropic's mid-tier 4.5-generation chat model, balancing reasoning quality and cost.",
  "capabilities": ["chat", "vision", "documents"],
  "tierRole": "infrastructure",
  "deploymentProfiles": ["hosted"],
  "reasoningDepth": "high",
  "latency": "medium",
  "costEfficiency": "high",
  "contextLength": "very_high",
  "toolUse": "strong",
  "bestRole": "General chat workhorse",
  "sources": [{
    "source": "web_search",
    "confidence": "high",
    "reference": "https://anthropic.com/news/sonnet-4-5",
    "snippet": "Anthropic announces Claude Sonnet 4.5, available via API from October 2025.",
    "note": "Result [2] announces the model's release."
  }]
}
\`\`\`

Note: \`modelId\` is the bare canonical form (\`claude-sonnet-4-5\`, not the dated release id); the source is \`web_search\` with a verifiable URL; confidence is \`high\` because it's a vendor announcement.

## Data

### Current model registry

\`\`\`json
{{load_models.output}}
\`\`\`

${SEARCH_RESULTS_BLOCK}

## Instruction

For each provider represented in the registry above, identify models that are **not present in the registry above** — "missing" is what matters, not "when released". Cross-reference web search results [N] when possible; a missing model with a \`web_search\` source is far stronger evidence than one with only \`training_knowledge\`.

Only propose models you can attribute. A proposal with only \`training_knowledge: "low"\` is acceptable so the admin can verify; a proposal with NO source will be rejected by the validator.`,
          maxToolIterations: 5,
        },
        nextSteps: [{ targetStepId: 'validate_proposals' }],
      },

      // ─── Step 6a: guard (Pattern 18 — Guardrails, schema mode) ────
      // Deterministic schema validation. Replaces the prior LLM-mode
      // validator that hallucinated on enum membership three times
      // in a week (rejected valid `capabilities: ["chat", "vision"]`
      // even with the spec pasted into the prompt as JSON). Runs the
      // `audit-proposals` Zod schema registered in
      // `lib/orchestration/schemas/audit-proposals.ts` against the
      // compound output of the three producer branches.
      //
      // Owns Rules 1–9 of the previous validator (field membership,
      // enum membership, array-element checks, sources presence /
      // shape / confidence caps, slug regex, required fields). Rule
      // 10 — "rationale engages with currentValue" — is genuinely
      // subjective and stays on the downstream `validate_rationale`
      // LLM guard.
      {
        id: 'validate_proposals',
        name: 'Validate proposed shape (deterministic schema)',
        description:
          'Runs the `audit-proposals` Zod schema against the combined output of the three producer branches. Catches enum-membership / required-field / source-shape issues deterministically — no LLM call, no hallucination surface. The retry edge sends a precise Zod-issue path back to the producer (which step + which field) so the next attempt can fix the exact problem.',
        type: 'guard',
        config: {
          mode: 'schema',
          schemaName: 'audit-proposals',
          inputStepIds: ['analyse_chat', 'analyse_embedding', 'discover_new_models'],
          failAction: 'block',
          maxRetries: 2,
        },
        nextSteps: [
          { targetStepId: 'validate_rationale', condition: 'pass' },
          { targetStepId: 'audit_models', condition: 'fail', maxRetries: 2 },
          { targetStepId: 'report_validation_failure', condition: 'fail' },
        ],
      },

      // ─── Step 6b: guard (Pattern 18 — Guardrails, LLM mode) ───────
      // The narrow LLM-judgement check that remains after the schema
      // gate ran above. By this point every proposal is structurally
      // well-formed; the LLM's only job is verifying that the change
      // `reason` text engages with the field's `currentValue` rather
      // than arguing against something unrelated. Rule 10 of the
      // previous monolithic validator, in isolation.
      {
        id: 'validate_rationale',
        name: 'Validate change rationales engage with currentValue',
        description:
          "LLM-mode check that every proposed change's `reason` references the field's `currentValue` (or otherwise explains why the current value is wrong). Generic framings get caught here. Only runs after the deterministic schema gate above passes — by this point every proposal is structurally valid, so the LLM only judges the prose.",
        type: 'guard',
        config: {
          rules: `You are a rationale checker for AI-model-audit proposals. The proposals below have already passed structural validation — every change has a valid field, valid enum values, and non-empty sources. Your job is narrow: verify that every \`change\` object's \`reason\` field engages with what is actually changing.

Proposal streams to check:

\`\`\`json
{{analyse_chat.output}}
\`\`\`

\`\`\`json
{{analyse_embedding.output}}
\`\`\`

**Empty proposal set is a valid outcome.** If \`models\` is empty in both streams, OR every \`models[*].changes\` array is empty, reply PASS — the upstream analysers reviewed the registry and found nothing worth changing, and there are no rationales to judge. Do NOT fail just because there is nothing to check.

For every change in \`models[*].changes[*]\` across both streams:

  - PASS if \`reason\` literally contains the JSON-stringified \`currentValue\` (e.g. when \`currentValue\` is "worker", the reason mentions "worker"), OR
  - PASS if \`reason\` explains why the field-at-its-current-value is wrong for this model.
  - FAIL if \`reason\` is generic, references unrelated framings, or doesn't engage with what's actually changing.

Worked examples:

- PASS: \`{ "field": "tierRole", "currentValue": "worker", "proposedValue": "thinking", "reason": "Worker tier is too low — this model's reasoning depth is very_high..." }\` (engages with "worker" by name)
- FAIL: \`{ "field": "tierRole", "currentValue": "worker", "proposedValue": "thinking", "reason": "This is a chat model, not an embedding model." }\` (irrelevant — currentValue is "worker", not "embedding")
- FAIL: \`{ "field": "deploymentProfiles", "currentValue": ["hosted"], "proposedValue": ["sovereign"], "reason": "This is an open-weight model." }\` (doesn't engage with why "hosted" is wrong)

Reply with exactly PASS or FAIL on the first line, then a brief reason on the second line. If FAIL, quote the offending change object so the producer can fix it on retry.

{{#if vars.__retryContext}}
RETRY CONTEXT: a previous attempt failed: {{vars.__retryContext.failureReason}}. Apply the same checks; quote the offending change for the next iteration.
{{/if}}`,
          mode: 'llm',
          failAction: 'block',
          maxRetries: 2,
          temperature: 0.1,
          // Override the default chat model (gpt-4o-mini) with gpt-5. The
          // smaller model confused the FAIL examples in the prompt with
          // real producer output and reported example text back as the
          // offending change — the retry context then asked the producer
          // to fix a change that didn't exist. gpt-5 is reliable enough
          // not to regurgitate few-shot example data as real input.
          modelOverride: 'gpt-5',
        },
        nextSteps: [
          { targetStepId: 'refine_findings', condition: 'pass' },
          { targetStepId: 'audit_models', condition: 'fail', maxRetries: 2 },
          { targetStepId: 'report_validation_failure', condition: 'fail' },
        ],
      },

      // ─── Step 7: reflect (Pattern 4 — Reflection) ─────────────────
      // Tests: Draft → critique → revise loop, maxIterations config,
      // iterative quality improvement.
      {
        id: 'refine_findings',
        name: 'Refine audit findings',
        description:
          'Draft-critique-revise loop that re-reads the proposals and tightens confidence levels, rationales, and consistency before they hit the approval queue.',
        type: 'reflect',
        config: {
          critiquePrompt:
            'Review the proposed model audit changes and new model proposals critically:\n\n1. Are any proposed changes based on outdated information about the model?\n2. Do the confidence levels accurately reflect certainty? High confidence should only be used for clear, verifiable facts.\n3. Are the reasons specific enough to help an admin understand why the change is proposed?\n4. Are there any contradictions between proposed changes for the same model?\n5. Should any "medium" confidence changes be downgraded to "low" if the evidence is circumstantial?\n6. For new model proposals: are the slugs, model IDs, and capability classifications plausible? Are there any duplicates of existing models under a different name?\n\nProvide specific, actionable feedback for each issue found.',
          maxIterations: 2,
        },
        nextSteps: [{ targetStepId: 'score_audit' }],
      },

      // ─── Step 8: evaluate (Pattern 19 — Evaluation) ───────────────
      // Tests: Quality scoring against rubric, scale configuration,
      // threshold-based gating.
      {
        id: 'score_audit',
        name: 'Score audit confidence and completeness',
        description:
          'Scores the refined proposal set against a 1–10 rubric covering accuracy, completeness, specificity, confidence calibration, and consistency.',
        type: 'evaluate',
        config: {
          rubric:
            'Evaluate the AI-model audit results below against a 1-10 rubric. The engine-supplied `Input:` block above is the workflow trigger payload and is unrelated to scoring — score the proposal streams included in this rubric instead.\n\nChat/completion model proposals:\n\n```json\n{{analyse_chat.output}}\n```\n\nEmbedding model proposals:\n\n```json\n{{analyse_embedding.output}}\n```\n\nNew model discoveries:\n\n```json\n{{discover_new_models.output}}\n```\n\n**Empty proposal set.** If `analyse_chat.models`, `analyse_chat.deactivateModels`, `analyse_embedding.models`, `analyse_embedding.deactivateModels`, AND `discover_new_models.newModels` are all empty arrays — i.e. the audit ran cleanly and the registry was already accurate — reply with `10` on the first line and explain on subsequent lines that no changes were needed. Do not penalise an audit for finding nothing; that is a valid and useful outcome.\n\nOtherwise, score on the following dimensions, ignoring any that are not applicable to what the audit produced:\n\n- **Accuracy** (1-10): Are the proposed changes factually correct based on current model capabilities? Are the deactivation reasons grounded in real provider announcements? Are the new-model discoveries real (correct slugs, providerSlugs, modelIds)?\n- **Completeness** (1-10): Did the analysers cover every relevant field on each model in scope? Were obvious issues missed? Were new models identified where appropriate?\n- **Specificity** (1-10): Are the `reason` fields specific and actionable, citing the model and field by name, rather than generic framings?\n- **Confidence calibration** (1-10): Do the `confidence` / `overallConfidence` levels match the strength of the cited sources? High confidence should only appear with clear, verifiable evidence.\n- **Consistency** (1-10): Are similar models treated consistently — e.g. same-family models with consistent tier roles, comparable embedding models with consistent deployment-profile assignments?\n\nReturn the aggregate score (mean of the dimensions you actually scored) on the first line as a single number. On subsequent lines, briefly explain how each dimension scored and which proposals drove the lowest scores.',
          scaleMin: 1,
          scaleMax: 10,
          threshold: 6,
        },
        nextSteps: [{ targetStepId: 'review_changes' }],
      },

      // ─── Step 9: human_approval (Pattern 13 — HITL) ───────────────
      // Tests: Execution pause via PausedForApproval exception, approval
      // queue, resume flow, approvalPayload forwarding.
      //
      // The `reviewSchema` drives the structured admin UI: three
      // sections projected from the upstream parallel branch outputs,
      // with per-change Accept / Reject / Modify. The short markdown
      // `prompt` is kept as a one-line summary for non-structured
      // surfaces (e.g. email notification bodies, the markdown
      // fallback when a section fails to parse). The full proposal
      // detail lives in the trace entry's upstream step outputs —
      // duplicating it into the prompt would be redundant and
      // confusing once the structured viewer renders.
      {
        id: 'review_changes',
        name: 'Admin reviews proposed changes and new models',
        description:
          'Pauses the workflow for admin review. Renders proposed field changes, new models, and deactivations as a per-row structured form with Accept / Reject / Modify and colour-coded source pills.',
        type: 'human_approval',
        config: {
          prompt:
            "Review the proposed provider model audit results.\n\nThe audit produced field changes for existing models, new model proposals, and deactivation proposals — all visible in the structured viewer below. Audit quality score: {{score_audit.output}}.\n\nDecide per-change:\n- **Accept** — apply the change (default)\n- **Reject** — skip this change\n- **Modify** — edit the proposed value before accepting\n\nReject any change whose evidence looks thin or whose `currentValue` doesn't match what the audit saw (the registry may have moved on since the audit started).",
          timeoutMinutes: 1440,
          reviewSchema: {
            sections: [
              {
                id: 'models',
                title: 'Proposed changes to existing models',
                description:
                  'Per-field updates the audit suggests. Each row has the field, the registry value, and the proposed value.',
                source:
                  '__merge__:{{analyse_chat.output.models}},{{analyse_embedding.output.models}}',
                itemKey: 'model_id',
                itemTitle: '{{item.modelName}} ({{item.providerSlug}})',
                itemBadges: [{ key: 'overallConfidence', label: 'confidence' }],
                subItems: {
                  source: 'item.changes',
                  itemKey: 'field',
                  fields: [
                    { key: 'field', label: 'Field', display: 'text', readonly: true },
                    {
                      key: 'currentValue',
                      label: 'Current',
                      display: 'text',
                      readonly: true,
                    },
                    {
                      key: 'proposedValue',
                      label: 'Proposed',
                      display: 'text',
                      editable: true,
                      // Per-field enum lookup: the Select shows the
                      // values valid for the row's `field` cell
                      // (tierRole → TIER_ROLES, latency → LATENCY,
                      // etc.). Free-text fields like `bestRole` fall
                      // through to a text input.
                      enumValuesByFieldKey: 'field',
                    },
                    { key: 'confidence', label: 'Confidence', display: 'badge' },
                    { key: 'reason', label: 'Reason', display: 'text', readonly: true },
                    // Source pills rendered by the `sources` display.
                    // Hover/focus pops the per-pill detail (URL / snippet
                    // / note). Lets admins distinguish a change backed by
                    // a real Brave result from a training-knowledge
                    // confabulation at a glance.
                    { key: 'sources', label: 'Sources', display: 'sources', readonly: true },
                  ],
                },
              },
              {
                id: 'newModels',
                title: 'Proposed new models',
                description:
                  'Models discovered from your providers that are not yet in the registry.',
                source: '{{discover_new_models.output.newModels}}',
                itemKey: 'slug',
                itemTitle: '{{item.name}} ({{item.providerSlug}})',
                fields: [
                  { key: 'modelId', label: 'Model ID', display: 'text', readonly: true },
                  { key: 'description', label: 'Description', display: 'textarea', editable: true },
                  // Capabilities is a string array; multi-select editing
                  // is out of scope for Phase 3 — admin can reject the
                  // whole model if capabilities are wrong.
                  { key: 'capabilities', label: 'Capabilities', display: 'pre', readonly: true },
                  {
                    key: 'tierRole',
                    label: 'Tier role',
                    display: 'badge',
                    editable: true,
                    enumValuesFrom: 'TIER_ROLES',
                  },
                  // Multi-value array — UI renders as `pre` for now; multi-select
                  // editing is out of scope. Admin rejects the whole model if
                  // the deployment profile is wrong.
                  {
                    key: 'deploymentProfiles',
                    label: 'Deployment',
                    display: 'pre',
                    readonly: true,
                  },
                  {
                    key: 'reasoningDepth',
                    label: 'Reasoning depth',
                    display: 'badge',
                    editable: true,
                    enumValuesFrom: 'REASONING_DEPTH',
                  },
                  {
                    key: 'latency',
                    label: 'Latency',
                    display: 'badge',
                    editable: true,
                    enumValuesFrom: 'LATENCY',
                  },
                  {
                    key: 'costEfficiency',
                    label: 'Cost efficiency',
                    display: 'badge',
                    editable: true,
                    enumValuesFrom: 'COST_EFFICIENCY',
                  },
                  {
                    key: 'contextLength',
                    label: 'Context length',
                    display: 'badge',
                    editable: true,
                    enumValuesFrom: 'CONTEXT_LENGTH',
                  },
                  {
                    key: 'toolUse',
                    label: 'Tool use',
                    display: 'badge',
                    editable: true,
                    enumValuesFrom: 'TOOL_USE',
                  },
                  { key: 'bestRole', label: 'Best role', display: 'text', editable: true },
                  // Same pill renderer as the changes section — the admin
                  // sees `[training · low]` vs `[web · provider.com]` and
                  // can spot un-grounded proposals before approving.
                  { key: 'sources', label: 'Sources', display: 'sources', readonly: true },
                ],
              },
              {
                id: 'deactivateModels',
                title: 'Proposed deactivations',
                description:
                  'Models the audit flagged as deprecated or discontinued. Soft-delete only — they can be reactivated later.',
                source:
                  '__merge__:{{analyse_chat.output.deactivateModels}},{{analyse_embedding.output.deactivateModels}}',
                itemKey: 'modelId',
                itemTitle: '{{item.modelId}}',
                fields: [
                  { key: 'reason', label: 'Reason', display: 'text', readonly: true },
                  { key: 'sources', label: 'Sources', display: 'sources', readonly: true },
                ],
              },
            ],
          },
        },
        nextSteps: [{ targetStepId: 'apply_changes' }],
      },

      // ─── Step 10: tool_call (Pattern 5 — Tool Use) ────────────────
      // Tests: Capability dispatch pipeline (Zod validation → binding
      // check → rate limit → execute → cost log), the
      // apply_audit_changes capability specifically.
      {
        id: 'apply_changes',
        name: 'Apply accepted changes',
        description:
          'Writes accepted field changes back to the AiProviderModel rows via the apply_audit_changes capability.',
        type: 'tool_call',
        config: {
          capabilitySlug: 'apply_audit_changes',
          argsFrom: 'review_changes',
        },
        nextSteps: [{ targetStepId: 'add_new_models' }],
      },

      // ─── Step 11: tool_call (Add New Models) ──────────────────────
      // Applies the second capability — creating approved new model
      // entries. Runs sequentially after apply_changes so both
      // capabilities share the same approval payload.
      {
        id: 'add_new_models',
        name: 'Add approved new models',
        description:
          'Creates the approved new model entries via the add_provider_models capability.',
        type: 'tool_call',
        config: {
          capabilitySlug: 'add_provider_models',
          argsFrom: 'review_changes',
        },
        nextSteps: [{ targetStepId: 'deactivate_models' }],
      },

      // ─── Step 12: tool_call (Deactivate Deprecated Models) ───────
      // Applies the third capability — soft-deleting models that the
      // audit identified as deprecated or discontinued. Uses the same
      // approval payload as the other tool_call steps.
      {
        id: 'deactivate_models',
        name: 'Deactivate deprecated models',
        description:
          'Soft-deletes deprecated models via the deactivate_provider_models capability. Reactivation is possible later.',
        type: 'tool_call',
        config: {
          capabilitySlug: 'deactivate_provider_models',
          argsFrom: 'review_changes',
        },
        nextSteps: [{ targetStepId: 'compile_report' }],
      },

      // ─── Step 13: agent_call (Pattern 8 — Agent Delegation) ──────
      // Tests: Agent delegation with zero tools, agent slug lookup,
      // system prompt resolution, cost tracking. The audit-report-writer
      // agent synthesises all step outputs into a human-readable
      // executive summary.
      {
        id: 'compile_report',
        name: 'Compile consolidated audit report',
        description:
          'Delegates to the audit-report-writer agent to synthesise an executive-summary narrative report from every preceding step output.',
        type: 'agent_call',
        config: {
          agentSlug: 'audit-report-writer',
          message:
            'Compile a consolidated, human-readable audit report from the following results.\n\n## Audit Scope\n{{load_models.output}}\n\n## Model Classification\n{{classify_models.output}}\n\n## Web Search Context\n{{search_provider_info.output}}\n\n## Chat Model Analysis\n{{analyse_chat.output}}\n\n## Embedding Model Analysis\n{{analyse_embedding.output}}\n\n## New Models Discovered\n{{discover_new_models.output}}\n\n## Validation Results\n{{validate_proposals.output}}\n\n## Reflection/Refinement\n{{refine_findings.output}}\n\n## Quality Score\n{{score_audit.output}}\n\n## Changes Applied\n{{apply_changes.output}}\n\n## New Models Added\n{{add_new_models.output}}\n\n## Models Deactivated\n{{deactivate_models.output}}\n\nWrite a structured report with these sections:\n1. **Executive Summary** — one paragraph overview of what was audited and key outcomes\n2. **Changes Applied** — table or list of field changes made, grouped by provider\n3. **New Models Added** — list of newly registered models with key attributes\n4. **Models Deactivated** — list of deactivated models with reasons\n5. **Quality Assessment** — summary of the audit quality scores\n6. **Recommendations** — any follow-up actions recommended (e.g. models needing manual review, providers to watch)\n\nUse clear formatting. Be specific — cite model names, providers, and field values.',
          maxToolIterations: 1,
        },
        nextSteps: [{ targetStepId: 'supervisor_review' }],
      },

      // ─── Step 14: supervisor (neutral post-hoc audit) ────────────
      // The audit's primary value prop is honest assessment of its own
      // work. compile_report is written by an agent that has the same
      // model lineage as the proposal-generating steps — that's marking
      // your own homework. supervisor_review takes the full trace and
      // produces an independent calibrated verdict using a separate
      // judge model (EVALUATION_JUDGE_MODEL).
      //
      // Run-time toggle: when the operator unchecks "Run neutral
      // supervisor review" in the audit dialog, inputData.__runSupervisor
      // is set to false and this step short-circuits with expectedSkip.
      // The notification template handles the missing verdict gracefully.
      //
      // failOnVerdict: 'never' — the supervisor is advisory, not a gate.
      // By the time it runs, capability dispatches have already mutated
      // the DB. A fail verdict surfaces in the notification and on the
      // execution detail page so the operator can react; it does not
      // terminate the workflow.
      {
        id: 'supervisor_review',
        name: 'Neutral supervisor review',
        description:
          'Independent judge model audits the full execution and produces a calibrated verdict (Pass / Concerns / Fail) plus a 0.00–1.00 score. Advisory only — does not gate the workflow. Can be turned off per-run from the trigger dialog.',
        type: 'supervisor',
        config: {
          assessmentCriteria:
            'Audit success means: (1) every proposed change cites a defensible source — web search, training knowledge with explicit confidence, or a prior step output; (2) the validator passed only proposals consistent with their cited evidence; (3) approved capability dispatches actually mutated the database (apply_changes / add_new_models / deactivate_models report nonzero counts when proposals existed); (4) the compiled report does not contradict the trace; (5) the audit explored every model in scope rather than silently dropping any.',
          redTeamPrompts: [
            'Did any proposal change a field without a corresponding source?',
            'Did the validator pass a proposal that contradicts an earlier step output?',
            'Did apply_changes / add_new_models / deactivate_models report zero changes despite proposals being approved?',
            'Was a model family proposed inconsistently (e.g. Sonnet upgraded but Haiku not assessed)?',
            'Did refine_findings revise a proposal in a way that weakened its source evidence?',
            'Did discover_new_models propose duplicates of existing registry entries?',
            'Did the human approval payload accept a proposal whose sources are flagged "training_knowledge" with confidence below "high"?',
          ],
          requireEvidenceCitations: true,
          minWeaknesses: 1,
          useJudgeModel: true,
          temperature: 0.2,
          failOnVerdict: 'never',
          includeStepOutputs: 'auto',
          defaultEnabled: true,
          respectRuntimeOptOut: true,
          // skip on error so a flaky judge model can't flip a successful
          // audit to FAILED. The supervisor's job is to add signal, not
          // gate the workflow.
          errorStrategy: 'skip',
          expectedSkip: false,
        },
        nextSteps: [{ targetStepId: 'report_render' }],
      },

      // ─── Step 15: report (Markdown render for email body) ─────────
      // No LLM. Walks the trace and renders a structured Markdown
      // report — header, supervisor verdict block (when present),
      // per-step timeline with inputs/outputs/duration/cost, footer.
      // Output lives on `report_render.output.markdown` so the
      // downstream notification interpolates it into the email body.
      //
      // NOTE: this step is NOT what makes the downloadable report
      // available. `GET /executions/:id/report.md` renders the report
      // on-demand from the persisted trace and works whether this step
      // ran or not. The sole job of this step is to embed the report
      // into the notification email body via
      // `{{report_render.output.markdown}}`.
      //
      // Run-time toggle: when inputData.__generateReport is false,
      // this step short-circuits with expectedSkip. The notification
      // template handles the missing value gracefully (the markdown
      // section reads as empty); the downloadable report endpoint is
      // unaffected.
      {
        id: 'report_render',
        name: 'Prepare report for email',
        description:
          'Walks the trace and renders a deterministic Markdown report — step-by-step inputs, outputs, durations, costs — for embedding into the notification email. Can be turned off per-run.',
        type: 'report',
        config: {
          format: 'markdown',
          includeStepOutputs: 'auto',
          defaultEnabled: true,
          respectRuntimeOptOut: true,
          errorStrategy: 'skip',
        },
        nextSteps: [{ targetStepId: 'notify_complete' }],
      },

      // ─── Step 16: send_notification ───────────────────────────────
      // Tests: Email/webhook notification output, bodyTemplate
      // interpolation with step references.
      // NOTE: `to` is a placeholder — admins should edit this workflow
      // after seeding to set the correct notification recipient.
      // `errorStrategy: 'skip'` is deliberate — by this point the audit
      // changes have already been applied to the DB, so a notification
      // delivery failure (e.g. invalid email credentials) must not flip
      // the workflow's terminal status from COMPLETED to FAILED. The
      // failed attempt is still visible in the trace.
      //
      // bodyTemplate leads with the supervisor's verdict so the email
      // recipient sees the honest assessment before the (potentially
      // optimistic) compile_report narrative. When the supervisor was
      // skipped (run-time opt-out or skip-on-error), the
      // supervisor_review.output fields resolve to empty strings and
      // the section reads as "(supervisor was skipped)" — graceful.
      {
        id: 'notify_complete',
        name: 'Notify audit completion',
        description:
          'Emails the configured recipient with the supervisor verdict, the agent-authored narrative, and the structured Markdown report.',
        type: 'send_notification',
        config: {
          channel: 'email',
          to: 'admin@example.com',
          subject: 'Provider Model Audit Complete',
          bodyTemplate:
            'The provider model audit has completed.\n\n## NEUTRAL SUPERVISOR ASSESSMENT\n\nVerdict: {{supervisor_review.output.verdict}} (score {{supervisor_review.output.score}})\n\n{{supervisor_review.output.summary}}\n\n### Top weaknesses\n{{supervisor_review.output.weaknesses}}\n\n### Areas the supervisor could not verify\n{{supervisor_review.output.unverifiedAreas}}\n\n---\n\n## NARRATIVE REPORT (agent-authored)\n\n{{compile_report.output}}\n\n---\n\n## STRUCTURED REPORT (deterministic step-by-step)\n\n{{report_render.output.markdown}}\n\n---\nView the full execution trace in the admin dashboard.',
          errorStrategy: 'skip',
        },
        nextSteps: [],
      },

      // ─── Exhaustion handler ───────────────────────────────────────
      // Reached when either validation guard (`validate_proposals`
      // schema-mode, `validate_rationale` LLM-mode) exhausts its
      // retry budget. The engine looks for a sibling fail edge
      // without maxRetries (this one) and routes here instead of
      // silently halting. Terminal step — workflow ends with FAILED
      // status after notification because `terminalStatus: 'failed'`
      // tells the engine to set `errorMessage` from the interpolated
      // body and emit workflow_failed instead of workflow_completed.
      //
      // `errorStrategy: 'skip'` is still set so a broken email channel
      // cannot mask the underlying validation-exhaustion signal:
      // terminalStatus is honoured even on skip, so the workflow still
      // finalises as FAILED with the body as the reason.
      {
        id: 'report_validation_failure',
        name: 'Notify admin: validation exhausted',
        description:
          'Terminal failure path. Reached when either the schema-mode `validate_proposals` guard or the LLM-mode `validate_rationale` guard exhausts its retry budget. Emails the admin with the last validator output and marks the execution FAILED.',
        type: 'send_notification',
        config: {
          channel: 'email',
          to: 'admin@example.com',
          subject: 'Provider Model Audit — validation failed after retries',
          bodyTemplate:
            'The Provider Model Audit halted at a validation gate after exhausting the retry budget.\n\nSchema validator output: {{validate_proposals.output}}\n\nRationale validator output: {{validate_rationale.output}}\n\nNo changes were applied. Open the execution trace in the admin dashboard for the full proposal payload and retry timeline, then re-run the workflow after refining the analysis prompts or reviewing the offending proposals.',
          errorStrategy: 'skip',
          terminalStatus: 'failed',
        },
        nextSteps: [],
      },
    ],
  },
};
