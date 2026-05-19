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

import type { WorkflowTemplate } from '@/prisma/seeds/data/templates/types';

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
  useCases: [
    {
      title: 'Employee onboarding assistant',
      scenario:
        'Load new-hire context, understand their question about company processes, reason about the best resource, look up the relevant policy, and compose a friendly answer.',
    },
    {
      title: 'Language tutoring bot',
      scenario:
        'Load learner history, understand the practice request, reason about appropriate difficulty, fetch grammar or vocabulary reference, and compose a lesson response.',
    },
    {
      title: 'Technical support chatbot',
      scenario:
        'Load prior ticket context, understand the issue, reason about troubleshooting steps, look up product documentation, and compose a diagnostic reply.',
    },
  ],
  workflowDefinition: {
    entryStepId: 'load_context',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'load_context',
        name: 'Load conversation context',
        description:
          'Calls the search_knowledge_base capability to pull prior conversation context, profile data, or recent history before the LLM sees the user turn.',
        type: 'tool_call',
        config: {
          capabilitySlug: 'search_knowledge_base',
        },
        nextSteps: [{ targetStepId: 'understand' }],
      },
      {
        id: 'understand',
        name: 'Understand the user turn',
        description:
          'Restates the user message in terms of what they are asking for and the implicit goal behind it — a structured handoff to the reasoning step rather than feeding the raw message forward.',
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
        description:
          'Decides whether the assistant should answer directly, ask a clarifying question, or fetch a specific reference — and returns a short action plan the response step follows.',
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
        description:
          'Fetches supporting facts the response will need via the get_pattern_detail capability. Replace with your own domain-specific lookup capability after cloning the template.',
        type: 'tool_call',
        config: {
          capabilitySlug: 'get_pattern_detail',
        },
        nextSteps: [{ targetStepId: 'respond' }],
      },
      {
        id: 'respond',
        name: 'Compose response',
        description:
          'Writes the conversational reply using the action plan and the looked-up facts. Higher temperature than the upstream reasoning steps because the output is user-facing prose.',
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
        description:
          'LLM-as-judge scores helpfulness, accuracy, and tone on a 1–5 scale with one-line feedback. The score feeds the learning loop that adjusts the agent over time.',
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
