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
 *     `<uuid>.<ext>` segment so the LLM never controls the path.
 *   - `allowedContentTypes?` — optional MIME allowlist (e.g.
 *     `['application/pdf']`). When set, an upload with a non-matching
 *     contentType fails closed. Recommended for narrow bindings.
 *   - `maxFileSizeBytes?` — optional per-binding cap. Defaults to the
 *     deployment's `MAX_FILE_SIZE_MB` (5 MB if unset).
 *   - `signedUrlTtlSeconds?` — when set, the result returns a signed
 *     URL instead of a public one. Only S3 supports this — fail-closed
 *     on Vercel Blob / local. Implies `public: false` at upload time.
 *   - `public?` — defaults true. Ignored when `signedUrlTtlSeconds` is
 *     set (signed implies private).
 *
 * Security posture:
 * - The LLM cannot influence the storage path: prefix is admin-set,
 *   filename is sanitised to an extension only, the path segment is a
 *   random UUID.
 * - `validateStorageKey` is applied to the resolved prefix at admin
 *   binding load and again to the full key before upload.
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
import { validateStorageKey } from '@/lib/storage/providers/validate-key';
import { getMaxFileSizeBytes } from '@/lib/validations/storage';

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

const customConfigSchema = z
  .object({
    keyPrefix: z.string().min(1).max(200).regex(/\/$/, 'keyPrefix must end with /').optional(),
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
  /** True when `url` is a time-limited signed URL; false for public URLs. */
  signed: boolean;
  /** Set when the URL is signed — RFC3339 expiry timestamp. */
  expiresAt?: string;
}

const SLUG = 'upload_to_storage';

export class UploadToStorageCapability extends BaseCapability<Args, Data> {
  readonly slug = SLUG;

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

    const storage = getStorageClient();
    if (!storage) {
      return this.error(
        'Storage is not configured for this deployment — set STORAGE_PROVIDER and credentials',
        'storage_not_configured'
      );
    }

    if (customConfig?.signedUrlTtlSeconds && typeof storage.getSignedUrl !== 'function') {
      return this.error(
        `Signed URLs are not supported by the configured storage provider (${storage.name}) — only S3 supports getSignedUrl`,
        'signed_url_not_supported'
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

    const prefix = customConfig?.keyPrefix ?? `agent-uploads/${context.agentId}/`;
    const extension = deriveExtension(args.filename, args.contentType);
    const key = `${prefix}${randomUUID()}${extension}`;

    try {
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

    const signedRequested = customConfig?.signedUrlTtlSeconds !== undefined;
    const isPublic = signedRequested ? false : (customConfig?.public ?? true);

    let upload;
    try {
      upload = await storage.upload(buffer, {
        key,
        contentType: args.contentType,
        public: isPublic,
        metadata: buildMetadata(context, args),
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

    if (signedRequested && customConfig?.signedUrlTtlSeconds && storage.getSignedUrl) {
      const expiresIn = customConfig.signedUrlTtlSeconds;
      try {
        const signedUrl = await storage.getSignedUrl(upload.key, expiresIn);
        const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
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

function buildMetadata(context: CapabilityContext, args: Args): Record<string, string> {
  const meta: Record<string, string> = {
    agentId: context.agentId,
    userId: context.userId,
    uploadedAt: new Date().toISOString(),
  };
  if (context.conversationId) meta.conversationId = context.conversationId;
  if (args.description) meta.description = args.description;
  if (args.filename) meta.originalFilename = args.filename.slice(0, 200);
  return meta;
}

export const __testing = { customConfigSchema, argsSchema, deriveExtension };
