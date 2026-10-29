'use client';

import { useCallback, useState, type BaseSyntheticEvent } from 'react';
import type { FieldErrors, FieldValues } from 'react-hook-form';

import {
  applyFieldErrors,
  invalidSave,
  readSaveError,
  unreadableNumbers,
  type SaveFailure,
} from '@/lib/errors/save-error';

/** `react-hook-form`'s `setError`, narrowed to what a failed save sets. */
type SetFieldError<TField extends string> = (
  name: TField,
  error: { type: string; message: string },
  options?: { shouldFocus: boolean }
) => void;

export interface SaveFailureState<TField extends string> {
  /** The failure to pass to `<SaveError>`; null until a save fails. */
  failure: SaveFailure<TField> | null;
  /**
   * Reads what a save threw, puts any field messages on the form, and shows
   * it. Returns the failure, so a caller can branch on `stale`.
   *
   * `context` leads the message, for a failure shown away from what it was
   * about: a list's row action reports into one box above the table, so it
   * names the row (`Couldn't update "Support bot"`).
   */
  report: (err: unknown, context?: string) => SaveFailure<TField>;
  /**
   * Shows a failure the page found itself before saving: a client-side check
   * on Save, or fields its own validation blocked.
   */
  show: (message: string, fields?: SaveFailure<TField>['fields']) => void;
  /**
   * react-hook-form's `onInvalid`: the form's own validation blocked Save.
   * Each field already shows its message; this says how many by Save and
   * moves focus to the first:
   * `handleSubmit(onSubmit, save.invalid)`.
   */
  invalid: <TValues extends FieldValues>(errors: FieldErrors<TValues>) => void;
  /**
   * A plain-state form's own check blocked Save. The form renders no message
   * under its fields, so theirs go by Save, and focus goes to the first field.
   * Fields are named as the page's inputs are (`name` or `id`), not as the
   * server names them. Returns whether it blocked:
   * `if (save.block(problems)) return;`.
   */
  block: (problems: Array<{ field: string; message: string }>) => boolean;
  /** Hides the failure. */
  clear: () => void;
  /**
   * Wraps a submit handler so every press clears the last failure first,
   * including a press that client validation blocks. A number field the
   * browser can't read blocks the press before the handler runs (see
   * `unreadableNumbers`):
   * `<form onSubmit={submit(handleSubmit(onSubmit))}>`.
   */
  submit: (
    handler: (e?: BaseSyntheticEvent) => Promise<void> | void
  ) => (e: BaseSyntheticEvent) => void;
}

interface Options {
  /** Shown when the server never answered with an error of its own. */
  fallback: string;
}

interface FormOptions<TField extends string> extends Options {
  /** Server path → the form field that shows it (see `readSaveError`). */
  fields: Partial<Record<string, TField>>;
  /** The form's `setError`, to put field messages under their fields. */
  setError?: SetFieldError<TField>;
}

/**
 * The field table for a page that places no field messages: every server
 * message joins the summary by Save. One object, so `report` stays stable.
 */
export const NO_SERVER_FIELDS: Partial<Record<string, never>> = Object.freeze({});

/**
 * Owns a page's failed save, so every page shows one the same way (§124):
 * each failure is a new object, which `<SaveError>` brings into view, and
 * every press of Save clears the last one.
 *
 * @see .context/ui/form-errors.md
 */
export function useSaveFailure(options: Options): SaveFailureState<string>;
export function useSaveFailure<TField extends string>(
  options: FormOptions<TField>
): SaveFailureState<TField>;
export function useSaveFailure<TField extends string>(
  options: Options | FormOptions<TField>
): SaveFailureState<TField | string> {
  const [failure, setFailure] = useState<SaveFailure<TField | string> | null>(null);
  const { fallback } = options;
  const fields = 'fields' in options ? options.fields : undefined;
  const setError = 'fields' in options ? options.setError : undefined;

  // Stable while the form's options are: a module-level or memoised table
  // (`NO_SERVER_FIELDS` for none) and react-hook-form's `setError` are.
  const report = useCallback(
    (err: unknown, context?: string) => {
      let next: SaveFailure<TField | string>;
      if (fields) {
        const read = readSaveError(err, { fallback, fields });
        if (setError) applyFieldErrors(read, setError);
        next = read;
      } else {
        next = readSaveError(err, { fallback });
      }
      if (context) {
        // With nothing from the server, the context says it all: the page's
        // fallback would repeat it ("Couldn't update "X": Could not update…").
        const said = next.message === fallback ? 'Try again.' : null;
        next = { ...next, message: said ? `${context}. ${said}` : `${context}: ${next.message}` };
      }
      setFailure(next);
      return next;
    },
    [fallback, fields, setError]
  );

  const show = useCallback(
    (message: string, named: SaveFailure<TField | string>['fields'] = []) =>
      setFailure({ message, stale: false, fields: named }),
    []
  );

  const invalid = useCallback(
    <TValues extends FieldValues>(errors: FieldErrors<TValues>) => setFailure(invalidSave(errors)),
    []
  );

  const block = useCallback(
    (problems: Array<{ field: string; message: string }>) => {
      if (problems.length === 0) return false;
      show(problems.map((p) => p.message).join(' '), problems);
      return true;
    },
    [show]
  );

  const clear = useCallback(() => setFailure(null), []);

  const submit = useCallback(
    (handler: (e?: BaseSyntheticEvent) => Promise<void> | void) => (e: BaseSyntheticEvent) => {
      const unreadable = unreadableNumbers(e.currentTarget);
      if (unreadable) {
        e.preventDefault();
        setFailure(unreadable);
        return;
      }
      setFailure(null);
      void handler(e);
    },
    []
  );

  return { failure, report, show, invalid, block, clear, submit };
}
