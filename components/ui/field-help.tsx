'use client';

/**
 * FieldHelp — contextual help affordance for form fields.
 *
 * A small info-icon (ⓘ) button that opens a popover with an explanation
 * of what a setting does, when to change it, and what its default is.
 *
 * Usage:
 *
 * ```tsx
 * <Label>
 *   Model{' '}
 *   <FieldHelp title="LLM model">
 *     The exact model identifier your provider exposes. Changing this
 *     switches which model answers prompts. Default: <code>claude-opus-4-6</code>.
 *   </FieldHelp>
 * </Label>
 * ```
 *
 * Cross-cutting directive: every non-trivial form field from Session 4.1
 * onward should include one of these. See `.context/ui/contextual-help.md`
 * for the recommended what/when/default help-text structure.
 */

import * as React from 'react';
import { Info } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface FieldHelpProps {
  /** Short label displayed as the popover heading. Optional. */
  title?: string;
  /** Help body — plain text, markup, or <Link>s welcome. */
  children: React.ReactNode;
  /** Extra classes applied to the trigger button. */
  className?: string;
  /** Accessible label for the icon button. Defaults to "More information". */
  ariaLabel?: string;
}

export function FieldHelp({
  title,
  children,
  className,
  ariaLabel = 'More information',
}: FieldHelpProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            'text-muted-foreground hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full align-middle transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
            className
          )}
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="text-sm" align="start">
        {title && <div className="mb-1 font-semibold">{title}</div>}
        <div className="text-muted-foreground space-y-1 leading-relaxed">{children}</div>
      </PopoverContent>
    </Popover>
  );
}
