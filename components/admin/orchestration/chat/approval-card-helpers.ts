/**
 * Pure helpers and reducer for ApprovalCard, extracted so they can be
 * unit-tested directly without bouncing through the React lifecycle.
 */

export type Action =
  | 'approve_submit'
  | 'reject_submit'
  | 'submit_ok'
  | 'poll_completed'
  | 'poll_failed'
  | 'poll_expired'
  | 'failure';

export type CardState =
  | { kind: 'idle' }
  | { kind: 'submitting'; action: 'approve' | 'reject' }
  | { kind: 'waiting'; action: 'approve' | 'reject' }
  | { kind: 'completed'; action: 'approve' | 'reject' }
  | { kind: 'failed'; message: string }
  | { kind: 'expired' };

export interface ReducerEvent {
  type: Action;
  payload?: { action?: 'approve' | 'reject'; message?: string };
}

export function reducer(state: CardState, event: ReducerEvent): CardState {
  switch (event.type) {
    case 'approve_submit':
      return { kind: 'submitting', action: 'approve' };
    case 'reject_submit':
      return { kind: 'submitting', action: 'reject' };
    case 'submit_ok':
      if (state.kind !== 'submitting') return state;
      return { kind: 'waiting', action: state.action };
    case 'poll_completed':
      // Carry the action forward so the rendered terminal-state copy
      // says the right thing — "approved/completed" vs "rejected/cancelled".
      // Without this, a successful reject path renders the approve copy.
      if (state.kind !== 'waiting') return state;
      return { kind: 'completed', action: state.action };
    case 'poll_failed':
      return { kind: 'failed', message: event.payload?.message ?? 'Workflow failed' };
    case 'poll_expired':
      return { kind: 'expired' };
    case 'failure':
      return { kind: 'failed', message: event.payload?.message ?? 'Action failed' };
    default:
      return state;
  }
}

export function extractFinalOutput(trace: unknown): unknown {
  if (!Array.isArray(trace) || trace.length === 0) return null;
  // Last completed entry's output is the final result for chained workflows.
  const arr = trace as unknown[];
  for (let i = arr.length - 1; i >= 0; i--) {
    const entry = arr[i];
    if (
      entry &&
      typeof entry === 'object' &&
      'status' in entry &&
      (entry as { status: unknown }).status === 'completed'
    ) {
      return (entry as { output?: unknown }).output ?? null;
    }
  }
  return null;
}

/**
 * Render a workflow output for the synthesised follow-up message.
 * Empty values become empty strings (callers fall back to a generic
 * "approved successfully" message). Large outputs are truncated so
 * the follow-up doesn't blow past the LLM's context window on the
 * next turn — workflows that produce structured data (refund
 * receipts, document URLs) fit comfortably; ones that dump entire
 * datasets get a stub the LLM can ask about.
 */
export const MAX_FOLLOWUP_RENDER_CHARS = 8_000;

export function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : tryStringify(value);
  if (raw.length <= MAX_FOLLOWUP_RENDER_CHARS) return raw;
  return `${raw.slice(0, MAX_FOLLOWUP_RENDER_CHARS)}… [truncated; ${raw.length} chars total]`;
}

function tryStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}
