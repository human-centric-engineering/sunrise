/**
 * User-Friendly Error Messages
 *
 * Maps technical error codes to user-friendly messages.
 * These messages are designed to:
 * - Be clear and actionable for end users
 * - Avoid technical jargon
 * - Provide guidance on how to resolve the issue
 * - Be appropriate for display in UI components
 *
 * Features:
 * - Static message mappings for known error codes
 * - Contextual message generation for dynamic errors
 * - Fallback messages for unknown errors
 * - i18n-ready structure (future: translate messages)
 *
 * @example
 * ```typescript
 * import { getUserFriendlyMessage } from '@/lib/errors/messages';
 *
 * const message = getUserFriendlyMessage('UNAUTHORIZED');
 * // → "Please sign in to continue."
 * ```
 */

import { ErrorCodes, type ErrorCode } from '@/lib/api/errors';

/**
 * User-friendly error messages for each error code
 *
 * These messages are:
 * - Written in plain language
 * - Actionable (tell user what to do)
 * - Appropriate for display in UI
 * - Avoid exposing sensitive technical details
 */
export const ErrorMessages: Record<ErrorCode, string> = {
  [ErrorCodes.UNAUTHORIZED]: 'Please sign in to continue.',
  [ErrorCodes.FORBIDDEN]: "You don't have permission to access this resource.",
  [ErrorCodes.NOT_FOUND]: 'The requested resource could not be found.',
  [ErrorCodes.VALIDATION_ERROR]: 'Please check your input and try again.',
  [ErrorCodes.EMAIL_TAKEN]: 'This email address is already registered.',
  [ErrorCodes.RATE_LIMIT_EXCEEDED]: 'Too many requests. Please try again later.',
  [ErrorCodes.INTERNAL_ERROR]: 'Something went wrong. Please try again.',
};

/**
 * Get user-friendly message for an error code
 *
 * @param code - The error code (e.g., 'UNAUTHORIZED')
 * @param defaultMessage - Optional default message if code is not found
 * @returns User-friendly error message
 *
 * @example
 * ```typescript
 * getUserFriendlyMessage('UNAUTHORIZED')
 * // → "Please sign in to continue."
 *
 * getUserFriendlyMessage('UNKNOWN_CODE')
 * // → "An error occurred. Please try again."
 *
 * getUserFriendlyMessage('UNKNOWN_CODE', 'Custom fallback')
 * // → "Custom fallback"
 * ```
 */
export function getUserFriendlyMessage(
  code?: string,
  defaultMessage: string = 'An error occurred. Please try again.'
): string {
  if (!code) {
    return defaultMessage;
  }

  // Check if we have a mapping for this code
  if (code in ErrorMessages) {
    return ErrorMessages[code as ErrorCode];
  }

  // Fallback to default message
  return defaultMessage;
}

/**
 * Get contextual error message for a specific resource/action
 *
 * Generates messages like:
 * - "User not found."
 * - "Post could not be deleted."
 * - "Email field is invalid."
 *
 * @param code - The error code
 * @param context - Context for the error (resource, action, field)
 * @returns Contextual error message
 *
 * @example
 * ```typescript
 * getContextualErrorMessage('NOT_FOUND', { resource: 'user' })
 * // → "User not found."
 *
 * getContextualErrorMessage('VALIDATION_ERROR', { field: 'email' })
 * // → "Email is invalid."
 *
 * getContextualErrorMessage('FORBIDDEN', { action: 'delete', resource: 'post' })
 * // → "You don't have permission to delete this post."
 * ```
 */
