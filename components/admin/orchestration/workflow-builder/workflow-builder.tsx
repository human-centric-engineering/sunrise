'use client';

/**
 * WorkflowBuilder — top-level client island rendered by the new/edit
 * admin pages.
 *
 * Owns the canvas state (nodes / edges / selection / name), the live
 * validation pipeline, and the save flow. Session 5.1b wiring:
 *
 *   - `capabilities` is fetched once for the Tool Call editor.
 *   - `validationErrors` is derived on every change from
 *     `validateWorkflow()` + `runExtraChecks()` (debounced 300 ms).
 *   - `errorByNodeId` marks each node with `data.hasError` so the
 *     `PatternNode` paints a red ring.
 *   - `handleSave` opens the `WorkflowDetailsDialog` the first time a
 *     create-mode save fires (we need slug + description before POST).
 *     On edit the details dialog is skipped and PATCH runs directly.
 *   - Save errors surface as an inline red alert above the canvas.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle } from 'lucide-react';
import {
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
} from '@xyflow/react';

import type { AiWorkflow } from '@prisma/client';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { logger } from '@/lib/logging';
import { validateWorkflow } from '@/lib/orchestration/workflows/validator';

import { BlockConfigPanel } from './block-config-panel';
import { BuilderToolbar } from './builder-toolbar';
import { ExecutionInputDialog } from './execution-input-dialog';
import { ExecutionPanel } from './execution-panel';
import { PatternPalette } from './pattern-palette';
import { TemplateDescriptionDialog } from './template-description-dialog';
import { ValidationSummaryPanel, type CombinedError } from './validation-summary-panel';
import { WorkflowCanvas } from './workflow-canvas';
import { WorkflowDetailsDialog } from './workflow-details-dialog';
import { runExtraChecks } from './extra-checks';
import { saveWorkflow, type WorkflowDetails } from './workflow-save';
import {
  flowToWorkflowDefinition,
  workflowDefinitionToFlow,
  type PatternNode,
} from './workflow-mappers';
import type { CapabilityOption } from './block-editors';
import type { WorkflowTemplate } from '@/lib/orchestration/workflows/templates';
import type { WorkflowDefinition } from '@/types/orchestration';

export type WorkflowBuilderMode = 'create' | 'edit';

export interface WorkflowBuilderProps {
  mode: WorkflowBuilderMode;
  workflow?: AiWorkflow | null;
  /** Pre-populate the canvas from a WorkflowDefinition (e.g. from advisor). */
  initialDefinition?: WorkflowDefinition;
}

interface InitialState {
  nodes: PatternNode[];
  edges: Edge[];
  name: string;
  details: WorkflowDetails | null;
}

function initialState(
  workflow: AiWorkflow | null | undefined,
  initialDefinition?: WorkflowDefinition
): InitialState {
  if (!workflow && initialDefinition && Array.isArray(initialDefinition.steps)) {
    const { nodes, edges } = workflowDefinitionToFlow(initialDefinition);
    return { nodes, edges, name: 'Imported workflow', details: null };
  }

  if (!workflow) {
    return { nodes: [], edges: [], name: 'Untitled workflow', details: null };
  }

  const def = workflow.workflowDefinition as unknown as WorkflowDefinition | null;
  const baseDetails: WorkflowDetails = {
    slug: workflow.slug,
    description: workflow.description,
    errorStrategy: def?.errorStrategy ?? 'fail',
    isTemplate: workflow.isTemplate,
  };

  if (!def || !Array.isArray(def.steps)) {
    return { nodes: [], edges: [], name: workflow.name, details: baseDetails };
  }

  const { nodes, edges } = workflowDefinitionToFlow(def);
  return { nodes, edges, name: workflow.name, details: baseDetails };
}

