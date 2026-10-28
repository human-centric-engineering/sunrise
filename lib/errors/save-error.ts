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
  /** Form field → its first message, for each field the server named, in the order sent. */
  fields: Array<{ field: TField; message: string }>;
}

export interface ReadSaveErrorOptions<TField extends string> {
  /** Shown when the error is not from the API (network failure, a thrown bug). */
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

function fieldCount(n: number): string {
  return n === 1 ? '1 field needs fixing.' : `${n} fields need fixing.`;
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
  if (!(err instanceof APIClientError)) {
    return { message: options.fallback, stale: false, fields: [] };
  }

  const fields: Array<{ field: TField | string; message: string }> = [];
  const unplaced: string[] = [];
  for (const [path, message] of serverFieldErrors(err.code, err.details)) {
    const field = options.fields ? tableField(options.fields, path) : path;
    if (field === undefined || field === '') {
      if (!unplaced.includes(message)) unplaced.push(message);
    } else if (!fields.some((f) => f.field === field)) {
      fields.push({ field, message });
    }
  }

  const message =
    fields.length === 0 && unplaced.length === 0
      ? err.message
      : [fields.length > 0 ? fieldCount(fields.length) : '', ...unplaced].filter(Boolean).join(' ');

  return {
    message,
    code: err.code,
    stale: err.code === ErrorCodes.STALE_RECORD,
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
