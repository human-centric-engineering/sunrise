/**
 * Reading a failed save
 *
 * Turns whatever a save threw into the one shape every form shows: a message,
 * the fields it names, and whether it was refused as stale. The server sends
 * field errors in two shapes, and this is the only place that knows both:
 *
 * - `{ errors: [{ path, message }] }` from `validateRequestBody` /
 *   `validateQueryParams` (`lib/api/validation.ts`)
 * - `Record<path, string[]>` from `handleAPIError` on a raw `ZodError`
 *   (`lib/api/errors.ts`)
 *
 * Pure: it neither renders nor touches a form. A react-hook-form form passes
 * the result to {@link applyFieldErrors}; a plain-state form reads `fields`
 * and places the messages itself. `<SaveError>` renders the summary.
 *
 * @see .context/ui/form-errors.md
 */

import type { FieldErrors, FieldValues } from 'react-hook-form';
import { z } from 'zod';

import { APIClientError } from '@/lib/api/client';
import { ErrorCodes } from '@/lib/api/errors';

/** One failed save, as a form shows it. */
export interface SaveFailure<TField extends string = string> {
  /** What to show by Save: the server's message, or a field-count summary. */
  message: string;
  /** The server's error code, when it sent one. */
  code?: string;
  /** Refused because the record changed since the page loaded it (412 `STALE_RECORD`). */
  stale: boolean;
  /** Form field → its messages, joined, for each field the server named, in the order sent. */
  fields: Array<{ field: TField; message: string }>;
}

export interface ReadSaveErrorOptions<TField extends string> {
  /**
   * Shown when the server never answered with an error of its own: a network
   * failure or a non-JSON response (which `apiClient` raises as `NETWORK_ERROR`
   * / `INVALID_RESPONSE` with the browser's text), or a thrown bug.
   */
  fallback: string;
  /**
   * Server path (`searchConfig.bm25Weight`) → the form field that shows it.
   * List only fields that render their error: a path missing from the table
   * has its message join the summary instead, so nothing the server said is
   * lost. An array element's path (`retryBackoffMs.1`) falls back to its
   * array's entry. Without a table, each server path is taken as the field
   * name (for a plain-state form placing messages itself).
   */
  fields?: Partial<Record<string, TField>>;
}

/** Codes `apiClient` raises itself, whose message is the browser's, not the server's. */
const CLIENT_SIDE_CODES = new Set(['NETWORK_ERROR', 'INVALID_RESPONSE']);

const listShape = z.object({
  errors: z.array(z.object({ path: z.string(), message: z.string() })),
});
const recordShape = z.record(z.string(), z.array(z.string()));

/**
 * Both server shapes, flattened to `[path, message]` in the order sent. Only a
 * validation failure carries field errors: other errors may send details of
 * the record shape that are not fields (`{ unknownIds: ['a1'] }`).
 */
function serverFieldErrors(code: string | undefined, details: unknown): Array<[string, string]> {
  if (code !== ErrorCodes.VALIDATION_ERROR) return [];
  const list = listShape.safeParse(details);
  if (list.success) return list.data.errors.map((e) => [e.path, e.message]);
  const record = recordShape.safeParse(details);
  if (record.success) {
    return Object.entries(record.data).flatMap(([path, messages]) =>
      messages.map((message): [string, string] => [path, message])
    );
  }
  return [];
}

/** The table's field for a path, or for the array holding it (`events.0` → `events`). */
function tableField<TField extends string>(
  table: Partial<Record<string, TField>>,
  path: string
): TField | undefined {
  for (let p = path; ; p = p.replace(/\.\d+$/, '')) {
    // Own keys only: `constructor` must not resolve to Object's.
    if (Object.hasOwn(table, p)) return table[p];
    if (!/\.\d+$/.test(p)) return undefined;
  }
}

/**
 * Whether a save was refused because the record changed since the page loaded
 * it (412 `STALE_RECORD`, §122). For a page that only needs to know that, such
 * as a list showing `<StaleSaveNotice>`; a form reads `readSaveError().stale`.
 */
export function isStaleSave(err: unknown): boolean {
  return err instanceof APIClientError && err.code === ErrorCodes.STALE_RECORD;
}

