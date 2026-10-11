/**
 * `upload_to_storage` capability
 *
 * Lets an agent persist a binary artefact (PDF from a renderer, image
 * from a generator, CSV from a report builder) to the configured
 * Sunrise storage backend (S3, Vercel Blob, or local) and hand the
 * resulting URL back to the user. Closes the loop with `call_external_api`
 * for endpoints that return bytes inline as
 * `{ encoding: 'base64', contentType, data }`.
 *
 * Per-agent binding (`AiAgentCapability.customConfig`):
 *   - `keyPrefix?` — optional path prefix. Defaults to
 *     `agent-uploads/<agentId>/`. Forced through `validateStorageKey`
 *     and required to end with `/`. The capability appends a
 *     `<uuid>.<ext>` segment so the LLM never controls the path. At
 *     `TENANCY_MODE=multi` it is wrapped in the org's prefix:
 *     `orgs/<orgId>/<keyPrefix><uuid>.<ext>`.
 *   - `allowedContentTypes?` — optional MIME allowlist (e.g.
 *     `['application/pdf']`). When set, an upload with a non-matching
 *     contentType fails closed. Recommended for narrow bindings.
 *   - `maxFileSizeBytes?` — optional per-binding cap. Defaults to the
 *     deployment's `MAX_FILE_SIZE_MB` (5 MB if unset).
 *   - `signedUrlTtlSeconds?` — when set, the result returns a signed
 *     URL instead of a public one. Requires a provider that declares
 *     `signedUrls` and `privateObjects`; fail-closed otherwise.
 *     Implies `public: false` at upload time.
 *   - `public?` — defaults true at `single`. Ignored when
 *     `signedUrlTtlSeconds` is set (signed implies private). Setting it
 *     false requires a provider that declares `privateObjects` — see
 *     `getStorageCapabilities()`.
 *
 * **At `TENANCY_MODE=multi` (§109 t-736, owner ruling 2026-10-08):**
 *   - The upload goes through the org-bound client
 *     (`getStorageClient({ orgId })`), which refuses any key outside
 *     `orgs/<orgId>/`. The org comes from the tenant context the dispatch
 *     already runs in (`requireOrgId()`), not from `CapabilityContext`: the
 *     same scope every database read in this call is filtered by, so there
 *     is one answer to "which org" rather than two that could disagree.
 *   - A binding that sets neither `public` nor `signedUrlTtlSeconds`
 *     uploads privately and returns a signed URL valid for
 *     {@link DEFAULT_MULTI_SIGNED_URL_TTL_SECONDS}. A public URL carries no
 *     token, so no org check can protect it; `public: true` is the explicit
 *     opt-out for a link that must outlive a TTL. On Vercel Blob, which has
 *     no signed URLs, such a binding is refused with
 *     `signed_url_not_supported` until it opts into public.
 *
 * Security posture:
 * - The LLM cannot influence the storage path: prefix is admin-set,
 *   filename is sanitised to an extension only, the path segment is a
 *   random UUID.
 * - `validateStorageKey` runs defensively on the resolved prefix and
 *   the full key inside `execute()` before any upload. Admin-save-time
 *   validation is a known gap — the PATCH route accepts customConfig
 *   as `z.record(z.unknown())` and does not sanity-check the prefix
 *   against the storage-key rules. The defensive check catches direct
 *   DB edits and bindings written before this guard existed.
 * - Result returns the canonical key (for any future delete capability)
 *   alongside the URL the LLM hands to the user.
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { getStorageClient } from '@/lib/storage/client';
import { isUnderOrgRoot, ORG_KEY_ROOT, orgKeyPrefix } from '@/lib/storage/org-keys';
import { isMultiTenant, requireOrgId } from '@/lib/tenancy/context';
import { getStorageCapabilities } from '@/lib/storage/providers/types';
import { validateStorageKey } from '@/lib/storage/providers/validate-key';
import { getMaxFileSizeBytes } from '@/lib/validations/storage';
import { redactedString } from '@/lib/security/redact';

/**
 * RFC 6838 loose match — type/subtype with the usual punctuation.
 * Tighter than accepting any string; loose enough to pass through
 * vendor-specific subtypes (`application/vnd.ms-excel`, etc).
 */
const CONTENT_TYPE_RE = /^[a-z0-9]+\/[a-zA-Z0-9.+\-_]+$/;

/**
 * 4 MB of base64 ≈ 3 MB of bytes — small enough to stay in memory on a
 * serverless function. Larger artefacts should stream through a signed
 * upload URL (future capability).
 */
