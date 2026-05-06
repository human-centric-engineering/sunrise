import type { SeedUnit } from '@/prisma/runner';

/**
 * Seed the `upload_to_storage` capability row.
 *
 * Adds the capability to the registry without binding it to any agent.
 * Bindings are created per-agent in the admin UI (or via API) so
 * outbound storage writes stay off-by-default.
 *
 * Idempotent — safe to run on every deploy. The `update` branch only
 * sets `isSystem: true` so re-seeding never overwrites admin edits.
 */
const unit: SeedUnit = {
  name: '013-upload-to-storage',
  async run({ prisma, logger }) {
    logger.info('📦 Seeding upload_to_storage capability...');

    await prisma.aiCapability.upsert({
      where: { slug: 'upload_to_storage' },
      update: { isSystem: true },
      create: {
        slug: 'upload_to_storage',
        name: 'Upload to Storage',
        description:
          'Persist a binary artefact (PDF, image, CSV) to the configured Sunrise storage backend (S3, Vercel Blob, or local) and return a URL the user can open. Path is admin-scoped — the LLM only supplies bytes, content type, and an optional filename.',
        category: 'external',
        executionType: 'internal',
        executionHandler: 'UploadToStorageCapability',
        functionDefinition: {
          name: 'upload_to_storage',
          description:
            'Upload a binary file (PDF, image, CSV, etc) to persistent storage and return a URL the user can open. Use this after generating a document, receiving a binary response from another tool, or capturing any artefact you want to hand back to the user. The path is chosen by the system — you only supply the bytes, content type, and an optional filename used for the extension.',
          parameters: {
            type: 'object',
            properties: {
              data: {
                type: 'string',
                description:
                  'Base64-encoded file bytes. If a previous tool returned `{ encoding: "base64", data }`, pass the `data` field directly.',
                maxLength: 8 * 1024 * 1024,
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
        },
        rateLimit: 30,
        isActive: true,
        isSystem: true,
      },
    });

    logger.info('✅ Seeded upload_to_storage capability (no agent bindings)');
  },
};

export default unit;
