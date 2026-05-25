/**
 * Admin Orchestration — Evaluation datasets (list + create/upload).
 *
 * GET  /api/v1/admin/orchestration/evaluations/datasets
 *   Paginated list of the caller's datasets. Filters: q (name search),
 *   tag (exact tag match).
 *
 * POST /api/v1/admin/orchestration/evaluations/datasets
 *   Two body shapes:
 *     - multipart/form-data with `file` (CSV or JSONL) and string
 *       fields `name`, `description?`, `tags?` (comma-separated).
 *     - application/json with `{ name, description?, tags?, cases[] }`.
 *
 * Ownership: every dataset is scoped to `session.user.id`. Cross-user
 * access from sibling endpoints returns 404.
 */

import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse, successResponse, errorResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import {
  createDatasetJsonSchema,
  listDatasetsQuerySchema,
} from '@/lib/validations/orchestration-evaluations';
import { uploadDataset } from '@/lib/orchestration/evaluations/datasets/upload-handler';
import { hashParsedCases } from '@/lib/orchestration/evaluations/datasets/hash';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB — datasets are structured rows, not free text

export const GET = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const { page, limit, q, tag } = validateQueryParams(searchParams, listDatasetsQuerySchema);
  const skip = (page - 1) * limit;

  const where: Prisma.AiDatasetWhereInput = { userId: session.user.id };
  if (q) where.name = { contains: q, mode: 'insensitive' };
  if (tag) where.tags = { has: tag };

  const [datasets, total] = await Promise.all([
    prisma.aiDataset.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        name: true,
        description: true,
        tags: true,
        caseCount: true,
        contentHash: true,
        source: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.aiDataset.count({ where }),
  ]);

  log.info('Listed datasets', { count: datasets.length, total });
  return paginatedResponse(datasets, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.startsWith('multipart/form-data')) {
    // -------------------------------------------------------------------
    // File upload path (CSV or JSONL)
    // -------------------------------------------------------------------
    const sizeHeader = Number(request.headers.get('content-length') ?? '0');
    if (sizeHeader > MAX_UPLOAD_BYTES) {
      return errorResponse(`Dataset upload exceeds ${MAX_UPLOAD_BYTES} bytes`, {
        code: 'FILE_TOO_LARGE',
        status: 413,
      });
    }
    const form = await request.formData();
    const file = form.get('file');
    const nameRaw = form.get('name');
    const name = (typeof nameRaw === 'string' ? nameRaw : '').trim();
    const description = form.get('description');
    const tagsRaw = form.get('tags');

    if (!(file instanceof Blob)) {
      throw new ValidationError('file is required (multipart `file` field)');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return errorResponse(`Dataset upload exceeds ${MAX_UPLOAD_BYTES} bytes`, {
        code: 'FILE_TOO_LARGE',
        status: 413,
      });
    }
    if (!name) throw new ValidationError('name is required');

    const buffer = Buffer.from(await file.arrayBuffer());
    const content = buffer.toString('utf-8');
    const tags =
      typeof tagsRaw === 'string'
        ? tagsRaw
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
        : [];

    // file.name isn't typed on Blob in older Web Streams typings — but
    // browsers + Next pass File which always has `.name`. Read defensively.
    const fileName = (file as { name?: string }).name ?? 'dataset.csv';

    const result = await uploadDataset({
      userId: session.user.id,
      name,
      description: typeof description === 'string' ? description : null,
      tags,
      fileName,
      content,
    });
    log.info('Dataset uploaded (multipart)', {
      datasetId: result.datasetId,
      caseCount: result.caseCount,
    });
    return successResponse(result, undefined, { status: 201 });
  }

  // -----------------------------------------------------------------------
  // JSON path (programmatic create with inline cases)
  // -----------------------------------------------------------------------
  const body = await validateRequestBody(request, createDatasetJsonSchema);
  const contentHash = hashParsedCases(body.cases);
  const dataset = await prisma.$transaction(async (tx) => {
    const created = await tx.aiDataset.create({
      data: {
        userId: session.user.id,
        name: body.name,
        description: body.description ?? null,
        tags: body.tags ?? [],
        caseCount: body.cases.length,
        contentHash,
        source: 'manual',
      },
    });
    await tx.aiDatasetCase.createMany({
      data: body.cases.map((c, i) => ({
        datasetId: created.id,
        position: i,
        input: c.input as Prisma.InputJsonValue,
        expectedOutput: c.expectedOutput ?? null,
        metadata: c.metadata !== undefined ? (c.metadata as Prisma.InputJsonValue) : undefined,
        referenceCitations:
          c.referenceCitations !== undefined
            ? (c.referenceCitations as Prisma.InputJsonValue)
            : undefined,
      })),
    });
    return created;
  });
  log.info('Dataset created (JSON)', { datasetId: dataset.id, caseCount: body.cases.length });
  return successResponse(
    { datasetId: dataset.id, caseCount: body.cases.length, contentHash, warnings: [] },
    undefined,
    { status: 201 }
  );
});
