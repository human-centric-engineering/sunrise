/**
 * MCP Audit Logger
 *
 * Fire-and-forget writes to the McpAuditLog table. Request params
 * are sanitized and truncated before storage.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { Prisma } from '@prisma/client';
import type { McpAuditLog, McpApiKey } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

export type McpAuditLogWithKey = McpAuditLog & {
  apiKey: Pick<McpApiKey, 'name' | 'keyPrefix'> | null;
};

const MAX_PARAMS_BYTES = 10_000; // 10KB

interface AuditEntry {
  apiKeyId: string | null;
  method: string;
  toolSlug?: string;
  resourceUri?: string;
  requestParams?: unknown;
  responseCode: 'success' | 'error' | 'rate_limited';
  errorMessage?: string;
  durationMs: number;
  clientIp?: string;
  userAgent?: string;
}

/**
 * Truncate and sanitize request params for audit storage.
 * Strips any keys that look like secrets and caps total size.
 */
/**
 * Matches field names that are likely secrets. For common words (`key`,
 * `token`) requires them to END the field name to avoid over-redacting
 * fields like `apiKeyCount` or `tokenizeInput`.
 */
const SECRET_PATTERN = /password|secret|credential|(?:key|token)(?:s?$)/i;

function sanitizeParams(params: unknown): unknown {
  if (params === undefined || params === null) return null;

  const json = JSON.stringify(params, (key, value) => {
    if (key && SECRET_PATTERN.test(key)) {
      return '[REDACTED]';
    }
    return value as unknown;
  });

  if (json.length > MAX_PARAMS_BYTES) {
    return { _truncated: true, originalSize: json.length, preview: json.slice(0, 500) };
  }

  return JSON.parse(json) as unknown;
}

/**
 * Log an MCP operation. Fire-and-forget — never throws to the caller.
 */
export function logMcpAudit(entry: AuditEntry): void {
  void prisma.mcpAuditLog
    .create({
      data: {
        apiKeyId: entry.apiKeyId,
        method: entry.method,
        toolSlug: entry.toolSlug ?? null,
        resourceUri: entry.resourceUri ?? null,
        requestParams: (() => {
          const sanitized = sanitizeParams(entry.requestParams);
          return sanitized === null ? Prisma.JsonNull : (sanitized as Prisma.InputJsonValue);
        })(),
        responseCode: entry.responseCode,
        errorMessage: entry.errorMessage ?? null,
        durationMs: entry.durationMs,
        clientIp: entry.clientIp ?? null,
        userAgent: entry.userAgent ?? null,
      },
    })
    .catch((err) => {
      logger.error('MCP audit: failed to write log', {
        method: entry.method,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * Query audit logs with filters and pagination.
 */
export async function queryMcpAuditLogs(filters: {
  page: number;
  limit: number;
  method?: string;
  toolSlug?: string;
  apiKeyId?: string;
  responseCode?: string;
  dateFrom?: Date;
  dateTo?: Date;
}): Promise<{ items: McpAuditLogWithKey[]; total: number }> {
  const where: Record<string, unknown> = {};

  if (filters.method) where.method = filters.method;
  if (filters.toolSlug) where.toolSlug = filters.toolSlug;
  if (filters.apiKeyId) where.apiKeyId = filters.apiKeyId;
  if (filters.responseCode) where.responseCode = filters.responseCode;

  if (filters.dateFrom || filters.dateTo) {
    const createdAt: Record<string, Date> = {};
    if (filters.dateFrom) createdAt.gte = filters.dateFrom;
    if (filters.dateTo) createdAt.lte = filters.dateTo;
    where.createdAt = createdAt;
  }

  const skip = (filters.page - 1) * filters.limit;

  const [items, total] = await Promise.all([
    prisma.mcpAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: filters.limit,
      include: {
        apiKey: {
          select: { name: true, keyPrefix: true },
        },
      },
    }),
    prisma.mcpAuditLog.count({ where }),
  ]);

  return { items, total };
}
