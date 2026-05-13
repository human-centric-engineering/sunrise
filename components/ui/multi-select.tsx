'use client';

/**
 * MultiSelect — popover-based multi-pick control.
 *
 * Two modes:
 *   - **Static** (`options` prop): fixed list, rendered with a client-side search
 *     filter. Use when the option set is small enough to load eagerly (tags,
 *     enum values, a few dozen entries).
 *   - **Async** (`loadOptions` prop): server-paginated. Debounces the search
 *     input and calls `loadOptions(query)`; selected items keep their labels
 *     via the `selectedLabels` prop so chips stay readable when the option
 *     list is filtered server-side.
 *
 * Built on the project's existing Popover + native Checkbox primitives — no
 * `cmdk` dependency. Selected items render inline as Badge chips inside the
 * trigger button.
 */

import * as React from 'react';
import { ChevronsUpDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface MultiSelectOption {
  value: string;
  label: string;
  description?: string;
}

interface BaseProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  /** Maximum chips to render in the trigger before collapsing to "N selected". */
  maxVisibleChips?: number;
  id?: string;
  /** Accessible label for the trigger button (ties the popover to a form label via aria-labelledby). */
  ariaLabelledBy?: string;
  /**
   * Optional inline-create hook. When provided and the operator's search
   * query doesn't match an existing option exactly, a "Create '<query>'"
   * row appears at the top of the popover. Clicking it calls this function
   * with the trimmed query string and (when `createSupportsDescription` is
   * set) the operator-supplied description; the resolved option is
   * auto-selected. Errors are surfaced inline; the popover stays open.
   */
  onCreate?: (label: string, description?: string) => Promise<MultiSelectOption>;
  /** Optional copy override for the inline-create row. Defaults to `Create "<query>"`. */
  createLabel?: (query: string) => string;
  /**
   * When true, the "+ Create" affordance expands into a two-field inline
   * form (name + optional description) so the operator can fill in the
   * description before posting. Description is forwarded as the second
   * arg to `onCreate`. When false (default), `onCreate` is called
   * immediately with just the label.
   */
  createSupportsDescription?: boolean;
}

interface StaticProps extends BaseProps {
  options: MultiSelectOption[];
  loadOptions?: never;
  selectedLabels?: never;
}

interface AsyncProps extends BaseProps {
  options?: never;
  /** Async search — called as the user types (debounced 200ms). Should return up to ~50 options. */
  loadOptions: (query: string) => Promise<MultiSelectOption[]>;
  /** Map of value → label for currently-selected items, so chips render the right text when the option list is filtered out. */
  selectedLabels?: Record<string, string>;
}

export type MultiSelectProps = StaticProps | AsyncProps;

const DEBOUNCE_MS = 200;

