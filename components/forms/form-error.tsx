import { AlertCircle } from 'lucide-react';
import { getUserFriendlyMessage } from '@/lib/errors/messages';

interface FormErrorProps {
  /**
   * Error message to display
   * If both message and code are provided, message takes precedence
   */
  message?: string;
  /**
   * Error code to map to user-friendly message
   * Uses the error messages from lib/errors/messages.ts
   */
  code?: string;
}

/**
 * Form Error Message Component
 *
 * Displays validation error messages with icon, colored background,
 * and border for better visibility and user feedback.
 * Works in both light and dark modes.
 *
 * Supports both direct messages and error code mapping for user-friendly display.
 *
 * Usage:
 * ```tsx
 * // Direct message
 * <FormError message={errors.email?.message} />
 *
 * // Error code (automatically maps to user-friendly message)
 * <FormError code="UNAUTHORIZED" />
 * // → "Please sign in to continue."
 *
 * // From API error response
 * <FormError code={apiError.code} message={apiError.message} />
 * ```
 */
export function FormError({ message, code }: FormErrorProps) {
  // Determine the display message:
  // 1. Use explicit message if provided
  // 2. Otherwise, map error code to user-friendly message
  // 3. If neither, show nothing
  const displayMessage = message || (code ? getUserFriendlyMessage(code) : undefined);

  if (!displayMessage) return null;

  return (
    <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-400">
      <AlertCircle className="h-4 w-4 flex-shrink-0" />
      <span>{displayMessage}</span>
    </div>
  );
}
