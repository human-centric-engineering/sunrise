/**
 * Public surface of the orchestration HTTP module.
 *
 * Used by the workflow `external_call` step executor and the
 * `call_external_api` capability. No other call sites in the
 * orchestration layer should reach for `fetch` directly — going
 * through this module is what gets you allowlist + rate limit + auth
 * + idempotency + size cap consistently.
 */

export {
  ALLOWED_HOSTS_ENV,
  isHostAllowed,
  resetAllowlistCache,
} from '@/lib/orchestration/http/allowlist';
export { applyAuth, type HttpAuthConfig, type HttpAuthType } from '@/lib/orchestration/http/auth';
export { HttpError, type HttpErrorCode } from '@/lib/orchestration/http/errors';
export {
  executeHttpRequest,
  type HttpMethod,
  type HttpRequestOptions,
  type HttpResponseBody,
} from '@/lib/orchestration/http/fetch';
export {
  resolveIdempotencyHeader,
  type HttpIdempotencyConfig,
} from '@/lib/orchestration/http/idempotency';
export {
  applyResponseTransform,
  getNestedValue,
  isBinaryResponseBody,
  isRetriableStatus,
  readResponseBody,
  type BinaryResponseBody,
  type ResponseTransform,
} from '@/lib/orchestration/http/response';