/** What `<SaveError>` says by Save when `n` named fields need fixing. */
export function fieldCount(n: number): string {
  return n === 1 ? '1 field needs fixing.' : `${n} fields need fixing.`;
}

/**
 * A save the form's own validation blocked (react-hook-form's `onInvalid`),
 * as `<SaveError>` shows it: how many fields need fixing, by Save, with each
 * field named so focus goes to the first. Each field already shows its own
 * message. Prefer `useSaveFailure().invalid`; this is for a form that holds
 * its failure itself.
 */
export function invalidSave<TValues extends FieldValues>(
  errors: FieldErrors<TValues>
): SaveFailure<string> {
  const fields = blockedFields(errors);
  const root = errors.root?.message;
  return {
    message:
      fields.length > 0 ? fieldCount(fields.length) : (root ?? 'Check the form and try again.'),
    stale: false,
    fields,
  };
}

/**
 * Each blocked field, by the name it was registered under (`variants.0.label`
 * for a field in an array), with its message, in the order react-hook-form
 * holds them. An entry with a `type` is a field's error; anything else holds
 * more fields. `root` is the form's own key, not a field.
 */
function blockedFields(errors: object, prefix = ''): Array<{ field: string; message: string }> {
  return Object.entries(errors).flatMap(([key, entry]: [string, unknown]) => {
    if ((!prefix && key === 'root') || !entry || typeof entry !== 'object') return [];
    const field = prefix ? `${prefix}.${key}` : key;
    if ('type' in entry && typeof entry.type === 'string') {
      const message = 'message' in entry && typeof entry.message === 'string' ? entry.message : '';
      return [{ field, message: message || 'Check this field.' }];
    }
    return blockedFields(entry, field);
  });
}

export function readSaveError(err: unknown, options: { fallback: string }): SaveFailure;
export function readSaveError<TField extends string>(
  err: unknown,
  options: ReadSaveErrorOptions<TField> & { fields: Partial<Record<string, TField>> }
): SaveFailure<TField>;
export function readSaveError<TField extends string>(
  err: unknown,
  options: ReadSaveErrorOptions<TField>
): SaveFailure<TField | string> {
  if (!(err instanceof APIClientError) || CLIENT_SIDE_CODES.has(err.code ?? '')) {
    return { message: options.fallback, stale: false, fields: [] };
  }

  const fields: Array<{ field: TField | string; message: string }> = [];
  const unplaced: string[] = [];
  const messagesFor = new Map<TField | string, string[]>();
  for (const [path, message] of serverFieldErrors(err.code, err.details)) {
    const field = options.fields ? tableField(options.fields, path) : path;
    if (field === undefined || field === '') {
      if (!unplaced.includes(message)) unplaced.push(message);
    } else {
      // Several paths can land on one field (each element of an array): say
      // every distinct problem there, or each costs the admin another save.
      const said = messagesFor.get(field);
      if (!said) {
        messagesFor.set(field, [message]);
        fields.push({ field, message });
      } else if (!said.includes(message)) {
        said.push(message);
        const placed = fields.find((f) => f.field === field);
        if (placed) placed.message = said.join(' ');
      }
    }
  }

  const message =
    fields.length === 0 && unplaced.length === 0
      ? // A server that sent no words gets the fallback, not an empty box.
        err.message.trim() || options.fallback
      : [fields.length > 0 ? fieldCount(fields.length) : '', ...unplaced].filter(Boolean).join(' ');

  return {
    message,
    code: err.code,
    stale: isStaleSave(err),
    fields,
  };
}

/**
 * Puts a failure's field messages on a react-hook-form form. Focus is left to
 * `<SaveError>`, which moves it to the first named field in page order, so
 * this passes `shouldFocus: false`.
 */
export function applyFieldErrors<TField extends string>(
  failure: SaveFailure<TField>,
  setError: (
    name: TField,
    error: { type: string; message: string },
    options?: { shouldFocus: boolean }
  ) => void
): void {
  for (const { field, message } of failure.fields) {
    setError(field, { type: 'server', message }, { shouldFocus: false });
  }
}
