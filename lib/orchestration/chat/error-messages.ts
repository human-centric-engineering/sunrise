/**
 * Error Message Registry (Phase 7 Session 7.3)
 *
 * Static map of error codes to user-facing messages with title,
 * description, and optional action. Developer-authored, not
 * admin-editable. Zero runtime cost, fully testable.
 */

export interface UserFacingError {
  title: string;
  message: string;
  action?: string;
}

const ERROR_MAP: Record<string, UserFacingError> = {
  budget_exceeded: {
    title: 'Monthly Budget Reached',
    message: 'This agent has reached its monthly budget.',
    action: 'Contact an admin to increase the limit or switch to a local model.',
  },
  budget_exceeded_per_turn: {
    title: 'Response Cost Limit Reached',
    message: "This response stopped early to stay within the agent's per-turn cost limit.",
    action: 'Try a more specific question, or ask an admin to raise the per-turn cap.',
  },
  all_providers_exhausted: {
    title: 'No Available Provider',
    message: 'None of the configured AI providers could handle the request.',
    action: 'Check that providers are enabled with valid API keys in Admin → Providers.',
  },
  agent_not_found: {
    title: 'Agent Not Found',
    message: "The requested agent doesn't exist or has been deactivated.",
    action: 'Check the agent settings or select a different agent.',
  },
  conversation_not_found: {
    title: 'Conversation Not Found',
    message: 'This conversation no longer exists.',
    action: 'Start a new conversation.',
  },
  tool_loop_cap: {
    title: 'Processing Limit Reached',
    message: 'The agent exceeded the maximum number of tool calls.',
    action: 'Try rephrasing your request to be more specific.',
  },
  internal_error: {
    title: 'Something Went Wrong',
    message: 'An unexpected error occurred while processing your message.',
    action: 'Try again. If the problem persists, the agent may need a different model or provider.',
  },
  stream_error: {
    title: 'Unable to Connect',
    message: 'Could not reach the AI service. This is usually temporary.',
    action: 'Wait a few seconds and try again.',
  },
  // Provider HTTP errors — surfaced when an LLM provider rejects the
  // request. Keeping these distinct from `internal_error` so the user
  // knows the issue sits with the upstream model, not the app itself,
  // and gets an actionable next step.
  http_400: {
    title: 'Request Rejected by Provider',
    message:
      'The AI provider rejected the request. The conversation history may have got out of sync.',
    action:
      'Start a new conversation. If it keeps happening, ask an admin to check the agent or model settings.',
  },
  http_401: {
    title: 'Provider Authentication Failed',
    message: 'The AI provider rejected the credentials configured for this agent.',
    action: 'Ask an admin to check the provider API key in Admin → Providers.',
  },
  http_403: {
    title: 'Provider Authentication Failed',
    message: 'The AI provider rejected the credentials configured for this agent.',
    action: 'Ask an admin to check the provider API key in Admin → Providers.',
  },
  http_404: {
    title: 'Provider Could Not Find the Model',
    message:
      'The configured model does not exist on the upstream provider, or is not available to this account.',
    action: 'Ask an admin to pick a valid model in Admin → AI Orchestration → Settings.',
  },
  http_429: {
    title: 'Provider Rate Limit Hit',
    message: 'The AI provider is throttling requests right now.',
    action: 'Wait a few seconds and try again.',
  },
  http_500: {
    title: 'Provider Is Having Trouble',
    message: 'The AI provider returned a server error.',
    action:
      'Wait a few seconds and try again. If it persists, switch to a different model or provider.',
  },
  http_502: {
    title: 'Provider Is Having Trouble',
    message: 'The AI provider returned a server error.',
    action:
      'Wait a few seconds and try again. If it persists, switch to a different model or provider.',
  },
  http_503: {
    title: 'Provider Is Having Trouble',
    message: 'The AI provider returned a server error.',
    action:
      'Wait a few seconds and try again. If it persists, switch to a different model or provider.',
  },
  http_504: {
    title: 'Provider Timed Out',
    message: 'The AI provider took too long to respond.',
    action: 'Try again — the issue is usually temporary.',
  },
  provider_error: {
    title: 'Provider Error',
    message: 'The AI provider could not complete the request.',
    action:
      'Wait a few seconds and try again. If it persists, switch to a different model or provider.',
  },
  timeout: {
    title: 'Request Timed Out',
    message: 'The AI provider did not respond in time.',
    action: 'Try again. If it keeps happening, ask an admin to check the provider.',
  },
  rate_limited: {
    title: 'Too Many Requests',
    message: 'You are sending messages too quickly.',
    action: 'Wait a moment before sending another message.',
  },
  input_blocked: {
    title: 'Message Blocked',
    message: 'Your message was flagged by the security policy.',
    action: 'Try rephrasing your message.',
  },
  output_blocked: {
    title: 'Response Blocked',
    message: 'The response was blocked by content policy.',
    action: 'Try a different question or contact an admin.',
  },
  conversation_length_cap_reached: {
    title: 'Conversation Limit Reached',
    message: 'This conversation has reached the maximum number of messages.',
    action: 'Start a new conversation to continue.',
  },
  conversation_cap_reached: {
    title: 'Conversation Limit Reached',
    message: 'You have reached the maximum number of conversations for this agent.',
    action: 'Delete an older conversation or contact an admin.',
  },
  provider_not_found: {
    title: 'No Provider Configured',
    message: "This agent's AI provider has not been set up yet.",
    action: 'Go to Admin → Providers and configure a provider, then assign it to this agent.',
  },
  no_provider_configured: {
    title: 'Setup Required',
    message: 'No LLM provider is configured for this Sunrise instance yet.',
    action: 'Run the setup wizard at Admin → AI Orchestration to add a provider.',
  },
  no_default_model_configured: {
    title: 'Default Model Not Set',
    message: 'A default model for this task has not been chosen yet.',
    action: 'Open Admin → AI Orchestration → Settings → Default models and pick one.',
  },
  provider_disabled: {
    title: 'Provider Disabled',
    message: "This agent's AI provider is currently disabled.",
    action: 'Go to Admin → Providers and enable the provider, or assign a different one.',
  },
  missing_api_key: {
    title: 'Provider Missing API Key',
    message: 'The AI provider is configured but its API key is not set.',
    action: 'Go to Admin → Providers and add the API key for this provider.',
  },
  missing_base_url: {
    title: 'Provider Missing URL',
    message: 'The AI provider is configured but its base URL is not set.',
    action: 'Go to Admin → Providers and set the base URL.',
  },
  unknown_provider_type: {
    title: 'Unsupported Provider Type',
    message: 'This agent is configured with an unsupported provider type.',
    action: 'Go to Admin → Providers and select a supported provider type.',
  },
};

/**
 * Look up a user-facing error by code.
 *
 * Resolution order: exact match → bucket-by-family (any unrecognised
 * `http_*` code falls back to the generic `provider_error` copy so the
 * user gets a "the provider is having trouble" message instead of the
 * scary "Something Went Wrong" default) → `internal_error`.
 */
export function getUserFacingError(code: string): UserFacingError {
  if (ERROR_MAP[code]) return ERROR_MAP[code];
  if (code.startsWith('http_')) return ERROR_MAP.provider_error;
  return ERROR_MAP.internal_error;
}
