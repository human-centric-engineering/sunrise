/**
 * How a workflow run started by the inbound route is marked.
 *
 * The inbound route (`app/api/v1/inbound/[channel]/[slug]/route.ts`) stamps
 * every run it creates with `AiWorkflowExecution.triggerSource` =
 * `inbound:<channel>`, and writes the run's own conversation into
 * `inputData.triggerMeta` itself. A reader that trusts `triggerMeta` must first
 * check the run really came from that route: any other run's `inputData` was
 * chosen by its starter, a model calling `run_workflow` included (t-770).
 */

/** The prefix of every `triggerSource` the inbound route stamps. */
export const INBOUND_TRIGGER_SOURCE_PREFIX = 'inbound:';

/** The `triggerSource` the inbound route stamps on a run it starts. */
export function inboundTriggerSource(channel: string): string {
  return `${INBOUND_TRIGGER_SOURCE_PREFIX}${channel}`;
}
