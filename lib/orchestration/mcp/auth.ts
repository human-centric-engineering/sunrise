/**
 * MCP API Key Authentication
 *
 * Generates, hashes, and verifies bearer tokens for MCP clients.
 * Only the SHA-256 hash is stored — plaintext is returned once at creation.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type { McpAuthContext } from '@/types/mcp';

const KEY_PREFIX = 'smcp_';
const KEY_BYTE_LENGTH = 32;

/** Base62 alphabet for compact key encoding */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function toBase62(buf: Buffer): string {
  let result = '';
  for (const byte of buf) {
    result += BASE62[byte % 62];
  }
  return result;
}

/** SHA-256 hash a plaintext key */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Generate a new MCP API key.
 *
 * Returns the plaintext key (to show once to the user) and the hash (to store).
 * Keys are prefixed with `smcp_` for easy identification in logs and configs.
 */
export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const raw = randomBytes(KEY_BYTE_LENGTH);
  const encoded = toBase62(raw);
  const plaintext = `${KEY_PREFIX}${encoded}`;
  const hash = hashApiKey(plaintext);
  const prefix = plaintext.slice(0, 12);
  return { plaintext, hash, prefix };
}

/**
 * Verify a bearer token against the database.
 *
 * Returns the auth context if valid, or null if the key is missing,
 * inactive, or expired. Updates `lastUsedAt` fire-and-forget.
 */
export async function authenticateMcpRequest(
  bearerToken: string,
  clientIp: string,
  userAgent: string
): Promise<McpAuthContext | null> {
  if (!bearerToken || !bearerToken.startsWith(KEY_PREFIX)) {
    return null;
  }

  const keyHash = hashApiKey(bearerToken);
  const key = await prisma.mcpApiKey.findUnique({
    where: { keyHash },
  });

  if (!key) {
    return null;
  }

  if (!key.isActive) {
    logger.warn('MCP auth: inactive key used', { keyPrefix: key.keyPrefix });
    return null;
  }

  if (key.expiresAt && key.expiresAt < new Date()) {
    logger.warn('MCP auth: expired key used', { keyPrefix: key.keyPrefix });
    return null;
  }

  // Fire-and-forget lastUsedAt update
  void prisma.mcpApiKey
    .update({
      where: { id: key.id },
      data: { lastUsedAt: new Date() },
    })
    .catch((err) => {
      logger.error('MCP auth: failed to update lastUsedAt', {
        keyId: key.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return {
    apiKeyId: key.id,
    apiKeyName: key.name,
    scopes: key.scopes,
    createdBy: key.createdBy,
    clientIp,
    userAgent,
    scopedAgentId: key.scopedAgentId,
  };
}

/**
 * Check whether an auth context has a specific scope.
 */
export function hasScope(auth: McpAuthContext, scope: string): boolean {
  return auth.scopes.includes(scope);
}
