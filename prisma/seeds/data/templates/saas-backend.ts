/**
 * Recipe 3: AI-First SaaS Backend
 *
 * Patterns: Routing (2) + Prompt Chaining (1) + Tool Use (5) + Resource-Aware (16).
 *
 * Flow: triage complexity → dispatch to a cheap / standard / frontier
 * model → estimate the request's cost via a tool call → final safety /
 * formatting pass before responding. `errorStrategy: 'fallback'` so a
 * failing branch can fall through to the safety check instead of halting.
 */

import type { WorkflowTemplate } from '@/prisma/seeds/data/templates/types';

export const SAAS_BACKEND_TEMPLATE: WorkflowTemplate = {
  slug: 'tpl-saas-backend',
  name: 'AI-First SaaS Backend',
  shortDescription:
    'Routes incoming requests by complexity to a cheap, standard, or frontier model, estimates their cost, and runs a final safety pass.',
  patterns: [
    { number: 1, name: 'Prompt Chaining' },
    { number: 2, name: 'Routing' },
    { number: 5, name: 'Tool Use' },
    { number: 16, name: 'Resource-Aware Optimisation' },
  ],
  flowSummary:
    'A Route step classifies each request as simple, standard, or complex and dispatches to an LLM call with an appropriate model override. All three branches converge at a Tool Call that estimates workflow cost, followed by a final LLM safety / formatting pass.',
  useCases: [
    {
      title: 'AI writing assistant API',
      scenario:
        'Route by task complexity (spell-check vs. paragraph rewrite vs. full essay), dispatch to cost-appropriate models, track per-request cost, and safety-check output.',
    },
    {
      title: 'Customer-facing chatbot backend',
      scenario:
        'Triage simple FAQ lookups vs. complex account questions, use cheap models for simple queries and frontier models for complex ones, estimate cost for billing, and sanitise PII from responses.',
    },
    {
      title: 'Developer copilot service',
      scenario:
        'Route code completion (simple) vs. generation (standard) vs. architectural advice (complex), dispatch to the right model tier, track cost, and scan output for leaked secrets.',
    },
  ],
  workflowDefinition: {
    entryStepId: 'complexity_triage',
    errorStrategy: 'fallback',
    steps: [
      {
        id: 'complexity_triage',
        name: 'Classify complexity',
        type: 'route',
        config: {
          classificationPrompt:
            'Classify the incoming request as "simple" (FAQ / lookup), "standard" (short generative task), or "complex" (multi-step reasoning).',
          routes: [{ label: 'simple' }, { label: 'standard' }, { label: 'complex' }],
        },
        nextSteps: [
          { targetStepId: 'simple_reply', condition: 'simple' },
          { targetStepId: 'standard_reply', condition: 'standard' },
          { targetStepId: 'complex_reply', condition: 'complex' },
        ],
      },
      {
        id: 'simple_reply',
        name: 'Cheap-tier response',
        type: 'llm_call',
        config: {
          prompt: 'Answer the simple user request directly and concisely.\n\n{{input}}',
          modelOverride: 'claude-haiku-4-5-20251001',
          temperature: 0.2,
        },
        nextSteps: [{ targetStepId: 'estimate_cost' }],
      },
      {
        id: 'standard_reply',
        name: 'Standard-tier response',
        type: 'llm_call',
        config: {
          prompt:
            'Answer the user request in full, showing your working where helpful.\n\n{{input}}',
          modelOverride: 'claude-sonnet-4-6',
          temperature: 0.5,
        },
        nextSteps: [{ targetStepId: 'estimate_cost' }],
      },
      {
        id: 'complex_reply',
        name: 'Frontier-tier response',
        type: 'llm_call',
        config: {
          prompt:
            'This request is complex. Decompose it, reason step by step, and return a well-structured answer.\n\n{{input}}',
          modelOverride: 'claude-opus-4-6',
          temperature: 0.6,
        },
        nextSteps: [{ targetStepId: 'estimate_cost' }],
      },
      {
        id: 'estimate_cost',
        name: 'Estimate workflow cost',
        type: 'tool_call',
        config: {
          capabilitySlug: 'estimate_workflow_cost',
        },
        nextSteps: [{ targetStepId: 'safety_check' }],
      },
      {
        id: 'safety_check',
        name: 'Safety and format pass',
        type: 'llm_call',
        config: {
          prompt:
            'Review the reply below for safety, tone, and formatting. Strip anything that leaks secrets or PII. Return the cleaned reply.\n\nReply:\n{{previous.output}}',
          modelOverride: '',
          temperature: 0.1,
        },
        nextSteps: [],
      },
    ],
  },
};