export function MultiSelect(props: MultiSelectProps): React.ReactElement {
  const {
    value,
    onChange,
    placeholder = 'Select…',
    emptyText = 'No options',
    disabled,
    className,
    contentClassName,
    maxVisibleChips = 6,
    id,
    ariaLabelledBy,
    onCreate,
    createLabel,
    createSupportsDescription,
  } = props;
  const isAsync = 'loadOptions' in props && typeof props.loadOptions === 'function';

  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [asyncOptions, setAsyncOptions] = React.useState<MultiSelectOption[]>([]);
  const [asyncLoading, setAsyncLoading] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [createFormOpen, setCreateFormOpen] = React.useState(false);
  const [createDescription, setCreateDescription] = React.useState('');

  // Reset the inline-create form whenever the popover closes or the query
  // is cleared — keeps the form state in sync with the operator's intent.
  React.useEffect(() => {
    if (!open) {
      setCreateFormOpen(false);
      setCreateDescription('');
      setCreateError(null);
    }
  }, [open]);

  // Debounced async fetch.
  React.useEffect(() => {
    if (!isAsync) return;
    if (!open) return;
    const loadOptions = props.loadOptions;
    setAsyncLoading(true);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const fetched = await loadOptions(query);
          setAsyncOptions(fetched);
        } finally {
          setAsyncLoading(false);
        }
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [isAsync, open, query, props]);

  const visibleOptions = React.useMemo<MultiSelectOption[]>(() => {
    if (isAsync) return asyncOptions;
    const all = props.options;
    if (!query.trim()) return all;
    const q = query.trim().toLowerCase();
    return all.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        (o.description?.toLowerCase().includes(q) ?? false)
    );
  }, [isAsync, asyncOptions, query, props]);

  function toggle(optionValue: string): void {
    if (value.includes(optionValue)) {
      onChange(value.filter((v) => v !== optionValue));
    } else {
      onChange([...value, optionValue]);
    }
  }

  // Inline-create affordance: when the operator types a query that doesn't
  // match any existing option (case-insensitive label match), surface a
  // "Create '<query>'" row at the top. Clicking it hands the trimmed query
  // to the consumer's onCreate hook; resolved option is auto-selected.
  const trimmedQuery = query.trim();
  const exactLabelMatch =
    trimmedQuery.length > 0 &&
    visibleOptions.some((o) => o.label.toLowerCase() === trimmedQuery.toLowerCase());
  const canCreate = !!onCreate && trimmedQuery.length > 0 && !exactLabelMatch && !asyncLoading;

  async function handleCreate(): Promise<void> {
    if (!onCreate || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const description = createSupportsDescription ? createDescription.trim() : '';
      const created = await onCreate(
        trimmedQuery,
        description.length > 0 ? description : undefined
      );
      // Auto-select the new option. The consumer is responsible for
      // refreshing the options list (or supplying selectedLabels in async
      // mode) so the chip renders the right label after this.
      if (!value.includes(created.value)) onChange([...value, created.value]);
      setQuery('');
      setCreateFormOpen(false);
      setCreateDescription('');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create');
    } finally {
      setCreating(false);
    }
  }

  function removeChip(optionValue: string, event: React.MouseEvent): void {
    event.stopPropagation();
    onChange(value.filter((v) => v !== optionValue));
  }

  // Build a value→label lookup for chip rendering. In static mode this comes from
  // `options`; in async mode the caller passes `selectedLabels` so chips for items
  // that don't appear in the current async search keep their labels.
  const labelByValue = React.useMemo<Record<string, string>>(() => {
    if (isAsync) {
      const out: Record<string, string> = {
        ...(props.selectedLabels ?? {}),
      };
      for (const o of asyncOptions) out[o.value] = o.label;
      return out;
    }
    const map: Record<string, string> = {};
    for (const o of props.options) map[o.value] = o.label;
    return map;
  }, [isAsync, asyncOptions, props]);

  const chipsToShow = value.slice(0, maxVisibleChips);
  const hiddenChips = value.length - chipsToShow.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-labelledby={ariaLabelledBy}
          id={id}
          disabled={disabled}
          className={cn(
            'h-auto min-h-9 w-full justify-between gap-2 px-3 py-2 font-normal',
            className
          )}
        >
          <div className="flex flex-1 flex-wrap items-center gap-1 text-left">
            {value.length === 0 ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : (
              <>
                {chipsToShow.map((v) => (
                  <Badge key={v} variant="secondary" className="gap-1">
                    {labelByValue[v] ?? v}
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Remove ${labelByValue[v] ?? v}`}
                      onClick={(e) => removeChip(v, e)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          onChange(value.filter((x) => x !== v));
                        }
                      }}
                      className="hover:bg-muted/60 -mr-1 rounded-sm px-0.5"
                    >
                      <X className="h-3 w-3" />
                    </span>
                  </Badge>
                ))}
                {hiddenChips > 0 ? <Badge variant="outline">+{hiddenChips} more</Badge> : null}
              </>
            )}
          </div>
          <ChevronsUpDown className="text-muted-foreground h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn('w-[var(--radix-popover-trigger-width)] p-0', contentClassName)}
      >
        <div className="border-b p-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={isAsync ? 'Search…' : 'Filter…'}
            className="h-8"
            aria-label="Search options"
          />
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {canCreate && !createFormOpen ? (
            <button
              type="button"
              onClick={() => {
                if (createSupportsDescription) {
                  setCreateFormOpen(true);
                  setCreateError(null);
                } else {
                  void handleCreate();
                }
              }}
              disabled={creating}
              className="hover:bg-muted/60 flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm font-medium disabled:cursor-not-allowed"
            >
              <span className="text-primary">+</span>
              <span className="truncate">
                {creating
                  ? 'Creating…'
                  : (createLabel?.(trimmedQuery) ?? `Create "${trimmedQuery}"`)}
              </span>
            </button>
          ) : null}
          {canCreate && createFormOpen && createSupportsDescription ? (
            <div className="space-y-2 border-b p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="text-primary">+</span>
                <span className="truncate">{`Create "${trimmedQuery}"`}</span>
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="multi-select-create-description"
                  className="text-muted-foreground text-xs"
                >
                  Description (optional)
                </label>
                <Input
                  id="multi-select-create-description"
                  value={createDescription}
                  onChange={(e) => setCreateDescription(e.target.value)}
                  placeholder="What is this option for?"
                  className="h-8 text-sm"
                  disabled={creating}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleCreate();
                    }
                  }}
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setCreateFormOpen(false);
                    setCreateDescription('');
                    setCreateError(null);
                  }}
                  disabled={creating}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-3 text-xs"
                  onClick={() => {
                    void handleCreate();
                  }}
                  disabled={creating}
                >
                  {creating ? 'Creating…' : 'Create'}
                </Button>
              </div>
            </div>
          ) : null}
          {createError ? (
            <p className="text-destructive border-b px-3 py-2 text-xs">{createError}</p>
          ) : null}
          {asyncLoading ? (
            <div className="text-muted-foreground px-3 py-6 text-center text-sm">Loading…</div>
          ) : visibleOptions.length === 0 && !canCreate ? (
            <div className="text-muted-foreground px-3 py-6 text-center text-sm">{emptyText}</div>
          ) : (
            visibleOptions.map((option) => {
              const checked = value.includes(option.value);
              return (
                <label
                  key={option.value}
                  className={cn(
                    'hover:bg-muted/60 flex cursor-pointer items-start gap-2 px-3 py-2 text-sm',
                    checked && 'bg-muted/40'
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggle(option.value)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{option.label}</div>
                    {option.description ? (
                      <div className="text-muted-foreground truncate text-xs">
                        {option.description}
                      </div>
                    ) : null}
                  </div>
                </label>
              );
            })
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t px-2 py-1.5">
          {value.length > 0 ? (
            <>
              <span className="text-muted-foreground text-xs">{value.length} selected</span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => onChange([])}
                >
                  Clear all
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-3 text-xs"
                  onClick={() => setOpen(false)}
                >
                  Done
                </Button>
              </div>
            </>
          ) : (
            <>
              <span className="text-muted-foreground text-xs">None selected</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => setOpen(false)}
              >
                Done
              </Button>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
