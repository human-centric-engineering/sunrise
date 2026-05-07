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
 * Unknown codes fall back to the `internal_error` entry.
 */
export function getUserFacingError(code: string): UserFacingError {
  return ERROR_MAP[code] ?? ERROR_MAP.internal_error;
}
