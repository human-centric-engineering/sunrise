/**
 * readSaveError / applyFieldErrors / invalidSave tests
 *
 * The helper is the only place that knows both server field-error shapes, so
 * each shape is tested landing on the fields it names, through a form's own
 * path table and without one.
 *
 * @see lib/errors/save-error.ts
 */

import { zodResolver } from '@hookform/resolvers/zod';
import type { FieldErrors, FieldValues } from 'react-hook-form';
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

import { APIClientError } from '@/lib/api/client';
import { applyFieldErrors, invalidSave, isStaleSave, readSaveError } from '@/lib/errors/save-error';

/** `validateRequestBody`'s shape (`lib/api/validation.ts`). */
function listError(errors: Array<{ path: string; message: string }>) {
  return new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, { errors });
}

/** `handleAPIError`'s shape on a raw ZodError (`lib/api/errors.ts`). */
function recordError(details: Record<string, string[]>) {
  return new APIClientError('Validation failed', 'VALIDATION_ERROR', 400, details);
}

describe('readSaveError', () => {
  it('uses the fallback for an error that did not come from the API', () => {
    const failure = readSaveError(new TypeError('Failed to fetch'), {
      fallback: 'Could not save.',
    });

    expect(failure).toEqual({ message: 'Could not save.', stale: false, fields: [] });
  });

  it.each(['NETWORK_ERROR', 'INVALID_RESPONSE'])(
    "uses the fallback for apiClient's own %s, not the browser's text",
    (code) => {
      const failure = readSaveError(new APIClientError('Failed to fetch', code), {
        fallback: 'Could not save.',
      });

      expect(failure.message).toBe('Could not save.');
    }
  );

  it.each(['', '   '])('uses the fallback when the server sent no words (%j)', (message) => {
    const failure = readSaveError(new APIClientError(message, 'INTERNAL_ERROR', 500), {
      fallback: 'Could not save.',
    });

    expect(failure.message).toBe('Could not save.');
  });

  it('keeps a distinct message for a field even when another contains its text', () => {
    const failure = readSaveError(
      listError([
        { path: 'emails.0', message: 'Invalid email address' },
        { path: 'emails.1', message: 'Invalid' },
      ]),
      { fallback: 'x', fields: { emails: 'emails' } }
    );

    expect(failure.fields).toEqual([{ field: 'emails', message: 'Invalid email address Invalid' }]);
  });

  it("shows the server's message when it names no fields", () => {
    const failure = readSaveError(new APIClientError('Budget too high', 'VALIDATION_ERROR', 400), {
      fallback: 'Could not save.',
    });

    expect(failure.message).toBe('Budget too high');
    expect(failure.code).toBe('VALIDATION_ERROR');
    expect(failure.fields).toEqual([]);
  });

  it('places the list shape on the fields its table maps to, and counts them', () => {
    const failure = readSaveError(
      listError([
        { path: 'searchConfig.bm25Weight', message: 'Must be at most 2' },
        { path: 'defaultApprovalTimeoutMs', message: 'Must be positive' },
      ]),
      {
        fallback: 'Could not save.',
        fields: {
          'searchConfig.bm25Weight': 'bm25Weight',
          defaultApprovalTimeoutMs: 'approvalTimeout',
        },
      }
    );

    expect(failure.fields).toEqual([
      { field: 'bm25Weight', message: 'Must be at most 2' },
      { field: 'approvalTimeout', message: 'Must be positive' },
    ]);
    expect(failure.message).toBe('2 fields need fixing.');
  });

  it('places the record shape on the fields its table maps to', () => {
    const failure = readSaveError(
      recordError({ url: ['Must be a public URL', 'Must be https'], maxAttempts: ['Too many'] }),
      { fallback: 'Could not save.', fields: { url: 'url', maxAttempts: 'maxAttempts' } }
    );

    // Every distinct problem with a field is said under it.
    expect(failure.fields).toEqual([
      { field: 'url', message: 'Must be a public URL Must be https' },
      { field: 'maxAttempts', message: 'Too many' },
    ]);
    expect(failure.message).toBe('2 fields need fixing.');
  });

  it('says "1 field" for one', () => {
    const failure = readSaveError(listError([{ path: 'url', message: 'Bad URL' }]), {
      fallback: 'x',
      fields: { url: 'url' },
    });

    expect(failure.message).toBe('1 field needs fixing.');
  });

  it('puts a message for a path the form has no field for into the summary', () => {
    const failure = readSaveError(
      listError([
        { path: 'url', message: 'Bad URL' },
        { path: 'escalationConfig.emailAddresses.0', message: 'Invalid email' },
        { path: 'escalationConfig.emailAddresses.1', message: 'Invalid email' },
      ]),
      { fallback: 'x', fields: { url: 'url' } }
    );

    expect(failure.fields).toEqual([{ field: 'url', message: 'Bad URL' }]);
    // Repeated messages are said once.
    expect(failure.message).toBe('1 field needs fixing. Invalid email');
  });

  it('gives a plain-state form the server paths as field names when it passes no table', () => {
    const failure = readSaveError(recordError({ name: ['Required'], 'limits.max': ['Too big'] }), {
      fallback: 'x',
    });

    expect(failure.fields).toEqual([
      { field: 'name', message: 'Required' },
      { field: 'limits.max', message: 'Too big' },
    ]);
  });

  it('marks a 412 STALE_RECORD as stale', () => {
    const failure = readSaveError(
      new APIClientError('This changed since you opened it.', 'STALE_RECORD', 412),
      { fallback: 'x' }
    );

    expect(failure.stale).toBe(true);
    expect(failure.message).toBe('This changed since you opened it.');
  });

  it('says every problem with one field when several paths land on it', () => {
    const failure = readSaveError(
      listError([
        { path: 'retryBackoffMs.0', message: 'Must be at least 1 second.' },
        { path: 'retryBackoffMs.3', message: 'Must be at most 1 hour.' },
        { path: 'retryBackoffMs.4', message: 'Must be at most 1 hour.' },
      ]),
      { fallback: 'x', fields: { retryBackoffMs: 'retryBackoffSeconds' } }
    );

    expect(failure.fields).toEqual([
      {
        field: 'retryBackoffSeconds',
        message: 'Must be at least 1 second. Must be at most 1 hour.',
      },
    ]);
  });

  it("places an array element's error on its array's field", () => {
    const failure = readSaveError(
      listError([
        { path: 'retryBackoffMs.1', message: 'Too big' },
        { path: 'escalationConfig.emailAddresses.0', message: 'Invalid email' },
      ]),
      { fallback: 'x', fields: { retryBackoffMs: 'retryBackoffSeconds' } }
    );

    expect(failure.fields).toEqual([{ field: 'retryBackoffSeconds', message: 'Too big' }]);
    // An array the table does not list still falls to the summary
    expect(failure.message).toBe('1 field needs fixing. Invalid email');
  });

  it('never resolves a path to an inherited property of the table', () => {
    const failure = readSaveError(recordError({ constructor: ['Bad'], toString: ['Worse'] }), {
      fallback: 'x',
      fields: { url: 'url' },
    });

    expect(failure.fields).toEqual([]);
    expect(failure.message).toBe('Bad Worse');
  });

  it('reads no fields from the details of an error that is not a validation failure', () => {
    // A record-shaped detail that is metadata, not fields
    const failure = readSaveError(
      new APIClientError('Unknown agents', 'NOT_FOUND', 404, { unknownIds: ['a1', 'a2'] }),
      { fallback: 'x', fields: { url: 'url' } }
    );

    expect(failure.fields).toEqual([]);
    expect(failure.message).toBe('Unknown agents');
  });

  it('ignores details in neither shape', () => {
    const failure = readSaveError(
      new APIClientError('Conflict', 'CONFLICT', 409, { existingId: 'abc' }),
      { fallback: 'x' }
    );

    expect(failure.fields).toEqual([]);
    expect(failure.message).toBe('Conflict');
  });
});

