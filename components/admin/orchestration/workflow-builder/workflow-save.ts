/**
 * Pure save helper for the workflow builder.
 *
 * Kept out of any React component so unit tests can exercise the full
 * create/edit path without mounting the builder shell. The builder wires
 * this up inside a `handleSave` callback and owns the loading/error state.
 *
 * The only non-trivial behaviour here is that we run the existing
 * `flowToWorkflowDefinition` mapper and then hand the result to the
 * `apiClient` — server-side Zod still gets the final word on whether the
 * definition is saveable (name / slug / description / ≥1 step).
 */
import type { Edge } from '@xyflow/react';

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import type { AiWorkflow } from '@/types/orchestration';

import { flowToWorkflowDefinition, type PatternNode } from './workflow-mappers';

/** Details captured via `WorkflowDetailsDialog` before the first create save. */
export interface WorkflowDetails {
  slug: string;
  description: string;
  errorStrategy: 'retry' | 'fallback' | 'fail';
  isTemplate: boolean;
}

export interface WorkflowSavePayload {
  mode: 'create' | 'edit';
  /** Required in edit mode; ignored in create mode. */
  workflowId?: string;
  name: string;
  nodes: readonly PatternNode[];
  edges: readonly Edge[];
  details: WorkflowDetails;
}

/**
 * Serialise the React Flow state and POST/PATCH via `apiClient`.
 *
 * - Create mode → POST `/workflows` with the full payload.
 * - Edit mode → PATCH `/workflows/:id` with the full payload (simpler than
 *   computing a diff; the route accepts all fields as optional so the
 *   server applies exactly what we send).
 *
 * Errors propagate unchanged so the caller can distinguish `APIClientError`
 * (shows a red inline alert) from network failures.
 */
export async function saveWorkflow(payload: WorkflowSavePayload): Promise<AiWorkflow> {
  const definition = flowToWorkflowDefinition(payload.nodes, payload.edges, {
    errorStrategy: payload.details.errorStrategy,
  });

  const body = {
    name: payload.name,
    slug: payload.details.slug,
    description: payload.details.description,
    workflowDefinition: definition,
    isTemplate: payload.details.isTemplate,
  };

  if (payload.mode === 'create') {
    return apiClient.post<AiWorkflow>(API.ADMIN.ORCHESTRATION.WORKFLOWS, { body });
  }

  if (!payload.workflowId) {
    throw new Error('workflowId is required when saving in edit mode');
  }
  return apiClient.patch<AiWorkflow>(API.ADMIN.ORCHESTRATION.workflowById(payload.workflowId), {
    body,
  });
}
