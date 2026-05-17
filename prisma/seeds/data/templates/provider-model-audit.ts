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

import { AUDITABLE_FIELDS } from '@/lib/orchestration/capabilities/built-in/apply-audit-changes';
import {
  CAPABILITIES,
  CONFIDENCE,
  CONTEXT_LENGTH,
  COST_EFFICIENCY,
  DEPLOYMENT_PROFILES,
  LATENCY,
  QUALITY,
  REASONING_DEPTH,
  TIER_ROLES,
  TOOL_USE,
} from '@/lib/orchestration/model-audit/enums';
import type { WorkflowTemplate } from '@/prisma/seeds/data/templates/types';

// Enum specifications used by the validate_proposals guard. Embedded as a
// JSON block in the prompt rather than comma-separated prose because LLMs
// repeatedly mis-read prose lists in this guard — first dropping
// `bestRole` from the accepted-field set (2026-05-15) and later dropping
// `infrastructure` from `tierRole` (2026-05-16). JSON is harder to
// silently misparse; the guard prompt explicitly tells the model to
// re-read this block before judging each proposal.
//
// Sourced from `lib/orchestration/model-audit/enums.ts` so the guard,
// the structured approval UI's Select widgets, and the server-side
// per-field validation all stay in sync.
const ENUM_SPEC = {
  field: AUDITABLE_FIELDS,
  tierRole: TIER_ROLES,
  deploymentProfiles: DEPLOYMENT_PROFILES,
  reasoningDepth: REASONING_DEPTH,
  latency: LATENCY,
  costEfficiency: COST_EFFICIENCY,
  contextLength: CONTEXT_LENGTH,
  toolUse: TOOL_USE,
  quality: QUALITY,
  confidence: CONFIDENCE,
  capabilities: CAPABILITIES,
} as const;
const ENUM_SPEC_JSON = JSON.stringify(ENUM_SPEC, null, 2);

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
        type: 'agent_call',
        config: {
          agentSlug: 'provider-model-auditor',
          message: `{{#if vars.__retryContext}}**Previous attempt failed schema validation.** Reason: {{vars.__retryContext.failureReason}} (attempt {{vars.__retryContext.attempt}} of {{vars.__retryContext.maxRetries}}). Re-evaluate and produce a corrected new-model proposal set. Pay particular attention to enum values — they must match the allowed lists exactly, and every proposed model MUST carry a non-empty \`sources\` array.

{{/if}}You are an AI model landscape expert. Given the list of providers and their currently registered models, identify any recently released models that are NOT in the registry.

Current model registry:
{{load_models.output}}

${SEARCH_RESULTS_BLOCK}

${SOURCES_INSTRUCTIONS}

For each provider represented in the data, check if they have released new models that are missing from the registry. For each new model found, propose a complete entry with:
- "name": Human-readable name (e.g. "Claude Opus 4")
- "slug": Lowercase with hyphens only (e.g. "anthropic-claude-opus-4")
- "providerSlug": Must match an existing provider slug from the registry
- "modelId": The API model identifier (e.g. "claude-opus-4-20250514")
- "description": Brief description of the model's purpose and strengths
- "capabilities": array of one or more of: chat, reasoning, embedding, audio, image, moderation, vision, documents. Use these exact tokens — do not substitute synonyms (e.g. use "image" for image generation, "vision" for image input to a chat model; do not invent values like "multimodal" or "pdf")
- "tierRole": one of: thinking, worker, infrastructure, control_plane, embedding — what the model is FOR (capability tier)
- "deploymentProfiles": array of one or more of: hosted, sovereign — where the model RUNS. \`hosted\` for vendor-managed API (default); \`sovereign\` for self-hosted (Ollama, vLLM); both if available either way. NEVER omit this field.
- "reasoningDepth": one of: very_high, high, medium, none
- "latency": one of: very_fast, fast, medium
- "costEfficiency": one of: very_high, high, medium, none
- "contextLength": one of: very_high, high, medium, n_a
- "toolUse": one of: strong, moderate, none
- "bestRole": One-line summary of optimal use case
- For embedding models also include: "dimensions" (integer), "quality" (high | medium | budget), "schemaCompatible" (boolean)
- "sources": non-empty array per the contract above — every new-model proposal MUST attribute the claim that the model exists and that its capabilities/tier are correct.

Respond with a JSON object:
{
  "newModels": [...array of proposed models...],
  "reasoning": "Summary of what was found and why these models should be added"
}

If no new models are found, respond with { "newModels": [], "reasoning": "All known models are already registered" }.

IMPORTANT: Only propose models you are confident exist with attributable evidence. A model proposed solely from training knowledge with "low" confidence is acceptable to emit so the admin can verify; a model with NO source is not acceptable and will be rejected by the validator.
Respond with ONLY the JSON object, no markdown fencing.`,
          maxToolIterations: 5,
        },
        nextSteps: [{ targetStepId: 'validate_proposals' }],
      },

      // ─── Step 6: guard (Pattern 18 — Guardrails) ──────────────────
      // Tests: Safety/quality validation gate, LLM-mode rule checking,
      // failAction configuration, bounded retry on failure.
      {
        id: 'validate_proposals',
        name: 'Validate proposed values against schemas',
        type: 'guard',
        config: {
          rules: `You are a schema validator for AI-model-audit proposals. Validate every change, new-model entry, and deactivation proposal against the spec below.

## ENUM SPEC (authoritative list of valid values)

The arrays below ARE the entire universe of valid values for each field. RE-READ THIS BLOCK BEFORE JUDGING EACH PROPOSAL. Do not abridge, paraphrase, or omit any array entry. If a proposed value appears character-for-character in the corresponding array, it is valid. If it does not, it is invalid. There are no implicit synonyms.

\`\`\`json
${ENUM_SPEC_JSON}
\`\`\`

## VALIDATION RULES

1. For every \`change\` object: its \`field\` value MUST be exactly one of the strings in \`field\` above. Treat these as literal identifiers, not natural-language phrases — \`bestRole\` is a recognised field (it is a free-text summary column on AiProviderModel, NOT an enum). Reject the change only if \`field\` is not present in the array.

2. For every change AND every new-model entry, when a value is provided for one of these enum fields, it MUST appear in the corresponding spec array: \`tierRole\`, \`reasoningDepth\`, \`latency\`, \`costEfficiency\`, \`contextLength\`, \`toolUse\`, \`quality\`, \`confidence\`. Before judging, COUNT THE ENTRIES in the spec array and confirm the proposed value matches one of them by exact string comparison.

   **Specific values to NEVER let through.** \`tierRole\` is exactly the five values in the spec — \`thinking\`, \`worker\`, \`infrastructure\`, \`control_plane\`, \`embedding\`. Reject anything else, especially:
   - \`chat\` — that's a capability, not a tier role
   - \`local_sovereign\` — removed 2026-05-16; deployment locus lives in \`deploymentProfiles\` now
   - \`reasoning\`, \`vision\`, \`multimodal\` — capabilities, not tiers

3. \`capabilities\` is an ARRAY field — apply per-element membership, NOT array-equality. The rule is: for every \`element\` in the proposal's \`capabilities\` array, check that \`element\` appears in the \`capabilities\` spec array above. Do NOT check whether the array as a whole appears in the spec — the spec lists individual capability tokens, not arrays. Concretely:

   - \`capabilities: ["chat"]\` → PASS (the single element "chat" is in the spec).
   - \`capabilities: ["chat", "vision"]\` → PASS (both elements are in the spec).
   - \`capabilities: ["multimodal"]\` → FAIL (the element "multimodal" is not in the spec).
   - \`capabilities: []\` → FAIL only if a separate field rule requires non-empty.

   A previous validator run rejected \`capabilities: ["chat"]\` with the reason ' \`capabilities: ["chat"]\` is not in [...]' — that is the wrong check. The element "chat" IS in the spec; that array is valid.

4. \`deploymentProfiles\` (when present on a change or new-model entry) must be an array where every element appears in the \`deploymentProfiles\` spec array above (\`hosted\`, \`sovereign\`). Empty arrays are invalid — every model has at least one deployment locus.

5. \`bestRole\` and \`description\` are free-text; validate only that they are present and non-empty.

6. \`slug\` (on new model proposals) must match \`^[a-z0-9]+(-[a-z0-9]+)*$\`.

7. New-model entries must include: \`name\`, \`slug\`, \`providerSlug\`, \`modelId\`, \`description\`, \`capabilities\`, \`tierRole\`, \`deploymentProfiles\`, \`bestRole\`. Reject entries missing any of these.

8. Deactivation proposals must have a non-empty \`modelId\` and a non-empty \`reason\`. Reject otherwise.

9. **Provenance.** Every \`change\` object MUST have a non-empty \`sources\` array. Every \`newModels\` entry MUST have a non-empty \`sources\` array. Every \`deactivateModels\` entry MUST have a non-empty \`sources\` array. Each \`sources[i]\` must:
   - Have a \`source\` field equal to one of: \`training_knowledge\`, \`web_search\`, \`knowledge_base\`, \`prior_step\`, \`external_call\`, \`user_input\`.
   - Have a \`confidence\` field equal to one of: \`high\`, \`medium\`, \`low\`.
   - When \`source\` is \`web_search\`, \`knowledge_base\`, \`external_call\`, or \`prior_step\`: have a non-empty \`reference\` string (URL, chunk id, or step path).
   - When \`source\` is \`training_knowledge\`: \`confidence\` MUST be \`medium\` or \`low\` (never \`high\`).
   - \`snippet\` and \`note\` are optional but must be non-empty strings if present.

   Reject the proposal if its sources array is missing, empty, or any entry fails the above. Quote the offending proposal so the producer can attribute on retry.

10. **Rationale must engage with currentValue.** For every \`change\` object, the \`reason\` field MUST explicitly reference the \`currentValue\` (or the field whose value is changing). Generic framings that argue against an unrelated value are rejected. Concretely:
    - PASS: \`{ "field": "tierRole", "currentValue": "worker", "proposedValue": "thinking", "reason": "Worker tier is too low — this model's reasoning depth is very_high and it's used as a planner, which is the thinking-tier definition." }\` (engages with \`worker\` by name)
    - FAIL: \`{ "field": "tierRole", "currentValue": "worker", "proposedValue": "thinking", "reason": "This model is primarily a chat model, not an embedding model." }\` (irrelevant — current is \`worker\`, not embedding)
    - FAIL: \`{ "field": "deploymentProfiles", "currentValue": ["hosted"], "proposedValue": ["sovereign"], "reason": "This is an open-weight model." }\` (doesn't engage with why \`hosted\` is wrong — the model may also be hosted via vendor API)

    To pass, the reason string must either (a) literally contain the \`currentValue\` (as JSON-stringified text), or (b) explain why the field at its current value is incorrect for this model. Reject when the reason is generic, references unrelated framings, or fails to engage with the current value.

## WORKED EXAMPLES

- \`{ "field": "bestRole", "currentValue": "Lightweight worker", "proposedValue": "Planner / orchestrator", "reason": "Current 'Lightweight worker' undersells this model's reasoning capability...", "sources": [{ "source": "web_search", "confidence": "high", "reference": "https://example.com/", "note": "..." }] }\` → PASS.
- \`{ "name": "Claude Sonnet 5", "capabilities": ["chat"], "tierRole": "worker", "deploymentProfiles": ["hosted"], "sources": [{ "source": "web_search", "confidence": "high", "reference": "https://anthropic.com/news", "note": "..." }] }\` → PASS (capabilities is checked per-element; "chat" is in the spec).
- \`{ "name": "Multimodal Foo", "capabilities": ["chat", "multimodal"] }\` → FAIL (per-element check: "multimodal" is not in the capabilities spec).
- \`{ "field": "tierRole", "currentValue": "worker", "proposedValue": "thinking", "reason": "Worker tier mismatches the model's very_high reasoning depth...", "sources": [{ "source": "training_knowledge", "confidence": "medium", "note": "..." }] }\` → PASS.
- \`{ "field": "tierRole", "proposedValue": "edge", "sources": [...] }\` → FAIL (not in tierRole array).
- \`{ "field": "tierRole", "proposedValue": "chat", "sources": [...] }\` → FAIL (capability, not a tier role).
- \`{ "field": "tierRole", "proposedValue": "local_sovereign", "sources": [...] }\` → FAIL (\`local_sovereign\` was removed; use \`deploymentProfiles: ["sovereign"]\` instead).
- \`{ "field": "freshness", "proposedValue": "stale", "sources": [...] }\` → FAIL (\`freshness\` is not in the field array).
- \`{ "field": "tierRole", "proposedValue": "embedding" }\` (no sources) → FAIL (Rule 9: missing sources).
- \`{ "field": "tierRole", "proposedValue": "embedding", "sources": [{ "source": "training_knowledge", "confidence": "high" }] }\` → FAIL (Rule 9: training_knowledge cannot be \`high\` confidence).
- \`{ "field": "tierRole", "currentValue": "worker", "proposedValue": "thinking", "reason": "This is a chat model, not an embedding model.", "sources": [...] }\` → FAIL (Rule 10: reason references "embedding" but currentValue is "worker").

{{#if vars.__retryContext}}
## RETRY CONTEXT

A previous attempt failed validation: {{vars.__retryContext.failureReason}}. The producer is re-running. Apply the same checks; quote the exact spec entry alongside any rejection so the producer can fix the next attempt.
{{/if}}

For each rejection in your verdict, quote the exact array entry the proposal failed to match (e.g. \`tierRole: "edge" is not in ["thinking","worker","infrastructure","control_plane","embedding"]\`). This anchoring prevents you from omitting valid values by mistake.`,
          mode: 'llm',
          failAction: 'block',
          maxRetries: 2,
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
        type: 'evaluate',
        config: {
          rubric:
            'Score the audit findings on a 1-10 scale:\n\n- **Accuracy** (1-10): Are the proposed changes factually correct based on current model capabilities?\n- **Completeness** (1-10): Were all relevant fields evaluated? Were any obvious issues missed? Were new models identified where appropriate?\n- **Specificity** (1-10): Are the reasons for changes specific and actionable, not vague?\n- **Confidence calibration** (1-10): Do the confidence levels match the strength of evidence?\n- **Consistency** (1-10): Are similar models treated consistently (e.g., same-family models should have consistent tier roles)?',
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
        type: 'agent_call',
        config: {
          agentSlug: 'audit-report-writer',
          message:
            'Compile a consolidated, human-readable audit report from the following results.\n\n## Audit Scope\n{{load_models.output}}\n\n## Model Classification\n{{classify_models.output}}\n\n## Web Search Context\n{{search_provider_info.output}}\n\n## Chat Model Analysis\n{{analyse_chat.output}}\n\n## Embedding Model Analysis\n{{analyse_embedding.output}}\n\n## New Models Discovered\n{{discover_new_models.output}}\n\n## Validation Results\n{{validate_proposals.output}}\n\n## Reflection/Refinement\n{{refine_findings.output}}\n\n## Quality Score\n{{score_audit.output}}\n\n## Changes Applied\n{{apply_changes.output}}\n\n## New Models Added\n{{add_new_models.output}}\n\n## Models Deactivated\n{{deactivate_models.output}}\n\nWrite a structured report with these sections:\n1. **Executive Summary** — one paragraph overview of what was audited and key outcomes\n2. **Changes Applied** — table or list of field changes made, grouped by provider\n3. **New Models Added** — list of newly registered models with key attributes\n4. **Models Deactivated** — list of deactivated models with reasons\n5. **Quality Assessment** — summary of the audit quality scores\n6. **Recommendations** — any follow-up actions recommended (e.g. models needing manual review, providers to watch)\n\nUse clear formatting. Be specific — cite model names, providers, and field values.',
          maxToolIterations: 1,
        },
        nextSteps: [{ targetStepId: 'notify_complete' }],
      },

      // ─── Step 14: send_notification ───────────────────────────────
      // Tests: Email/webhook notification output, bodyTemplate
      // interpolation with step references.
      // NOTE: `to` is a placeholder — admins should edit this workflow
      // after seeding to set the correct notification recipient.
      // `errorStrategy: 'skip'` is deliberate — by this point the audit
      // changes have already been applied to the DB, so a notification
      // delivery failure (e.g. invalid email credentials) must not flip
      // the workflow's terminal status from COMPLETED to FAILED. The
      // failed attempt is still visible in the trace.
      {
        id: 'notify_complete',
        name: 'Notify audit completion',
        type: 'send_notification',
        config: {
          channel: 'email',
          to: 'admin@example.com',
          subject: 'Provider Model Audit Complete',
          bodyTemplate:
            'The provider model audit has completed.\n\n{{compile_report.output}}\n\n---\nView the full execution trace in the admin dashboard.',
          errorStrategy: 'skip',
        },
        nextSteps: [],
      },

      // ─── Exhaustion handler ───────────────────────────────────────
      // Reached when the validate_proposals guard exhausts its retry
      // budget. The engine looks for a sibling fail edge without
      // maxRetries (this one) and routes here instead of silently
      // halting. Terminal step — workflow ends with FAILED status after
      // notification because `terminalStatus: 'failed'` tells the engine
      // to set `errorMessage` from the interpolated body and emit
      // workflow_failed instead of workflow_completed.
      //
      // `errorStrategy: 'skip'` is still set so a broken email channel
      // cannot mask the underlying validation-exhaustion signal:
      // terminalStatus is honoured even on skip, so the workflow still
      // finalises as FAILED with the body as the reason.
      {
        id: 'report_validation_failure',
        name: 'Notify admin: validation exhausted',
        type: 'send_notification',
        config: {
          channel: 'email',
          to: 'admin@example.com',
          subject: 'Provider Model Audit — validation failed after retries',
          bodyTemplate:
            'The Provider Model Audit halted at the schema-validation gate after exhausting the retry budget.\n\nFinal validator output: {{validate_proposals.output}}\n\nNo changes were applied. Open the execution trace in the admin dashboard for the full proposal payload and retry timeline, then re-run the workflow after refining the analysis prompts or reviewing the offending proposals.',
          errorStrategy: 'skip',
          terminalStatus: 'failed',
        },
        nextSteps: [],
      },
    ],
  },
};