const ABSOLUTE_MAX_BASE64_LENGTH = 8 * 1024 * 1024;

/**
 * Signed-URL lifetime for a binding that chose neither public nor a TTL, at
 * `multi`. A day, because the agent hands the link on in conversation: the
 * person reads it some time after the turn that produced it, often after a
 * break, and an hour would expire links people have not opened yet. Longer
 * makes a leaked link live longer. A binding that needs something else sets
 * `signedUrlTtlSeconds` (60 s to 7 days).
 */
export const DEFAULT_MULTI_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

const customConfigSchema = z
  .object({
    keyPrefix: z
      .string()
      .min(1)
      .max(200)
      .regex(/\/$/, 'keyPrefix must end with /')
      // No `.`, `..` or empty segments: the local provider resolves keys as
      // paths, so `./orgs/x/` or `a//b/` would land somewhere other than the
      // string says, and every prefix rule here (the reserved `orgs/` root,
      // `orgOfKey`) reads the string.
      .refine(
        (p) =>
          p
            .slice(0, -1)
            .split('/')
            .every((seg) => seg !== '' && seg !== '.' && seg !== '..'),
        'keyPrefix must not contain empty, "." or ".." segments'
      )
      .optional(),
    allowedContentTypes: z.array(z.string().regex(CONTENT_TYPE_RE)).min(1).max(20).optional(),
    maxFileSizeBytes: z
      .number()
      .int()
      .positive()
      .max(100 * 1024 * 1024)
      .optional(),
    signedUrlTtlSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 24 * 60 * 60)
      .optional(),
    public: z.boolean().optional(),
  })
  .strict();

type CustomConfig = z.infer<typeof customConfigSchema>;

const argsSchema = z.object({
  data: z.string().min(1).max(ABSOLUTE_MAX_BASE64_LENGTH).describe('Base64-encoded file bytes'),
  contentType: z.string().regex(CONTENT_TYPE_RE).max(127),
  filename: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Original filename — only used to derive an extension; the stored path is randomised.'
    ),
  description: z.string().max(500).optional(),
});

type Args = z.infer<typeof argsSchema>;

interface Data {
  key: string;
  url: string;
  size: number;
  contentType: string;
  /**
   * True when `url` is a time-limited signed URL.
   *
   * False means the URL is unsigned — usually a public one, but a binding with
   * `public: false` and no `signedUrlTtlSeconds` also lands here, and that URL
   * is deliberately not openable (401 on the local read route, 403 on S3). Ask
   * for `signedUrlTtlSeconds` if the caller needs to actually fetch it.
   */
  signed: boolean;
  /** Set when the URL is signed — RFC3339 expiry timestamp. */
  expiresAt?: string;
}

const SLUG = 'upload_to_storage';

export class UploadToStorageCapability extends BaseCapability<Args, Data> {
  readonly slug = SLUG;
  readonly processesPii = true;

  /**
   * The `data` argument is base64-encoded file bytes — invoices,
   * receipts, PDFs of medical letters, screenshots of user docs — and
   * routinely contains PII. The default trace would JSON-stringify the
   * entire base64 string (truncated to 480 chars), preserving the first
   * ~360 raw bytes of the file forever in the audit row.
   *
   * Audit row keeps `contentType`, `filename` (just the original name —
   * useful for "was an invoice uploaded?" audit context), `description`,
   * and the file size derived from the base64 length. The bytes themselves
   * become a sentinel.
   */
  redactProvenance(
    args: Args,
    result: CapabilityResult<Data>
  ): {
    args: unknown;
    resultPreview: string;
  } {
    // Approximate decoded size from base64 length (4 chars → 3 bytes).
    // Useful for "was this a thumbnail or a 5MB upload?" audit context.
    const approxBytes = Math.floor((args.data.length * 3) / 4);
    const safeArgs = {
      data: redactedString(`file bytes, ~${approxBytes} bytes`),
      contentType: args.contentType,
      ...(args.filename !== undefined ? { filename: args.filename } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
    };
    // The result envelope is structural (key, url, size, contentType,
    // signed, expiresAt) — no file content echoed back. Safe to persist
    // as-is via the default JSON-stringify path.
    return { args: safeArgs, resultPreview: JSON.stringify(result) };
  }

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: SLUG,
    description:
      'Upload a binary file (PDF, image, CSV, etc) to persistent storage and return a URL the user can open. Use this after generating a document, receiving a binary response from another tool, or capturing any artefact you want to hand back to the user. The path is chosen by the system — you only supply the bytes, content type, and an optional filename used for the extension.',
    parameters: {
      type: 'object',
      properties: {
        data: {
          type: 'string',
          description:
            'Base64-encoded file bytes. If a previous tool returned `{ encoding: "base64", data }`, pass the `data` field directly.',
          maxLength: ABSOLUTE_MAX_BASE64_LENGTH,
        },
        contentType: {
          type: 'string',
          description:
            'MIME type of the file (e.g. application/pdf, image/png, text/csv). Bindings may restrict which types are accepted.',
          maxLength: 127,
        },
        filename: {
          type: 'string',
          description:
            'Optional original filename. Only the extension is used; the stored path is a random UUID under an admin-defined prefix.',
          maxLength: 200,
        },
        description: {
          type: 'string',
          description:
            'Optional human-readable description stored as object metadata for later auditing.',
          maxLength: 500,
        },
      },
      required: ['data', 'contentType'],
    },
  };

