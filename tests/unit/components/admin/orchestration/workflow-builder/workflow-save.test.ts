/**
 * Unit Tests: saveWorkflow
 *
 * Test Coverage:
 * - Create mode → apiClient.post called with correct body shape
 * - Edit mode → apiClient.patch called on workflowById(id) with correct body shape
 * - Body includes serialised workflowDefinition from flowToWorkflowDefinition
 * - Propagates APIClientError from the client unchanged
 * - Edit mode without workflowId throws an error
 *
 * @see components/admin/orchestration/workflow-builder/workflow-save.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Edge } from '@xyflow/react';

// ─── Mock apiClient ──────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: vi.fn(),
    patch: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    code?: string;
    status?: number;
    constructor(message: string, code?: string, status?: number) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
      this.status = status;
    }
  },
}));

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { saveWorkflow } from '@/components/admin/orchestration/workflow-builder/workflow-save';
import type { PatternNode } from '@/components/admin/orchestration/workflow-builder/workflow-mappers';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_WORKFLOW_RESPONSE = {
  id: 'wf-created-1',
  name: 'My Workflow',
  slug: 'my-workflow',
  description: 'A workflow',
  workflowDefinition: {},
  isTemplate: false,
  isActive: true,
  patternsUsed: [],
  metadata: null,
  createdBy: 'user-1',
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
};

function makeNode(id: string): PatternNode {
  return {
    id,
    type: 'pattern',
    position: { x: 0, y: 0 },
    data: {
      label: 'LLM Step',
      type: 'llm_call',
      config: { prompt: 'hello world' },
    },
  };
}

const VALID_DETAILS = {
  slug: 'my-workflow',
  description: 'A test workflow',
  errorStrategy: 'fail' as const,
  isTemplate: false,
  maxCostPerExecutionUsd: null,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('saveWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.post).mockResolvedValue(MOCK_WORKFLOW_RESPONSE);
    vi.mocked(apiClient.patch).mockResolvedValue({ ...MOCK_WORKFLOW_RESPONSE, id: 'wf-edit-1' });
  });

  describe('create mode', () => {
    it('calls apiClient.post with the WORKFLOWS endpoint', async () => {
      const nodes: PatternNode[] = [makeNode('step-1')];
      const edges: Edge[] = [];

      await saveWorkflow({
        mode: 'create',
        name: 'My Workflow',
        nodes,
        edges,
        details: VALID_DETAILS,
      });

      expect(apiClient.post).toHaveBeenCalledTimes(1);
      const [url] = vi.mocked(apiClient.post).mock.calls[0];
      expect(url).toBe(API.ADMIN.ORCHESTRATION.WORKFLOWS);
    });

    it('sends name, slug, description, workflowDefinition, isTemplate in the body', async () => {
      const nodes: PatternNode[] = [makeNode('step-1')];
      const edges: Edge[] = [];

      await saveWorkflow({
        mode: 'create',
        name: 'My Workflow',
        nodes,
        edges,
        details: VALID_DETAILS,
      });

      const [, options] = vi.mocked(apiClient.post).mock.calls[0];
      const body = options?.body as Record<string, unknown>;
      expect(body.name).toBe('My Workflow');
      expect(body.slug).toBe('my-workflow');
      expect(body.description).toBe('A test workflow');
      expect(body.isTemplate).toBe(false);
      expect(body.workflowDefinition).toBeDefined();
    });

    it('serialises a workflowDefinition with the correct step', async () => {
      const nodes: PatternNode[] = [makeNode('step-1')];
      const edges: Edge[] = [];

      await saveWorkflow({
        mode: 'create',
        name: 'My Workflow',
        nodes,
        edges,
        details: VALID_DETAILS,
      });

      const [, options] = vi.mocked(apiClient.post).mock.calls[0];
      const body = options?.body as Record<string, unknown>;
      const def = body.workflowDefinition as { steps: Array<{ id: string; type: string }> };
      expect(def.steps).toHaveLength(1);
      expect(def.steps[0].id).toBe('step-1');
      expect(def.steps[0].type).toBe('llm_call');
    });

    it('uses errorStrategy from details in the workflowDefinition', async () => {
      const nodes: PatternNode[] = [makeNode('step-1')];
      const edges: Edge[] = [];

      await saveWorkflow({
        mode: 'create',
        name: 'My Workflow',
        nodes,
        edges,
        details: { ...VALID_DETAILS, errorStrategy: 'retry' },
      });

      const [, options] = vi.mocked(apiClient.post).mock.calls[0];
      const body = options?.body as Record<string, unknown>;
      const def = body.workflowDefinition as { errorStrategy: string };
      expect(def.errorStrategy).toBe('retry');
    });

    it('does NOT call apiClient.patch in create mode', async () => {
      const nodes: PatternNode[] = [makeNode('step-1')];
      const edges: Edge[] = [];

      await saveWorkflow({
        mode: 'create',
        name: 'My Workflow',
        nodes,
        edges,
        details: VALID_DETAILS,
      });

      expect(apiClient.patch).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });
  });

  describe('a canvas copied from a custom template (§122 t-900)', () => {
    const COPY = { workflowId: 'cmjbv4i3x00003wslotemplate', definitionVersion: '"tpl-v1"' };

    it('sends copiedFrom with the create', async () => {
      await saveWorkflow({
        mode: 'create',
        name: 'From template',
        nodes: [makeNode('step-1')],
        edges: [],
        details: VALID_DETAILS,
        copiedFrom: COPY,
      });

      const [, options] = vi.mocked(apiClient.post).mock.calls[0];
      expect((options?.body as Record<string, unknown>).copiedFrom).toEqual(COPY);
    });

    it('sends no copiedFrom with a create typed from scratch', async () => {
      await saveWorkflow({
        mode: 'create',
        name: 'Scratch',
        nodes: [makeNode('step-1')],
        edges: [],
        details: VALID_DETAILS,
      });

      const [, options] = vi.mocked(apiClient.post).mock.calls[0];
      expect(options?.body).not.toHaveProperty('copiedFrom');
    });
  });

  describe('edit mode', () => {
    it('calls apiClient.patch with the workflowById URL', async () => {
      const nodes: PatternNode[] = [makeNode('step-1')];
      const edges: Edge[] = [];

      await saveWorkflow({
        mode: 'edit',
        workflowId: 'wf-edit-1',
        definitionVersion: '"v-loaded"',
        name: 'My Workflow',
        nodes,
        edges,
        details: VALID_DETAILS,
      });

      expect(apiClient.patch).toHaveBeenCalledTimes(1);
      const [url] = vi.mocked(apiClient.patch).mock.calls[0];
      expect(url).toBe(API.ADMIN.ORCHESTRATION.workflowById('wf-edit-1'));
    });

    it('writes the canvas to draftDefinition (not workflowDefinition) on PATCH', async () => {
      const nodes: PatternNode[] = [makeNode('step-1')];
      const edges: Edge[] = [];

      await saveWorkflow({
        mode: 'edit',
        workflowId: 'wf-edit-1',
        definitionVersion: '"v-loaded"',
        name: 'Updated Workflow',
        nodes,
        edges,
        details: { ...VALID_DETAILS, slug: 'updated-workflow', description: 'Updated' },
      });

      const [, options] = vi.mocked(apiClient.patch).mock.calls[0];
      const body = options?.body as Record<string, unknown>;
      expect(body.name).toBe('Updated Workflow');
      expect(body.slug).toBe('updated-workflow');
      expect(body.description).toBe('Updated');
      // PATCH writes to the draft only — published version is not overwritten
      // until an explicit POST /publish.
      expect(body.draftDefinition).toBeDefined();
      expect(body.workflowDefinition).toBeUndefined();
    });

    it('does NOT call apiClient.post in edit mode', async () => {
      const nodes: PatternNode[] = [makeNode('step-1')];
      const edges: Edge[] = [];

      await saveWorkflow({
        mode: 'edit',
        workflowId: 'wf-edit-1',
        definitionVersion: '"v-loaded"',
        name: 'My Workflow',
        nodes,
        edges,
        details: VALID_DETAILS,
      });

      expect(apiClient.post).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('throws an error when workflowId is missing in edit mode', async () => {
      const nodes: PatternNode[] = [makeNode('step-1')];
      const edges: Edge[] = [];

      await expect(
        saveWorkflow({
          mode: 'edit',
          definitionVersion: '"v-loaded"',
          name: 'My Workflow',
          nodes,
          edges,
          details: VALID_DETAILS,
        })
      ).rejects.toThrow('workflowId and definitionVersion are required when saving in edit mode');
    });

    it('throws rather than send a save with no definition version (§122 t-900)', async () => {
      await expect(
        saveWorkflow({
          mode: 'edit',
          workflowId: 'wf-edit-1',
          name: 'My Workflow',
          nodes: [makeNode('step-1')],
          edges: [],
          details: VALID_DETAILS,
        })
      ).rejects.toThrow('workflowId and definitionVersion are required');
      expect(apiClient.patch).not.toHaveBeenCalled();
    });

    it('sends the definition version it loaded as If-Match (§122 t-900)', async () => {
      await saveWorkflow({
        mode: 'edit',
        workflowId: 'wf-edit-1',
        definitionVersion: '"v-loaded"',
        name: 'My Workflow',
        nodes: [makeNode('step-1')],
        edges: [],
        details: VALID_DETAILS,
      });

      const [, options] = vi.mocked(apiClient.patch).mock.calls[0];
      expect(options?.options?.headers).toEqual({ 'If-Match': '"v-loaded"' });
    });
  });

  describe('error propagation', () => {
    it('propagates APIClientError from apiClient.post unchanged', async () => {
      const apiError = new APIClientError('Validation failed', 'VALIDATION_ERROR', 400);
      vi.mocked(apiClient.post).mockRejectedValue(apiError);

      const nodes: PatternNode[] = [makeNode('step-1')];
      const edges: Edge[] = [];

      await expect(
        saveWorkflow({ mode: 'create', name: 'My Workflow', nodes, edges, details: VALID_DETAILS })
      ).rejects.toThrow('Validation failed');
    });

    it('propagates APIClientError from apiClient.patch unchanged', async () => {
      const apiError = new APIClientError('Not found', 'NOT_FOUND', 404);
      vi.mocked(apiClient.patch).mockRejectedValue(apiError);

      const nodes: PatternNode[] = [makeNode('step-1')];
      const edges: Edge[] = [];

      await expect(
        saveWorkflow({
          mode: 'edit',
          workflowId: 'wf-edit-1',
          definitionVersion: '"v-loaded"',
          name: 'My Workflow',
          nodes,
          edges,
          details: VALID_DETAILS,
        })
      ).rejects.toThrow('Not found');
    });
  });
});
