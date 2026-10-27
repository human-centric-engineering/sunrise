'use client';

/**
 * The agent form's web search setting: the provider's own web search, which
 * it runs while the model answers (`AiAgent.providerTools.webSearch`).
 *
 * Its own component rather than part of `ModelParamsFields`: that one is
 * shared with the `llm_call` step editor, and a step has no web search
 * setting. Controlled: the caller owns the whole `providerTools` value and
 * receives each change whole; this changes only its own key. Null means no
 * provider tool is on.
 */

import { useState } from 'react';

import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { MAX_WEB_SEARCH_USES, withProviderTool } from '@/lib/orchestration/llm/model-params';
import type { ProviderTools, WebSearchOptions } from '@/lib/orchestration/llm/types';

export interface WebSearchFieldsProps {
  /** Prefix for the input ids, so two instances on a page don't collide. */
  idPrefix: string;
  value: ProviderTools | null;
  onChange: (next: ProviderTools | null) => void;
  disabled?: boolean;
  /** A validation message for the setting, shown under it. */
  error?: string;
}

type DomainMode = 'any' | 'allow' | 'block';

function domainModeOf(search: WebSearchOptions | undefined): DomainMode {
  if (search?.allowedDomains?.length) return 'allow';
  if (search?.blockedDomains?.length) return 'block';
  return 'any';
}

/** One domain per line, blank lines dropped. */
function parseDomains(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function WebSearchFields({
  idPrefix,
  value,
  onChange,
  disabled = false,
  error,
}: WebSearchFieldsProps) {
  const search = value?.webSearch;
  const storedDomains = (search?.allowedDomains ?? search?.blockedDomains ?? []).join('\n');
  // The box and the mode keep what was typed and picked, so choosing "Only
  // these sites" before typing one isn't undone. When the stored value changes
  // from outside (a form reset, a version restore) both take it instead —
  // judged against the last value seen or sent, as the stop-sequence box does.
  const [domainText, setDomainText] = useState(storedDomains);
  const [mode, setMode] = useState<DomainMode>(domainModeOf(search));
  const incoming = JSON.stringify(search ?? null);
  const [synced, setSynced] = useState(incoming);
  if (incoming !== synced) {
    setSynced(incoming);
    setDomainText(storedDomains);
    setMode(domainModeOf(search));
  }

  const send = (next: WebSearchOptions | null): void => {
    setSynced(JSON.stringify(next));
    // Turning search off leaves the other provider tools on.
    onChange(withProviderTool(value, 'webSearch', next));
  };
  const withDomains = (
    base: WebSearchOptions,
    nextMode: DomainMode,
    domains: string[]
  ): WebSearchOptions => {
    const { allowedDomains: _allowed, blockedDomains: _blocked, ...rest } = base;
    if (nextMode === 'allow') return { ...rest, allowedDomains: domains };
    if (nextMode === 'block') return { ...rest, blockedDomains: domains };
    return rest;
  };

  return (
    <div className="grid gap-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`${idPrefix}-web-search`}>
          Web search{' '}
          <FieldHelp title="Provider web search">
            <p>
              Lets the model search the web while it answers, and use what it finds. The provider
              runs the searches, and each one costs $0.01 on top of the tokens its results add. Cost
              tracking includes both, and each search shows in the conversation trace.
            </p>
            <p className="mt-2">
              Works on Claude models (3.5 and later), and on OpenAI models from gpt-4o on (not
              gpt-4.1-nano, o1 or o3-mini) when the provider is OpenAI itself. Other providers and
              models ignore it. On Anthropic, an admin of your Anthropic organisation has to turn
              web search on in the Anthropic Console first, or requests from this agent will fail.
            </p>
            <p className="mt-2">
              OpenAI doesn&rsquo;t search at Minimal reasoning effort, or when the agent asks for
              structured output.
            </p>
          </FieldHelp>
        </Label>
        <Switch
          id={`${idPrefix}-web-search`}
          checked={search !== undefined}
          disabled={disabled}
          onCheckedChange={(on) => {
            setDomainText('');
            setMode('any');
            send(on ? {} : null);
          }}
        />
      </div>

      {search !== undefined && (
        <>
          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-web-search-max-uses`}>
              Most searches per reply{' '}
              <FieldHelp title="Search limit">
                <p>
                  The most searches the model may run for one reply, from 1 to {MAX_WEB_SEARCH_USES}
                  , counted across every step of the reply. Leave it empty for no limit.
                </p>
                <p className="mt-2">
                  On Claude, each later step of a reply that has already searched, such as the step
                  after a tool call, is sent the searches it has left. That step can&rsquo;t use the
                  prompt cache, so its input costs more.
                </p>
                <p className="mt-2">
                  On OpenAI, the limit applies to each step instead. The step after a tool call
                  usually searches again to cite its sources, and stopping it loses what the earlier
                  searches found. So a reply that calls tools can run past the limit. Opening a page
                  it found, or searching within one, counts toward the limit too. With code
                  execution also on, OpenAI would count code runs against the limit as well, so it
                  isn&rsquo;t applied there and searches are uncapped.
                </p>
              </FieldHelp>
            </Label>
            <Input
              id={`${idPrefix}-web-search-max-uses`}
              type="number"
              min={1}
              max={MAX_WEB_SEARCH_USES}
              step={1}
              value={search.maxUses ?? ''}
              placeholder="No limit"
              disabled={disabled}
              onChange={(e) => {
                const { maxUses: _maxUses, ...rest } = search;
                send(e.target.value === '' ? rest : { ...rest, maxUses: Number(e.target.value) });
              }}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-web-search-domain-mode`}>
              Sites{' '}
              <FieldHelp title="Which sites to search">
                <p>
                  Search any site, only the sites you list, or any site except the ones you list.
                  Put one domain on each line, like <code>example.com</code> or{' '}
                  <code>docs.example.com/guides</code>, without <code>https://</code>. A domain
                  includes its subdomains.
                </p>
                <p className="mt-2">
                  OpenAI models take domains without a path, so <code>docs.example.com/guides</code>{' '}
                  covers all of <code>docs.example.com</code> there. gpt-4o-mini and gpt-4.1-mini
                  can&rsquo;t limit sites at all, so with a list set they don&rsquo;t search.
                </p>
              </FieldHelp>
            </Label>
            <Select
              value={mode}
              disabled={disabled}
              onValueChange={(v) => {
                const nextMode = v as DomainMode;
                setMode(nextMode);
                send(withDomains(search, nextMode, parseDomains(domainText)));
              }}
            >
              <SelectTrigger id={`${idPrefix}-web-search-domain-mode`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any site</SelectItem>
                <SelectItem value="allow">Only these sites</SelectItem>
                <SelectItem value="block">Any site except these</SelectItem>
              </SelectContent>
            </Select>
            {mode !== 'any' && (
              <Textarea
                id={`${idPrefix}-web-search-domains`}
                aria-label={mode === 'allow' ? 'Sites to search' : 'Sites never to search'}
                rows={3}
                value={domainText}
                placeholder="One domain per line"
                disabled={disabled}
                onChange={(e) => {
                  setDomainText(e.target.value);
                  send(withDomains(search, mode, parseDomains(e.target.value)));
                }}
              />
            )}
          </div>
        </>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