  protected readonly schema = argsSchema;

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const loaded = await this.loadCustomConfig(context.agentId);
    if (loaded.kind === 'malformed') {
      logger.error('upload_to_storage: refusing call — customConfig JSON is malformed', {
        agentId: context.agentId,
        issues: loaded.issues,
      });
      return this.error(
        'Capability binding is misconfigured — admin must repair the customConfig JSON',
        'invalid_binding'
      );
    }
    const customConfig = loaded.config;

    // At `multi` the upload is the org's, so it needs the org. A dispatch with
    // no org in its context (a system scope) has nowhere to put the file.
    const multi = isMultiTenant();
    let orgId: string | undefined;
    if (multi) {
      try {
        orgId = requireOrgId();
      } catch {
        logger.error('upload_to_storage: refusing call — no org in the tenant context', {
          agentId: context.agentId,
        });
        return this.error(
          'Uploads need an organisation to belong to, and this call is not running as one',
          'no_org_context'
        );
      }
    }

    let storage: ReturnType<typeof getStorageClient>;
    try {
      storage = getStorageClient({ orgId });
    } catch (err) {
      // Binding the client validates the org id as a path segment.
      logger.error('upload_to_storage: refusing call — org id is not usable as a storage prefix', {
        agentId: context.agentId,
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.error(
        'This organisation cannot be given a storage location — contact the platform operator',
        'invalid_org'
      );
    }
    if (!storage) {
      return this.error(
        'Storage is not configured for this deployment — set STORAGE_PROVIDER and credentials',
        'storage_not_configured'
      );
    }

    // Signed by default at `multi` when the binding chose neither way; see
    // the module header. `single` keeps the public default.
    const signedByDefault =
      multi &&
      customConfig?.signedUrlTtlSeconds === undefined &&
      customConfig?.public === undefined;
    const signedTtl = signedByDefault
      ? DEFAULT_MULTI_SIGNED_URL_TTL_SECONDS
      : customConfig?.signedUrlTtlSeconds;
    const signedRequested = signedTtl !== undefined;
    const isPublic = signedRequested ? false : (customConfig?.public ?? true);
    const caps = getStorageCapabilities(storage);

    if (signedRequested && !caps.signedUrls) {
      return this.error(
        `Signed URLs are not supported by the configured storage provider (${storage.name})` +
          (signedByDefault
            ? '. Uploads are private by default when the deployment runs several organisations; ' +
              'set public: true on the binding to publish the file instead.'
            : ''),
        'signed_url_not_supported'
      );
    }

    // Both a `public: false` binding and a signed-URL binding require the
    // provider to actually store the object privately. Refusing here is the
    // whole point of the capability contract: the alternative is an upload
    // that succeeds and hands the user a world-readable URL.
    if (!isPublic && !caps.privateObjects) {
      // A binding that chose nothing is private only because of the `multi`
      // default, so the generic remedy ("remove signedUrlTtlSeconds and
      // public:false") would name settings it never had. S3 without
      // S3_OBJECTS_PRIVATE_BY_DEFAULT or S3_USE_ACL lands here.
      return this.error(
        `The configured storage provider (${storage.name}) cannot store private objects, ` +
          `so this binding would publish the file. ` +
          (signedByDefault
            ? `Uploads are private by default when the deployment runs several organisations. ` +
              `${privateObjectsDeploymentRemedy(storage.name)}Or set public: true on the binding ` +
              `to publish the file instead.`
            : privateObjectsRemedy(storage.name)),
        'private_objects_not_supported'
      );
    }

    if (customConfig?.allowedContentTypes) {
      // RFC 6838 §4.2: MIME type and subtype names are case-insensitive.
      // Compare lower-cased so admins can bind `application/pdf` and the
      // LLM can send `Application/PDF` (or vice-versa) without a false
      // rejection. Parameters (after `;`) are not used by the allowlist.
      const requested = args.contentType.toLowerCase();
      const allowed = customConfig.allowedContentTypes.map((t) => t.toLowerCase());
      if (!allowed.includes(requested)) {
        return this.error(
          `Content type ${args.contentType} not allowed by binding: must be one of ${customConfig.allowedContentTypes.join(', ')}`,
          'content_type_not_allowed'
        );
      }
    }

    // Node's `Buffer.from(s, 'base64')` silently strips non-base64
    // characters and returns a partial buffer rather than throwing —
    // a zero-length result only catches the all-invalid case. Validate
    // the input shape strictly first. Upstream producers (the HTTP
    // module's binary wrapper, any LLM-driven tool chaining) emit
    // unwrapped base64 with no whitespace; rejecting whitespace blocks
    // strings like "not actually base64 at all" from sneaking through.
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(args.data)) {
      return this.error(
        'data contains non-base64 characters — must be standard base64 (A-Z, a-z, 0-9, +, /, optional = padding) with no whitespace',
        'invalid_data'
      );
    }
    const buffer = Buffer.from(args.data, 'base64');
    if (buffer.length === 0) {
      return this.error('Decoded payload is empty — data must be valid base64', 'invalid_data');
    }

    const maxBytes = customConfig?.maxFileSizeBytes ?? getMaxFileSizeBytes();
    if (buffer.length > maxBytes) {
      const maxMB = (maxBytes / (1024 * 1024)).toFixed(1);
      return this.error(
        `File size ${buffer.length} bytes exceeds the binding limit of ${maxMB} MB`,
        'file_too_large'
      );
    }

    // The org prefix wraps the admin's rather than replacing it, so a binding's
    // own layout survives the move to `multi`.
    const bindingPrefix = customConfig?.keyPrefix ?? `agent-uploads/${context.agentId}/`;
    // `orgs/` is where org-owned keys live, and the unbound client refuses any
    // key under it, in any case. At `single` nothing names an org, so such a
    // binding could never upload; say so as a binding error, before decoding
    // anything, rather than as a failed upload.
    if (orgId === undefined && isUnderOrgRoot(bindingPrefix)) {
      logger.error('upload_to_storage: keyPrefix uses the reserved orgs/ root', {
        agentId: context.agentId,
        keyPrefix: bindingPrefix,
      });
      return this.error(
        `keyPrefix must not start with "${ORG_KEY_ROOT}" — that root is reserved for organisation-owned files`,
        'invalid_binding'
      );
    }
    const extension = deriveExtension(args.filename, args.contentType);
    let prefix = bindingPrefix;
    let key = '';

    try {
      // Inside the try: `orgKeyPrefix` throws for an org id it cannot use as a
      // path segment, and that must come back as a result, not an exception.
      prefix = orgId !== undefined ? `${orgKeyPrefix(orgId)}${bindingPrefix}` : bindingPrefix;
      key = `${prefix}${randomUUID()}${extension}`;
      validateStorageKey(prefix);
      validateStorageKey(key);
    } catch (err) {
      // The prefix is admin-set; this should fail at admin-save time.
      // The defensive check here catches bindings written before key
      // validation existed, or via direct DB edits.
      logger.error('upload_to_storage: storage key validation rejected resolved path', {
        agentId: context.agentId,
        prefix,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.error(
        'Resolved storage key is invalid — admin must repair the keyPrefix in customConfig',
        'invalid_binding'
      );
    }

    let upload;
    try {
      upload = await storage.upload(buffer, {
        key,
        contentType: args.contentType,
        public: isPublic,
        metadata: buildMetadata(context, args, orgId),
      });
    } catch (err) {
      logger.error('upload_to_storage: storage upload failed', {
        agentId: context.agentId,
        provider: storage.name,
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.error(
        err instanceof Error ? err.message : 'Storage upload failed',
        'upload_failed'
      );
    }

    if (signedTtl !== undefined) {
      // The capability check above already passed, so a missing method means
      // the provider declares `signedUrls` without implementing it. Fail
      // rather than fall through to the public-URL return below, which would
      // hand out an unsigned URL for an upload the binding wanted private.
      if (typeof storage.getSignedUrl !== 'function') {
        logger.error('upload_to_storage: provider declares signedUrls but has no getSignedUrl', {
          agentId: context.agentId,
          provider: storage.name,
        });
        return this.error(
          `Storage provider ${storage.name} declares signed-URL support but does not implement it`,
          'signed_url_not_supported'
        );
      }
      try {
        const signedUrl = await storage.getSignedUrl(upload.key, signedTtl);
        const expiresAt = new Date(Date.now() + signedTtl * 1000).toISOString();
        return this.success({
          key: upload.key,
          url: signedUrl,
          size: upload.size,
          contentType: args.contentType,
          signed: true,
          expiresAt,
        });
      } catch (err) {
        logger.error('upload_to_storage: signed URL generation failed after upload', {
          agentId: context.agentId,
          provider: storage.name,
          key: upload.key,
          error: err instanceof Error ? err.message : String(err),
        });
        return this.error(
          'Upload succeeded but signed URL generation failed — admin should investigate',
          'signed_url_failed'
        );
      }
    }

    return this.success({
      key: upload.key,
      url: upload.url,
      size: upload.size,
      contentType: args.contentType,
      signed: false,
    });
  }

  private async loadCustomConfig(agentId: string): Promise<LoadCustomConfigResult> {
    const binding = await prisma.aiAgentCapability.findFirst({
      where: { agentId, capability: { slug: SLUG } },
      select: { customConfig: true },
    });
    if (!binding?.customConfig) return { kind: 'ok', config: undefined };

    const parsed = customConfigSchema.safeParse(binding.customConfig);
    if (!parsed.success) {
      return { kind: 'malformed', issues: parsed.error.issues };
    }
    return { kind: 'ok', config: parsed.data };
  }
}

type LoadCustomConfigResult =
  | { kind: 'ok'; config: CustomConfig | undefined }
  | { kind: 'malformed'; issues: ReadonlyArray<unknown> };

/**
 * Tell the admin what to change, per provider — the refusal is otherwise
 * indistinguishable from a bug, and the fix is different on each backend.
 */
function privateObjectsRemedy(providerName: string): string {
  switch (providerName) {
    case 's3':
      return 'Set S3_OBJECTS_PRIVATE_BY_DEFAULT=true if the bucket blocks public access, or S3_USE_ACL=true on a legacy ACL bucket.';
    case 'vercel-blob':
      return 'Vercel Blob has no private storage — switch STORAGE_PROVIDER to s3, or drop signedUrlTtlSeconds and public:false from the binding.';
    default:
      return 'Remove signedUrlTtlSeconds and public:false from the binding, or configure a provider that supports private objects.';
  }
}

/**
 * The deployment-side fix for a provider that cannot store privately, for a
 * binding that set nothing: only the provider can change, so only S3 has one.
 */
function privateObjectsDeploymentRemedy(providerName: string): string {
  return providerName === 's3' ? `${privateObjectsRemedy('s3')} ` : '';
}

/**
 * Pull an extension from the supplied filename if present and safe;
 * fall back to a contentType-based lookup; finally return empty
 * string. Never returns a path separator or relative-path token.
 */
function deriveExtension(filename: string | undefined, contentType: string): string {
  if (filename) {
    const dot = filename.lastIndexOf('.');
    if (dot > 0 && dot < filename.length - 1) {
      const ext = filename.slice(dot).toLowerCase();
      if (/^\.[a-z0-9]{1,10}$/.test(ext)) return ext;
    }
  }
  return CONTENT_TYPE_TO_EXT[contentType.toLowerCase()] ?? '';
}

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/json': '.json',
  'application/zip': '.zip',
  'application/octet-stream': '',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/markdown': '.md',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

function buildMetadata(
  context: CapabilityContext,
  args: Args,
  orgId: string | undefined
): Record<string, string> {
  const meta: Record<string, string> = {
    agentId: context.agentId,
    userId: context.userId ?? '',
    uploadedAt: new Date().toISOString(),
  };
  if (orgId !== undefined) meta.orgId = orgId;
  if (context.conversationId) meta.conversationId = context.conversationId;
  if (args.description) meta.description = args.description;
  if (args.filename) meta.originalFilename = args.filename.slice(0, 200);
  return meta;
}

export const __testing = { customConfigSchema, argsSchema, deriveExtension };