export function getContextualErrorMessage(
  code: string,
  context?: {
    resource?: string;
    action?: string;
    field?: string;
  }
): string {
  // If no context, use default message
  if (!context || (!context.resource && !context.action && !context.field)) {
    return getUserFriendlyMessage(code);
  }

  const { resource, action, field } = context;

  // Generate contextual messages based on error code
  switch (code) {
    case ErrorCodes.NOT_FOUND:
      if (resource) {
        return `${capitalize(resource)} not found.`;
      }
      return ErrorMessages[ErrorCodes.NOT_FOUND];

    case ErrorCodes.VALIDATION_ERROR:
      if (field) {
        return `${capitalize(field)} is invalid.`;
      }
      return ErrorMessages[ErrorCodes.VALIDATION_ERROR];

    case ErrorCodes.FORBIDDEN:
      if (action && resource) {
        return `You don't have permission to ${action} this ${resource}.`;
      }
      if (action) {
        return `You don't have permission to ${action}.`;
      }
      return ErrorMessages[ErrorCodes.FORBIDDEN];

    case ErrorCodes.UNAUTHORIZED:
      if (action) {
        return `Please sign in to ${action}.`;
      }
      return ErrorMessages[ErrorCodes.UNAUTHORIZED];

    case ErrorCodes.EMAIL_TAKEN:
      return ErrorMessages[ErrorCodes.EMAIL_TAKEN];

    case ErrorCodes.RATE_LIMIT_EXCEEDED:
      return ErrorMessages[ErrorCodes.RATE_LIMIT_EXCEEDED];

    case ErrorCodes.INTERNAL_ERROR:
      if (action) {
        return `Failed to ${action}. Please try again.`;
      }
      return ErrorMessages[ErrorCodes.INTERNAL_ERROR];

    default:
      return getUserFriendlyMessage(code);
  }
}

/**
 * Get user-friendly validation error message
 *
 * Converts Zod error details into readable messages
 *
 * @param details - Validation error details from API response
 * @returns Human-readable validation errors
 *
 * @example
 * ```typescript
 * const details = {
 *   email: ['Invalid email format'],
 *   password: ['Must be at least 8 characters', 'Must contain a number']
 * };
 *
 * const messages = getValidationErrorMessages(details);
 * // → {
 * //   email: 'Invalid email format',
 * //   password: 'Must be at least 8 characters and must contain a number'
 * // }
 * ```
 */
export function getValidationErrorMessages(
  details?: Record<string, string[]>
): Record<string, string> {
  if (!details) {
    return {};
  }

  const messages: Record<string, string> = {};

  for (const [field, errors] of Object.entries(details)) {
    if (errors.length === 1) {
      // Single error: just use it
      messages[field] = errors[0];
    } else {
      // Multiple errors: join with "and"
      const lastError = errors[errors.length - 1];
      const otherErrors = errors.slice(0, -1);
      messages[field] = `${otherErrors.join(', ')} and ${lastError}`;
    }
  }

  return messages;
}

/**
 * Capitalize first letter of a string
 * Helper for generating contextual messages
 */
function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Get error message for display in forms
 *
 * Extracts the appropriate message from an API error response
 * Handles both general errors and field-specific validation errors
 *
 * @param error - Error from API call
 * @param field - Optional field name for validation errors
 * @returns User-friendly error message
 *
 * @example
 * ```typescript
 * // General error
 * const error = { code: 'UNAUTHORIZED', message: '...' };
 * getFormErrorMessage(error)
 * // → "Please sign in to continue."
 *
 * // Field-specific error
 * const error = {
 *   code: 'VALIDATION_ERROR',
 *   details: { email: ['Invalid email format'] }
 * };
 * getFormErrorMessage(error, 'email')
 * // → "Invalid email format"
 * ```
 */
export function getFormErrorMessage(
  error: {
    code?: string;
    message?: string;
    details?: Record<string, string[]>;
  },
  field?: string
): string {
  // If field is specified and we have validation details, return field error
  if (field && error.details && error.details[field]) {
    const messages = getValidationErrorMessages({ [field]: error.details[field] });
    return messages[field] || getUserFriendlyMessage(error.code);
  }

  // Otherwise return general error message
  return getUserFriendlyMessage(error.code, error.message);
}
