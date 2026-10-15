/**
 * Who may set an MCP key's own rate limit, and to what (§111 t-811).
 *
 * `rateLimitOverride` replaces the server's `globalRateLimit` for one key
 * (`getKeyRateLimit` in `protocol-handler.ts`). The server limit is the
 * platform's, set on the platform-only MCP settings page; once org admins can
 * mint and edit their keys, an override above it would let a customer org
 * lift its own keys past the limit the operator chose. So a caller who does
 * not administer the platform may set an override at or below the server
 * limit — lowering a key is theirs to do — and not above it.
 */
import { ValidationError } from '@/lib/api/errors';
import { administersPlatform } from '@/lib/auth/admin-viewer';
import type { AuthorizationPrincipal } from '@/lib/auth/authorization';
import { getMcpServerConfig } from '@/lib/orchestration/mcp/config';

/** Refuse an override this caller may not set. `null` / absent (the server default) always passes. */
export async function assertKeyRateLimitAllowed(
  principal: AuthorizationPrincipal,
  override: number | null | undefined
): Promise<void> {
  if (override === null || override === undefined) return;
  if (await administersPlatform(principal)) return;
  const { globalRateLimit } = await getMcpServerConfig();
  if (override > globalRateLimit) {
    throw new ValidationError(
      `A key's rate limit can be lowered below the server's ${globalRateLimit} requests a minute, not raised above it.`,
      { rateLimitOverride: [`At most ${globalRateLimit}`] }
    );
  }
}
