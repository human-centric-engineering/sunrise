/**
 * Recipe 6: Data Pipeline with Quality Gate
 *
 * Patterns: Inter-Agent Communication (15) + Guardrails (18) + Parallelisation (3)
 * + Evaluation (19) + Tool Use (5).
 *
 * Flow: fetch data from an external source → guard against invalid/unsafe
 * records → parallel-transform two enrichment streams → merge → score
 * quality → push results to an external destination. The guard step blocks
 * bad data from reaching the transformation layer; the evaluate step
 * ensures the output meets a quality threshold before it leaves the
 * pipeline.
 *
 * Showcases: external_call (ingress + egress), guard, chain (merge),
 * parallel, evaluate.
 */

import type { WorkflowTemplate } from './types';

export const DATA_PIPELINE_TEMPLATE: WorkflowTemplate = {
  slug: 'tpl-data-pipeline',
  name: 'Data Pipeline with Quality Gate',
  shortDescription:
    'Fetches data from an external source, validates it through a safety gate, transforms in parallel, scores quality, and pushes results downstream.',
  patterns: [
    { number: 3, name: 'Parallelisation' },
    { number: 5, name: 'Tool Use' },
    { number: 15, name: 'Inter-Agent Communication' },
    { number: 18, name: 'Guardrails' },
    { number: 19, name: 'Evaluation & Monitoring' },
  ],
  flowSummary:
    'An External Call fetches raw data from a source API, a Guard step validates it against safety rules (blocking invalid records), a Parallel step fans out to two LLM enrichment calls, a Chain step merges the branches, an Evaluate step scores overall quality, and a final External Call pushes the clean results to a downstream system.',
  useCases: [
    {
      title: 'Regulatory compliance pipeline',
      scenario:
        'Pull financial transaction data from an external API, guard against PII and sanctions-list matches, transform and enrich in parallel, score data quality, and push clean records downstream.',
    },
    {
      title: 'Product catalog sync',
      scenario:
        'Fetch product listings from a supplier API, guard against malformed or incomplete entries, parallel-transform descriptions and pricing, evaluate completeness, and push updates to an e-commerce platform.',
    },
    {
      title: 'ML feature pipeline',
      scenario:
        'Fetch raw event data from a warehouse API, guard against schema violations, parallel-compute multiple feature sets via LLM extraction, evaluate feature quality distribution, and push vectors to a feature store.',
    },
  ],
  workflowDefinition: {
    entryStepId: 'fetch_source',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'fetch_source',
        name: 'Fetch source data',
        type: 'external_call',
        config: {
          url: 'https://api.example.com/data/export',
          method: 'GET',
          headers: {},
          bodyTemplate: '',
          timeoutMs: 30000,
          authType: 'bearer',
          authSecret: 'SOURCE_API_TOKEN',
        },
        nextSteps: [{ targetStepId: 'validate_input' }],
      },
      {
        id: 'validate_input',
        name: 'Validate input data',
        type: 'guard',
        config: {
          rules:
            'Reject any record that contains personally identifiable information (names, emails, phone numbers, national ID numbers) or references sanctioned entities. Also reject records with missing required fields.',
          mode: 'llm',
          failAction: 'block',
          temperature: 0.1,
        },
        nextSteps: [
          { targetStepId: 'fanout', condition: 'pass' },
          { targetStepId: 'rejection_log', condition: 'fail' },
        ],
      },
      {
        id: 'rejection_log',
        name: 'Log rejection reason',
        type: 'llm_call',
        config: {
          prompt:
            'A data record was rejected by the safety gate. Summarise why it was blocked and what fields were problematic.\n\nGuard output:\n{{validate_input.output}}',
          modelOverride: '',
          temperature: 0.2,
        },
        nextSteps: [],
      },
      {
        id: 'fanout',
        name: 'Parallel enrichment',
        type: 'parallel',
        config: {
          branches: ['enrich_classify', 'enrich_summarise'],
          timeoutMs: 60000,
          stragglerStrategy: 'wait-all',
        },
        nextSteps: [{ targetStepId: 'enrich_classify' }, { targetStepId: 'enrich_summarise' }],
      },
      {
        id: 'enrich_classify',
        name: 'Classify and tag',
        type: 'llm_call',
        config: {
          prompt:
            'Classify the following data record into categories and add structured tags. Return a JSON object with "category" and "tags" fields.\n\nRecord:\n{{fetch_source.output}}',
          modelOverride: '',
          temperature: 0.2,
        },
        nextSteps: [{ targetStepId: 'merge' }],
      },
      {
        id: 'enrich_summarise',
        name: 'Summarise content',
        type: 'llm_call',
        config: {
          prompt:
            'Write a concise one-paragraph summary of the following data record, highlighting the key facts and any anomalies.\n\nRecord:\n{{fetch_source.output}}',
          modelOverride: '',
          temperature: 0.3,
        },
        nextSteps: [{ targetStepId: 'merge' }],
      },
      {
        id: 'merge',
        name: 'Merge enrichments',
        type: 'chain',
        config: {
          steps: [],
        },
        nextSteps: [{ targetStepId: 'score_quality' }],
      },
      {
        id: 'score_quality',
        name: 'Score output quality',
        type: 'evaluate',
        config: {
          rubric:
            'Rate the enriched data record on completeness (are all fields populated?), accuracy (do tags match the content?), and summary quality (is the summary factual and concise?). Score from 1 to 10.',
          scaleMin: 1,
          scaleMax: 10,
          threshold: 7,
          temperature: 0.2,
        },
        nextSteps: [{ targetStepId: 'push_output' }],
      },
      {
        id: 'push_output',
        name: 'Push to destination',
        type: 'external_call',
        config: {
          url: 'https://api.example.com/data/import',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          bodyTemplate: '{"record": {{previous.output}}}',
          timeoutMs: 15000,
          authType: 'api-key',
          authSecret: 'DEST_API_KEY',
        },
        nextSteps: [],
      },
    ],
  },
};
