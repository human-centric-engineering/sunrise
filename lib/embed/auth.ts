/**
 * Embed Token Authentication
 *
 * Resolves an `X-Embed-Token` header to an agent context for the
 * embeddable chat widget. Creates deterministic anonymous user IDs
 * from the token + client IP so conversations are scoped per-visitor.
 */

import { createHash } from 'crypto';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

export interface EmbedContext {
  agentId: string;
  agentSlug: string;
  userId: string;
  allowedOrigins: string[];
}

/**
 * Validate an embed token and return the associated agent context.
 * Returns `null` if the token is invalid, inactive, or the agent is disabled.
 */
export async function resolveEmbedToken(
  token: string,
  clientIp: string
): Promise<EmbedContext | null> {
  try {
    const record = await prisma.aiAgentEmbedToken.findUnique({
      where: { token },
      include: {
        agent: {
          select: { id: true, slug: true, isActive: true },
        },
      },
    });

    if (!record || !record.isActive || !record.agent.isActive) {
      return null;
    }

    // Deterministic anonymous user ID per embed token + IP
    const hash = createHash('sha256')
      .update(`embed:${record.id}:${clientIp}`)
      .digest('hex')
      .slice(0, 16);
    const userId = `embed_${hash}`;

    return {
      agentId: record.agent.id,
      agentSlug: record.agent.slug,
      userId,
      allowedOrigins: record.allowedOrigins,
    };
  } catch (err) {
    logger.error('resolveEmbedToken failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Check if the request origin is allowed by the embed token's allowedOrigins.
 * Empty allowedOrigins = allow all origins.
 */
export function isOriginAllowed(origin: string | null, allowedOrigins: string[]): boolean {
  if (allowedOrigins.length === 0) return true;
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}
