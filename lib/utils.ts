import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Utility function to merge Tailwind CSS classes
 * Used by shadcn/ui components
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Type guard for plain record objects.
 *
 * Returns `true` when `value` is a non-null, non-array object, narrowing it
 * to `Record<string, unknown>`. Use this instead of `as Record<…>` casts
 * whenever you need to safely inspect properties on an unknown value.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
