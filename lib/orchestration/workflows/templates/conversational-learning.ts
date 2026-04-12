/**
 * Recipe 5: Conversational Agent with Learning
 *
 * Patterns: Prompt Chaining (1) + Tool Use (5) + Memory (8) + Learning (9)
 * + Evaluation (19).
 *
 * Linear chain: load conversational context via a tool call → understand →
 * reason → look up supporting facts via another tool call → respond →
 * evaluate response quality. The final evaluation step is what drives the
 * learning loop in Session 5.2+ — negative feedback will be fed back into
 * the agent's instructions.
 */

import type { WorkflowTemplate } from './types';

export const CONVERSATIONAL_LEARNING_TEMPLATE: WorkflowTemplate = {
  slug: 'tpl-conversational-learning',
  name: 'Conversational Agent with Learning',
  shortDescription:
    'Loads prior context, chains understand → reason → respond, and self-evaluates the reply to feed a learning loop.',
  patterns: [
    { number: 1, name: 'Prompt Chaining' },
    { number: 5, name: 'Tool Use' },
    { number: 8, name: 'Memory' },
    { number: 9, name: 'Learning & Adaptation' },
    { number: 19, name: 'Evaluation & Monitoring' },
  ],
  flowSummary:
    'A Tool Call loads conversation context from the knowledge base, an LLM understands the user turn, a second LLM reasons about the appropriate action, another Tool Call fetches supporting facts about an agentic pattern, an LLM composes the reply, and a final LLM scores the reply so the outcome can feed a learning loop.',
  workflowDefinition: {
    entryStepId: 'load_context',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'load_context',
        name: 'Load conversation context',
        type: 'tool_call',
        config: {
          capabilitySlug: 'search_knowledge_base',
        },
        nextSteps: [{ targetStepId: 'understand' }],
      },
      {
        id: 'understand',
        name: 'Understand the user turn',
        type: 'llm_call',
        config: {
          prompt:
            "Given the loaded context and the user's latest message, restate what the user is asking for and the implicit goal.\n\nContext:\n{{load_context.output}}\n\nUser:\n{{input}}",
          modelOverride: '',
          temperature: 0.2,
        },
        nextSteps: [{ targetStepId: 'reason' }],
      },
      {
        id: 'reason',
        name: 'Reason about next action',
        type: 'llm_call',
        config: {
          prompt:
            'Given the restated goal, decide what the assistant should do: answer directly, ask a clarifying question, or fetch a specific reference. Return a short action plan.\n\nGoal:\n{{understand.output}}',
          modelOverride: '',
          temperature: 0.3,
        },
        nextSteps: [{ targetStepId: 'lookup_facts' }],
      },
      {
        id: 'lookup_facts',
        name: 'Look up pattern detail',
        type: 'tool_call',
        config: {
          capabilitySlug: 'get_pattern_detail',
        },
        nextSteps: [{ targetStepId: 'respond' }],
      },
      {
        id: 'respond',
        name: 'Compose response',
        type: 'llm_call',
        config: {
          prompt:
            'Compose the final response for the user. Use the action plan and the retrieved facts. Keep it conversational.\n\nPlan:\n{{reason.output}}\n\nFacts:\n{{lookup_facts.output}}',
          modelOverride: '',
          temperature: 0.6,
        },
        nextSteps: [{ targetStepId: 'evaluate_quality' }],
      },
      {
        id: 'evaluate_quality',
        name: 'Evaluate reply quality',
        type: 'llm_call',
        config: {
          prompt:
            'You are an LLM-as-a-judge. Score the reply below on helpfulness, accuracy, and tone from 1–5 each, and return the scores plus one-sentence feedback. The score drives the learning loop.\n\nReply:\n{{respond.output}}',
          modelOverride: '',
          temperature: 0.1,
        },
        nextSteps: [],
      },
    ],
  },
};
