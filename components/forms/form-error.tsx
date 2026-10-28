'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Copy, RotateCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { getUserFriendlyMessage } from '@/lib/errors/messages';
import type { SaveFailure } from '@/lib/errors/save-error';

interface FormErrorProps {
  /**
   * Error message to display
   * If both message and code are provided, message takes precedence
   */
  message?: string;
  /**
   * Error code to map to user-friendly message
   * Uses the error messages from lib/errors/messages.ts
   */
  code?: string;
}

/**
 * Form Error Message Component
 *
 * Displays validation error messages with icon, colored background,
 * and border for better visibility and user feedback.
 * Works in both light and dark modes.
 *
 * Supports both direct messages and error code mapping for user-friendly display.
 *
 * A failed **save** uses `<SaveError>` below instead: it sits by the Save
 * button and brings itself into view (`.context/ui/form-errors.md`).
 *
 * Usage:
 * ```tsx
 * // Direct message
 * <FormError message={errors.email?.message} />
 *
 * // Error code (automatically maps to user-friendly message)
 * <FormError code="UNAUTHORIZED" />
 * // → "Please sign in to continue."
 *
 * // From API error response
 * <FormError code={apiError.code} message={apiError.message} />
 * ```
 */
export function FormError({ message, code }: FormErrorProps) {
  // Determine the display message:
  // 1. Use explicit message if provided
  // 2. Otherwise, map error code to user-friendly message
  // 3. If neither, show nothing
  const displayMessage = message || (code ? getUserFriendlyMessage(code) : undefined);

  if (!displayMessage) return null;

  return (
    <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-400">
      <AlertCircle className="h-4 w-4 flex-shrink-0" />
      <span>{displayMessage}</span>
    </div>
  );
}

/** The stale variant's content: what changed, and what the page can do about it. */
export interface StaleSaveProps {
  /** What changed, as the start of a sentence: "The escalation list". */
  what: string;
  /** Called instead of reloading the page, for a list that can reload its own data. */
  onReload?: () => void;
  /**
   * Copies the unsaved edits somewhere they survive a reload, for a page that
   * can. Its promise says whether the copy landed: the button says so too,
   * since an admin who trusts a failed copy and reloads loses the edits.
   */
  onCopyChanges?: () => Promise<void>;
}

export interface SaveErrorProps<TField extends string> {
  /**
   * The failed save, from `readSaveError()`; null renders nothing. Each new
   * failure object brings the error into view again, so a second failure with
   * the same message still moves.
   */
  failure: SaveFailure<TField> | null;
  /**
   * Rendered in place of the message when the failure is stale (412
   * `STALE_RECORD`). Without it a stale failure shows its message like any other.
   */
  stale?: StaleSaveProps;
  /**
   * Brings a hidden field's container forward (a tab) when not every named
   * field is on the page. Called with all of them, in the order the server
   * sent; the form brings forward whichever holds the one it shows first (its
   * earliest tab). Focus then goes to the first named field on the page.
   */
  onRevealField?: (fields: TField[]) => void;
}

/**
 * The first of `names` in page order inside `root`, matched on `name` or `id`,
 * or null unless every one of them is there: with any missing, the first in
 * page order is unknown, and focusing a later one would skip an earlier error.
 */
function firstField(root: ParentNode, names: readonly string[]): HTMLElement | null {
  const found = Array.from(root.querySelectorAll<HTMLElement>('[name], [id]')).filter(
    (el) => names.includes(el.getAttribute('name') ?? '') || names.includes(el.id)
  );
  const matched = new Set(
    found.flatMap((el) => [el.getAttribute('name') ?? '', el.id]).filter((n) => names.includes(n))
  );
  return names.every((n) => matched.has(n)) ? (found[0] ?? null) : null; // document order
}

/** The first of `names` on the page inside `root`, in page order, whichever it is. */
function firstPresent(root: ParentNode, names: readonly string[]): HTMLElement | null {
  return (
    Array.from(root.querySelectorAll<HTMLElement>('[name], [id]')).find(
      (el) => names.includes(el.getAttribute('name') ?? '') || names.includes(el.id)
    ) ?? null
  );
}

