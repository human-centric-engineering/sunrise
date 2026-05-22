/**
 * useWorkflowCostEstimate Hook Tests
 *
 * @see components/admin/orchestration/workflow-builder/use-workflow-cost-estimate.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
}));

vi.mock('@/lib/logging', () => ({
  logger: { debug: vi.fn() },
}));

import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useWorkflowCostEstimate } from '@/components/admin/orchestration/workflow-builder/use-workflow-cost-estimate';
import type { WorkflowDefinition } from '@/types/orchestration';
import type { WorkflowCostEstimateWithCap } from '@/components/admin/orchestration/workflow-builder/use-workflow-cost-estimate';

const WORKFLOW_ID = 'wf-test-123';
const DEBOUNCE_MS = 800;

function makeStep(id: string, label: string = 'Step'): WorkflowDefinition['steps'][0] {
  return {
    id,
    name: label,
    type: 'llm_call',
    config: {},
    nextSteps: [],
  } as unknown as WorkflowDefinition['steps'][0];
}

function makeDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    steps: [makeStep('step-1', 'Analyse')],
    entryStepId: 'step-1',
    errorStrategy: 'fail',
    ...overrides,
  };
}

function makeEstimate(
  overrides: Partial<WorkflowCostEstimateWithCap> = {}
): WorkflowCostEstimateWithCap {
  return {
    midUsd: 0.02,
    lowUsd: 0.01,
    highUsd: 0.04,
    basedOn: 'heuristic',
    sampleSize: 0,
    modelUsed: 'gpt-4o-mini',
    judgeModelUsed: null,
    modelMix: [],
    workflowHasSupervisor: false,
    llmStepCount: 1,
    perStep: [],
    notes: '',
    effectiveCapUsd: null,
    ...overrides,
  };
}

describe('useWorkflowCostEstimate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Guard conditions ──────────────────────────────────────────────────────

  it('does not fetch when workflowId is null', async () => {
    const definition = makeDefinition();
    renderHook(() => useWorkflowCostEstimate(null, definition));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    });

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('does not fetch when definition is null', async () => {
    renderHook(() => useWorkflowCostEstimate(WORKFLOW_ID, null));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    });

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('does not fetch when definition.steps is empty', async () => {
    const emptyDef = makeDefinition({ steps: [] });
    renderHook(() => useWorkflowCostEstimate(WORKFLOW_ID, emptyDef));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    });

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  // ─── Debounce behaviour ────────────────────────────────────────────────────

  it('fetches after 800ms debounce with the correct payload', async () => {
    const definition = makeDefinition();
    const estimate = makeEstimate();
    vi.mocked(apiClient.post).mockResolvedValue(estimate);

    renderHook(() => useWorkflowCostEstimate(WORKFLOW_ID, definition));

    // Should not have fired before the debounce window.
    expect(apiClient.post).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith(
      API.ADMIN.ORCHESTRATION.workflowCostEstimate(WORKFLOW_ID),
      { body: { definition } }
    );
  });

  it('coalesces rapid edits into one fetch — only the final definition fires', async () => {
    const def1 = makeDefinition({ steps: [makeStep('step-1', 'A')] });
    const def2 = makeDefinition({ steps: [makeStep('step-1', 'B')] });
    const def3 = makeDefinition({ steps: [makeStep('step-1', 'C')] });

    const estimate = makeEstimate();
    vi.mocked(apiClient.post).mockResolvedValue(estimate);

    const { rerender } = renderHook(
      ({ def }: { def: WorkflowDefinition }) => useWorkflowCostEstimate(WORKFLOW_ID, def),
      { initialProps: { def: def1 } }
    );

    // Re-render twice more inside the debounce window — each re-render
    // cancels the previous timer and schedules a fresh one.
    rerender({ def: def2 });
    rerender({ def: def3 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    // Only one fetch should have fired, with the final definition.
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith(
      API.ADMIN.ORCHESTRATION.workflowCostEstimate(WORKFLOW_ID),
      { body: { definition: def3 } }
    );
  });

  // ─── Content-key guard (critical regression test) ──────────────────────────

  it('re-renders with the same content (different object identity) do NOT re-fire the timer', async () => {
    // This is the React Flow churn guard. If the effect re-ran on object
    // identity, the cleanup (clearTimeout) would kill the debounce before it
    // fired, and the banner would get stuck on "Estimating cost…" forever.
    const estimate = makeEstimate();
    vi.mocked(apiClient.post).mockResolvedValue(estimate);

    // Two separate object literals with identical content.
    const def1: WorkflowDefinition = {
      steps: [makeStep('step-1', 'Analyse')],
      entryStepId: 'step-1',
      errorStrategy: 'fail',
    };
    const def2: WorkflowDefinition = {
      steps: [makeStep('step-1', 'Analyse')],
      entryStepId: 'step-1',
      errorStrategy: 'fail',
    };

    const { rerender } = renderHook(
      ({ def }: { def: WorkflowDefinition }) => useWorkflowCostEstimate(WORKFLOW_ID, def),
      { initialProps: { def: def1 } }
    );

    // Re-render with a new object that has identical serialised content.
    // The content-key must not change, so the effect must NOT re-run.
    rerender({ def: def2 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    });

    // Exactly one fetch — not two. The identity-churn did not reset the timer.
    expect(apiClient.post).toHaveBeenCalledTimes(1);
  });

  // ─── Loading and success state ─────────────────────────────────────────────

  it('sets loading true while in flight, then false on success', async () => {
    let resolvePost!: (v: WorkflowCostEstimateWithCap) => void;
    const pending = new Promise<WorkflowCostEstimateWithCap>((resolve) => {
      resolvePost = resolve;
    });
    vi.mocked(apiClient.post).mockReturnValueOnce(pending);

    const definition = makeDefinition();
    const { result } = renderHook(() => useWorkflowCostEstimate(WORKFLOW_ID, definition));

    // The hook sets loading=true synchronously inside the effect (before the
    // debounce timer fires) — so it's already true on initial render.
    expect(result.current.loading).toBe(true);

    // Advance past the debounce — the timer fires and the POST is initiated.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    // Still in-flight while the pending promise hasn't resolved.
    expect(result.current.loading).toBe(true);
    expect(apiClient.post).toHaveBeenCalledTimes(1);

    // Resolve the fetch — loading should flip to false.
    const estimate = makeEstimate();
    await act(async () => {
      resolvePost(estimate);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
  });

  it('populates estimate on success', async () => {
    const estimate = makeEstimate({ midUsd: 0.05, effectiveCapUsd: 1.0 });
    vi.mocked(apiClient.post).mockResolvedValue(estimate);

    const definition = makeDefinition();
    const { result } = renderHook(() => useWorkflowCostEstimate(WORKFLOW_ID, definition));

    // Advance past the debounce and let all pending microtasks flush so
    // the async IIFE inside the timeout resolves fully.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      // Flush the microtask queue produced by the async IIFE resolving.
      await Promise.resolve();
      await Promise.resolve();
    });

    // The hook must surface what the API returned — prove the POST response
    // was transformed into state, not just that the mock resolved.
    expect(result.current.estimate).not.toBeNull();
    expect(result.current.estimate?.midUsd).toBe(0.05);
    expect(result.current.estimate?.effectiveCapUsd).toBe(1.0);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  // ─── Error handling ────────────────────────────────────────────────────────

  it('sets error and clears estimate when apiClient.post rejects', async () => {
    // Prime a successful first fetch so estimate is non-null to start.
    vi.mocked(apiClient.post).mockResolvedValueOnce(makeEstimate({ midUsd: 0.03 }));

    const def1: WorkflowDefinition = makeDefinition();
    const def2: WorkflowDefinition = makeDefinition({ steps: [makeStep('step-2', 'Different')] });

    const { result, rerender } = renderHook(
      ({ def }: { def: WorkflowDefinition }) => useWorkflowCostEstimate(WORKFLOW_ID, def),
      { initialProps: { def: def1 } }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.estimate).not.toBeNull();

    // Now mock the next call to reject.
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('network timeout'));

    rerender({ def: def2 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.estimate).toBeNull();
    expect(result.current.error).toBe('network timeout');
    expect(result.current.loading).toBe(false);
  });

  // ─── Cancellation: unmount before post resolves ────────────────────────────

  it('does not update state when the hook unmounts before the POST resolves', async () => {
    // Drive a pending POST so the cancelled flag is set while the IIFE is
    // mid-flight. The success branch must skip every `setEstimate` /
    // `setLoading` write — otherwise React logs "state update on unmounted
    // component" and `apiClient.post` resolutions would leak through.
    let resolvePost!: (v: WorkflowCostEstimateWithCap) => void;
    const pending = new Promise<WorkflowCostEstimateWithCap>((resolve) => {
      resolvePost = resolve;
    });
    vi.mocked(apiClient.post).mockReturnValueOnce(pending);

    const definition = makeDefinition();
    const { result, unmount } = renderHook(() => useWorkflowCostEstimate(WORKFLOW_ID, definition));

    // Fire the debounced timer so the POST is in-flight.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });
    expect(apiClient.post).toHaveBeenCalledTimes(1);

    // Unmount BEFORE the post resolves — the effect cleanup flips
    // `cancelled = true`.
    unmount();

    // Now resolve the post. Every cancelled-guarded write must be skipped.
    const estimate = makeEstimate({ midUsd: 99 });
    await act(async () => {
      resolvePost(estimate);
      await Promise.resolve();
      await Promise.resolve();
    });

    // State captured at unmount time — never mutated by the late resolution.
    expect(result.current.estimate).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('does not update state when the hook unmounts before the POST rejects', async () => {
    let rejectPost!: (e: Error) => void;
    const pending = new Promise<WorkflowCostEstimateWithCap>((_resolve, reject) => {
      rejectPost = reject;
    });
    vi.mocked(apiClient.post).mockReturnValueOnce(pending);

    const definition = makeDefinition();
    const { result, unmount } = renderHook(() => useWorkflowCostEstimate(WORKFLOW_ID, definition));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });
    expect(apiClient.post).toHaveBeenCalledTimes(1);

    unmount();

    // The error path's `setError` / `setEstimate(null)` must also be
    // skipped after unmount.
    await act(async () => {
      rejectPost(new Error('boom after unmount'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.estimate).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it('falls back to the literal "Cost estimate failed" message when the thrown value is not an Error', async () => {
    // The catch block uses `err instanceof Error ? err.message : 'Cost
    // estimate failed'`. Throwing a non-Error (e.g. a string) is rare in
    // practice but the guard exists — exercise it so a future refactor
    // does not silently regress the user-facing copy.
    vi.mocked(apiClient.post).mockRejectedValueOnce('something broke (string)');

    const definition = makeDefinition();
    const { result } = renderHook(() => useWorkflowCostEstimate(WORKFLOW_ID, definition));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.error).toBe('Cost estimate failed');
    expect(result.current.estimate).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  // ─── Mid-debounce nullification ────────────────────────────────────────────

  it('clears estimate and stops loading when inputs become null mid-debounce', async () => {
    const estimate = makeEstimate();
    vi.mocked(apiClient.post).mockResolvedValue(estimate);

    const definition = makeDefinition();
    const { result, rerender } = renderHook(
      ({ def }: { def: WorkflowDefinition | null }) => useWorkflowCostEstimate(WORKFLOW_ID, def),
      { initialProps: { def: definition as WorkflowDefinition | null } }
    );

    // The debounce timer has been scheduled but not fired yet.
    // Now null out the definition — the contentKey becomes '' and the
    // effect cleanup cancels the timer.
    rerender({ def: null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    });

    // The POST must not have been called — the timer was cancelled.
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(result.current.estimate).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
