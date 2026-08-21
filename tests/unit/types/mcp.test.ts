/**
 * `negotiateMcpProtocolVersion` — the single rule for turning a client's
 * declared protocol version into one this server will act on.
 *
 * It has **two** callers that arrive by different routes: `handleInitialize`
 * reads `params.protocolVersion` from the handshake, and the stateless request
 * path reads the `MCP-Protocol-Version` header because there is no session
 * remembering a negotiation (#609). Both must reach the same answer, which is
 * why the rule lives here rather than at either call site — a reimplementation
 * beside it got the forward-dated case wrong and served the newest clients the
 * oldest semantics.
 */

import { describe, it, expect } from 'vitest';
import {
  negotiateMcpProtocolVersion,
  MCP_PROTOCOL_VERSIONS,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_DEFAULT_PROTOCOL_VERSION_FOR_MISSING,
} from '@/types/mcp';

describe('negotiateMcpProtocolVersion', () => {
  it('accepts every version the server actually supports, unchanged', () => {
    // Derived from the constant rather than hardcoded, so adding a revision
    // does not leave this asserting about a list that has moved on.
    for (const version of MCP_PROTOCOL_VERSIONS) {
      expect(negotiateMcpProtocolVersion(version)).toEqual({ version, wasDowngraded: false });
    }
  });

  it('treats a missing version as the OLDEST, not the newest', () => {
    // A client that omits it most likely predates version negotiation, so the
    // conservative read is the right one — it must not be opted into features
    // it never agreed to.
    expect(negotiateMcpProtocolVersion(undefined)).toEqual({
      version: MCP_DEFAULT_PROTOCOL_VERSION_FOR_MISSING,
      wasDowngraded: false,
    });
    expect(negotiateMcpProtocolVersion(null)).toEqual({
      version: MCP_DEFAULT_PROTOCOL_VERSION_FOR_MISSING,
      wasDowngraded: false,
    });
    expect(MCP_DEFAULT_PROTOCOL_VERSION_FOR_MISSING).toBe(
      MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1]
    );
  });

  it('DOWNGRADES a forward-dated version to our latest, flagged', () => {
    // The case that matters and the one easiest to get wrong. Such a client
    // understands strictly MORE than we do, so flooring it to the oldest would
    // mean the newer the client, the worse it is treated — and annotations are
    // gated on `>= 2025-06-18`.
    for (const future of ['2025-11-25', '2026-07-28', '9999-12-31']) {
      expect(negotiateMcpProtocolVersion(future)).toEqual({
        version: MCP_LATEST_PROTOCOL_VERSION,
        wasDowngraded: true,
      });
    }
  });

  it('rejects a date-shaped version that is older and unknown', () => {
    // Not evidence of a newer client, and not something we speak. `null` lets
    // the caller decide — `initialize` raises INVALID_PARAMS, the stateless path
    // falls back to the conservative default.
    expect(negotiateMcpProtocolVersion('1999-01-01')).toBeNull();
    expect(negotiateMcpProtocolVersion('2024-01-01')).toBeNull();
  });

  it('rejects anything that is not a version string at all', () => {
    expect(negotiateMcpProtocolVersion('banana')).toBeNull();
    expect(negotiateMcpProtocolVersion('')).toBeNull();
    expect(negotiateMcpProtocolVersion(2025)).toBeNull();
    expect(negotiateMcpProtocolVersion({})).toBeNull();
    expect(negotiateMcpProtocolVersion([])).toBeNull();
  });

  it('compares dates lexicographically, which the yyyy-mm-dd format makes safe', () => {
    // The forward-dated branch relies on string comparison. Pinned because a
    // format change (or a two-digit month slipping in) would break it silently.
    expect(MCP_LATEST_PROTOCOL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // One day newer than latest must downgrade, not reject.
    const [y, m, d] = MCP_LATEST_PROTOCOL_VERSION.split('-').map(Number);
    const nextDay = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    expect(negotiateMcpProtocolVersion(nextDay)?.wasDowngraded).toBe(true);
  });
});
