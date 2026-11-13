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
   * `<form method="post" onSubmit={submit(handleSubmit(onSubmit))}>`.
   */
  submit: (
    handler: (e?: BaseSyntheticEvent) => Promise<void> | void
  ) => (e: BaseSyntheticEvent) => void;
}

interface Options {
  /** Shown when the server never answered with an error of its own. */
  fallback: string;
  /**
   * The form's live `formState.errors`. With it, a save the form's own
   * validation blocked (`invalid`) follows the fields: the count by Save
   * drops as they are fixed, and the summary goes when none are left (t-1013).
   * A server's failure, or one the page showed itself, stays until the next
   * Save either way.
   */
  errors?: FieldErrors<FieldValues>;
}

interface FormOptions<TField extends string> extends Options {
  /** Server path → the form field that shows it (see `readSaveError`). */
  fields: Partial<Record<string, TField>>;
  /** The form's `setError`, to put field messages under their fields. */
  setError?: SetFieldError<TField>;
}

/**
 * The failure showing. For a save the form's own validation blocked, `key` is
 * what its fields said when it was last shown, so the summary can follow them;
 * null for any other failure, which stays as it is until the next Save.
 */
interface Shown<TField extends string> {
  failure: SaveFailure<TField> | null;
  key: string | null;
}

const NONE: Shown<never> = { failure: null, key: null };

/** What a failure says, so an update that says nothing new keeps the same object. */
function failureKey(failure: SaveFailure<string>): string {
  return JSON.stringify([failure.message, failure.fields]);
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
  const [state, setState] = useState<Shown<TField | string>>(NONE);
  const setFailure = useCallback(
    (failure: SaveFailure<TField | string> | null, fromValidation = false) =>
      setState({ failure, key: fromValidation && failure ? failureKey(failure) : null }),
    []
  );
  const { fallback, errors } = options;
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
    [fallback, fields, setError, setFailure]
  );

  const show = useCallback(
    (message: string, named: SaveFailure<TField | string>['fields'] = []) =>
      setFailure({ message, stale: false, fields: named }),
    [setFailure]
  );

  const invalid = useCallback(
    <TValues extends FieldValues>(blocked: FieldErrors<TValues>) =>
      setFailure(invalidSave(blocked), true),
    [setFailure]
  );

  const block = useCallback(
    (problems: Array<{ field: string; message: string }>) => {
      if (problems.length === 0) return false;
      show(problems.map((p) => p.message).join(' '), problems);
      return true;
    },
    [show]
  );

  const clear = useCallback(() => setFailure(null), [setFailure]);

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
    [setFailure]
  );

  // A blocked save follows the live field errors (t-1013), as derived state
  // set during render: compared on what they say, because react-hook-form
  // updates `formState.errors` in place. Every change is an update, marked so
  // `<SaveError>` moves nothing, including one back to what the press said.
  // When nothing is left to fix the failure is cleared, not hidden, so a field
  // broken again later shows its own message without reviving the summary.
  if (state.key !== null && errors) {
    const live = invalidSave(errors);
    const liveKey = failureKey(live);
    if (liveKey !== state.key) {
      // No fields left is nothing left: react-hook-form never passes a root
      // error to onInvalid, and one set later wouldn't clear on re-validation.
      setState(
        live.fields.length > 0 ? { failure: { ...live, updated: true }, key: liveKey } : NONE
      );
    }
  }
  const failure = state.failure;

  return { failure, report, show, invalid, block, clear, submit };
}
