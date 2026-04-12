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
    title: 'Service Temporarily Unavailable',
    message: 'All AI providers are experiencing issues.',
    action: 'Wait a moment and try again, or switch to a different provider.',
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
    message: 'The AI provider returned an error.',
    action: 'Try again, or switch to a different model in the agent settings.',
  },
  stream_error: {
    title: 'Something Went Wrong',
    message: 'The AI provider returned an error.',
    action: 'Try again, or switch to a different model in the agent settings.',
  },
  rate_limited: {
    title: 'Too Many Requests',
    message: 'You are sending messages too quickly.',
    action: 'Wait a moment before sending another message.',
  },
};

/**
 * Look up a user-facing error by code.
 * Unknown codes fall back to the `internal_error` entry.
 */
export function getUserFacingError(code: string): UserFacingError {
  return ERROR_MAP[code] ?? ERROR_MAP.internal_error;
}
