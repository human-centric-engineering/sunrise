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
import type { WorkflowTemplate } from '@/prisma/seeds/data/templates/types';

// Sourced from the capability's Zod enum so the guard prompt cannot drift
// from the apply step's accepted field set. Quoted + backtick-wrapped so
// the LLM treats them as literal field names, not natural-language nouns
// (e.g. without quoting it interpreted `bestRole` as "best role" and
// rejected it as not-a-recognised-field — observed 2026-05-15).
const AUDITABLE_FIELDS_LIST = AUDITABLE_FIELDS.map((f) => `\`${f}\``).join(', ');

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
      // Tests: External HTTP call with bearer auth, response
      // transformation (jmespath), per-step error strategy override.
      // Optional enrichment — gracefully skipped if BRAVE_SEARCH_API_KEY
      // is not set or api.search.brave.com is not in
      // ORCHESTRATION_ALLOWED_HOSTS. Downstream prompts treat the
      // output as optional context.
      {
        id: 'search_provider_info',
        name: 'Search web for current provider model info',
        type: 'external_call',
        config: {
          url: 'https://api.search.brave.com/res/v1/web/search?q=AI+model+releases+updates+deprecations+{{load_models.output}}&count=5',
          method: 'GET',
          authType: 'bearer',
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
          prompt:
            '{{#if vars.__retryContext}}**Previous attempt failed schema validation.** Reason: {{vars.__retryContext.failureReason}} (attempt {{vars.__retryContext.attempt}} of {{vars.__retryContext.maxRetries}}). Re-evaluate the data, fix the specific issues identified above, and produce corrected output. Pay particular attention to enum values — they must match the allowed lists exactly.\n\n{{/if}}You are an AI model evaluation expert. Analyse the chat and completion model entries and propose corrections where the data appears inaccurate or outdated. Also identify any models that have been deprecated or discontinued by their provider.\n\nModel data:\n{{load_models.output}}\n\nRouting context (capability type):\n{{classify_models.output}}\n\nWeb search context (if available — may be null if search was skipped):\n{{search_provider_info.output}}\n\nFor each chat/completion model, evaluate:\n1. **Tier role** — Is the classification correct? (thinking, worker, infrastructure, control_plane, local_sovereign)\n2. **Reasoning depth** — Accurate? (very_high, high, medium, none)\n3. **Latency** — Correct categorisation? (very_fast, fast, medium)\n4. **Cost efficiency** — Still accurate? (very_high, high, medium, none)\n5. **Context length** — Current? (very_high, high, medium, n_a)\n6. **Tool use** — Correct? (strong, moderate, none)\n7. **Best role** — Still the right summary?\n8. **Description** — Accurate and current?\n9. **Deprecated/discontinued** — Has this model been deprecated, sunset, or replaced by a newer version from the same provider?\n\nRespond with a JSON object containing two arrays:\n\n1. "models" — models needing field changes:\n[\n  {\n    "model_id": "<id>",\n    "modelName": "<name>",\n    "providerSlug": "<provider>",\n    "changes": [\n      { "field": "<field_name>", "currentValue": "<current>", "proposedValue": "<proposed>", "reason": "<why>", "confidence": "high" | "medium" | "low" }\n    ],\n    "overallConfidence": "high" | "medium" | "low",\n    "reasoning": "<overall assessment>"\n  }\n]\n\n2. "deactivateModels" — models that should be removed from the active registry:\n[\n  { "modelId": "<id>", "reason": "Model deprecated by <provider> on <date> — replaced by <successor>" }\n]\n\nOnly include models that need changes or deactivation. If no deactivations are needed, use an empty array.\nRespond with ONLY the JSON object, no markdown fencing.',
          temperature: 0.2,
        },
        nextSteps: [{ targetStepId: 'validate_proposals' }],
      },
      {
        id: 'analyse_embedding',
        name: 'Analyse embedding models',
        type: 'llm_call',
        config: {
          prompt:
            '{{#if vars.__retryContext}}**Previous attempt failed schema validation.** Reason: {{vars.__retryContext.failureReason}} (attempt {{vars.__retryContext.attempt}} of {{vars.__retryContext.maxRetries}}). Re-evaluate the data, fix the specific issues identified above, and produce corrected output. Pay particular attention to enum values — they must match the allowed lists exactly.\n\n{{/if}}You are an AI model evaluation expert specialising in embedding models. Analyse the embedding model entries and propose corrections where the data appears inaccurate or outdated. Also identify any models that have been deprecated or discontinued by their provider.\n\nModel data:\n{{load_models.output}}\n\nRouting context (capability type):\n{{classify_models.output}}\n\nWeb search context (if available — may be null if search was skipped):\n{{search_provider_info.output}}\n\nFor each embedding model, evaluate:\n1. **Tier role** — Should be "embedding"\n2. **Dimensions** — Correct vector dimensions for this model?\n3. **Quality** — Accurate? (high, medium, budget)\n4. **Cost efficiency** — Still accurate? (very_high, high, medium, none)\n5. **Context length** — Current? (very_high, high, medium, n_a)\n6. **Best role** — Still the right summary?\n7. **Description** — Accurate and current?\n8. **Deprecated/discontinued** — Has this model been deprecated, sunset, or replaced by a newer version from the same provider?\n\nRespond with a JSON object containing two arrays:\n\n1. "models" — models needing field changes:\n[\n  {\n    "model_id": "<id>",\n    "modelName": "<name>",\n    "providerSlug": "<provider>",\n    "changes": [\n      { "field": "<field_name>", "currentValue": "<current>", "proposedValue": "<proposed>", "reason": "<why>", "confidence": "high" | "medium" | "low" }\n    ],\n    "overallConfidence": "high" | "medium" | "low",\n    "reasoning": "<overall assessment>"\n  }\n]\n\n2. "deactivateModels" — models that should be removed from the active registry:\n[\n  { "modelId": "<id>", "reason": "Model deprecated by <provider> on <date> — replaced by <successor>" }\n]\n\nOnly include models that need changes or deactivation. If no deactivations are needed, use an empty array.\nRespond with ONLY the JSON object, no markdown fencing.',
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
          message:
            '{{#if vars.__retryContext}}**Previous attempt failed schema validation.** Reason: {{vars.__retryContext.failureReason}} (attempt {{vars.__retryContext.attempt}} of {{vars.__retryContext.maxRetries}}). Re-evaluate and produce a corrected new-model proposal set. Pay particular attention to enum values — they must match the allowed lists exactly.\n\n{{/if}}You are an AI model landscape expert. Given the list of providers and their currently registered models, identify any recently released models that are NOT in the registry.\n\nCurrent model registry:\n{{load_models.output}}\n\nWeb search context (if available — may be null if search was skipped):\n{{search_provider_info.output}}\n\nFor each provider represented in the data, check if they have released new models that are missing from the registry. For each new model found, propose a complete entry with:\n- "name": Human-readable name (e.g. "Claude Opus 4")\n- "slug": Lowercase with hyphens only (e.g. "anthropic-claude-opus-4")\n- "providerSlug": Must match an existing provider slug from the registry\n- "modelId": The API model identifier (e.g. "claude-opus-4-20250514")\n- "description": Brief description of the model\'s purpose and strengths\n- "capabilities": array of one or more of: chat, reasoning, embedding, audio, image, moderation, vision, documents. Use these exact tokens — do not substitute synonyms (e.g. use "image" for image generation, "vision" for image input to a chat model; do not invent values like "multimodal" or "pdf")\n- "tierRole": one of: thinking, worker, infrastructure, control_plane, local_sovereign, embedding\n- "reasoningDepth": one of: very_high, high, medium, none\n- "latency": one of: very_fast, fast, medium\n- "costEfficiency": one of: very_high, high, medium, none\n- "contextLength": one of: very_high, high, medium, n_a\n- "toolUse": one of: strong, moderate, none\n- "bestRole": One-line summary of optimal use case\n- For embedding models also include: "dimensions" (integer), "quality" (high | medium | budget), "schemaCompatible" (boolean)\n\nRespond with a JSON object:\n{\n  "newModels": [...array of proposed models...],\n  "reasoning": "Summary of what was found and why these models should be added"\n}\n\nIf no new models are found, respond with { "newModels": [], "reasoning": "All known models are already registered" }.\n\nIMPORTANT: Only propose models you are confident exist. Do not fabricate model names or IDs.\nRespond with ONLY the JSON object, no markdown fencing.',
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
          rules: `Validate that all proposed changes, new model entries, and deactivation proposals use valid values:\n\n**Recognised \`field\` names (for changes only):**\nThe \`field\` value on each change MUST be one of: ${AUDITABLE_FIELDS_LIST}. Treat these as exact literal strings — do not interpret them semantically. Note that \`bestRole\` IS a recognised field (it is a free-text summary column on AiProviderModel, not an enum). Reject only changes whose \`field\` value is not present in the list above.\n\n**Enum fields (for changes and new models):**\n- tierRole must be one of: thinking, worker, infrastructure, control_plane, local_sovereign, embedding\n- reasoningDepth must be one of: very_high, high, medium, none\n- latency must be one of: very_fast, fast, medium\n- costEfficiency must be one of: very_high, high, medium, none\n- contextLength must be one of: very_high, high, medium, n_a\n- toolUse must be one of: strong, moderate, none\n- quality (embedding) must be one of: high, medium, budget\n- confidence must be one of: high, medium, low\n- capabilities must be an array whose elements are drawn from this exact set: chat, reasoning, embedding, audio, image, moderation, vision, documents. Reject any element not in this set (e.g. "multimodal", "pdf", "text" are not valid)\n- slug (for new models) must be lowercase alphanumeric with hyphens only\n\n**Free-text fields:**\n- bestRole and description accept any non-empty string — do not validate their content, only that they are present and non-empty.\n\nReject any proposed change that uses a value not in the above lists. For new model proposals, reject entries missing required fields (name, slug, providerSlug, modelId, description, capabilities, tierRole, bestRole).\n\n**Deactivation proposals:**\n- Each must have a non-empty modelId (string)\n- Each must have a non-empty reason (string) explaining why the model should be deactivated\n- Reject deactivation proposals without a clear reason\n\n{{#if vars.__retryContext}}Previous validation attempt failed: {{vars.__retryContext.failureReason}}. Fix the issues identified above and re-submit.{{/if}}`,
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
      {
        id: 'review_changes',
        name: 'Admin reviews proposed changes and new models',
        type: 'human_approval',
        config: {
          prompt:
            'Review the proposed provider model changes, new model additions, and deactivation proposals below.\n\n## Proposed Changes to Existing Models\n\nThe audit has analysed your model entries and suggests the following updates. For each proposed change you can:\n- **Accept** — the change will be applied to the model entry\n- **Reject** — the change will be skipped\n- **Modify** — adjust the proposed value before accepting\n\n{{refine_findings.output}}\n\n## Proposed New Models\n\nThe audit has identified the following new models from your providers that are not yet in the registry. For each new model you can:\n- **Accept** — the model will be added to the registry\n- **Reject** — the model will not be added\n- **Modify** — adjust the proposed values before accepting\n\n{{discover_new_models.output}}\n\n## Proposed Deactivations\n\nThe audit has identified models that appear to be deprecated or discontinued by their providers. Deactivation sets isActive=false (soft delete) — the model can be reactivated later if needed. For each deactivation you can:\n- **Accept** — the model will be deactivated\n- **Reject** — the model will remain active\n\nDeactivation proposals from chat model analysis:\n{{analyse_chat.output}}\n\nDeactivation proposals from embedding model analysis:\n{{analyse_embedding.output}}\n\nAudit quality score: {{score_audit.output}}\n\n## Approval Payload Format\n\nWhen you approve, your payload should contain all three top-level keys (use an empty array for any category with no entries):\n- **models** — array of { model_id, changes: [{ field, currentValue, proposedValue, reason, confidence }] } for updates to existing models\n- **newModels** — array of new model entries to add (from the discovery section above)\n- **deactivateModels** — array of { modelId, reason } for models to deactivate',
          timeoutMinutes: 1440,
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
      // halting. Terminal step — workflow ends after notification.
      // Also `errorStrategy: 'skip'` so a broken email channel cannot
      // mask the underlying validation-exhaustion signal: the trace
      // already records the guard's three failed attempts plus the
      // routing decision, and that's the authoritative diagnostic.
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
        },
        nextSteps: [],
      },
    ],
  },
};
