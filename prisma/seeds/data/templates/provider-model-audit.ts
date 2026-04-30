/**
 * Recipe 10: Provider Model Audit
 *
 * Patterns: Prompt Chaining (1) + Routing (2) + Parallelisation (3) +
 * Reflection (4) + Tool Use (5) + Human-in-the-Loop (13) + RAG (14) +
 * Guardrails (18) + Evaluation (19).
 *
 * This template serves a dual purpose:
 *
 * 1. **Genuinely useful** — AI-powered evaluation of provider model
 *    entries for accuracy and freshness, plus discovery of new models
 *    released by providers. Proposes changes and additions for admin
 *    review via human-in-the-loop approval.
 *
 * 2. **Framework reference implementation** — exercises 10 of the 15
 *    step types end-to-end, proving that the orchestration engine,
 *    approval queue, capability dispatch, budget enforcement, and
 *    SSE streaming all work together. FieldHelp annotations in the
 *    trigger UI explain which framework capability each step tests.
 *
 * Flow: load models from input → retrieve prior audit context from
 * knowledge base → route by model capability type (chat vs embedding
 * vs dual) → fan out parallel LLM analysis per model + new model
 * discovery → validate proposed changes against enum schemas → refine
 * findings via reflection loop → score confidence against rubric →
 * pause for human approval → apply accepted changes via capability →
 * add approved new models → notify admin of results.
 *
 * Step types NOT exercised (by design — not relevant to this use case):
 * chain (layout marker), plan (runtime DAG generation), agent_call
 * (agent delegation), orchestrator (multi-agent coordination).
 */

import type { WorkflowTemplate } from '@/prisma/seeds/data/templates/types';

