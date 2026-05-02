/**
 * Human-readable labels for webhook event types.
 * Shared between forms, tables, and delivery views.
 */
export const EVENT_LABELS: Record<string, string> = {
  budget_exceeded: 'Budget Exceeded',
  workflow_failed: 'Workflow Failed',
  approval_required: 'Approval Required',
  circuit_breaker_opened: 'Circuit Breaker Opened',
  conversation_started: 'Conversation Started',
  conversation_completed: 'Conversation Completed',
  message_created: 'Message Created',
  agent_updated: 'Agent Updated',
  budget_threshold_reached: 'Budget Threshold Reached',
  execution_completed: 'Execution Completed',
  execution_failed: 'Execution Failed',
  execution_crashed: 'Execution Crashed (engine error)',
};

/** Returns the human-readable label or formats the raw value as title case. */
export function formatEventLabel(raw: string): string {
  return EVENT_LABELS[raw] ?? raw.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
