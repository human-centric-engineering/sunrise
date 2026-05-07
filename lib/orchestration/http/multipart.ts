/**
 * Multipart/form-data body construction for orchestration outbound HTTP.
 *
 * Some hosted endpoints (Gotenberg HTML→PDF being the canonical
 * example) require `multipart/form-data` with named file parts and
 * field parts rather than JSON. This module exposes a Zod-validated
 * shape that both the `call_external_api` capability (LLM-supplied
 * args) and the workflow `external_call` step (admin-authored config,
 * post-interpolation) can hand to a pure builder that returns a
 * `FormData` instance suitable for `fetch()` to send.
 *
 * Pure module — no side effects, no I/O. All validation is content-
 * blind to host or auth concerns; the surrounding HTTP machinery
 * (allowlist, auth, idempotency, response cap) still applies.
 *
 * Size posture:
 *   - Per-file pre-decode cap: 8 MB of base64 (~6 MB of bytes), matching
 *     `upload_to_storage`'s `ABSOLUTE_MAX_BASE64_LENGTH`.
 *   - Total request body cap: 25 MB (sum of decoded file bytes + field
 *     byte lengths). Caps fail closed with a typed error before any
 *     `FormData` allocation, so a malformed input never reaches fetch.
 *
 * HMAC compatibility: not supported. The HMAC signing path in
 * `auth.ts` consumes a string body — multipart bodies cannot be signed
 * deterministically (boundary changes per request, part ordering is
 * implementation-defined). The fetch entry point rejects the
 * combination with `multipart_hmac_unsupported` rather than silently
 * weakening the signature.
 */

import { z } from 'zod';

/** Max base64 length per file part. Matches upload-to-storage. 8 MB base64 ≈ 6 MB decoded. */
export const ABSOLUTE_MAX_FILE_BASE64_LENGTH = 8 * 1024 * 1024;

/** Max total request body size in decoded bytes (sum of all file parts + field bytes). */
export const MAX_TOTAL_MULTIPART_BYTES = 25 * 1024 * 1024;

/** Max number of file parts in a single request — bounded so a malformed input can't allocate unbounded FormData entries. */
export const MAX_FILE_PARTS = 16;

/** Max number of field parts in a single request. */
export const MAX_FIELD_PARTS = 64;

/** Max length of a multipart field NAME (matches the file-part `name` cap). */
export const MAX_FIELD_NAME_LENGTH = 128;

/**
 * Max character length of a multipart field VALUE. Generous enough to
 * cover legitimate "longish text in a field" cases (e.g. an email
 * body in a SendGrid `text` field, a JSON blob in a config field) but
 * small enough that an accidental interpolation blowup or LLM mistake
 * is rejected at field granularity rather than via the body-total
 * math. Content larger than this should be sent as a file part —
 * that's the right multipart pattern for blob content anyway, and
 * file parts carry proper Content-Type metadata.
 */
export const MAX_FIELD_VALUE_LENGTH = 1 * 1024 * 1024;

const CONTENT_TYPE_RE = /^[a-z0-9]+\/[a-zA-Z0-9.+\-_]+$/;
const STRICT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Canonical multipart input shape. Used by both call sites:
 *   - `call_external_api`'s LLM args (values already resolved).
 *   - workflow `external_call`'s config (values are post-
 *     `interpolatePrompt` — the executor runs interpolation before
 *     handing to the builder).
 *
 * `data` is **base64-encoded bytes**. Strict base64 validation runs in
 * the builder rather than at this schema layer so the schema stays
 * cheap and reusable for shape checks.
 */
export const multipartShapeSchema = z
  .object({
    files: z
      .array(
        z.object({
          /** Form field name for this part. Becomes the `name=` attribute on the multipart Content-Disposition. */
          name: z.string().min(1).max(128),
          /** Optional upload filename. Defaults to `name` when omitted. */
          filename: z.string().min(1).max(255).optional(),
          /** MIME type for this part. Validated against the same regex as upload-to-storage. */
          contentType: z.string().regex(CONTENT_TYPE_RE).max(127),
          /** Base64-encoded bytes. Per-part cap is `ABSOLUTE_MAX_FILE_BASE64_LENGTH`. */
          data: z.string().min(1).max(ABSOLUTE_MAX_FILE_BASE64_LENGTH),
        })
      )
      .min(1)
      .max(MAX_FILE_PARTS),
    /**
     * Optional plain-text field parts. Names are capped at
     * `MAX_FIELD_NAME_LENGTH`; values at `MAX_FIELD_VALUE_LENGTH`.
     * Use file parts for blob content larger than that.
     */
    fields: z
      .record(z.string().min(1).max(MAX_FIELD_NAME_LENGTH), z.string().max(MAX_FIELD_VALUE_LENGTH))
      .optional(),
  })
  .strict()
  .refine(
    (parts) => !parts.fields || Object.keys(parts.fields).length <= MAX_FIELD_PARTS,
    `multipart fields cannot have more than ${MAX_FIELD_PARTS} entries`
  );

