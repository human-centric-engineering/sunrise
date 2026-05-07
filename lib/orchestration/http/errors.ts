/**
 * Typed errors for the orchestration HTTP module.
 *
 * Callers (workflow `external_call` executor, `call_external_api`
 * capability) catch `HttpError` and map `code` to their domain error
 * (e.g. `ExecutorError`, `CapabilityResult.error`).
 */

export type HttpErrorCode =
  | 'host_not_allowed'
  | 'missing_auth_secret'
  | 'multipart_hmac_unsupported'
  | 'outbound_rate_limited'
  | 'request_failed'
  | 'request_aborted'
  | 'request_timeout'
  | 'http_error'
  | 'http_error_retriable'
  | 'response_too_large'
  | 'response_transform_failed';

export class HttpError extends Error {
  constructor(
    public readonly code: HttpErrorCode,
    message: string,
    public readonly retriable = false,
    public readonly cause?: unknown,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
