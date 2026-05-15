'use client';

/**
 * MarkdownOrRawView — renders a string body either as rendered markdown
 * or as a raw monospace block, with a small toggle. Used by the admin
 * executions UI to show input/output summaries that the model emits in
 * markdown without losing access to the underlying text.
 *
 * The caller is responsible for the surrounding card / copy button.
 * Copy actions should always operate on the raw string passed in here.
 */

import { useState } from 'react';
// SECURITY: only `remark-gfm` is enabled (tables, task lists, strikethrough,
// autolinks). It is a parser-level extension and does NOT permit raw HTML —
// raw `<script>` etc. in the source still renders as inert text. Do NOT add
// `rehype-raw` or `allowDangerousHtml`; that would turn prompt-injected HTML
// into an XSS sink.
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const MARKDOWN_BLOCK_CLASSES = [
  '[&>:first-child]:mt-0 [&>:last-child]:mb-0',
  '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_ul]:my-2 [&_ul]:pl-5 [&_ul]:list-disc',
  '[&_ol]:my-2 [&_ol]:pl-5 [&_ol]:list-decimal',
  '[&_li]:my-0.5 [&_li>p]:my-0',
  '[&_h1]:my-2 [&_h1]:text-base [&_h1]:font-semibold',
  '[&_h2]:my-2 [&_h2]:text-base [&_h2]:font-semibold',
  '[&_h3]:my-2 [&_h3]:font-semibold',
  '[&_h4]:my-2 [&_h4]:font-semibold',
  '[&_h5]:my-2 [&_h5]:font-semibold',
  '[&_h6]:my-2 [&_h6]:font-semibold',
  '[&_strong]:font-semibold [&_em]:italic',
  '[&_code]:rounded-sm [&_code]:bg-foreground/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em]',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-foreground/5 [&_pre]:p-2',
  '[&_pre>code]:bg-transparent [&_pre>code]:p-0',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:opacity-90',
  '[&_a]:text-primary [&_a]:underline',
  '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs',
  '[&_th]:border [&_th]:border-border [&_th]:bg-muted/60 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold',
  '[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top',
  '[&_hr]:my-3 [&_hr]:border-border',
  '[&_input[type=checkbox]]:mr-1',
].join(' ');

interface Props {
  /** Raw text content (must be markdown-eligible — caller decides). */
  content: string;
  /** Optional max-height utility class for the raw <pre>. */
  rawMaxHeightClass?: string;
  /** Optional className for the outer container. */
  className?: string;
}

export function MarkdownOrRawView({
  content,
  rawMaxHeightClass,
  className,
}: Props): React.ReactElement {
  const [mode, setMode] = useState<'rendered' | 'raw'>('rendered');

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex justify-end">
        <div
          role="tablist"
          aria-label="View mode"
          className="bg-muted text-muted-foreground inline-flex rounded-md p-0.5"
        >
          <Button
            type="button"
            role="tab"
            aria-selected={mode === 'rendered'}
            size="sm"
            variant={mode === 'rendered' ? 'secondary' : 'ghost'}
            className="h-6 px-2 text-[11px]"
            onClick={() => setMode('rendered')}
          >
            Rendered
          </Button>
          <Button
            type="button"
            role="tab"
            aria-selected={mode === 'raw'}
            size="sm"
            variant={mode === 'raw' ? 'secondary' : 'ghost'}
            className="h-6 px-2 text-[11px]"
            onClick={() => setMode('raw')}
          >
            Raw
          </Button>
        </div>
      </div>
      {mode === 'rendered' ? (
        <div
          className={cn(
            'bg-muted/40 max-w-none overflow-x-auto rounded p-2 text-sm',
            MARKDOWN_BLOCK_CLASSES
          )}
        >
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        </div>
      ) : (
        <pre
          className={cn(
            'bg-muted/40 rounded p-2 font-mono text-xs break-all whitespace-pre-wrap',
            rawMaxHeightClass
          )}
        >
          {content}
        </pre>
      )}
    </div>
  );
}
