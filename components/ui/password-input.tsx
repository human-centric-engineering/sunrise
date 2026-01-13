'use client';

import * as React from 'react';
import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface PasswordInputProps extends Omit<React.ComponentProps<'input'>, 'type'> {
  /**
   * Additional class name for the wrapper div
   */
  wrapperClassName?: string;
}

/**
 * Password Input Component
 *
 * A password input field with a show/hide toggle button.
 * Wraps the standard Input component with visibility toggle functionality.
 *
 * Features:
 * - Show/hide password toggle with Eye/EyeOff icons
 * - Accessible with proper aria-labels
 * - Forwards ref to the underlying input element
 * - Supports all standard input props (except type, which is managed internally)
 *
 * Usage:
 * ```tsx
 * <PasswordInput
 *   id="password"
 *   placeholder="Enter password"
 *   {...register('password')}
 * />
 * ```
 */
const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, wrapperClassName, disabled, ...props }, ref) => {
    const [showPassword, setShowPassword] = useState(false);

    return (
      <div className={cn('relative', wrapperClassName)}>
        <Input
          type={showPassword ? 'text' : 'password'}
          className={cn('pr-10', className)}
          disabled={disabled}
          ref={ref}
          {...props}
        />
        <button
          type="button"
          onClick={() => setShowPassword(!showPassword)}
          disabled={disabled}
          className={cn(
            'absolute top-1/2 right-2 -translate-y-1/2',
            'text-muted-foreground hover:text-foreground',
            'focus-visible:ring-ring rounded focus-visible:ring-1 focus-visible:outline-none',
            disabled && 'pointer-events-none opacity-50'
          )}
          aria-label={showPassword ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    );
  }
);
PasswordInput.displayName = 'PasswordInput';

export { PasswordInput };
