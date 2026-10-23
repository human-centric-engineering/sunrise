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

import {
  flowToWorkflowDefinition,
  type PatternNode,
} from '@/components/admin/orchestration/workflow-builder/workflow-mappers';

/** Details captured via `WorkflowDetailsDialog` before the first create save. */
export interface WorkflowDetails {
  slug: string;
  description: string;
  errorStrategy: 'retry' | 'fallback' | 'skip' | 'fail';
  isTemplate: boolean;
  /**
   * Per-execution cost cap (USD). When set, every execution of this
   * workflow inherits the cap unless the caller passes an explicit
   * `budgetLimitUsd`. Null inherits the org-wide default
   * (`AiOrchestrationSettings.defaultMaxCostPerExecutionUsd`).
   * Runaway-loop guard from improvement #39.
   */
  maxCostPerExecutionUsd: number | null;
}

export interface WorkflowSavePayload {
  mode: 'create' | 'edit';
  /** Required in edit mode; ignored in create mode. */
  workflowId?: string;
  /**
   * Edit mode: the definition version the builder loaded, sent as `If-Match`
   * (§122 t-900). A save refused because it moved on throws `STALE_RECORD`.
   */
  definitionVersion?: string;
  /**
   * Create mode: the custom template the canvas was loaded from, sent as
   * `copiedFrom` (§122 t-900): the server refuses the copy if the template
   * moved on since. Templates cannot be applied in edit mode.
   */
  copiedFrom?: { workflowId: string; definitionVersion: string };
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
export async function saveWorkflow(
  payload: WorkflowSavePayload
): Promise<AiWorkflow & { definitionVersion?: string }> {
  const definition = flowToWorkflowDefinition(payload.nodes, payload.edges, {
    errorStrategy: payload.details.errorStrategy,
  });

  if (payload.mode === 'create') {
    return apiClient.post<AiWorkflow>(API.ADMIN.ORCHESTRATION.WORKFLOWS, {
      body: {
        name: payload.name,
        slug: payload.details.slug,
        description: payload.details.description,
        workflowDefinition: definition,
        ...(payload.copiedFrom ? { copiedFrom: payload.copiedFrom } : {}),
        isTemplate: payload.details.isTemplate,
        maxCostPerExecutionUsd: payload.details.maxCostPerExecutionUsd,
      },
    });
  }

  if (!payload.workflowId || !payload.definitionVersion) {
    throw new Error('workflowId and definitionVersion are required when saving in edit mode');
  }
  // PATCH writes the canvas state to `draftDefinition`; the published version
  // is only updated by an explicit POST /publish from Phase 3's UI.
  return apiClient.patch<AiWorkflow & { definitionVersion: string }>(
    API.ADMIN.ORCHESTRATION.workflowById(payload.workflowId),
    {
      options: { headers: { 'If-Match': payload.definitionVersion } },
      body: {
        name: payload.name,
        slug: payload.details.slug,
        description: payload.details.description,
        draftDefinition: definition,
        isTemplate: payload.details.isTemplate,
        maxCostPerExecutionUsd: payload.details.maxCostPerExecutionUsd,
      },
    }
  );
}
