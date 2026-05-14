'use client';

/**
 * InputBreakdownList — admin-only inline panel that explains why a
 * chat turn consumed N input tokens. Surfaces the per-section
 * breakdown supplied by the streaming handler on the `done` SSE event
 * so operators can attribute scaffolding cost (system prompt, tool
 * schemas, history) vs the user's actual message.
 *
 * Renders inline beneath an assistant message, alongside Sources and
 * Tools panels — same chevron-toggle pattern (see `AssistantMetaStrip`
 * in `chat-interface.tsx`). Safe to render only inside admin route
 * groups since it surfaces the raw system prompt and capability
 * schemas.
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import type {
  InputBreakdown,
  InputBreakdownPart,
  SideEffectModelUsage,
} from '@/types/orchestration';

interface Props {
  /**
   * Per-section input-token breakdown for the main LLM call. Optional
   * — the panel can render with only side-effect models if the breakdown
   * never came through (e.g. an error before usage was reported).
   */
  breakdown?: InputBreakdown;
  /** The model-reported input-token count, for the header comparison. */
  reportedInputTokens?: number;
  /**
   * Model id used for this turn. Drives the provider-specific copy in
   * the "Provider framing" explainer — OpenAI, Anthropic, Gemini and
   * the Llama-family approximator each have different framing
   * overheads and local tokenisation strategies, so the explainer
   * needs to match what we actually did for this turn.
   */
  model?: string;
  /**
   * Additional models invoked during this turn beyond the main chat
   * LLM (embeddings from `search_knowledge_base`, the rolling
   * summariser). Rendered as a separate section beneath the main
   * input-token breakdown so the operator can see the full per-turn
   * cost picture without leaving the panel.
   */
  sideEffectModels?: SideEffectModelUsage[];
  className?: string;
}

function formatPanelCostUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '$0.00';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

type ProviderFamily = 'openai' | 'anthropic' | 'gemini' | 'llama' | 'unknown';

/**
 * Detect provider family from a model id using the same naming
 * conventions the server-side `tokeniserForModel` uses. Kept inline
 * (client component) so we don't pull the server-only registry into
 * the bundle.
 */
function detectProviderFamily(modelId: string | undefined): ProviderFamily {
  if (!modelId) return 'unknown';
  const id = modelId.toLowerCase();
  if (id.startsWith('claude-') || id.includes('anthropic')) return 'anthropic';
  if (id.startsWith('gemini-') || id.startsWith('gemini/') || id.includes('google'))
    return 'gemini';
  if (id.startsWith('gpt-') || id === 'gpt-4' || id.includes('gpt-3.5')) return 'openai';
  if (/^o[134](-|$)/.test(id)) return 'openai';
  if (id.includes('llama') || id.includes('mistral') || id.includes('qwen')) return 'llama';
  return 'unknown';
}

