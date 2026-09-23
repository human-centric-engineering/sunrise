/**
 * MCP Session Manager
 *
 * In-memory session tracking with TTL eviction and per-key limits.
 * Sessions are lost on restart — MCP clients re-initialize on
 * session-not-found, which is acceptable for v1.
 *
 * Platform-agnostic: no Next.js imports. Server-only, though, and now more
 * firmly so: the eviction timer is armed through `lib/tenancy/context.ts` (see
 * the constructor), so this module's graph reaches `lib/db/client.ts` and
 * therefore `pg`. Nothing client-side imports this tree — checked before adding
 * that import, because the same edge into `lib/admin/logs.ts` put `pg` in the
 * browser bundle one task ago, and only `npm run build` catches it (§108
 * t-714).
 */

import { randomUUID } from 'node:crypto';
import { logger } from '@/lib/logging';
import { getTenantContext, isMultiTenant, runDetached } from '@/lib/tenancy/context';
import {
  MCP_LATEST_PROTOCOL_VERSION,
  type McpLogLevel,
  type McpProtocolVersion,
  type McpSession,
  type JsonRpcNotification,
} from '@/types/mcp';

/** Callback registered by an SSE stream to receive server-to-client notifications */
export type NotificationSink = (notification: JsonRpcNotification) => void;

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const EVICTION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Max URIs a single session may subscribe to. */
export const MAX_SUBSCRIPTIONS_PER_SESSION = 50;

/**
 * A session for one request, under `MCP_SESSION_MODE=stateless`.
 *
 * Nothing stores it and nothing looks it up. It exists because the handlers all
 * take a session and read two things off it — `initialized` and
 * `protocolVersion` — and synthesising those is cheaper and clearer than
 * threading an optional session through every method.
 *
 * `initialized: true` because there is no handshake to remember: the client
 * never received an `Mcp-Session-Id`, so per the Streamable HTTP transport it
 * never sends one, and every request stands alone. Refusing them all as
 * un-initialised would fail every client that skips `initialize` — which under
 * MCP revision 2026-07-28 is every conforming client, since that revision
 * removes the handshake.
 *
 * `ephemeral: true` is what makes the difference honest downstream: the three
 * methods that need continuity refuse by name instead of accepting work that
 * would be dropped when the process moves on.
 */
export function createEphemeralSession(
  apiKeyId: string,
  protocolVersion: McpProtocolVersion
): McpSession {
  const now = Date.now();
  return {
    // Prefixed rather than a bare uuid so it is obvious in a log line that this
    // id was never registered anywhere and cannot be looked up.
    id: `stateless-${randomUUID()}`,
    apiKeyId,
    // Stamped like any other session even though nothing indexes this one, so
    // `orgId` is never the field a reader has to remember is sometimes absent.
    orgId: getTenantContext()?.orgId ?? null,
    initialized: true,
    protocolVersion,
    // The default. `logging/setLevel` refuses in this mode, so nothing can move it.
    logLevel: 'warning',
    createdAt: now,
    lastActivityAt: now,
    ephemeral: true,
  };
}

/**
 * Whose subscribers a per-URI `resources/updated` notification is for (§108 t-716).
 *
 * **Both answers are correct for different callers, which is why this is an
 * argument and not a default.** The same `sunrise://agents` URI is subscribed
 * to by every org's sessions, so "who is subscribed" does not decide "who
 * should be told":
 *
 * - `'this-org'` — the CONTENTS changed, and the contents are tenant-owned. An
 *   agent, a workflow or a knowledge document was mutated in one org, so only
 *   that org's subscribers should re-read. Telling another org its list changed
 *   when it did not is a false signal derived from someone else's activity.
 * - `'every-org'` — the DEFINITION changed, and definitions are global config.
 *   `McpExposedResource` is in `GLOBAL_CONFIG_MODELS`
 *   (`lib/tenancy/classification.ts`), so editing the row really does change
 *   every org's answer, and scoping it to the editing org would leave every
 *   other org holding a stale definition with nothing to tell them.
 *
 * A default would be wrong for half the callers either way, and wrong silently
 * — an absent notification looks exactly like nothing having happened.
 */