export type MultipartShape = z.infer<typeof multipartShapeSchema>;

export type MultipartErrorCode = 'invalid_shape' | 'invalid_base64' | 'body_too_large';

export class MultipartError extends Error {
  constructor(
    public readonly code: MultipartErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'MultipartError';
  }
}

/**
 * Validate the supplied input as a multipart shape and assemble it
 * into a `FormData`. Throws `MultipartError` with a typed code on any
 * failure — callers map that to their domain (`invalid_args` for the
 * capability, `ExecutorError` for the workflow step).
 *
 * The function is synchronous and pure: same input → same FormData
 * (modulo Blob identity). It does not touch `process.env`, the
 * filesystem, or the network.
 */
export function buildMultipartBody(input: unknown): FormData {
  const parsed = multipartShapeSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
    throw new MultipartError(
      'invalid_shape',
      `multipart shape is invalid${path}: ${issue?.message ?? 'unknown error'}`
    );
  }
  const parts = parsed.data;

  // Validate field-byte budget first (cheap — no base64 decode needed)
  // and seed the running total. This lets the file-decode loop bail
  // as soon as decoded files push the total over the cap, rather than
  // decoding every file first and only THEN noticing the body is
  // too big (which would have allocated all those buffers for nothing).
  let totalBytes = 0;
  if (parts.fields) {
    for (const value of Object.values(parts.fields)) {
      totalBytes += Buffer.byteLength(value, 'utf8');
    }
    if (totalBytes > MAX_TOTAL_MULTIPART_BYTES) {
      throw new MultipartError(
        'body_too_large',
        `multipart fields total ${totalBytes} bytes exceeds cap of ${MAX_TOTAL_MULTIPART_BYTES} bytes`
      );
    }
  }

  // Decode each file's base64 so we can (a) reject non-base64 inputs
  // before fetch, and (b) sum the decoded sizes for the total-body
  // cap. `Buffer.from(s, 'base64')` silently drops invalid characters,
  // so we screen with a strict regex first — same posture as
  // `upload_to_storage`. We check the running total AFTER each push so
  // the function fails closed without allocating buffers for files
  // beyond the body-cap point.
  const decodedFiles: Array<{ part: MultipartShape['files'][number]; bytes: Buffer }> = [];

  for (const part of parts.files) {
    if (!STRICT_BASE64_RE.test(part.data)) {
      throw new MultipartError(
        'invalid_base64',
        `file part "${part.name}" data is not valid base64 (must be A-Z a-z 0-9 + / with optional = padding, no whitespace)`
      );
    }
    const bytes = Buffer.from(part.data, 'base64');
    if (bytes.length === 0) {
      throw new MultipartError('invalid_base64', `file part "${part.name}" decoded to zero bytes`);
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_MULTIPART_BYTES) {
      throw new MultipartError(
        'body_too_large',
        `multipart body total ${totalBytes} bytes exceeds cap of ${MAX_TOTAL_MULTIPART_BYTES} bytes (failed at file part "${part.name}")`
      );
    }
    decodedFiles.push({ part, bytes });
  }

  const fd = new FormData();
  for (const { part, bytes } of decodedFiles) {
    // Use `File` directly rather than `Blob` + filename arg on
    // `fd.append`: Node's global FormData implementation does not
    // reliably honour the filename argument when the part is a plain
    // Blob, but the File constructor stamps it on the instance.
    const file = new File([new Uint8Array(bytes)], part.filename ?? part.name, {
      type: part.contentType,
    });
    fd.append(part.name, file);
  }
  if (parts.fields) {
    for (const [name, value] of Object.entries(parts.fields)) {
      fd.append(name, value);
    }
  }
  return fd;
}
