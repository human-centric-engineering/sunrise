'use client';

/**
 * Checkbox — minimal native <input type="checkbox"> wrapper shaped like
 * the shadcn/Radix Checkbox API (accepts `checked` + `onCheckedChange`).
 *
 * The project doesn't ship `@radix-ui/react-checkbox`, so this is a
 * thin wrapper around the DOM primitive that gives us a typed
 * `onCheckedChange(next: boolean)` callback and applies the site's
 * Tailwind classes. If we later adopt Radix Checkbox, callers can stay
 * on the same prop shape.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface CheckboxProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'onChange'
> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, checked, onCheckedChange, ...props }, ref) => (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      className={cn(
        'border-input text-primary focus-visible:ring-ring h-4 w-4 shrink-0 rounded-sm border focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
);
Checkbox.displayName = 'Checkbox';