/** Frames to wait for a revealed tab to render before giving the summary focus. */
const REVEAL_FRAMES = 5;

/** Focuses a field, reporting whether it took focus (a disabled one does not). */
function focusField(el: HTMLElement): boolean {
  el.focus({ preventScroll: true });
  if (document.activeElement !== el) return false;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return true;
}

/**
 * The one way a form shows a failed save (§124): red, announced, placed by the
 * form beside the Save button that was pressed, and brought into view and
 * focused whenever a new failure appears. When the server named fields and all
 * of them are on the page, focus goes to the first of them instead, since that
 * is what needs fixing; this summary stays by Save saying how many. Otherwise,
 * or when that field cannot take focus, the summary takes it.
 *
 * It decides nothing about placement: the form puts it where its Save is.
 *
 * @see .context/ui/form-errors.md
 */
export function SaveError<TField extends string>({
  failure,
  stale,
  onRevealField,
}: SaveErrorProps<TField>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = ref.current;
    if (!failure || !box) return;
    const focusBox = () => {
      box.focus({ preventScroll: true });
      box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    const names = failure.fields.map((f) => f.field);
    if (names.length === 0) return focusBox();

    const root = box.closest('form') ?? document;
    const onPage = firstField(root, names);
    if (onPage) {
      if (!focusField(onPage)) focusBox();
      return;
    }
    if (!onRevealField) return focusBox();

    // The form picks the tab. With errors on two tabs, the fields on the
    // others can't all be on the page at once, so focus goes to the first
    // named field the revealed tab shows: the summary by Save says how many.
    onRevealField(names);
    // The revealed tab renders on a later commit; look again until it has.
    // A field found before that commit can be on the tab being left, so the
    // look goes on until the field it focused is still there a frame later.
    let frame = 0;
    let tries = 0;
    let focused: HTMLElement | null = null;
    const look = () => {
      if (focused?.isConnected) return;
      const revealed = firstPresent(root, names);
      if (revealed && revealed !== focused && focusField(revealed)) focused = revealed;
      if (++tries < REVEAL_FRAMES) {
        frame = requestAnimationFrame(look);
      } else if (!focused?.isConnected) {
        focusBox();
      }
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
    // Moves on a new failure only; a parent re-rendering with a new
    // onRevealField must not pull focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failure]);

  if (!failure) return null;

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="flex flex-col gap-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 outline-none focus-visible:ring-2 focus-visible:ring-red-400 sm:flex-row sm:items-start dark:border-red-800 dark:bg-red-950 dark:text-red-200"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {failure.stale && stale ? (
        <StaleBody {...stale} />
      ) : (
        <p className="flex-1 font-medium">{failure.message}</p>
      )}
    </div>
  );
}

function StaleBody({ what, onReload, onCopyChanges }: StaleSaveProps) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  // A page passes a new copier when its edits change (the builder's follows
  // its canvas), so an earlier "Copied" no longer covers what is on screen.
  useEffect(() => setCopy('idle'), [onCopyChanges]);
  return (
    <>
      <div className="flex-1 space-y-1">
        <p className="font-medium">{what} changed since you opened it. Nothing was saved.</p>
        {onCopyChanges ? (
          <p>
            Someone else saved it, or a person on it had their data erased. Your changes are still
            here, and reloading discards them: copy them first to keep a record, then reload to see
            the current version and make them again.
          </p>
        ) : (
          <p>
            Someone else saved it, or a person on it had their data erased. Your changes are still
            here: note anything you want to keep, then reload to see the current version and make
            them again.
          </p>
        )}
      </div>
      {onCopyChanges && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            // Started inside a promise, so a copier that throws before it has
            // one (no clipboard outside a secure context) is reported too.
            Promise.resolve()
              .then(onCopyChanges)
              .then(
                () => setCopy('copied'),
                () => setCopy('failed')
              );
          }}
        >
          <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {copy === 'copied'
            ? 'Copied'
            : copy === 'failed'
              ? 'Copy failed: try again'
              : 'Copy my changes'}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => (onReload ? onReload() : window.location.reload())}
      >
        <RotateCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Reload
      </Button>
    </>
  );
}
