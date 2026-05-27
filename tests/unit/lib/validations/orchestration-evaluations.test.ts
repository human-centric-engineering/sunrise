/**
 * Unit tests for the Phase 1 evaluation Zod schemas.
 *
 * Pure Zod validation — no mocks. Each schema gets at least one
 * happy-path + one failure case per branch (especially the .refine()
 * checks on createRunSchema, where the rules are non-obvious).
 */

import { describe, it, expect } from 'vitest';

import {
  createDatasetJsonSchema,
  createRunSchema,
  estimateRunCostSchema,
  gateConfigSchema,
  listDatasetCasesQuerySchema,
  listDatasetsQuerySchema,
  listRunCasesQuerySchema,
  listRunsQuerySchema,
  patchDatasetSchema,
  runPairwiseVerdictSchema,
} from '@/lib/validations/orchestration-evaluations';

// ---------------------------------------------------------------------------
// listDatasetsQuerySchema
// ---------------------------------------------------------------------------

describe('listDatasetsQuerySchema', () => {
  it('defaults page=1 and limit=20 when empty', () => {
    const r = listDatasetsQuerySchema.parse({});
    expect(r.page).toBe(1);
    expect(r.limit).toBe(20);
  });

  it('coerces string-number page/limit from query strings', () => {
    const r = listDatasetsQuerySchema.parse({ page: '3', limit: '50' });
    expect(r.page).toBe(3);
    expect(r.limit).toBe(50);
  });

  it('rejects negative page', () => {
    expect(() => listDatasetsQuerySchema.parse({ page: -1 })).toThrow();
  });

  it('rejects limit > 100', () => {
    expect(() => listDatasetsQuerySchema.parse({ limit: 101 })).toThrow();
  });

  it('accepts optional q and tag', () => {
    const r = listDatasetsQuerySchema.parse({ q: 'support', tag: 'refund' });
    expect(r.q).toBe('support');
    expect(r.tag).toBe('refund');
  });

  it('rejects q longer than 120 chars', () => {
    expect(() => listDatasetsQuerySchema.parse({ q: 'x'.repeat(121) })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createDatasetJsonSchema
// ---------------------------------------------------------------------------

describe('createDatasetJsonSchema', () => {
  it('accepts the minimal valid body', () => {
    const r = createDatasetJsonSchema.parse({
      name: 'My dataset',
      cases: [{ input: 'hello' }],
    });
    expect(r.cases).toHaveLength(1);
  });

  it('accepts object-shaped input', () => {
    const r = createDatasetJsonSchema.parse({
      name: 'wf cases',
      cases: [{ input: { sku: 'ABC' }, expectedOutput: 'ok' }],
    });
    expect(r.cases[0].input).toEqual({ sku: 'ABC' });
  });

  it('rejects empty cases array', () => {
    expect(() => createDatasetJsonSchema.parse({ name: 'x', cases: [] })).toThrow();
  });

  it('rejects more than 10000 cases', () => {
    const cases = Array.from({ length: 10001 }, () => ({ input: 'x' }));
    expect(() => createDatasetJsonSchema.parse({ name: 'x', cases })).toThrow();
  });

  it('rejects unknown fields on a case (strict)', () => {
    expect(() =>
      createDatasetJsonSchema.parse({
        name: 'x',
        cases: [{ input: 'a', extraField: 'nope' }],
      })
    ).toThrow();
  });

  it('rejects empty name', () => {
    expect(() => createDatasetJsonSchema.parse({ name: '', cases: [{ input: 'a' }] })).toThrow();
  });

  it('rejects empty-string input', () => {
    expect(() => createDatasetJsonSchema.parse({ name: 'x', cases: [{ input: '' }] })).toThrow();
  });

  it('accepts optional description, tags, metadata, referenceCitations', () => {
    const r = createDatasetJsonSchema.parse({
      name: 'rich',
      description: 'notes',
      tags: ['a', 'b'],
      cases: [
        {
          input: 'q',
          expectedOutput: 'a',
          metadata: { difficulty: 'high' },
          referenceCitations: [{ marker: 1 }],
        },
      ],
    });
    expect(r.tags).toEqual(['a', 'b']);
    expect(r.cases[0].metadata).toEqual({ difficulty: 'high' });
  });

  it('rejects more than 20 tags', () => {
    expect(() =>
      createDatasetJsonSchema.parse({
        name: 'x',
        tags: Array.from({ length: 21 }, (_, i) => `t${i}`),
        cases: [{ input: 'a' }],
      })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// patchDatasetSchema
// ---------------------------------------------------------------------------

describe('patchDatasetSchema', () => {
  it('accepts a single-field rename', () => {
    const r = patchDatasetSchema.parse({ name: 'New name' });
    expect(r.name).toBe('New name');
  });

  it('accepts description=null (clear)', () => {
    const r = patchDatasetSchema.parse({ description: null });
    expect(r.description).toBeNull();
  });

  it('rejects empty body via the .refine() rule', () => {
    expect(() => patchDatasetSchema.parse({})).toThrow(/At least one field/);
  });

  it('accepts a tags-only update', () => {
    const r = patchDatasetSchema.parse({ tags: ['x'] });
    expect(r.tags).toEqual(['x']);
  });
});

// ---------------------------------------------------------------------------
// listDatasetCasesQuerySchema & listRunCasesQuerySchema
// ---------------------------------------------------------------------------

describe('cursor-paginated query schemas', () => {
  it('listDatasetCasesQuerySchema defaults limit=50, cursor optional', () => {
    const r = listDatasetCasesQuerySchema.parse({});
    expect(r.limit).toBe(50);
    expect(r.cursor).toBeUndefined();
  });

  it('listDatasetCasesQuerySchema coerces string cursor', () => {
    const r = listDatasetCasesQuerySchema.parse({ cursor: '17' });
    expect(r.cursor).toBe(17);
  });

  it('listDatasetCasesQuerySchema rejects limit > 200', () => {
    expect(() => listDatasetCasesQuerySchema.parse({ limit: 201 })).toThrow();
  });

  it('listRunCasesQuerySchema mirrors the same shape', () => {
    const r = listRunCasesQuerySchema.parse({ cursor: '0', limit: '10' });
    expect(r.cursor).toBe(0);
    expect(r.limit).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// listRunsQuerySchema
// ---------------------------------------------------------------------------

describe('listRunsQuerySchema', () => {
  it('defaults page=1, limit=20', () => {
    const r = listRunsQuerySchema.parse({});
    expect(r.page).toBe(1);
    expect(r.limit).toBe(20);
  });

  it('accepts every valid status enum', () => {
    for (const status of ['queued', 'running', 'completed', 'failed', 'cancelled'] as const) {
      const r = listRunsQuerySchema.parse({ status });
      expect(r.status).toBe(status);
    }
  });

  it('rejects an invalid status', () => {
    expect(() => listRunsQuerySchema.parse({ status: 'paused' })).toThrow();
  });

  it('accepts both subjectKind values', () => {
    expect(listRunsQuerySchema.parse({ subjectKind: 'agent' }).subjectKind).toBe('agent');
    expect(listRunsQuerySchema.parse({ subjectKind: 'workflow' }).subjectKind).toBe('workflow');
  });

  it('passes through optional datasetId and agentId filters', () => {
    const r = listRunsQuerySchema.parse({ datasetId: 'ds-1', agentId: 'ag-1' });
    expect(r.datasetId).toBe('ds-1');
    expect(r.agentId).toBe('ag-1');
  });
});

// ---------------------------------------------------------------------------
// createRunSchema — the most complex (two .refine() rules)
// ---------------------------------------------------------------------------

describe('createRunSchema', () => {
  const baseAgentRun = {
    name: 'My run',
    subjectKind: 'agent' as const,
    agentId: 'agent-1',
    datasetId: 'ds-1',
    metricConfigs: [{ slug: 'exact_match' }],
  };

  it('accepts a minimal agent run', () => {
    const r = createRunSchema.parse(baseAgentRun);
    expect(r.subjectKind).toBe('agent');
    expect(r.agentId).toBe('agent-1');
  });

  it('accepts a workflow run with workflowId', () => {
    const r = createRunSchema.parse({
      ...baseAgentRun,
      subjectKind: 'workflow',
      agentId: undefined,
      workflowId: 'wf-1',
    });
    expect(r.subjectKind).toBe('workflow');
    expect(r.workflowId).toBe('wf-1');
  });

  it('rejects agent subjectKind without agentId', () => {
    expect(() => createRunSchema.parse({ ...baseAgentRun, agentId: undefined })).toThrow(
      /exactly one/
    );
  });

  it('rejects workflow subjectKind without workflowId', () => {
    expect(() =>
      createRunSchema.parse({ ...baseAgentRun, subjectKind: 'workflow', agentId: undefined })
    ).toThrow(/exactly one/);
  });

  it('rejects BOTH agentId AND workflowId on the same run', () => {
    expect(() => createRunSchema.parse({ ...baseAgentRun, workflowId: 'wf-1' })).toThrow(
      /exactly one/
    );
  });

  it('rejects mismatched subjectKind (agent kind + workflowId)', () => {
    expect(() =>
      createRunSchema.parse({
        ...baseAgentRun,
        agentId: undefined,
        workflowId: 'wf-1',
      })
    ).toThrow(/exactly one/);
  });

  it('rejects judgeProvider without judgeModel', () => {
    expect(() => createRunSchema.parse({ ...baseAgentRun, judgeProvider: 'openai' })).toThrow(
      /together or omitted together/
    );
  });

  it('rejects judgeModel without judgeProvider', () => {
    expect(() => createRunSchema.parse({ ...baseAgentRun, judgeModel: 'gpt-4o' })).toThrow(
      /together or omitted together/
    );
  });

  it('accepts judgeProvider + judgeModel as a pair', () => {
    const r = createRunSchema.parse({
      ...baseAgentRun,
      judgeProvider: 'openai',
      judgeModel: 'gpt-4o',
    });
    expect(r.judgeProvider).toBe('openai');
    expect(r.judgeModel).toBe('gpt-4o');
  });

  it('requires at least one metric', () => {
    expect(() => createRunSchema.parse({ ...baseAgentRun, metricConfigs: [] })).toThrow(
      /At least one metric/
    );
  });

  it('accepts metricConfigs with optional config', () => {
    const r = createRunSchema.parse({
      ...baseAgentRun,
      metricConfigs: [
        { slug: 'judge_agent', config: { agentSlug: 'eval-judge-relevance' } },
        { slug: 'contains' },
      ],
    });
    expect(r.metricConfigs).toHaveLength(2);
  });

  it('accepts optional subjectOutputSelector', () => {
    const r = createRunSchema.parse({
      ...baseAgentRun,
      subjectOutputSelector: { kind: 'step_id', stepId: 'step-1' },
    });
    expect(r.subjectOutputSelector?.kind).toBe('step_id');
  });

  it('rejects invalid subjectOutputSelector kind', () => {
    expect(() =>
      createRunSchema.parse({
        ...baseAgentRun,
        subjectOutputSelector: { kind: 'invalid' },
      })
    ).toThrow();
  });

  it('rejects empty name', () => {
    expect(() => createRunSchema.parse({ ...baseAgentRun, name: '' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// estimateRunCostSchema (Phase 3.5b — workflow-aware)
// ---------------------------------------------------------------------------

describe('estimateRunCostSchema', () => {
  it("defaults subjectKind to 'agent' when omitted", () => {
    const r = estimateRunCostSchema.parse({ agentId: 'agent-1', datasetId: 'ds-1' });
    expect(r.subjectKind).toBe('agent');
    expect(r.judgeAgentSlugs).toEqual([]);
  });

  it('accepts a workflow subject with workflowId', () => {
    const r = estimateRunCostSchema.parse({
      subjectKind: 'workflow',
      workflowId: 'wf-1',
      datasetId: 'ds-1',
    });
    expect(r.subjectKind).toBe('workflow');
    expect(r.workflowId).toBe('wf-1');
  });

  it('rejects subjectKind=agent without agentId', () => {
    expect(() =>
      estimateRunCostSchema.parse({ subjectKind: 'agent', datasetId: 'ds-1' })
    ).toThrow();
  });

  it('rejects subjectKind=workflow without workflowId', () => {
    expect(() =>
      estimateRunCostSchema.parse({ subjectKind: 'workflow', datasetId: 'ds-1' })
    ).toThrow();
  });

  it('accepts an explicit caseCount override (for in-progress dataset previews)', () => {
    const r = estimateRunCostSchema.parse({
      agentId: 'a',
      datasetId: 'ds-1',
      caseCount: '42',
    });
    expect(r.caseCount).toBe(42);
  });

  it('rejects a negative caseCount', () => {
    expect(() =>
      estimateRunCostSchema.parse({ agentId: 'a', datasetId: 'ds-1', caseCount: -3 })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// gateConfigSchema (Phase 4 — minimal CI gate)
// ---------------------------------------------------------------------------

describe('gateConfigSchema', () => {
  it('accepts a single mean-only threshold', () => {
    const r = gateConfigSchema.parse({
      thresholds: [{ metricSlug: 'judge_agent', minMean: 0.8 }],
    });
    expect(r.thresholds).toHaveLength(1);
    expect(r.thresholds[0].minMean).toBe(0.8);
  });

  it('accepts a single passRate-only threshold', () => {
    const r = gateConfigSchema.parse({
      thresholds: [{ metricSlug: 'judge_agent', minPassRate: 0.9 }],
    });
    expect(r.thresholds[0].minPassRate).toBe(0.9);
  });

  it('accepts thresholds with both mean and passRate set', () => {
    const r = gateConfigSchema.parse({
      thresholds: [{ metricSlug: 'judge_agent', minMean: 0.8, minPassRate: 0.9 }],
    });
    expect(r.thresholds[0].minMean).toBe(0.8);
    expect(r.thresholds[0].minPassRate).toBe(0.9);
  });

  it('rejects a threshold with neither minMean nor minPassRate', () => {
    expect(() => gateConfigSchema.parse({ thresholds: [{ metricSlug: 'judge_agent' }] })).toThrow();
  });

  it('rejects an empty thresholds array', () => {
    expect(() => gateConfigSchema.parse({ thresholds: [] })).toThrow();
  });

  it('rejects more than 20 thresholds (anti-abuse cap)', () => {
    const tooMany = Array.from({ length: 21 }, () => ({
      metricSlug: 'judge_agent',
      minMean: 0.5,
    }));
    expect(() => gateConfigSchema.parse({ thresholds: tooMany })).toThrow();
  });

  it('rejects minMean outside [0, 1]', () => {
    expect(() =>
      gateConfigSchema.parse({
        thresholds: [{ metricSlug: 'judge_agent', minMean: 1.5 }],
      })
    ).toThrow();
    expect(() =>
      gateConfigSchema.parse({
        thresholds: [{ metricSlug: 'judge_agent', minMean: -0.1 }],
      })
    ).toThrow();
  });

  it('rejects an empty metricSlug', () => {
    expect(() =>
      gateConfigSchema.parse({ thresholds: [{ metricSlug: '', minMean: 0.5 }] })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// runPairwiseVerdictSchema (Phase 3.5a)
// ---------------------------------------------------------------------------

describe('runPairwiseVerdictSchema', () => {
  it('accepts a valid body with distinct variant ids', () => {
    const r = runPairwiseVerdictSchema.parse({
      judgeAgentSlug: 'eval-judge-correctness',
      variantAId: 'v-a',
      variantBId: 'v-b',
    });
    expect(r.judgeAgentSlug).toBe('eval-judge-correctness');
    expect(r.variantAId).toBe('v-a');
    expect(r.variantBId).toBe('v-b');
  });

  it('rejects equal variantAId / variantBId', () => {
    expect(() =>
      runPairwiseVerdictSchema.parse({
        judgeAgentSlug: 'eval-judge-correctness',
        variantAId: 'v-a',
        variantBId: 'v-a',
      })
    ).toThrow();
  });

  it('rejects empty judgeAgentSlug', () => {
    expect(() =>
      runPairwiseVerdictSchema.parse({
        judgeAgentSlug: '',
        variantAId: 'v-a',
        variantBId: 'v-b',
      })
    ).toThrow();
  });

  it('rejects extra unknown fields (.strict())', () => {
    expect(() =>
      runPairwiseVerdictSchema.parse({
        judgeAgentSlug: 'eval-judge-correctness',
        variantAId: 'v-a',
        variantBId: 'v-b',
        unexpectedField: 'should not be here',
      })
    ).toThrow();
  });
});