describe('applyFieldErrors', () => {
  it("sets each named field's message on the form, leaving focus to <SaveError>", () => {
    const setError = vi.fn();
    const failure = readSaveError(
      listError([
        { path: 'url', message: 'Bad URL' },
        { path: 'maxAttempts', message: 'Too many' },
      ]),
      { fallback: 'x', fields: { url: 'url', maxAttempts: 'maxAttempts' } }
    );

    applyFieldErrors(failure, setError);

    expect(setError).toHaveBeenCalledTimes(2);
    expect(setError).toHaveBeenNthCalledWith(
      1,
      'url',
      { type: 'server', message: 'Bad URL' },
      { shouldFocus: false }
    );
    expect(setError).toHaveBeenNthCalledWith(
      2,
      'maxAttempts',
      { type: 'server', message: 'Too many' },
      { shouldFocus: false }
    );
  });
});

describe('isStaleSave', () => {
  it('is true for a 412 STALE_RECORD', () => {
    expect(isStaleSave(new APIClientError('Changed', 'STALE_RECORD', 412))).toBe(true);
  });

  it('is false for any other refusal, and for an error the API never sent', () => {
    expect(isStaleSave(new APIClientError('Conflict', 'CONFLICT', 409))).toBe(false);
    expect(isStaleSave(new Error('STALE_RECORD'))).toBe(false);
  });
});