/** Short tokeniser-status line for each family. */
function tokeniserLabel(family: ProviderFamily): string {
  switch (family) {
    case 'openai':
      return 'Exact: gpt-tokenizer (o200k_base for gpt-4o/4.1/o-series, cl100k_base for older).';
    case 'anthropic':
      return 'Approximate: o200k_base × 1.10 calibration (Anthropic ships no local tokeniser; their count_tokens endpoint is network-only and we need a synchronous count).';
    case 'gemini':
      return 'Approximate: o200k_base × 1.10 calibration (Google’s countTokens is SDK-only / network).';
    case 'llama':
      return 'Approximate: o200k_base × 1.05 calibration (Llama-family BPE is close in density to o200k).';
    case 'unknown':
      return 'Approximate: o200k_base × 1.05 calibration (defensive default for unrecognised model id).';
  }
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

export function InputBreakdownList({
  breakdown,
  reportedInputTokens,
  model,
  sideEffectModels,
  className,
}: Props): React.ReactElement {
  const totalEstimated = breakdown?.totalEstimated || 1;
  const family = detectProviderFamily(model);
  const hasSideEffects = !!sideEffectModels && sideEffectModels.length > 0;

  const sections: SectionConfig[] = [];
  if (breakdown) {
    sections.push({
      key: 'systemPrompt',
      label: 'System prompt',
      part: breakdown.systemPrompt,
      content: breakdown.systemPrompt.content,
    });
  }
  if (breakdown?.toolDefinitions) {
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
  if (breakdown?.contextBlock) {
    sections.push({
      key: 'contextBlock',
      label: 'Entity context',
      part: breakdown.contextBlock,
      content: breakdown.contextBlock.content,
    });
  }
  if (breakdown?.userMemories) {
    sections.push({
      key: 'userMemories',
      label: `User memories (${breakdown.userMemories.count})`,
      part: breakdown.userMemories,
      content: breakdown.userMemories.content,
    });
  }
  if (breakdown?.conversationSummary) {
    sections.push({
      key: 'conversationSummary',
      label: 'Conversation summary',
      part: breakdown.conversationSummary,
      content: breakdown.conversationSummary.content,
    });
  }
  if (breakdown?.conversationHistory) {
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
  if (breakdown?.attachments) {
    sections.push({
      key: 'attachments',
      label: `Attachments (${breakdown.attachments.count})`,
      part: { tokens: breakdown.attachments.tokens, chars: 0 },
    });
  }
  if (breakdown) {
    sections.push({
      key: 'userMessage',
      label: 'Your message',
      part: breakdown.userMessage,
      content: breakdown.userMessage.content,
    });
  }
  if (breakdown?.framingOverhead) {
    sections.push({
      key: 'framingOverhead',
      label: 'Provider framing',
      part: breakdown.framingOverhead,
      detail: <span className="text-muted-foreground">click to see what this covers</span>,
      explanation: <FramingExplainer family={family} model={model} />,
    });
  }

  return (
    <aside
      className={cn('border-border/40 bg-muted/40 mt-2 overflow-hidden rounded border', className)}
      data-testid="input-breakdown"
    >
      {breakdown && typeof reportedInputTokens === 'number' && (
        <div className="border-border/40 text-muted-foreground flex items-baseline justify-between border-b px-3 py-1.5 text-[11px] tabular-nums">
          <span>model reported {reportedInputTokens.toLocaleString()}</span>
          <span>est. {breakdown.totalEstimated.toLocaleString()}</span>
        </div>
      )}
      {sections.length > 0 && (
        <ul className="divide-border/40 divide-y">
          {sections.map((section) => (
            <Section key={section.key} section={section} totalEstimated={totalEstimated} />
          ))}
        </ul>
      )}
      {breakdown && (
        <p className="text-muted-foreground border-border/40 border-t p-2 text-[10.5px] leading-snug">
          Sections show the local-tokeniser count of each piece of content sent to the model. The
          total is reconciled to the model&rsquo;s reported{' '}
          <code className="font-mono">usage.input_tokens</code>, with any unattributed remainder
          shown as &ldquo;Provider framing&rdquo;. Counts reflect the first LLM call of this turn;
          tool round-trips add more on subsequent iterations.
        </p>
      )}
      {hasSideEffects && sideEffectModels && <SideEffectModelsSection entries={sideEffectModels} />}
    </aside>
  );
}

/**
 * Detail panel for "other models invoked this turn" — embeddings fired
 * by `search_knowledge_base`, the rolling conversation summariser, etc.
 *
 * Kept inside the input-breakdown popover (rather than always-visible on
 * the cost row) so admins see the full cost picture *on demand* without
 * the strip itself getting noisier. The cost row's `+N models` chip
 * advertises that there's more to see.
 */
function SideEffectModelsSection({
  entries,
}: {
  entries: SideEffectModelUsage[];
}): React.ReactElement {
  const totalCost = entries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  return (
    <div className="border-border/40 border-t" data-testid="side-effect-models">
      <div className="text-muted-foreground flex items-baseline justify-between px-3 py-1.5 text-[11px] tabular-nums">
        <span>Other models this turn</span>
        {totalCost > 0 && <span>≈ {formatPanelCostUsd(totalCost)}</span>}
      </div>
      <ul className="divide-border/40 divide-y">
        {entries.map((entry) => (
          <SideEffectModelRow key={`${entry.kind}-${entry.model}`} entry={entry} />
        ))}
      </ul>
      <p className="text-muted-foreground border-border/40 border-t p-2 text-[10.5px] leading-snug">
        These models run alongside the main chat LLM — <strong>embeddings</strong> each time the
        agent calls <code className="font-mono">search_knowledge_base</code>, and the{' '}
        <strong>summariser</strong> when the conversation history grows past the agent&rsquo;s{' '}
        <code className="font-mono">maxHistoryMessages</code> cap. Their cost is logged separately
        in <code className="font-mono">AiCostLog</code> and rolls up into the agent&rsquo;s monthly
        spend; the main cost line above only reflects the chat LLM.
      </p>
    </div>
  );
}

function SideEffectModelRow({ entry }: { entry: SideEffectModelUsage }): React.ReactElement {
  const label = entry.kind === 'embedding' ? 'Embedding' : 'Summariser';
  const calls = entry.callCount ?? 1;
  return (
    <li className="px-3 py-1.5 text-[11px] tabular-nums">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 flex-1 items-baseline gap-1 text-left">
          <span className="font-medium">{label}</span>
          {calls > 1 && <span className="text-muted-foreground">× {calls}</span>}
          <span className="text-muted-foreground font-mono text-[10.5px]">{entry.model}</span>
          {entry.provider && (
            <span className="text-muted-foreground text-[10.5px]">via {entry.provider}</span>
          )}
        </span>
        <span className="text-muted-foreground shrink-0">
          {typeof entry.inputTokens === 'number' && (
            <span>
              {entry.inputTokens.toLocaleString()}
              {typeof entry.outputTokens === 'number' && entry.outputTokens > 0
                ? `→${entry.outputTokens.toLocaleString()}`
                : ''}{' '}
              toks
            </span>
          )}
          {typeof entry.costUsd === 'number' && entry.costUsd > 0 && (
            <span> · ≈ {formatPanelCostUsd(entry.costUsd)}</span>
          )}
        </span>
      </div>
    </li>
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

interface FramingExplainerProps {
  family: ProviderFamily;
  model: string | undefined;
}

/**
 * Provider-conditional copy for the "Provider framing" row. The
 * scaffolding tokens, tool-envelope shape, image charging rules and
 * local tokeniser all differ per provider family, so the explainer
 * needs to match the active model — not parrot OpenAI nuances for an
 * Anthropic turn.
 */
function FramingExplainer({ family, model }: FramingExplainerProps): React.ReactElement {
  return (
    <div className="space-y-2 text-[11.5px] leading-relaxed">
      <p>
        <strong>What this row is.</strong> The reconciliation line — the difference between the
        model&rsquo;s reported input-token count and the sum of every other section above. Each
        section above counts the raw text we sent for that piece of content; this row catches
        everything the model adds on top that we can&rsquo;t attribute precisely from our side.
      </p>
      <div>
        <strong>What ends up in here{model ? ` (${model})` : ''}:</strong>
        <ul className="mt-1 ml-3 list-disc space-y-0.5">
          {family === 'openai' && <OpenAiFramingBullets />}
          {family === 'anthropic' && <AnthropicFramingBullets />}
          {family === 'gemini' && <GeminiFramingBullets />}
          {(family === 'llama' || family === 'unknown') && <GenericFramingBullets />}
          <li>
            <strong>Tokeniser drift.</strong> {tokeniserLabel(family)} Any residual difference vs
            the model&rsquo;s own count lands here.
          </li>
        </ul>
      </div>
      <p>
        <strong>Why it&rsquo;s often the biggest line.</strong> On agents with many bound
        capabilities or long history, per-message scaffolding and tool-call wrappers stack up fast.
        The fix isn&rsquo;t code changes here — it&rsquo;s reducing the prompt: drop unused
        capabilities, shorten the system prompt, or let the conversation summariser kick in earlier
        (<code className="font-mono">maxHistoryMessages</code> on the agent config).
      </p>
    </div>
  );
}

function OpenAiFramingBullets(): React.ReactElement {
  return (
    <>
      <li>
        <strong>Per-message scaffolding.</strong> OpenAI adds ~3 tokens per message for role markers
        and delimiters (<code className="font-mono">&lt;|im_start|&gt;system</code>, etc.). On a
        turn with N messages that&rsquo;s ~3N tokens we never see in the section bodies.
      </li>
      <li>
        <strong>Tool-call envelope.</strong> Even with the openai-accurate tool counter wired in,
        the model still inserts a small wrapper around the <em>tools</em> block (
        <code className="font-mono"># Tools</code> header, namespace markers, assistant-priming
        displacement). ~5–15 tokens for the envelope itself.
      </li>
      <li>
        <strong>Assistant priming.</strong> 3 tokens at the very end of every prompt telling the
        model it&rsquo;s the assistant&rsquo;s turn to respond.
      </li>
      <li>
        <strong>Tool-call history.</strong> Previous assistant turns that called tools encode the
        function name + <code className="font-mono">tool_call_id</code> + arguments JSON, plus the
        matching <code className="font-mono">tool</code>-role result message. Our history estimator
        counts the text but under-counts these wrappers — they can easily add 100–300 tokens per
        round-trip.
      </li>
      <li>
        <strong>Image / document attachments.</strong> Vision tokens are charged per image tile (a
        1024&times;1024 hi-res image is ~765 tokens on gpt-4o); we add a flat overhead per
        attachment, the rest lands here.
      </li>
    </>
  );
}

function AnthropicFramingBullets(): React.ReactElement {
  return (
    <>
      <li>
        <strong>Per-message scaffolding.</strong> Anthropic wraps each turn in content blocks (
        <code className="font-mono">role</code> + content array framing). Overhead is comparable to
        OpenAI&rsquo;s ~3 tokens/message but the exact figure is unpublished — what we can&rsquo;t
        attribute lands here.
      </li>
      <li>
        <strong>Tool definitions &amp; tool-use blocks.</strong> Anthropic tokenises tools via its
        own internal representation (XML-style <code className="font-mono">&lt;tool_use&gt;</code> /{' '}
        <code className="font-mono">&lt;tool_result&gt;</code> blocks). We count tool schemas as raw
        JSON, which is conservative but loose — the difference vs Anthropic&rsquo;s real
        tokenisation flows through this row.
      </li>
      <li>
        <strong>System prompt placement.</strong> Anthropic accepts a top-level{' '}
        <code className="font-mono">system</code> field separate from the messages array. Framing
        around that field isn&rsquo;t in our raw text count.
      </li>
      <li>
        <strong>Tool-call history.</strong> Prior <code className="font-mono">tool_use</code> /{' '}
        <code className="font-mono">tool_result</code> block pairs add ~50–200 tokens of envelope
        per round-trip that our text-only history estimator misses.
      </li>
      <li>
        <strong>Image / document attachments.</strong> Anthropic charges per image based on
        resolution bands (typically ~1 000–1 600 tokens for a normal image). We add a flat ~1 600
        per attachment; any difference vs Anthropic&rsquo;s actual lands here.
      </li>
    </>
  );
}

function GeminiFramingBullets(): React.ReactElement {
  return (
    <>
      <li>
        <strong>Per-message scaffolding.</strong> Gemini wraps each turn in <em>parts</em> with role
        framing. The exact per-message overhead isn&rsquo;t published — what we can&rsquo;t
        attribute lands here.
      </li>
      <li>
        <strong>System instructions field.</strong> Gemini accepts{' '}
        <code className="font-mono">systemInstruction</code> as a top-level field, separate from{' '}
        <code className="font-mono">contents</code>. Framing around that field isn&rsquo;t in our
        raw text count.
      </li>
      <li>
        <strong>Function declarations &amp; calls.</strong> Tool schemas are sent as{' '}
        <code className="font-mono">functionDeclarations</code>; tool-use history encodes as{' '}
        <code className="font-mono">functionCall</code> /{' '}
        <code className="font-mono">functionResponse</code> parts. We count tool schemas as raw
        JSON; the difference vs Google&rsquo;s internal tokenisation flows here.
      </li>
      <li>
        <strong>Image / document attachments.</strong> Gemini tokenises images per tile / per page
        (PDFs at ~258 tokens/page). We add a flat overhead; any delta vs Google&rsquo;s actual lands
        here.
      </li>
    </>
  );
}

function GenericFramingBullets(): React.ReactElement {
  return (
    <>
      <li>
        <strong>Per-message scaffolding.</strong> Most chat-template providers add a small number of
        tokens per message for role markers and delimiters. The exact value depends on the chat
        template the provider uses (Llama 3 ChatML-like, Mistral instruct, etc.).
      </li>
      <li>
        <strong>Tool definitions &amp; calls.</strong> Tool schemas are typically serialised
        per-provider. We count raw JSON; the difference vs the provider&rsquo;s actual internal
        representation lands here.
      </li>
      <li>
        <strong>Tool-call history.</strong> Previous tool round-trips add envelope tokens our
        text-only history estimator doesn&rsquo;t see — typically 50–300 per round-trip.
      </li>
      <li>
        <strong>Image / document attachments.</strong> Vision tokenisation varies widely by
        provider. We add a flat overhead per attachment; any difference lands here.
      </li>
    </>
  );
}