function WorkflowBuilderInner({ mode, workflow, initialDefinition }: WorkflowBuilderProps) {
  const router = useRouter();
  const seed = useMemo(
    () => initialState(workflow, initialDefinition),
    [workflow, initialDefinition]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<PatternNode>(seed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(seed.edges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [workflowName, setWorkflowName] = useState(seed.name);
  const [details, setDetails] = useState<WorkflowDetails | null>(seed.details);

  // Live validation state.
  const [validationErrors, setValidationErrors] = useState<CombinedError[]>([]);
  const summaryPanelRef = useRef<HTMLDivElement | null>(null);

  // Save flow state.
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Capabilities for the Tool Call editor — fetched once on mount.
  const [capabilities, setCapabilities] = useState<readonly CapabilityOption[]>([]);

  // Execution flow state.
  const [executionDialogOpen, setExecutionDialogOpen] = useState(false);
  const [executionPanelOpen, setExecutionPanelOpen] = useState(false);
  const [executionInput, setExecutionInput] = useState<{
    inputData: Record<string, unknown>;
    budgetLimitUsd?: number;
  } | null>(null);

  // Template selection state. `pendingTemplate` drives the description
  // dialog — a null value hides it. The dialog confirms before the canvas
  // is actually replaced so we don't clobber in-progress work.
  const [pendingTemplate, setPendingTemplate] = useState<WorkflowTemplate | null>(null);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .get<CapabilityOption[]>(API.ADMIN.ORCHESTRATION.CAPABILITIES, {
        params: { limit: 100 },
      })
      .then((result) => {
        if (!cancelled) setCapabilities(result);
      })
      .catch((err) => {
        logger.error('Failed to load capabilities for workflow builder', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced live validation. Runs both the authoritative backend-aligned
  // validator and the FE-only extra checks, merges their errors, and
  // updates each node's `data.hasError` for the red ring.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (nodes.length === 0) {
        setValidationErrors([]);
        return;
      }
      const definition = flowToWorkflowDefinition(nodes, edges);
      const coreErrors = validateWorkflow(definition).errors;
      const extraErrors = runExtraChecks(nodes, edges);
      const combined: CombinedError[] = [...coreErrors, ...extraErrors];
      setValidationErrors(combined);

      // Propagate per-node error flags.
      const errorIds = new Set(
        combined
          .map((e) => ('stepId' in e ? e.stepId : undefined))
          .filter((id): id is string => typeof id === 'string')
      );
      setNodes((prev) =>
        prev.map((node) => {
          const next = errorIds.has(node.id);
          if (Boolean(node.data.hasError) === next) return node;
          return { ...node, data: { ...node.data, hasError: next } };
        })
      );
    }, 300);

    return () => window.clearTimeout(handle);
    // We deliberately depend on nodes + edges (not setNodes) — every
    // change reschedules the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge({ ...connection, type: 'default' }, eds));
    },
    [setEdges]
  );

  const handleNodeAdd = useCallback(
    (node: PatternNode) => {
      setNodes((prev) => [...prev, node]);
    },
    [setNodes]
  );

  const handleLabelChange = useCallback(
    (nodeId: string, label: string) => {
      setNodes((prev) =>
        prev.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, label } } : n))
      );
    },
    [setNodes]
  );

  const handleConfigChange = useCallback(
    (nodeId: string, partial: Record<string, unknown>) => {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, config: { ...n.data.config, ...partial } } }
            : n
        )
      );
    },
    [setNodes]
  );

  const handleNodeDelete = useCallback(
    (nodeId: string) => {
      setNodes((prev) => prev.filter((n) => n.id !== nodeId));
      setEdges((prev) => prev.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelectedNodeId(null);
    },
    [setEdges, setNodes]
  );

  const { setCenter, getNode } = useReactFlow();

  const handleFocusNode = useCallback(
    (stepId: string) => {
      const node = getNode(stepId);
      if (!node) return;
      setSelectedNodeId(stepId);
      void setCenter(node.position.x + 100, node.position.y + 40, { zoom: 1.2, duration: 400 });
    },
    [getNode, setCenter]
  );

  const handleValidate = useCallback(() => {
    summaryPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  // ------------------------------------------------------------------
  // Template selection
  // ------------------------------------------------------------------

  const handleTemplateSelect = useCallback((template: WorkflowTemplate) => {
    setPendingTemplate(template);
    setTemplateDialogOpen(true);
  }, []);

  const handleTemplateDialogOpenChange = useCallback((open: boolean) => {
    setTemplateDialogOpen(open);
    if (!open) setPendingTemplate(null);
  }, []);

  const handleTemplateConfirm = useCallback(() => {
    if (!pendingTemplate) return;
    const { nodes: templateNodes, edges: templateEdges } = workflowDefinitionToFlow(
      pendingTemplate.workflowDefinition
    );
    setNodes(templateNodes);
    setEdges(templateEdges);
    setWorkflowName(pendingTemplate.name);
    setSelectedNodeId(null);
    setSaveError(null);
    setTemplateDialogOpen(false);
    setPendingTemplate(null);
  }, [pendingTemplate, setEdges, setNodes]);

  // ------------------------------------------------------------------
  // Save flow
  // ------------------------------------------------------------------

  const performSave = useCallback(
    async (resolvedDetails: WorkflowDetails) => {
      if (nodes.length === 0) {
        setSaveError('Add at least one step before saving.');
        return;
      }
      setSaving(true);
      setSaveError(null);
      try {
        const saved = await saveWorkflow({
          mode,
          workflowId: workflow?.id,
          name: workflowName.trim() || 'Untitled workflow',
          nodes,
          edges,
          details: resolvedDetails,
        });
        setDetails(resolvedDetails);
        if (mode === 'create') {
          router.push(`/admin/orchestration/workflows/${saved.id}`);
        } else {
          router.refresh();
        }
      } catch (err) {
        const message =
          err instanceof APIClientError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to save workflow';
        setSaveError(message);
        logger.error('Workflow save failed', { error: message });
      } finally {
        setSaving(false);
      }
    },
    [edges, mode, nodes, router, workflow?.id, workflowName]
  );

  const handleSave = useCallback(() => {
    setSaveError(null);
    if (details) {
      void performSave(details);
    } else {
      setSaveDialogOpen(true);
    }
  }, [details, performSave]);

  // ------------------------------------------------------------------
  // Execution flow
  // ------------------------------------------------------------------

  const handleExecute = useCallback(() => {
    setExecutionDialogOpen(true);
  }, []);

  const handleExecutionConfirm = useCallback(
    (input: { inputData: Record<string, unknown>; budgetLimitUsd?: number }) => {
      setExecutionDialogOpen(false);
      setExecutionInput(input);
      setExecutionPanelOpen(true);
    },
    []
  );

  const handleExecutionPanelClose = useCallback(() => {
    setExecutionPanelOpen(false);
    setExecutionInput(null);
  }, []);

  const handleDialogConfirm = useCallback(
    (resolved: WorkflowDetails) => {
      setSaveDialogOpen(false);
      void performSave(resolved);
    },
    [performSave]
  );

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <BuilderToolbar
        mode={mode}
        workflowName={workflowName}
        onNameChange={setWorkflowName}
        onValidate={handleValidate}
        onSave={handleSave}
        onExecute={handleExecute}
        onTemplateSelect={handleTemplateSelect}
        templatesDisabled={mode === 'edit'}
        saving={saving}
        hasErrors={validationErrors.length > 0}
      />

      <div ref={summaryPanelRef}>
        <ValidationSummaryPanel errors={validationErrors} onFocusNode={handleFocusNode} />
      </div>

      {saveError && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          <AlertCircle className="h-4 w-4" />
          <span>{saveError}</span>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <PatternPalette />
        <WorkflowCanvas
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={setSelectedNodeId}
          onNodeAdd={handleNodeAdd}
        />
        {selectedNode && (
          <BlockConfigPanel
            node={selectedNode}
            onLabelChange={handleLabelChange}
            onConfigChange={handleConfigChange}
            onDelete={handleNodeDelete}
            capabilities={capabilities}
          />
        )}
        {executionPanelOpen && executionInput && workflow && (
          <ExecutionPanel
            open={executionPanelOpen}
            workflowId={workflow.id}
            inputData={executionInput.inputData}
            budgetLimitUsd={executionInput.budgetLimitUsd}
            onClose={handleExecutionPanelClose}
          />
        )}
      </div>

      <ExecutionInputDialog
        open={executionDialogOpen}
        onOpenChange={setExecutionDialogOpen}
        onConfirm={handleExecutionConfirm}
      />

      <WorkflowDetailsDialog
        open={saveDialogOpen}
        workflowName={workflowName}
        initial={details ?? undefined}
        onOpenChange={setSaveDialogOpen}
        onConfirm={handleDialogConfirm}
      />

      <TemplateDescriptionDialog
        open={templateDialogOpen}
        template={pendingTemplate}
        canvasHasContent={nodes.length > 0}
        onOpenChange={handleTemplateDialogOpenChange}
        onConfirm={handleTemplateConfirm}
      />
    </div>
  );
}

export function WorkflowBuilder(props: WorkflowBuilderProps) {
  // React Flow requires a provider wrapper for `useReactFlow` et al.
  return (
    <ReactFlowProvider>
      <WorkflowBuilderInner {...props} />
    </ReactFlowProvider>
  );
}
