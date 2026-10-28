/**
 * readSaveError / applyFieldErrors tests
 *
 * The helper is the only place that knows both server field-error shapes, so
 * each shape is tested landing on the fields it names, through a form's own
 * path table and without one.
 *
 * @see lib/errors/save-error.ts
 */

import { describe, it, expect, vi } from 'vitest';

import { APIClientError } from '@/lib/api/client';
import { applyFieldErrors, readSaveError } from '@/lib/errors/save-error';

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

    // First message per field: one line under each field, not a list.
    expect(failure.fields).toEqual([
      { field: 'url', message: 'Must be a public URL' },
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
