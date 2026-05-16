import { describe, expect, it } from 'vitest';

import {
  buildApprovalPayload,
  gatherSectionItems,
  renderTitleTemplate,
  resolveTemplatePath,
  type FlatItemState,
  type NestedItemState,
  type ReviewSelectionState,
  type SectionData,
} from '@/lib/orchestration/review-schema/resolver';
import type { ReviewSchema } from '@/lib/orchestration/review-schema/types';
import type { ExecutionTraceEntry } from '@/types/orchestration';

function entry(overrides: Partial<ExecutionTraceEntry> = {}): ExecutionTraceEntry {
  return {
    stepId: 's1',
    stepType: 'llm_call',
    label: 'Step',
    status: 'completed',
    output: null,
    tokensUsed: 0,
    costUsd: 0,
    startedAt: '2026-05-05T00:00:00.000Z',
    completedAt: '2026-05-05T00:00:01.000Z',
    durationMs: 100,
    ...overrides,
  };
}

describe('resolveTemplatePath', () => {
  it('reads a nested key from an object output', () => {
    const trace = [
      entry({
        stepId: 'discover',
        output: { newModels: [{ name: 'A' }, { name: 'B' }] },
      }),
    ];
    expect(resolveTemplatePath('{{discover.output.newModels}}', trace)).toEqual([
      { name: 'A' },
      { name: 'B' },
    ]);
  });

  it('unwraps a JSON-string output before descent', () => {
    // llm_call stores response.content (a string). The resolver must
    // parse strings whose content looks like an object before reading
    // sub-keys, otherwise structured upstream outputs are unreachable.
    const trace = [
      entry({
        stepId: 'analyse',
        output: JSON.stringify({ models: [{ model_id: 'm1' }] }),
      }),
    ];
    expect(resolveTemplatePath('{{analyse.output.models}}', trace)).toEqual([{ model_id: 'm1' }]);
  });

  it('returns undefined when the step is missing', () => {
    expect(resolveTemplatePath('{{missing.output.foo}}', [])).toBeUndefined();
  });

  it('returns undefined when a mid-path key is absent', () => {
    const trace = [entry({ stepId: 's', output: { a: 1 } })];
    expect(resolveTemplatePath('{{s.output.b}}', trace)).toBeUndefined();
  });

  it('rejects templates that do not address an output field', () => {
    const trace = [entry({ stepId: 's', output: { input: 'x' } })];
    expect(resolveTemplatePath('{{s.input.value}}', trace)).toBeUndefined();
  });
});

describe('gatherSectionItems', () => {
  const baseFields = [{ key: 'name', label: 'Name', display: 'text' as const }];

  it('extracts items and assigns the key from itemKey', () => {
    const trace = [
      entry({
        stepId: 'discover',
        output: {
          newModels: [
            { slug: 'a', name: 'A' },
            { slug: 'b', name: 'B' },
          ],
        },
      }),
    ];
    const result = gatherSectionItems(
      {
        id: 'newModels',
        title: 'New models',
        source: '{{discover.output.newModels}}',
        itemKey: 'slug',
        itemTitle: '{{item.name}}',
        fields: baseFields,
      },
      trace
    );
    expect(result.items).toHaveLength(2);
    expect(result.items[0].__key).toBe('a');
    expect(result.items[1].__key).toBe('b');
    expect(result.items[0].name).toBe('A');
  });

  it('concatenates arrays from __merge__ paths', () => {
    const trace = [
      entry({
        stepId: 'analyse_chat',
        output: { deactivateModels: [{ modelId: 'm1', reason: 'r1' }] },
      }),
      entry({
        stepId: 'analyse_embedding',
        output: { deactivateModels: [{ modelId: 'm2', reason: 'r2' }] },
      }),
    ];
    const result = gatherSectionItems(
      {
        id: 'deactivateModels',
        title: 'Deactivations',
        source:
          '__merge__:{{analyse_chat.output.deactivateModels}},{{analyse_embedding.output.deactivateModels}}',
        itemKey: 'modelId',
        itemTitle: '{{item.modelId}}',
        fields: baseFields,
      },
      trace
    );
    expect(result.items.map((i) => i.modelId)).toEqual(['m1', 'm2']);
  });

  it('disambiguates duplicate keys across merged sources', () => {
    const trace = [
      entry({
        stepId: 'a',
        output: { items: [{ key: 'dup', name: 'first' }] },
      }),
      entry({
        stepId: 'b',
        output: { items: [{ key: 'dup', name: 'second' }] },
      }),
    ];
    const result = gatherSectionItems(
      {
        id: 'items',
        title: 'Items',
        source: '__merge__:{{a.output.items}},{{b.output.items}}',
        itemKey: 'key',
        itemTitle: '{{item.name}}',
        fields: baseFields,
      },
      trace
    );
    expect(result.items.map((i) => i.__key)).toEqual(['dup', 'dup#1']);
  });

  it('reports a parse error instead of throwing when source is missing', () => {
    const result = gatherSectionItems(
      {
        id: 'x',
        title: 't',
        source: '{{missing.output.values}}',
        itemKey: 'id',
        itemTitle: 'x',
        fields: baseFields,
      },
      []
    );
    expect(result.error).toBeDefined();
    expect(result.items).toHaveLength(0);
  });

  it('reports an error when the path resolves to a non-array', () => {
    const trace = [entry({ stepId: 's', output: { values: { not: 'array' } } })];
    const result = gatherSectionItems(
      {
        id: 'x',
        title: 't',
        source: '{{s.output.values}}',
        itemKey: 'id',
        itemTitle: 'x',
        fields: baseFields,
      },
      trace
    );
    expect(result.error).toBeDefined();
  });
});