export type McpResourceAudience = 'this-org' | 'every-org';

export class McpSessionManager {
  private sessions = new Map<string, McpSession>();
  private sseListeners = new Map<string, NotificationSink>();
  /**
   * Per-session set of resource URIs the client wants update notifications for.
   * Cleared with the session on destroy / expiry, so a forgotten unsubscribe
   * never leaks beyond the session lifetime (1 h TTL).
   */
  private subscriptions = new Map<string, Set<string>>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Armed OUTSIDE whatever tenant scope constructed this manager (§108 t-715).
   *
   * The manager is a lazily constructed process singleton
   * (`lib/orchestration/mcp/singletons.ts`), so the first MCP request after
   * boot is what builds it — and that request runs inside `runAsOrg(auth.orgId)`.
   * An `AsyncLocalStorage` store is captured when `setInterval` is *called*, so
   * without `runDetached` the eviction timer would carry that one org for the
   * life of the process, and every "evicted expired sessions" line would be
   * attributed to it: at `multi`, org A reading a count of org B's evictions on
   * its own Logs page while B sees none of its own.
   *
   * **Under `MCP_SESSION_MODE=stateful` only**, because that is the only mode
   * with sessions to evict — `stateless` synthesises an ephemeral session per
   * request and indexes nothing, so the map stays empty, `evicted > 0` never
   * holds and the sweep logs nothing at all. It is the default, which is why
   * this is groundwork rather than a live mis-attribution. The reason to fix it
   * anyway is that the wrong stamp is a property of the arming, not of the
   * mode: it is already wrong in every `stateful` install, and it would become
   * wrong everywhere the day anything else is armed here.
   *
   * The eviction pass itself is genuinely process-wide — one in-memory map of
   * every org's sessions, keyed by ids unique across orgs — so no scope is the
   * honest one. It touches no database, which is why detaching is safe here and
   * would not be for a timer whose callback writes an org's rows.
   */
  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {
    this.evictionTimer = runDetached(() =>
      setInterval(() => this.evictExpired(), EVICTION_INTERVAL_MS)
    );
    // Allow process to exit even if this timer is still running
    if (this.evictionTimer.unref) {
      this.evictionTimer.unref();
    }
  }

