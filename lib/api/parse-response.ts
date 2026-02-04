/**
 * Runtime validation for API responses.
 *
 * Replaces unsafe `as` casts on fetch results with a lightweight
 * structural check that validates the `APIResponse<T>` discriminated union.
 */

import type { APIResponse } from '@/types/api';

/**
 * Parse and validate a fetch Response as an `APIResponse<T>`.
 *
 * Checks that the body is an object with a boolean `success` field,
 * `data` when success is true, and `error` when success is false.
 *
 * @throws {Error} If the body does not conform to the APIResponse shape.
 */
export async function parseApiResponse<T>(response: Response): Promise<APIResponse<T>> {
  const body: unknown = await response.json();

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('Invalid API response: body is not an object');
  }

  const record = body as Record<string, unknown>;

  if (typeof record.success !== 'boolean') {
    throw new Error('Invalid API response: missing boolean "success" field');
  }

  if (record.success === true && !('data' in record)) {
    throw new Error('Invalid API response: success=true but missing "data" field');
  }

  if (record.success === false) {
    if (typeof record.error !== 'object' || record.error === null) {
      throw new Error('Invalid API response: success=false but missing "error" object');
    }
  }

  return body as APIResponse<T>;
}
