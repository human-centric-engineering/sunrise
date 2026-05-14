'use client';

/**
 * InputBreakdownPopover — admin-only popover that explains why a chat
 * turn consumed N input tokens. Surfaces the per-section breakdown
 * supplied by the streaming handler on the `done` SSE event so
 * operators can attribute scaffolding cost (system prompt, tool
 * schemas, history) vs the user's actual message.
 *
 * Triggered by clicking the input-tokens number in the per-turn cost
 * strip; safe to render only inside admin route groups since it
 * surfaces the raw system prompt and capability schemas.
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { InputBreakdown, InputBreakdownPart } from '@/types/orchestration';

interface Props {
  breakdown: InputBreakdown;
  /** The model-reported input-token count, for comparison. */
  reportedInputTokens?: number;
  className?: string;
  /**
   * When true, the trigger renders just the number (no trailing
   * "input tokens" label). Used by the live chat's compact meta strip
   * where the surrounding text — `Toks: <number> input, …` — already
   * supplies the label.
   */
  compact?: boolean;
}

interface SectionConfig {
  key: string;
  label: string;
  part?: InputBreakdownPart;
  detail?: ReactNode;
  /** Optional raw text to expand inline. */
  content?: string;
}

export function InputBreakdownPopover({
  breakdown,
  reportedInputTokens,
  className,
  compact = false,
}: Props): React.ReactElement {
  const totalEstimated = breakdown.totalEstimated || 1;
  const displayTokens = reportedInputTokens ?? breakdown.totalEstimated;

  const sections: SectionConfig[] = [
    {
      key: 'systemPrompt',
      label: 'System prompt',
      part: breakdown.systemPrompt,
      content: breakdown.systemPrompt.content,
    },
  ];
  if (breakdown.toolDefinitions) {
    sections.push({
      key: 'toolDefinitions',
      label: `Tool schemas (${breakdown.toolDefinitions.count})`,
      part: breakdown.toolDefinitions,
      detail: (
        <span className="text-muted-foreground">{breakdown.toolDefinitions.names.join(', ')}</span>
      ),
      content: breakdown.toolDefinitions.content,
    });
  }
  if (breakdown.contextBlock) {
    sections.push({
      key: 'contextBlock',
      label: 'Entity context',
      part: breakdown.contextBlock,
      content: breakdown.contextBlock.content,
    });
  }
  if (breakdown.userMemories) {
    sections.push({
      key: 'userMemories',
      label: `User memories (${breakdown.userMemories.count})`,
      part: breakdown.userMemories,
      content: breakdown.userMemories.content,
    });
  }
  if (breakdown.conversationSummary) {
    sections.push({
      key: 'conversationSummary',
      label: 'Conversation summary',
      part: breakdown.conversationSummary,
      content: breakdown.conversationSummary.content,
    });
  }
  if (breakdown.conversationHistory) {
    sections.push({
      key: 'conversationHistory',
      label: 'Conversation history',
      part: breakdown.conversationHistory,
      detail: (
        <span className="text-muted-foreground">
          {breakdown.conversationHistory.messageCount} message
          {breakdown.conversationHistory.messageCount === 1 ? '' : 's'}
          {breakdown.conversationHistory.droppedCount > 0
            ? ` · ${breakdown.conversationHistory.droppedCount} dropped`
            : ''}
        </span>
      ),
    });
  }
  if (breakdown.attachments) {
    sections.push({
      key: 'attachments',
      label: `Attachments (${breakdown.attachments.count})`,
      part: { tokens: breakdown.attachments.tokens, chars: 0 },
    });
  }
  sections.push({
    key: 'userMessage',
    label: 'Your message',
    part: breakdown.userMessage,
    content: breakdown.userMessage.content,
  });
  if (breakdown.framingOverhead) {
    sections.push({
      key: 'framingOverhead',
      label: 'Provider framing',
      part: breakdown.framingOverhead,
      detail: (
        <span className="text-muted-foreground">
          per-message scaffolding, tool envelope, priming, tokeniser drift
        </span>
      ),
    });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'hover:text-foreground cursor-pointer underline decoration-dotted underline-offset-2',
            className
          )}
          title="Click to see why this turn used this many input tokens"
        >
          {displayTokens.toLocaleString()}
          {!compact && ' input tokens'}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(48rem,95vw)] p-0" align="start" side="top">
        <div className="border-border/60 flex items-baseline justify-between border-b p-3">
          <div className="text-sm font-medium">Input breakdown</div>
          <div className="text-muted-foreground text-[11px] tabular-nums">
            {typeof reportedInputTokens === 'number' && (
              <>model reported {reportedInputTokens.toLocaleString()} · </>
            )}
            est. {breakdown.totalEstimated.toLocaleString()}
          </div>
        </div>
        <ul className="divide-border/40 max-h-[60vh] divide-y overflow-auto">
          {sections.map((section) => (
            <Section key={section.key} section={section} totalEstimated={totalEstimated} />
          ))}
        </ul>
        <p className="text-muted-foreground border-border/60 border-t p-2 text-[10.5px] leading-snug">
          Sections show the local-tokeniser count of each piece of content sent to the model. The
          total is reconciled to the model&rsquo;s reported{' '}
          <code className="font-mono">usage.input_tokens</code>, with any unattributed remainder
          shown as &ldquo;Provider framing&rdquo;. Counts reflect the first LLM call of this turn;
          tool round-trips add more on subsequent iterations.
        </p>
      </PopoverContent>
    </Popover>
  );
}

interface SectionProps {
  section: SectionConfig;
  totalEstimated: number;
}

function Section({ section, totalEstimated }: SectionProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const tokens = section.part?.tokens ?? 0;
  const pct = totalEstimated > 0 ? Math.round((tokens / totalEstimated) * 100) : 0;
  const hasContent = !!section.content && section.content.length > 0;

  return (
    <li className="p-2">
      <div className="flex items-baseline justify-between gap-2">
        <button
          type="button"
          onClick={() => hasContent && setOpen((v) => !v)}
          className={cn(
            'flex min-w-0 flex-1 items-baseline gap-1 text-left text-xs',
            hasContent ? 'hover:text-foreground cursor-pointer' : 'cursor-default'
          )}
          aria-expanded={hasContent ? open : undefined}
        >
          {hasContent &&
            (open ? (
              <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
            ))}
          {!hasContent && <span className="w-3 shrink-0" aria-hidden="true" />}
          <span className="font-medium whitespace-nowrap">{section.label}</span>
          {section.detail && (
            <span className="ml-1 min-w-0 text-[11px] break-words">{section.detail}</span>
          )}
        </button>
        <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
          {tokens.toLocaleString()} <span className="opacity-70">· {pct}%</span>
        </span>
      </div>
      {open && hasContent && section.content && (
        <pre className="bg-muted/60 mt-2 max-h-64 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap">
          {section.content}
        </pre>
      )}
    </li>
  );
}
