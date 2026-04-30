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
 *    entries for accuracy and freshness. Proposes changes for admin
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
 * vs dual) → fan out parallel LLM analysis per model → validate
 * proposed changes against enum schemas → refine findings via
 * reflection loop → score confidence against rubric → pause for
 * human approval → apply accepted changes via capability → notify
 * admin of results.
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
    'AI-powered evaluation of provider model entries for accuracy and freshness. Exercises 11 step types as a framework reference implementation.',
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
    'Load selected model entries → retrieve prior audit context from the knowledge base → route by capability type (chat/embedding/dual) so analysis prompts are tailored → fan out parallel LLM analysis per model → validate proposed enum values against the schema → refine findings through a draft-critique-revise loop → score confidence against a quality rubric → pause for admin approval with a diff-style review → apply accepted changes via the apply_audit_changes capability → send a notification summarising results.',
  useCases: [
    {
      title: 'Quarterly provider registry review',
      scenario:
        'Run a full audit of all model entries to catch stale ratings, deprecated models, and missing new releases. The workflow evaluates each model against current provider data and proposes updates for admin review.',
    },
    {
      title: 'Post-launch model assessment',
      scenario:
        'After a provider launches new models, audit the affected entries to ensure tier classification, cost efficiency ratings, and capability flags are accurate for the new releases.',
    },
    {
      title: 'Framework integration validation',
      scenario:
        'Exercise 11 step types end-to-end to verify the orchestration engine, approval queue, capability dispatch, and budget enforcement all work together. Use as a smoke test after engine upgrades.',
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
      // All route branches converge here. Two parallel analysis branches
      // (chat-focused and embedding-focused) run concurrently.
      {
        id: 'audit_models',
        name: 'Analyse models in parallel',
        type: 'parallel',
        config: {
          branches: ['analyse_chat', 'analyse_embedding'],
          stragglerStrategy: 'wait-all',
          timeoutMs: 120000,
        },
        nextSteps: [{ targetStepId: 'analyse_chat' }, { targetStepId: 'analyse_embedding' }],
      },
      {
        id: 'analyse_chat',
        name: 'Analyse chat/completion models',
        type: 'llm_call',
        config: {
          prompt:
            'You are an AI model evaluation expert. Analyse the chat and completion model entries and propose corrections where the data appears inaccurate or outdated.\n\nModel data:\n{{load_models.output}}\n\nRouting context (capability type):\n{{classify_models.output}}\n\nPrior audit context (if available):\n{{retrieve_context.output}}\n\nFor each chat/completion model, evaluate:\n1. **Tier role** — Is the classification correct? (thinking, worker, infrastructure, control_plane, local_sovereign)\n2. **Reasoning depth** — Accurate? (none, basic, moderate, advanced, frontier)\n3. **Latency** — Correct categorisation? (ultra_fast, fast, moderate, slow, very_slow)\n4. **Cost efficiency** — Still accurate? (very_low, low, moderate, high, very_high)\n5. **Context length** — Current? (small, medium, large, very_large, massive)\n6. **Tool use** — Correct? (none, basic, moderate, advanced)\n7. **Best role** — Still the right summary?\n8. **Description** — Accurate and current?\n\nRespond with a JSON array of audit results. Each result:\n{\n  "modelId": "<id>",\n  "modelName": "<name>",\n  "providerSlug": "<provider>",\n  "proposedChanges": [\n    { "field": "<field_name>", "currentValue": "<current>", "proposedValue": "<proposed>", "reason": "<why>", "confidence": "high" | "medium" | "low" }\n  ],\n  "overallConfidence": "high" | "medium" | "low",\n  "reasoning": "<overall assessment>"\n}\n\nOnly include models that need changes. Respond with ONLY the JSON array.',
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
            'You are an AI model evaluation expert specialising in embedding models. Analyse the embedding model entries and propose corrections where the data appears inaccurate or outdated.\n\nModel data:\n{{load_models.output}}\n\nRouting context (capability type):\n{{classify_models.output}}\n\nPrior audit context (if available):\n{{retrieve_context.output}}\n\nFor each embedding model, evaluate:\n1. **Tier role** — Should be "embedding"\n2. **Dimensions** — Correct vector dimensions for this model?\n3. **Quality** — Accurate? (basic, good, excellent, sota)\n4. **Cost efficiency** — Still accurate? (very_low, low, moderate, high, very_high)\n5. **Context length** — Current? (small, medium, large, very_large, massive)\n6. **Best role** — Still the right summary?\n7. **Description** — Accurate and current?\n\nRespond with a JSON array of audit results. Each result:\n{\n  "modelId": "<id>",\n  "modelName": "<name>",\n  "providerSlug": "<provider>",\n  "proposedChanges": [\n    { "field": "<field_name>", "currentValue": "<current>", "proposedValue": "<proposed>", "reason": "<why>", "confidence": "high" | "medium" | "low" }\n  ],\n  "overallConfidence": "high" | "medium" | "low",\n  "reasoning": "<overall assessment>"\n}\n\nOnly include models that need changes. Respond with ONLY the JSON array.',
          temperature: 0.2,
        },
        nextSteps: [{ targetStepId: 'validate_proposals' }],
      },

      // ─── Step 5: guard (Pattern 18 — Guardrails) ──────────────────
      // Tests: Safety/quality validation gate, LLM-mode rule checking,
      // failAction configuration.
      {
        id: 'validate_proposals',
        name: 'Validate proposed values against schemas',
        type: 'guard',
        config: {
          rules:
            'Validate that all proposed changes use valid enum values:\n\n- tierRole must be one of: thinking, worker, infrastructure, control_plane, local_sovereign, embedding\n- reasoningDepth must be one of: none, basic, moderate, advanced, frontier\n- latency must be one of: ultra_fast, fast, moderate, slow, very_slow\n- costEfficiency must be one of: very_low, low, moderate, high, very_high\n- contextLength must be one of: small, medium, large, very_large, massive\n- toolUse must be one of: none, basic, moderate, advanced\n- quality (embedding) must be one of: basic, good, excellent, sota\n- confidence must be one of: high, medium, low\n\nReject any proposed change that uses a value not in the above lists. Also reject changes where the field name is not a recognised AiProviderModel field.',
          mode: 'llm',
          failAction: 'block',
        },
        nextSteps: [{ targetStepId: 'refine_findings', condition: 'pass' }],
      },

      // ─── Step 6: reflect (Pattern 4 — Reflection) ─────────────────
      // Tests: Draft → critique → revise loop, maxIterations config,
      // iterative quality improvement.
      {
        id: 'refine_findings',
        name: 'Refine audit findings',
        type: 'reflect',
        config: {
          critiquePrompt:
            'Review the proposed model audit changes critically:\n\n1. Are any proposed changes based on outdated information about the model?\n2. Do the confidence levels accurately reflect certainty? High confidence should only be used for clear, verifiable facts.\n3. Are the reasons specific enough to help an admin understand why the change is proposed?\n4. Are there any contradictions between proposed changes for the same model?\n5. Should any "medium" confidence changes be downgraded to "low" if the evidence is circumstantial?\n\nProvide specific, actionable feedback for each issue found.',
          maxIterations: 2,
        },
        nextSteps: [{ targetStepId: 'score_audit' }],
      },

      // ─── Step 7: evaluate (Pattern 19 — Evaluation) ───────────────
      // Tests: Quality scoring against rubric, scale configuration,
      // threshold-based gating.
      {
        id: 'score_audit',
        name: 'Score audit confidence and completeness',
        type: 'evaluate',
        config: {
          rubric:
            'Score the audit findings on a 1-10 scale:\n\n- **Accuracy** (1-10): Are the proposed changes factually correct based on current model capabilities?\n- **Completeness** (1-10): Were all relevant fields evaluated? Were any obvious issues missed?\n- **Specificity** (1-10): Are the reasons for changes specific and actionable, not vague?\n- **Confidence calibration** (1-10): Do the confidence levels match the strength of evidence?\n- **Consistency** (1-10): Are similar models treated consistently (e.g., same-family models should have consistent tier roles)?',
          scaleMin: 1,
          scaleMax: 10,
          threshold: 6,
        },
        nextSteps: [{ targetStepId: 'review_changes' }],
      },

      // ─── Step 8: human_approval (Pattern 13 — HITL) ───────────────
      // Tests: Execution pause via PausedForApproval exception, approval
      // queue, resume flow, approvalPayload forwarding.
      {
        id: 'review_changes',
        name: 'Admin reviews proposed changes',
        type: 'human_approval',
        config: {
          prompt:
            'Review the proposed provider model changes below. The audit has analysed your model entries and suggests the following updates.\n\nFor each proposed change you can:\n- **Accept** — the change will be applied to the model entry\n- **Reject** — the change will be skipped\n- **Modify** — adjust the proposed value before accepting\n\nAudit quality score: {{score_audit.output}}\n\nProposed changes:\n{{refine_findings.output}}',
          timeoutMinutes: 1440,
        },
        nextSteps: [{ targetStepId: 'apply_changes' }],
      },

      // ─── Step 9: tool_call (Pattern 5 — Tool Use) ─────────────────
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
        nextSteps: [{ targetStepId: 'notify_complete' }],
      },

      // ─── Step 10: send_notification ────────────────────────────────
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
            'The provider model audit has completed.\n\nScope: {{load_models.output}}\nChanges applied: {{apply_changes.output}}\nQuality score: {{score_audit.output}}\n\nReview the full execution trace in the admin dashboard.',
        },
        nextSteps: [],
      },
    ],
  },
};