/** What react-hook-form hands `onInvalid` for `values`, from its real Zod resolver. */
async function resolverErrors<T extends z.ZodType<FieldValues, FieldValues>>(
  schema: T,
  values: FieldValues
) {
  const result = await zodResolver(schema)(values, undefined, {
    fields: {},
    shouldUseNativeValidation: false,
  });
  return result.errors;
}

describe('invalidSave', () => {
  it('counts the blocked fields by Save and names each, in the order the form holds them', async () => {
    const schema = z.object({
      name: z.string().min(1, 'Name is required'),
      weight: z.number().max(2, 'At most 2'),
      note: z.string(),
    });

    const failure = invalidSave(await resolverErrors(schema, { name: '', weight: 15, note: '' }));

    expect(failure).toEqual({
      message: '2 fields need fixing.',
      stale: false,
      fields: [
        { field: 'name', message: 'Name is required' },
        { field: 'weight', message: 'At most 2' },
      ],
    });
  });

  it('names a field in an array by its registered path, so focus can find it', async () => {
    const schema = z.object({
      variants: z.array(z.object({ label: z.string().min(1, 'Label is required') })),
    });

    const failure = invalidSave(
      await resolverErrors(schema, { variants: [{ label: 'A' }, { label: '' }] })
    );

    expect(failure.message).toBe('1 field needs fixing.');
    expect(failure.fields).toEqual([{ field: 'variants.1.label', message: 'Label is required' }]);
  });

  it('treats a field called "type" as a field, not as part of an error', async () => {
    const schema = z.object({ type: z.enum(['a', 'b'], { message: 'Pick a type' }) });

    const failure = invalidSave(await resolverErrors(schema, { type: 'c' }));

    expect(failure.fields).toEqual([{ field: 'type', message: 'Pick a type' }]);
  });

  it('says the form-level message when no field is blocked, and never "0 fields"', () => {
    // react-hook-form's `root` type also indexes sub-keys; a plain one is its common shape.
    const errors = { root: { type: 'server', message: 'Pick at least one' } } as FieldErrors;
    expect(invalidSave(errors)).toEqual({
      message: 'Pick at least one',
      stale: false,
      fields: [],
    });
    expect(invalidSave({}).message).toBe('Check the form and try again.');
  });

  it('gives a field with no message of its own a prompt, so the summary still names it', () => {
    expect(invalidSave({ slug: { type: 'validate' } }).fields).toEqual([
      { field: 'slug', message: 'Check this field.' },
    ]);
  });
});
