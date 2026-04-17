import { describe, it, expect } from 'vitest';

import { extractTemplateVariables } from '@/lib/orchestration/workflows/template-scanner';
import type { WorkflowDefinition } from '@/types/orchestration';

function makeDef(steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return {
    steps,
    entryStepId: steps[0]?.id ?? 'step-1',
    errorStrategy: 'fail',
  };
}

function step(id: string, config: Record<string, unknown>) {
  return { id, name: id, type: 'llm_call', config, nextSteps: [] };
}

describe('extractTemplateVariables', () => {
  it('extracts {{input.foo}} from step config strings', () => {
    const def = makeDef([step('s1', { prompt: 'Hello {{input.name}}, you said {{input.query}}' })]);
    expect(extractTemplateVariables(def)).toEqual(['name', 'query']);
  });

  it('handles nested config objects', () => {
    const def = makeDef([
      step('s1', {
        nested: {
          deep: {
            template: 'Use {{input.topic}} for research',
          },
        },
      }),
    ]);
    expect(extractTemplateVariables(def)).toEqual(['topic']);
  });

  it('handles arrays in config', () => {
    const def = makeDef([
      step('s1', {
        messages: ['First: {{input.a}}', 'Second: {{input.b}}'],
      }),
    ]);
    expect(extractTemplateVariables(def)).toEqual(['a', 'b']);
  });

  it('deduplicates across steps', () => {
    const def = makeDef([
      step('s1', { prompt: '{{input.query}}' }),
      step('s2', { prompt: 'Again: {{input.query}}' }),
    ]);
    expect(extractTemplateVariables(def)).toEqual(['query']);
  });

  it('detects bare {{input}} as __whole__', () => {
    const def = makeDef([step('s1', { prompt: 'Process: {{input}}' })]);
    expect(extractTemplateVariables(def)).toEqual(['__whole__']);
  });

  it('ignores non-input templates like {{previous.output}} and {{step1.output}}', () => {
    const def = makeDef([
      step('s1', {
        prompt: 'Use {{previous.output}} and {{step1.output}} but also {{input.key}}',
      }),
    ]);
    expect(extractTemplateVariables(def)).toEqual(['key']);
  });

  it('returns empty array when no templates found', () => {
    const def = makeDef([step('s1', { prompt: 'No templates here' })]);
    expect(extractTemplateVariables(def)).toEqual([]);
  });

  it('returns empty array for steps with no config values', () => {
    const def = makeDef([step('s1', {})]);
    expect(extractTemplateVariables(def)).toEqual([]);
  });

  it('handles mixed types in config (numbers, booleans, null)', () => {
    const def = makeDef([
      step('s1', {
        count: 5,
        enabled: true,
        nothing: null,
        prompt: '{{input.x}}',
      }),
    ]);
    expect(extractTemplateVariables(def)).toEqual(['x']);
  });

  it('returns sorted results', () => {
    const def = makeDef([step('s1', { prompt: '{{input.z}} {{input.a}} {{input.m}}' })]);
    expect(extractTemplateVariables(def)).toEqual(['a', 'm', 'z']);
  });
});
