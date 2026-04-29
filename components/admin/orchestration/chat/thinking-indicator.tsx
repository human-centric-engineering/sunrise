/**
 * ThinkingIndicator — animated dots with optional status message.
 *
 * Renders three bouncing dots followed by a status label (e.g. "Thinking…",
 * "Executing search_documents"). Used inside the assistant message bubble
 * while the LLM is processing, replacing the previous generic Loader2 spinner.
 *
 * The dots use staggered CSS `animation-delay` for the classic chatbot pulse.
 *
 * @see components/admin/orchestration/chat/chat-interface.tsx
 */

import { cn } from '@/lib/utils';

export interface ThinkingIndicatorProps {
  /** Status text from SSE, e.g. "Thinking…", "Executing search_documents". */
  message?: string | null;
  /** Additional class names for the outer container. */
  className?: string;
}

export function ThinkingIndicator({ message, className }: ThinkingIndicatorProps) {
  const label = message || 'Thinking…';

  return (
    <div
      className={cn('flex items-center gap-1.5 text-sm', className)}
      role="status"
      aria-label={label}
    >
      <span className="flex items-center gap-0.5" aria-hidden="true">
        <span className="bg-muted-foreground/60 inline-block h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:0s]" />
        <span className="bg-muted-foreground/60 inline-block h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:0.15s]" />
        <span className="bg-muted-foreground/60 inline-block h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:0.3s]" />
      </span>
      <span className="text-muted-foreground max-w-[250px] truncate text-xs italic">{label}</span>
    </div>
  );
}
