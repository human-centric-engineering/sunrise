/**
 * Dataset upload handler.
 *
 * Format-agnostic entry point: dispatches to the right parser based on
 * file extension, validates the parsed cases via Zod, writes
 * `AiDataset` + `AiDatasetCase[]` in a single transaction, and
 * computes the `contentHash` pin from the same normalised case array
 * the hash function uses elsewhere — so re-uploading the identical
 * file produces the same hash.
 *
 * Owner enforcement (cross-user 404) happens at the route layer; this
 * function assumes `userId` is already trusted.
 */

import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { ValidationError } from '@/lib/api/errors';
import {
  type ParsedDataset,
  type ParsedDatasetCase,
  DatasetParseError,
} from '@/lib/orchestration/evaluations/datasets/parsers/types';
import { parseDatasetCsv } from '@/lib/orchestration/evaluations/datasets/parsers/csv-parser';
import { parseDatasetJsonl } from '@/lib/orchestration/evaluations/datasets/parsers/jsonl-parser';
import { hashParsedCases } from '@/lib/orchestration/evaluations/datasets/hash';

const MAX_CASES = 10_000;
const MAX_INPUT_CHARS = 50_000;
const MAX_EXPECTED_CHARS = 50_000;

/** Zod schema validating one parser-output case. */
const caseSchema = z
  .object({
    input: z
      .union([z.string().min(1).max(MAX_INPUT_CHARS), z.record(z.string(), z.unknown())])
      .refine(
        (v) =>
          typeof v === 'string' ||
          (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length > 0),
        { message: 'Object inputs must have at least one key' }
      ),
    expectedOutput: z.string().max(MAX_EXPECTED_CHARS).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    referenceCitations: z.array(z.unknown()).optional(),
  })
  .strict();

export interface UploadDatasetParams {
  userId: string;
  name: string;
  description?: string | null;
  tags?: string[];
  fileName: string;
  content: string;
}

export interface UploadDatasetResult {
  datasetId: string;
  caseCount: number;
  contentHash: string;
  warnings: string[];
}

export async function uploadDataset(params: UploadDatasetParams): Promise<UploadDatasetResult> {
  const parsed = parseByExtension(params.fileName, params.content);

  if (parsed.cases.length > MAX_CASES) {
    throw new ValidationError(
      `Dataset exceeds ${MAX_CASES}-case cap (${parsed.cases.length} cases)`
    );
  }

  // Per-case Zod validation. Failures throw early — we'd rather refuse
  // the whole upload than silently drop bad cases.
  const validated: ParsedDatasetCase[] = parsed.cases.map((c, i) => {
    const r = caseSchema.safeParse(c);
    if (!r.success) {
      throw new ValidationError(
        `Case at position ${i} is invalid: ${r.error.issues.map((iss) => iss.message).join('; ')}`
      );
    }
    return r.data;
  });

  const contentHash = hashParsedCases(validated);

  const dataset = await prisma.$transaction(async (tx) => {
    const created = await tx.aiDataset.create({
      data: {
        userId: params.userId,
        name: params.name,
        description: params.description ?? null,
        tags: params.tags ?? [],
        caseCount: validated.length,
        contentHash,
        source: detectSource(params.fileName),
      },
    });
    await tx.aiDatasetCase.createMany({
      data: validated.map((c, i) => ({
        datasetId: created.id,
        position: i,
        input: c.input as Prisma.InputJsonValue,
        expectedOutput: c.expectedOutput ?? null,
        metadata: c.metadata !== undefined ? (c.metadata as Prisma.InputJsonValue) : Prisma.DbNull,
        referenceCitations:
          c.referenceCitations !== undefined
            ? (c.referenceCitations as Prisma.InputJsonValue)
            : Prisma.DbNull,
      })),
    });
    return created;
  });

  logger.info('Dataset uploaded', {
    datasetId: dataset.id,
    userId: params.userId,
    caseCount: validated.length,
    contentHash,
    parseWarnings: parsed.warnings.length,
  });

  return {
    datasetId: dataset.id,
    caseCount: validated.length,
    contentHash,
    warnings: parsed.warnings,
  };
}

function parseByExtension(fileName: string, content: string): ParsedDataset {
  const ext = fileName.toLowerCase().split('.').pop();
  try {
    if (ext === 'csv') return parseDatasetCsv(content);
    if (ext === 'jsonl' || ext === 'ndjson') return parseDatasetJsonl(content);
    throw new ValidationError(`Unsupported dataset format: ${ext}. Use .csv or .jsonl.`);
  } catch (err) {
    if (err instanceof DatasetParseError) {
      throw new ValidationError(`Dataset parse failed: ${err.message}`);
    }
    throw err;
  }
}

function detectSource(_fileName: string): string {
  // Currently every uploaded dataset reports `source: 'upload'`. Phase 2
  // introduces `synthetic` and `conversation_capture` via separate
  // endpoints, not this handler — kept as a function for symmetry.
  return 'upload';
}
