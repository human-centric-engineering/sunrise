import { AlertCircle } from 'lucide-react';

interface FormErrorProps {
  /**
   * Error message to display
   */
  message?: string;
}

/**
 * Form Error Message Component
 *
 * Displays validation error messages with icon, colored background,
 * and border for better visibility and user feedback.
 * Works in both light and dark modes.
 *
 * Usage:
 * ```tsx
 * <FormError message={errors.email?.message} />
 * ```
 */
export function FormError({ message }: FormErrorProps) {
  if (!message) return null;

  return (
    <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-400">
      <AlertCircle className="h-4 w-4 flex-shrink-0" />
      <span>{message}</span>
    </div>
  );
}
