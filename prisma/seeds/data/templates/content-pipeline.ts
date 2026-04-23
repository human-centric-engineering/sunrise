/**
 * Recipe 2: Content Generation Pipeline
 *
 * Patterns: Planning (6) + Prompt Chaining (1) + Reflection (4) + Parallelisation (3).
 *
 * Flow: plan the article → research the topic and analyse the audience in
 * parallel → merge findings into an outline → draft → reflect (critique
 * loop) until the draft meets the quality bar.
 */

import type { WorkflowTemplate } from '@/prisma/seeds/data/templates/types';

export const CONTENT_PIPELINE_TEMPLATE: WorkflowTemplate = {
  slug: 'tpl-content-pipeline',
  name: 'Content Generation Pipeline',
  shortDescription:
    'Plans an article, researches and audience-analyses in parallel, drafts it, and refines via a critique loop.',
  patterns: [
    { number: 1, name: 'Prompt Chaining' },
    { number: 3, name: 'Parallelisation' },
    { number: 4, name: 'Reflection' },
    { number: 6, name: 'Planning' },
  ],
  flowSummary:
    'A Plan step breaks the brief into stages, a Parallel step fans out to a research call and an audience-analysis call at the same time, both results feed an outline generator, which hands off to a drafting call, and a Reflect step iterates draft → critique → revise until the quality bar is met.',
  useCases: [
    {
      title: 'SEO blog production',
      scenario:
        'Plan a keyword-targeted article, research the topic and analyse search intent in parallel, outline, draft, and iterate until quality meets brand guidelines.',
    },
    {
      title: 'Product launch announcements',
      scenario:
        'Plan the announcement structure, parallel-research competitive positioning and audience segments, draft the announcement, and reflect until messaging is crisp.',
    },
    {
      title: 'Internal knowledge base articles',
      scenario:
        'Plan documentation structure from a feature spec, parallel-research technical details and user pain points, draft, and refine via a critique loop.',
    },
  ],
  workflowDefinition: {
    entryStepId: 'plan_outline',
    errorStrategy: 'retry',
    steps: [
      {
        id: 'plan_outline',
        name: 'Plan content stages',
        type: 'plan',
        config: {
          objective:
            'Break the content brief into an ordered list of stages: research, audience analysis, outline, draft, review.',
          maxSubSteps: 5,
        },
        nextSteps: [{ targetStepId: 'fanout' }],
      },
      {
        id: 'fanout',
        name: 'Research and audience in parallel',
        type: 'parallel',
        config: {
          branches: ['research_topic', 'analyze_audience'],
          timeoutMs: 60000,
          stragglerStrategy: 'wait-all',
        },
        nextSteps: [{ targetStepId: 'research_topic' }, { targetStepId: 'analyze_audience' }],
      },
      {
        id: 'research_topic',
        name: 'Research topic',
        type: 'llm_call',
        config: {
          prompt:
            'Research the following topic and produce a bullet list of key facts, recent developments, and primary sources.\n\nTopic:\n{{input.topic}}',
          modelOverride: '',
          temperature: 0.3,
        },
        nextSteps: [{ targetStepId: 'outline' }],
      },
      {
        id: 'analyze_audience',
        name: 'Analyse audience',
        type: 'llm_call',
        config: {
          prompt:
            'Describe the target audience for the brief below: their level, goals, and the tone that will resonate.\n\nBrief:\n{{input.brief}}',
          modelOverride: '',
          temperature: 0.3,
        },
        nextSteps: [{ targetStepId: 'outline' }],
      },
      {
        id: 'outline',
        name: 'Write outline',
        type: 'llm_call',
        config: {
          prompt:
            'Combine the research notes and audience analysis into a section-by-section outline.\n\nResearch:\n{{research_topic.output}}\n\nAudience:\n{{analyze_audience.output}}',
          modelOverride: '',
          temperature: 0.4,
        },
        nextSteps: [{ targetStepId: 'draft' }],
      },
      {
        id: 'draft',
        name: 'Draft article',
        type: 'llm_call',
        config: {
          prompt:
            'Write the full article from the outline below. Match the audience tone.\n\nOutline:\n{{outline.output}}',
          modelOverride: '',
          temperature: 0.7,
        },
        nextSteps: [{ targetStepId: 'critique' }],
      },
      {
        id: 'critique',
        name: 'Critique and revise',
        type: 'reflect',
        config: {
          critiquePrompt:
            'Critique the draft for clarity, accuracy, structure, and tone. List concrete improvements and produce a revised version until the critique returns no further changes.',
          maxIterations: 3,
        },
        nextSteps: [],
      },
    ],
  },
};
