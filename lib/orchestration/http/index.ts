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
export { mergeHeaders } from '@/lib/orchestration/http/headers';
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
  ABSOLUTE_MAX_FILE_BASE64_LENGTH,
  MAX_FIELD_NAME_LENGTH,
  MAX_FIELD_PARTS,
  MAX_FIELD_VALUE_LENGTH,
  MAX_FILE_PARTS,
  MAX_TOTAL_MULTIPART_BYTES,
  MultipartError,
  buildMultipartBody,
  multipartShapeSchema,
  type MultipartErrorCode,
  type MultipartShape,
} from '@/lib/orchestration/http/multipart';
export {
  applyResponseTransform,
  getNestedValue,
  isBinaryResponseBody,
  isRetriableStatus,
  readResponseBody,
  type BinaryResponseBody,
  type ResponseTransform,
} from '@/lib/orchestration/http/response';