describe('renderTitleTemplate', () => {
  it('interpolates {{item.foo}} placeholders', () => {
    expect(
      renderTitleTemplate('{{item.name}} ({{item.provider}})', {
        __key: 'a',
        name: 'GPT-5',
        provider: 'openai',
      })
    ).toBe('GPT-5 (openai)');
  });

  it('renders missing keys as empty string', () => {
    expect(renderTitleTemplate('{{item.missing}}', { __key: 'a' })).toBe('');
  });

  it('drops non-primitive values from the title', () => {
    // A nested object in an item title would render as `[object Object]`
    // without coercion; force empty so authors notice the bug.
    expect(renderTitleTemplate('{{item.thing}}', { __key: 'a', thing: { nested: true } })).toBe('');
  });
});

describe('buildApprovalPayload', () => {
  it('projects flat sections, dropping rejected items', () => {
    const schema: ReviewSchema = {
      sections: [
        {
          id: 'newModels',
          title: 'new',
          source: '{{discover.output.newModels}}',
          itemKey: 'slug',
          itemTitle: '{{item.name}}',
          fields: [{ key: 'name', label: 'Name', display: 'text' }],
        },
      ],
    };
    const sectionsData: SectionData[] = [
      {
        section: schema.sections[0],
        items: [
          { __key: 'a', slug: 'a', name: 'A' },
          { __key: 'b', slug: 'b', name: 'B' },
        ],
      },
    ];
    const selection: ReviewSelectionState = {
      newModels: {
        items: {
          a: { decision: 'accept' } satisfies FlatItemState,
          b: { decision: 'reject' } satisfies FlatItemState,
        },
      },
    };
    const payload = buildApprovalPayload(schema, sectionsData, selection);
    expect(payload.newModels).toEqual([{ slug: 'a', name: 'A' }]);
  });

  it('projects nested sections, filtering sub-items', () => {
    const schema: ReviewSchema = {
      sections: [
        {
          id: 'models',
          title: 'models',
          source: '{{refine.output.models}}',
          itemKey: 'model_id',
          itemTitle: '{{item.modelName}}',
          subItems: {
            source: 'item.changes',
            itemKey: 'field',
            fields: [
              { key: 'field', label: 'Field', display: 'text', readonly: true },
              { key: 'proposedValue', label: 'Proposed', display: 'text' },
            ],
          },
        },
      ],
    };
    const sectionsData: SectionData[] = [
      {
        section: schema.sections[0],
        items: [
          {
            __key: 'm1',
            model_id: 'm1',
            modelName: 'Claude',
            changes: [
              { field: 'tierRole', proposedValue: 'thinking' },
              { field: 'latency', proposedValue: 'fast' },
            ],
          },
        ],
      },
    ];
    const selection: ReviewSelectionState = {
      models: {
        items: {
          m1: {
            decision: 'accept',
            subItems: {
              tierRole: { decision: 'accept' },
              latency: { decision: 'reject' },
            },
          } satisfies NestedItemState,
        },
      },
    };
    const payload = buildApprovalPayload(schema, sectionsData, selection);
    expect(payload.models).toEqual([
      {
        model_id: 'm1',
        modelName: 'Claude',
        changes: [{ field: 'tierRole', proposedValue: 'thinking' }],
      },
    ]);
  });

  it('drops parent items when no sub-items survive filtering', () => {
    const schema: ReviewSchema = {
      sections: [
        {
          id: 'models',
          title: 'models',
          source: '{{refine.output.models}}',
          itemKey: 'model_id',
          itemTitle: '{{item.model_id}}',
          subItems: {
            source: 'item.changes',
            itemKey: 'field',
            fields: [{ key: 'field', label: 'Field', display: 'text' }],
          },
        },
      ],
    };
    const sectionsData: SectionData[] = [
      {
        section: schema.sections[0],
        items: [
          {
            __key: 'm1',
            model_id: 'm1',
            changes: [{ field: 'tierRole' }],
          },
        ],
      },
    ];
    const selection: ReviewSelectionState = {
      models: {
        items: {
          m1: {
            decision: 'accept',
            subItems: { tierRole: { decision: 'reject' } },
          },
        },
      },
    };
    const payload = buildApprovalPayload(schema, sectionsData, selection);
    expect(payload.models).toEqual([]);
  });

  it('applies overrides to flat-section items in modify mode', () => {
    const schema: ReviewSchema = {
      sections: [
        {
          id: 'newModels',
          title: 'new',
          source: '{{discover.output.newModels}}',
          itemKey: 'slug',
          itemTitle: '{{item.name}}',
          fields: [
            { key: 'name', label: 'Name', display: 'text', editable: true },
            { key: 'tierRole', label: 'Tier', display: 'badge', editable: true },
            // Read-only field — overrides on this key should be ignored.
            { key: 'slug', label: 'Slug', display: 'text', readonly: true },
          ],
        },
      ],
    };
    const sectionsData: SectionData[] = [
      {
        section: schema.sections[0],
        items: [{ __key: 'a', slug: 'a', name: 'Original', tierRole: 'worker' }],
      },
    ];
    const selection: ReviewSelectionState = {
      newModels: {
        items: {
          a: {
            decision: 'accept',
            overrides: {
              name: 'Edited',
              tierRole: 'thinking',
              // This override targets a readonly field; the builder
              // must drop it rather than letting an admin slip a
              // forbidden change through.
              slug: 'hacked-slug',
            },
          } satisfies FlatItemState,
        },
      },
    };
    const payload = buildApprovalPayload(schema, sectionsData, selection);
    expect(payload.newModels).toEqual([{ slug: 'a', name: 'Edited', tierRole: 'thinking' }]);
  });

  it('applies overrides to nested sub-item rows', () => {
    const schema: ReviewSchema = {
      sections: [
        {
          id: 'models',
          title: 'models',
          source: '{{refine.output.models}}',
          itemKey: 'model_id',
          itemTitle: '{{item.model_id}}',
          subItems: {
            source: 'item.changes',
            itemKey: 'field',
            fields: [
              { key: 'field', label: 'Field', display: 'text', readonly: true },
              {
                key: 'proposedValue',
                label: 'Proposed',
                display: 'text',
                editable: true,
                enumValuesByFieldKey: 'field',
              },
            ],
          },
        },
      ],
    };
    const sectionsData: SectionData[] = [
      {
        section: schema.sections[0],
        items: [
          {
            __key: 'm1',
            model_id: 'm1',
            changes: [{ field: 'tierRole', proposedValue: 'worker' }],
          },
        ],
      },
    ];
    const selection: ReviewSelectionState = {
      models: {
        items: {
          m1: {
            decision: 'accept',
            subItems: {
              tierRole: {
                decision: 'accept',
                overrides: { proposedValue: 'thinking' },
              },
            },
          },
        },
      },
    };
    const payload = buildApprovalPayload(schema, sectionsData, selection);
    expect(payload.models).toEqual([
      { model_id: 'm1', changes: [{ field: 'tierRole', proposedValue: 'thinking' }] },
    ]);
  });

  it('treats untouched items as accepted (default)', () => {
    const schema: ReviewSchema = {
      sections: [
        {
          id: 'deactivateModels',
          title: 'deactivations',
          source: '{{a.output.deactivateModels}}',
          itemKey: 'modelId',
          itemTitle: '{{item.modelId}}',
          fields: [{ key: 'reason', label: 'Reason', display: 'text' }],
        },
      ],
    };
    const sectionsData: SectionData[] = [
      {
        section: schema.sections[0],
        items: [
          { __key: 'm1', modelId: 'm1', reason: 'deprecated' },
          { __key: 'm2', modelId: 'm2', reason: 'replaced' },
        ],
      },
    ];
    const payload = buildApprovalPayload(schema, sectionsData, {});
    expect(payload.deactivateModels).toEqual([
      { modelId: 'm1', reason: 'deprecated' },
      { modelId: 'm2', reason: 'replaced' },
    ]);
  });
});