  /**
   * Create a new session for the given API key.
   * Returns null if the key has reached its session limit.
   *
   * The session starts at the server's latest supported protocol version.
   * `initialize` replaces this with the negotiated version once the client
   * declares which spec revision it speaks.
   */
  createSession(apiKeyId: string, maxSessionsPerKey: number): McpSession | null {
    const activeCount = this.getActiveSessionCount(apiKeyId);
    if (activeCount >= maxSessionsPerKey) {
      logger.warn('MCP session: max sessions exceeded', {
        apiKeyId,
        activeCount,
        maxSessionsPerKey,
      });
      return null;
    }

    const now = Date.now();
    const session: McpSession = {
      id: randomUUID(),
      apiKeyId,
      // The call stack's own org, never a caller's word for it — the same rule
      // `addLogEntry` follows (§108 t-714). An argument here would be a
      // mislabel primitive: code in org A minting a session onto org B's page.
      orgId: getTenantContext()?.orgId ?? null,
      initialized: false,
      protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
      // Default to 'warning' so clients that never call logging/setLevel
      // don't get flooded with info/debug noise.
      logLevel: 'warning',
      createdAt: now,
      lastActivityAt: now,
    };

    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Record the protocol version negotiated during `initialize`. Called from
   * the protocol handler once it has run `negotiateMcpProtocolVersion`.
   */
  setProtocolVersion(sessionId: string, version: McpProtocolVersion): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.protocolVersion = version;
      session.lastActivityAt = Date.now();
    }
  }

  /**
   * Update the minimum log level the client wants pushed via
   * `notifications/message`. Called from `logging/setLevel`.
   */
  setLogLevel(sessionId: string, level: McpLogLevel): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.logLevel = level;
      session.lastActivityAt = Date.now();
    }
  }

  /**
   * Deliberately NOT org-filtered (§108 t-716). The transport is the only
   * caller and it refuses a session whose `apiKeyId` is not the authenticated
   * key's at all three places it accepts an `Mcp-Session-Id` —
   * `app/api/v1/mcp/route.ts` POST, DELETE and GET — which is strictly stronger
   * than an org filter, since a key belongs to one org. Adding one here would
   * guard a state the callers cannot reach, which reads as safety and is not.
   *
   * GET was the third only from t-716: it attaches the SSE sink and was passing
   * the header through unchecked, which is why the count in this sentence is
   * worth keeping right.
   */
  getSession(sessionId: string): McpSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (Date.now() - session.lastActivityAt > this.ttlMs) {
      this.forget(sessionId);
      return null;
    }

    session.lastActivityAt = Date.now();
    return session;
  }

  /**
   * The session, without refreshing its activity — for a lookup whose answer may
   * be "refuse" (§108 t-716).
   *
   * {@link getSession} bumps `lastActivityAt` as a side effect of being asked,
   * which is right for the request path and wrong for an ownership check: the
   * bump lands *before* the caller compares `apiKeyId`, so polling GET or DELETE
   * with someone else's session id kept that session from ever expiring. At
   * `multi` that is one org holding another org's session open. Expired sessions
   * answer `null` here and are torn down, same as `getSession`.
   */
  peekSession(sessionId: string): McpSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (Date.now() - session.lastActivityAt > this.ttlMs) {
      this.forget(sessionId);
      return null;
    }
    return session;
  }

  /**
   * Drop every trace of a session: the row, its subscriptions, and its SSE sink.
   *
   * **One function because three paths forget a session and all three have to
   * forget the same things** (§108 t-716). `destroySession`, `evictExpired` and
   * `getSession`'s lazy TTL check each used to delete their own subset, and
   * `getSession` deleted only from `sessions` — which is the worst place to be
   * incomplete, because `evictExpired` iterates `sessions`, so once the lazy path
   * had removed the row the sweep could never reach that id again. The sink was
   * then orphaned for the life of the TCP connection and went on receiving every
   * unscoped `list_changed` ping, which is the "sink outlives the address"
   * defect this task closes, surviving on the one path nobody looked at. The
   * class docblock's claim that subscriptions are "cleared with the session on
   * destroy / expiry" was untrue for the same reason.
   */
  private forget(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.subscriptions.delete(sessionId);
    this.sseListeners.delete(sessionId);
  }

  markInitialized(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.initialized = true;
      session.lastActivityAt = Date.now();
    }
  }

  /**
   * Terminate a session. Returns `false` for an unknown id **and for a session
   * belonging to another org** (§108 t-716), which the admin route turns into
   * its ordinary `NotFoundError` — so the two are indistinguishable to the
   * caller and an org cannot probe for another's session ids.
   */
  destroySession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !this.isVisible(session)) return false;
    // `forget`, not three deletes: the push channel goes with the session, or a
    // force-terminated client's open GET stream keeps receiving every
    // `list_changed` ping for as long as it stays connected. `sseListeners` is
    // what `broadcastNotification`
    // enumerates (§108 t-716) — the "sink outlives the address" case the GET
    // ownership check exists to prevent.
    //
    // **It stops the pushes; it does not close the connection.** Nothing aborts
    // the generator in `app/api/v1/mcp/route.ts`, which stays parked on its
    // queue until the client disconnects, so a terminated client sees an open
    // stream that has gone quiet rather than a close that would make it
    // re-`initialize`. Tearing the stream down needs a per-session abort hook or
    // a terminal frame, which is the same question as idea #6 (what a stateful
    // session's liveness means) and is recorded there rather than half-built.
    this.forget(sessionId);
    return true;
  }

  /**
   * Not org-filtered, and correct without it (§108 t-716): an MCP key belongs
   * to one org, so counting one key's sessions cannot cross orgs whatever
   * scope asks. Filtering by the caller's org as well would change nothing
   * except to make `maxSessionsPerKey` silently unenforceable from a scope
   * that is not the key's.
   */
  getActiveSessionCount(apiKeyId: string): number {
    const now = Date.now();
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.apiKeyId === apiKeyId && now - session.lastActivityAt <= this.ttlMs) {
        count++;
      }
    }
    return count;
  }

  /**
   * Every live session the CALLING scope may see — its own org's at `multi`,
   * all of them at `single` (§108 t-716).
   *
   * Two callers, and the filter is what each one needed: the admin sessions
   * route served this array verbatim, so an org admin read every other org's
   * session ids, `apiKeyId`s and activity times; and `lib/.../log-emitter.ts`
   * builds its notification targets from it, so an MCP log line raised in one
   * org would be pushed to every org's open SSE stream. The second was reachable
   * only by a fork: `emitMcpLog` has no caller in the platform, and it is a
   * documented server-side API, so the fix is real but the leak was latent.
   */
  getActiveSessions(): McpSession[] {
    const now = Date.now();
    const active: McpSession[] = [];
    for (const session of this.sessions.values()) {
      if (now - session.lastActivityAt <= this.ttlMs && this.isVisible(session)) {
        active.push(session);
      }
    }
    return active;
  }

  /**
   * May the calling scope see this session?
   *
   * At `single` everything is visible — the same gate as the admin log buffer
   * (§108 t-714) and the per-org retention windows (t-713): the per-org rule
   * applies where something confines it. It is not merely a shortcut there: the
   * org API creates orgs in both modes, so a single-mode install can hold a
   * second org whose key mints sessions stamped with it, and narrowing to the
   * install org would hide them from a page that has always shown them.
   *
   * **A platform credential sees nothing here at `multi`, and that is the
   * owner's standing ruling rather than an oversight.** An admin API key with no
   * org runs unscoped in both modes, so its context has no org and this compares
   * `null` against a stamp that production always sets — an empty list, and a 404
   * from the terminate route. It is the identical trade the owner ruled on for
   * the admin Logs page (2026-09-23, t-714): scope to the reading org and accept
   * that an operator loses the cross-org view until §111 supplies the operator
   * role, because `multi` is not used until the phase is complete. The loss is
   * total here rather than partial — the Logs page at least still shows a
   * platform key the unstamped lines — so §111 owns restoring both.
   */
  private isVisible(session: McpSession): boolean {
    if (!isMultiTenant()) return true;
    return (session.orgId ?? null) === (getTenantContext()?.orgId ?? null);
  }

  private evictExpired(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > this.ttlMs) {
        // `forget` rather than `destroySession`, which would apply the org
        // filter — the sweep runs detached (§108 t-715) and is meant to reach
        // every org's expired sessions.
        this.forget(id);
        evicted++;
      }
    }
    if (evicted > 0) {
      logger.info('MCP session: evicted expired sessions', { evicted });
    }
  }

  // ---------------------------------------------------------------------------
  // Resource subscriptions (MCP 2025-06-18)
  // ---------------------------------------------------------------------------

  /**
   * Subscribe a session to update notifications for a concrete resource URI.
   *
   * Returns:
   *  - `'ok'` for fresh or duplicate subscribes (idempotent per spec).
   *  - `'session-not-found'` if the session is unknown or expired.
   *  - `'limit-exceeded'` if the session is already at MAX_SUBSCRIPTIONS_PER_SESSION.
   */
  subscribe(sessionId: string, uri: string): 'ok' | 'session-not-found' | 'limit-exceeded' {
    if (!this.getSession(sessionId)) return 'session-not-found';
    let set = this.subscriptions.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscriptions.set(sessionId, set);
    }
    if (set.has(uri)) return 'ok';
    if (set.size >= MAX_SUBSCRIPTIONS_PER_SESSION) return 'limit-exceeded';
    set.add(uri);
    return 'ok';
  }

  /** Unsubscribe is always a no-op success — duplicates are tolerated. */
  unsubscribe(sessionId: string, uri: string): 'ok' | 'session-not-found' {
    if (!this.getSession(sessionId)) return 'session-not-found';
    this.subscriptions.get(sessionId)?.delete(uri);
    return 'ok';
  }

  /**
   * The session ids subscribed to a URI (active sessions only), narrowed to the
   * given {@link McpResourceAudience} — see that type for why the caller has to
   * say which, rather than this defaulting (§108 t-716).
   *
   * `'this-org'` is the calling scope's org at `multi` and everything at
   * `single`; `'every-org'` is every subscriber in the process, which is right
   * when what changed was global config.
   */
  getSubscribers(uri: string, audience: McpResourceAudience): string[] {
    // `'this-org'` asked from a scope with no org matches nothing, because
    // production stamps every session. Today that is unreachable and the reason
    // is not obvious, so it is logged rather than left silent: a platform
    // credential runs unscoped in both modes, but every caller of `'this-org'`
    // fires after a TENANT-OWNED write, and at `multi` the data layer refuses
    // such a write with no org before any SQL — so the route 500s and never
    // reaches the notify. What this line exists for is the day someone attaches
    // a `'this-org'` notification to a global-config write, where the platform
    // credential CAN succeed: the fan-out would then reach nobody, and "nobody
    // was told" is indistinguishable from "nothing changed" (§108 t-716).
    if (audience === 'this-org' && isMultiTenant() && !getTenantContext()?.orgId) {
      logger.warn('MCP resource fan-out asked for this-org from a scope with no org', { uri });
      return [];
    }

    const out: string[] = [];
    for (const [sessionId, set] of this.subscriptions) {
      if (!set.has(uri)) continue;
      // `this.sessions.get` rather than `getSession`, because `getSession` is
      // unfiltered by design and also refreshes `lastActivityAt` — a fan-out
      // must not keep a session alive by being interested in it, or one org's
      // `'every-org'` edit silently extends every other org's sessions.
      //
      // **The cost, stated rather than discovered:** a client that subscribes
      // and then only LISTENS used to be kept alive by that refresh and now
      // expires at the TTL like any other idle session. When the sweep reaches
      // it, `evictExpired` drops its sink too, so the stream then delivers
      // NOTHING — not `resources/updated`, not the unscoped `list_changed`
      // pings, nothing — while the SSE keepalive holds the connection open and
      // healthy-looking. The client finds out on its next POST, which is a 404.
      // The real answer is for an open SSE stream to refresh its own session;
      // that is a behaviour change with its own consequences (a stream could
      // then hold a session for ever, which interacts with maxSessionsPerKey and
      // with the point of a TTL), so it is Hub idea #6 rather than smuggled in
      // here. Asked directly at review round 3 whether that is the intended
      // trade: yes. Keeping the refresh is worse than the regression, because it
      // makes one org's `'every-org'` edit silently extend every other org's
      // sessions, and a liveness rule that depends on who else is editing is not
      // a rule. What round 3 did add is the half that WAS cheap — a stream that
      // could not attach now closes instead of parking (see
      // {@link registerSseListener}).
      const session = this.sessions.get(sessionId);
      if (!session || Date.now() - session.lastActivityAt > this.ttlMs) continue;
      if (audience === 'this-org' && !this.isVisible(session)) continue;
      out.push(sessionId);
    }
    return out;
  }

  /** Test/inspection helper — current subscription count for a session. */
  getSubscriptionCount(sessionId: string): number {
    return this.subscriptions.get(sessionId)?.size ?? 0;
  }

  /**
   * Register an SSE notification sink for a session.
   * Called when a client opens a GET /api/v1/mcp SSE stream.
   *
   * **Refuses an id with no live session, which closes a window the route's own
   * check cannot** (§108 t-716). `handleGet` verifies ownership and then returns
   * a `Response`; the generator that gets here runs later, when the platform
   * pulls the body. A session destroyed in between — an admin terminate, the
   * eviction sweep — would otherwise leave a sink registered for a session that
   * no longer exists, and `broadcastNotification` with no targets enumerates
   * `sseListeners` rather than `sessions`, so that zombie would receive every
   * `list_changed` ping for the life of the connection. Precisely the "the sink
   * outlives the address" case the GET check exists to prevent.
   *
   * Existence only, deliberately **not** {@link isVisible}: by the time the
   * generator runs, the request's `runAsOrg` scope has been left, so there is no
   * org to compare against. Ownership was established before the stream opened;
   * this re-checks only that there is still something to attach to.
   *
   * **Returns whether it attached**, so the caller can close the stream instead
   * of holding one open that can never deliver. A refusal that only logged left
   * the client with an established, keepalive-healthy event stream whose
   * notification channel was silently unwired — it would find out on its next
   * POST, which is a 404.
   */
  registerSseListener(sessionId: string, sink: NotificationSink): boolean {
    const session = this.peekSession(sessionId);
    if (!session) {
      logger.debug('MCP SSE: no live session to attach a listener to', { sessionId });
      return false;
    }
    this.sseListeners.set(sessionId, sink);
    return true;
  }

  /**
   * Unregister an SSE notification sink (on client disconnect).
   */
  unregisterSseListener(sessionId: string): void {
    this.sseListeners.delete(sessionId);
  }

  /**
   * Push a notification to SSE clients. Fire-and-forget — errors in
   * individual sinks are logged and swallowed.
   *
   * `targetSessionIds`:
   *  - `undefined` (default): broadcast to every connected session.
   *  - An array: deliver only to those sessions that are still connected.
   *    Used by per-session features (progress updates, targeted resource
   *    update fan-out) so notifications don't leak across sessions.
   *
   * **This is deliberately not org-filtered (§108 t-716), and that needs
   * saying because it is the one fan-out here that is not.** Every caller is
   * already in one of two correct positions: the three `list_changed` helpers
   * in `lib/orchestration/mcp/index.ts` announce a change to `McpExposedTool`,
   * `McpExposedPrompt`, `McpExposedResource` — or `AiCapability`, which
   * `broadcastMcpToolsChanged` also fires for, from the capabilities routes —
   * and all four are `GLOBAL_CONFIG_MODELS`, so every org's answer really did
   * change and an
   * org filter here would leave every org but one holding a stale list; and
   * every other caller passes ids it already chose under a scope, from
   * `getSubscribers(uri, audience)`, from the org-filtered
   * {@link getActiveSessions}, or from its own session.
   *
   * So the rule for a new caller is: **decide the audience where you know what
   * changed**, not here. If a fourth caller ever wants "this org, no URI", add
   * an explicit arm rather than making `undefined` mean it — an unfiltered
   * default is right for today's callers and silently wrong for that one.
   */
  broadcastNotification(
    notification: JsonRpcNotification,
    targetSessionIds?: readonly string[]
  ): void {
    const recipients =
      targetSessionIds === undefined
        ? Array.from(this.sseListeners.keys())
        : targetSessionIds.filter((id) => this.sseListeners.has(id));
    for (const sessionId of recipients) {
      const sink = this.sseListeners.get(sessionId);
      if (!sink) continue;
      try {
        sink(notification);
      } catch (err) {
        logger.warn('MCP SSE: failed to send notification', {
          sessionId,
          method: notification.method,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** For testing and shutdown */
  destroy(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    this.sessions.clear();
    this.sseListeners.clear();
    this.subscriptions.clear();
  }
}
