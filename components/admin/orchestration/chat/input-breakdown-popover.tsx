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
  /** Optional raw text to expand inline (rendered in a monospace block). */
  content?: string;
  /** Optional rich explanation rendered above any `content` when the row is expanded. */
  explanation?: ReactNode;
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
      detail: <span className="text-muted-foreground">click to see what this covers</span>,
      explanation: (
        <div className="space-y-2 text-[11.5px] leading-relaxed">
          <p>
            <strong>What this row is.</strong> The reconciliation line — the difference between the
            model&rsquo;s reported input-token count and the sum of every other section above. Each
            section above counts the raw text we sent for that piece of content; this row catches
            everything the model adds on top that we can&rsquo;t attribute precisely from our side.
          </p>
          <div>
            <strong>What ends up in here:</strong>
            <ul className="mt-1 ml-3 list-disc space-y-0.5">
              <li>
                <strong>Per-message scaffolding.</strong> OpenAI adds ~3 tokens per message for role
                markers and delimiters (<code className="font-mono">&lt;|im_start|&gt;system</code>,
                etc.). On a turn with N messages that&rsquo;s ~3N tokens we never see in the section
                bodies.
              </li>
              <li>
                <strong>Tool-call envelope.</strong> Even with the openai-accurate tool counter
                wired in, the model still inserts a small wrapper around the <em>tools</em> block (
                <code className="font-mono"># Tools</code> header, namespace markers,
                assistant-priming displacement). ~5–15 tokens for the envelope itself.
              </li>
              <li>
                <strong>Assistant priming.</strong> 3 tokens at the very end of every prompt telling
                the model it&rsquo;s the assistant&rsquo;s turn to respond.
              </li>
              <li>
                <strong>Tool-call history.</strong> Previous assistant turns that called tools
                encode the function name + <code className="font-mono">tool_call_id</code> +
                arguments JSON, plus the matching <code className="font-mono">tool</code>-role
                result message. Our history estimator counts the text but under-counts these
                wrappers — they can easily add 100–300 tokens per round-trip.
              </li>
              <li>
                <strong>Image / document attachments.</strong> Vision tokens are charged per image
                tile (a 1024&times;1024 hi-res image is ~765 tokens on gpt-4o); we add a flat
                overhead per attachment, the rest lands here.
              </li>
              <li>
                <strong>Tokeniser drift.</strong> We tokenise locally with{' '}
                <code className="font-mono">gpt-tokenizer</code> (`o200k_base` for
                gpt-4o/4.1/o-series, <code className="font-mono">cl100k_base</code> for older
                models). It&rsquo;s very close to OpenAI&rsquo;s internal encoder but not
                bit-identical — last few tokens of drift land here.
              </li>
            </ul>
          </div>
          <p>
            <strong>Why it&rsquo;s often the biggest line.</strong> On agents with many bound
            capabilities or long history, the per-message scaffolding and tool-call wrappers stack
            up fast. The fix isn&rsquo;t code changes here — it&rsquo;s reducing the prompt: drop
            unused capabilities, shorten the system prompt, or let the conversation summariser kick
            in earlier (<code className="font-mono">maxHistoryMessages</code> on the agent config).
          </p>
        </div>
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
  const hasExplanation = !!section.explanation;
  const expandable = hasContent || hasExplanation;

  return (
    <li className="p-2">
      <div className="flex items-baseline justify-between gap-2">
        <button
          type="button"
          onClick={() => expandable && setOpen((v) => !v)}
          className={cn(
            'flex min-w-0 flex-1 items-baseline gap-1 text-left text-xs',
            expandable ? 'hover:text-foreground cursor-pointer' : 'cursor-default'
          )}
          aria-expanded={expandable ? open : undefined}
        >
          {expandable &&
            (open ? (
              <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
            ))}
          {!expandable && <span className="w-3 shrink-0" aria-hidden="true" />}
          <span className="font-medium whitespace-nowrap">{section.label}</span>
          {section.detail && (
            <span className="ml-1 min-w-0 text-[11px] break-words">{section.detail}</span>
          )}
        </button>
        <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
          {tokens.toLocaleString()} <span className="opacity-70">· {pct}%</span>
        </span>
      </div>
      {open && hasExplanation && (
        <div className="bg-muted/40 text-muted-foreground mt-2 rounded p-3">
          {section.explanation}
        </div>
      )}
      {open && hasContent && section.content && (
        <pre className="bg-muted/60 mt-2 max-h-64 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap">
          {section.content}
        </pre>
      )}
    </li>
  );
}