export const PROVIDER_MODEL_AUDIT_TEMPLATE: WorkflowTemplate = {
  slug: 'tpl-provider-model-audit',
  name: 'Provider Model Audit',
  shortDescription:
    'AI-powered evaluation of provider model entries for accuracy and freshness, plus new model discovery. Exercises 10 step types as a framework reference implementation.',
  patterns: [
    { number: 1, name: 'Prompt Chaining' },
    { number: 2, name: 'Routing' },
    { number: 3, name: 'Parallelisation' },
    { number: 4, name: 'Reflection' },
    { number: 5, name: 'Tool Use' },
    { number: 13, name: 'Human-in-the-Loop' },
    { number: 14, name: 'RAG' },
    { number: 18, name: 'Guardrails' },
    { number: 19, name: 'Evaluation' },
  ],
  flowSummary:
    'Load selected model entries → retrieve prior audit context from the knowledge base → route by capability type (chat/embedding/dual) so analysis prompts are tailored → fan out parallel LLM analysis per model + new model discovery → validate proposed enum values against the schema → refine findings through a draft-critique-revise loop → score confidence against a quality rubric → pause for admin approval with a diff-style review → apply accepted changes via the apply_audit_changes capability → add approved new models via the add_provider_models capability → send a notification summarising results.',
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
        'Exercise 10 step types end-to-end to verify the orchestration engine, approval queue, capability dispatch, and budget enforcement all work together. Use as a smoke test after engine upgrades.',
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
        nextSteps: [{ targetStepId: 'retrieve_context' }],
      },

      // ─── Step 2: rag_retrieve (Pattern 14 — RAG) ──────────────────
      // Tests: Knowledge base semantic search, topK/threshold config,
      // template interpolation ({{load_models.output}}).
      {
        id: 'retrieve_context',
        name: 'Retrieve prior audit context',
        type: 'rag_retrieve',
        config: {
          query:
            'provider model audit results tier classification accuracy cost efficiency ratings {{load_models.output}}',
          topK: 8,
          similarityThreshold: 0.5,
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
      // discovery.
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
            'You are an AI model evaluation expert. Analyse the chat and completion model entries and propose corrections where the data appears inaccurate or outdated.\n\nModel data:\n{{load_models.output}}\n\nRouting context (capability type):\n{{classify_models.output}}\n\nPrior audit context (if available):\n{{retrieve_context.output}}\n\nFor each chat/completion model, evaluate:\n1. **Tier role** — Is the classification correct? (thinking, worker, infrastructure, control_plane, local_sovereign)\n2. **Reasoning depth** — Accurate? (very_high, high, medium, none)\n3. **Latency** — Correct categorisation? (very_fast, fast, medium)\n4. **Cost efficiency** — Still accurate? (very_high, high, medium, none)\n5. **Context length** — Current? (very_high, high, medium, n_a)\n6. **Tool use** — Correct? (strong, moderate, none)\n7. **Best role** — Still the right summary?\n8. **Description** — Accurate and current?\n\nRespond with a JSON array of audit results. Each result:\n{\n  "modelId": "<id>",\n  "modelName": "<name>",\n  "providerSlug": "<provider>",\n  "proposedChanges": [\n    { "field": "<field_name>", "currentValue": "<current>", "proposedValue": "<proposed>", "reason": "<why>", "confidence": "high" | "medium" | "low" }\n  ],\n  "overallConfidence": "high" | "medium" | "low",\n  "reasoning": "<overall assessment>"\n}\n\nOnly include models that need changes. Respond with ONLY the JSON array.',
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
            'You are an AI model evaluation expert specialising in embedding models. Analyse the embedding model entries and propose corrections where the data appears inaccurate or outdated.\n\nModel data:\n{{load_models.output}}\n\nRouting context (capability type):\n{{classify_models.output}}\n\nPrior audit context (if available):\n{{retrieve_context.output}}\n\nFor each embedding model, evaluate:\n1. **Tier role** — Should be "embedding"\n2. **Dimensions** — Correct vector dimensions for this model?\n3. **Quality** — Accurate? (high, medium, budget)\n4. **Cost efficiency** — Still accurate? (very_high, high, medium, none)\n5. **Context length** — Current? (very_high, high, medium, n_a)\n6. **Best role** — Still the right summary?\n7. **Description** — Accurate and current?\n\nRespond with a JSON array of audit results. Each result:\n{\n  "modelId": "<id>",\n  "modelName": "<name>",\n  "providerSlug": "<provider>",\n  "proposedChanges": [\n    { "field": "<field_name>", "currentValue": "<current>", "proposedValue": "<proposed>", "reason": "<why>", "confidence": "high" | "medium" | "low" }\n  ],\n  "overallConfidence": "high" | "medium" | "low",\n  "reasoning": "<overall assessment>"\n}\n\nOnly include models that need changes. Respond with ONLY the JSON array.',
          temperature: 0.2,
        },
        nextSteps: [{ targetStepId: 'validate_proposals' }],
      },

      // ─── Step 5b: llm_call (New Model Discovery) ─────────────────
      // Runs in parallel with analyse_chat and analyse_embedding.
      // Asks the LLM to identify recently released models from the
      // providers in scope that are NOT yet in the matrix.
      {
        id: 'discover_new_models',
        name: 'Identify new models from providers',
        type: 'llm_call',
        config: {
          prompt:
            'You are an AI model landscape expert. Given the list of providers and their currently registered models, identify any recently released models that are NOT in the registry.\n\nCurrent model registry:\n{{load_models.output}}\n\nPrior audit context:\n{{retrieve_context.output}}\n\nFor each provider represented in the data, check if they have released new models that are missing from the registry. For each new model found, propose a complete entry with:\n- "name": Human-readable name (e.g. "Claude Opus 4")\n- "slug": Lowercase with hyphens only (e.g. "anthropic-claude-opus-4")\n- "providerSlug": Must match an existing provider slug from the registry\n- "modelId": The API model identifier (e.g. "claude-opus-4-20250514")\n- "description": Brief description of the model\'s purpose and strengths\n- "capabilities": ["chat"] or ["embedding"] or ["chat", "embedding"]\n- "tierRole": one of: thinking, worker, infrastructure, control_plane, local_sovereign, embedding\n- "reasoningDepth": one of: very_high, high, medium, none\n- "latency": one of: very_fast, fast, medium\n- "costEfficiency": one of: very_high, high, medium, none\n- "contextLength": one of: very_high, high, medium, n_a\n- "toolUse": one of: strong, moderate, none\n- "bestRole": One-line summary of optimal use case\n- For embedding models also include: "dimensions" (integer), "quality" (high | medium | budget), "schemaCompatible" (boolean)\n\nRespond with a JSON object:\n{\n  "newModels": [...array of proposed models...],\n  "reasoning": "Summary of what was found and why these models should be added"\n}\n\nIf no new models are found, respond with { "newModels": [], "reasoning": "All known models are already registered" }.\n\nIMPORTANT: Only propose models you are confident exist. Do not fabricate model names or IDs.\nRespond with ONLY the JSON object, no markdown fencing.',
          temperature: 0.2,
        },
        nextSteps: [{ targetStepId: 'validate_proposals' }],
      },

      // ─── Step 6: guard (Pattern 18 — Guardrails) ──────────────────
      // Tests: Safety/quality validation gate, LLM-mode rule checking,
      // failAction configuration.
      {
        id: 'validate_proposals',
        name: 'Validate proposed values against schemas',
        type: 'guard',
        config: {
          rules:
            'Validate that all proposed changes and new model entries use valid enum values:\n\n- tierRole must be one of: thinking, worker, infrastructure, control_plane, local_sovereign, embedding\n- reasoningDepth must be one of: very_high, high, medium, none\n- latency must be one of: very_fast, fast, medium\n- costEfficiency must be one of: very_high, high, medium, none\n- contextLength must be one of: very_high, high, medium, n_a\n- toolUse must be one of: strong, moderate, none\n- quality (embedding) must be one of: high, medium, budget\n- confidence must be one of: high, medium, low\n- capabilities must be an array containing: chat, embedding, or both\n- slug (for new models) must be lowercase alphanumeric with hyphens only\n\nReject any proposed change that uses a value not in the above lists. Also reject changes where the field name is not a recognised AiProviderModel field. For new model proposals, reject entries missing required fields (name, slug, providerSlug, modelId, description, capabilities, tierRole, bestRole).',
          mode: 'llm',
          failAction: 'block',
        },
        nextSteps: [{ targetStepId: 'refine_findings', condition: 'pass' }],
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
            'Review the proposed provider model changes and new model additions below.\n\n## Proposed Changes to Existing Models\n\nThe audit has analysed your model entries and suggests the following updates. For each proposed change you can:\n- **Accept** — the change will be applied to the model entry\n- **Reject** — the change will be skipped\n- **Modify** — adjust the proposed value before accepting\n\n{{refine_findings.output}}\n\n## Proposed New Models\n\nThe audit has identified the following new models from your providers that are not yet in the registry. For each new model you can:\n- **Accept** — the model will be added to the registry\n- **Reject** — the model will not be added\n- **Modify** — adjust the proposed values before accepting\n\n{{discover_new_models.output}}\n\nAudit quality score: {{score_audit.output}}',
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
        nextSteps: [{ targetStepId: 'notify_complete' }],
      },

      // ─── Step 12: send_notification ───────────────────────────────
      // Tests: Email/webhook notification output, bodyTemplate
      // interpolation with step references.
      // NOTE: `to` is a placeholder — admins should edit this workflow
      // after seeding to set the correct notification recipient.
      {
        id: 'notify_complete',
        name: 'Notify audit completion',
        type: 'send_notification',
        config: {
          channel: 'email',
          to: 'admin@example.com',
          subject: 'Provider Model Audit Complete',
          bodyTemplate:
            'The provider model audit has completed.\n\nScope: {{load_models.output}}\nChanges applied: {{apply_changes.output}}\nNew models added: {{add_new_models.output}}\nQuality score: {{score_audit.output}}\n\nReview the full execution trace in the admin dashboard.',
        },
        nextSteps: [],
      },
    ],
  },
};
