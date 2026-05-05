/**
 * Attribute key constants for the tracer interface.
 *
 * Two namespaces:
 * - `gen_ai.*` — OpenTelemetry GenAI semantic conventions. These align with
 *   the OTEL spec so any OTLP-compatible backend (Datadog, Honeycomb,
 *   Grafana Tempo, Langfuse-via-OTLP) renders Sunrise spans correctly
 *   without custom mapping.
 * - `sunrise.*` — Sunrise-specific extensions for cost, agent, workflow,
 *   capability, and conversation correlation. Always lower-case dot-namespaced.
 */

// --- GenAI semantic conventions (subset Sunrise emits) ---

export const GEN_AI_SYSTEM = 'gen_ai.system';
export const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
export const GEN_AI_REQUEST_TEMPERATURE = 'gen_ai.request.temperature';
export const GEN_AI_REQUEST_MAX_TOKENS = 'gen_ai.request.max_tokens';
export const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const GEN_AI_USAGE_TOTAL_TOKENS = 'gen_ai.usage.total_tokens';
/** One of: 'chat' | 'tool_call' | 'embedding' | 'summary' | 'evaluation'. */
export const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
/** Opt-in only. Never set unless `SUNRISE_OTEL_RECORD_PROMPTS=true`. */
export const GEN_AI_PROMPT = 'gen_ai.prompt';
/** Opt-in only. Never set unless `SUNRISE_OTEL_RECORD_PROMPTS=true`. */
export const GEN_AI_COMPLETION = 'gen_ai.completion';
export const GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
export const GEN_AI_TOOL_CALL_ID = 'gen_ai.tool.call.id';

// --- Sunrise-specific extensions ---

export const SUNRISE_EXECUTION_ID = 'sunrise.execution_id';
export const SUNRISE_WORKFLOW_ID = 'sunrise.workflow_id';
export const SUNRISE_STEP_ID = 'sunrise.step_id';
export const SUNRISE_STEP_TYPE = 'sunrise.step_type';
export const SUNRISE_AGENT_ID = 'sunrise.agent_id';
export const SUNRISE_AGENT_SLUG = 'sunrise.agent_slug';
export const SUNRISE_CONVERSATION_ID = 'sunrise.conversation_id';
export const SUNRISE_CAPABILITY_SLUG = 'sunrise.capability';
export const SUNRISE_CAPABILITY_SUCCESS = 'sunrise.capability.success';
export const SUNRISE_USER_ID = 'sunrise.user_id';
export const SUNRISE_COST_USD = 'sunrise.cost_usd';
export const SUNRISE_TOOL_ITERATION = 'sunrise.tool_iteration';
export const SUNRISE_PROVIDER_FAILOVER_FROM = 'sunrise.provider.failover_from';
export const SUNRISE_PROVIDER_FAILOVER_TO = 'sunrise.provider.failover_to';
export const SUNRISE_STEP_LLM_DURATION_MS = 'sunrise.step.llm_duration_ms';
export const SUNRISE_EVALUATION_PHASE = 'sunrise.evaluation.phase';

// --- Span name constants ---

export const SPAN_WORKFLOW_EXECUTE = 'workflow.execute';
export const SPAN_WORKFLOW_STEP = 'workflow.step';
export const SPAN_LLM_CALL = 'llm.call';
export const SPAN_AGENT_CALL_TURN = 'agent_call.turn';
export const SPAN_CAPABILITY_DISPATCH = 'capability.dispatch';
export const SPAN_CHAT_TURN = 'chat.turn';
export const SPAN_TOOL_LOOP_ITERATION = 'chat.tool_loop_iteration';

/** Maximum length for any string attribute value. Strings beyond this are truncated at the wrap boundary. */
export const MAX_ATTRIBUTE_STRING_LENGTH = 1024;
