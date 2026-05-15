'use client';

/**
 * JsonPretty — renders a JSON value (or pre-stringified JSON) inside a
 * monospaced block with proper indentation and lightweight syntax
 * highlighting (keys, strings, numbers, booleans, null).
 *
 * Indentation is preserved because the container uses `whitespace-pre`
 * with `overflow-x-auto` — long lines scroll horizontally instead of
 * being broken mid-token, which is what destroys indentation in the
 * default `<pre whitespace-pre-wrap break-all>` styling.
 *
 * The highlighter runs over `JSON.stringify` output, which is always
 * well-formed, so a regex tokenizer is sufficient. The component never
 * renders raw user-provided HTML — every span body is a JS string.
 */

import { Fragment, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface Props {
  /** Already-formatted JSON string, or any value to stringify. */
  data: unknown;
  /** Optional class names (e.g. `max-h-60 overflow-y-auto`). */
  className?: string;
}

const TOKEN_RE =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export function JsonPretty({ data, className }: Props) {
  const text = typeof data === 'string' ? data : safeStringify(data);

  return (
    <pre
      className={cn(
        'bg-muted/40 text-foreground/90 overflow-x-auto rounded p-2 font-mono text-xs leading-relaxed whitespace-pre',
        className
      )}
    >
      {highlight(text)}
    </pre>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function highlight(json: string): ReactNode {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  TOKEN_RE.lastIndex = 0;
  for (let match = TOKEN_RE.exec(json); match !== null; match = TOKEN_RE.exec(json)) {
    if (match.index > lastIndex) {
      nodes.push(<Fragment key={`t${key++}`}>{json.slice(lastIndex, match.index)}</Fragment>);
    }
    const [whole, stringLit, colonSuffix, keyword] = match;
    if (stringLit !== undefined) {
      const isKey = colonSuffix !== undefined;
      nodes.push(
        <span
          key={`s${key++}`}
          className={
            isKey ? 'text-sky-700 dark:text-sky-300' : 'text-emerald-700 dark:text-emerald-300'
          }
        >
          {stringLit}
        </span>
      );
      if (isKey) {
        nodes.push(<Fragment key={`c${key++}`}>{colonSuffix}</Fragment>);
      }
    } else if (keyword !== undefined) {
      nodes.push(
        <span
          key={`k${key++}`}
          className={
            keyword === 'null' ? 'text-muted-foreground' : 'text-purple-700 dark:text-purple-300'
          }
        >
          {keyword}
        </span>
      );
    } else {
      // numeric literal — `whole` is the full match
      nodes.push(
        <span key={`n${key++}`} className="text-amber-700 dark:text-amber-300">
          {whole}
        </span>
      );
    }
    lastIndex = TOKEN_RE.lastIndex;
  }
  if (lastIndex < json.length) {
    nodes.push(<Fragment key={`t${key++}`}>{json.slice(lastIndex)}</Fragment>);
  }
  return nodes;
}
