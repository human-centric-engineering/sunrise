/**
 * Admin Log Buffer (Phase 4.4)
 *
 * In-memory ring buffer for storing recent log entries.
 * Used by the admin logs viewer to display application logs.
 *
 * Note: This is an in-memory buffer that resets on server restart.
 * For production use, consider integrating with a log aggregation
 * service (DataDog, CloudWatch, etc.).
 *
 * ## Whose lines a reader sees (§108 t-714)
 *
 * The buffer stays process-wide — one ring, every org's lines in it — and the
 * *query* is what is scoped. Each entry is stamped with the org its call stack
 * ran in, and {@link getLogEntries} returns only the reading org's.
 *
 * **`null` is not "everyone's", and it is not nothing either.** An entry is
 * unstamped when it was produced outside any tenant scope: at boot, inside a
 * `runAsSystem` job, or on a request authenticated by a **platform
 * credential** — an admin API key with no org, which `inTenantScope` in
 * `lib/auth/guards.ts` deliberately runs unscoped in *both* modes, and which
 * is how a cron calls the maintenance tick. Those lines are visible:
 *
 * - at `single`, to everyone — as is every other line there. The scope rule
 *   applies at `multi` only, which is where something confines it: hiding
 *   anything at `single` would empty the Logs page of what an operator opens
 *   it for while protecting nothing, since there is one org;
 * - at `multi`, only to a reader who is themselves outside an org — which in
 *   practice means a platform-admin API key and NOT a browser, because
 *   `enterSessionOrg` refuses a session with no active org at `multi`. So a
 *   failing maintenance tick leaves `/admin/logs` empty of any trace of it for
 *   every human looking at the page.
 *
 * So at `multi` a platform operator has **no** cross-org view through this
 * page, and no view of the unstamped lines either except by API key. That is
 * the owner's ruling (2026-09-23) — `multi` is not used until the phase is
 * complete — and §111's to supply, not an accident.
 *
 * ## Why the tenancy arrives through a registration and not an import
 *
 * This module must keep **no runtime imports**, and that is a load-bearing
 * property rather than a style: `lib/logging/index.ts` reaches it with a
 * literal `require('@/lib/admin/logs')`, and the logger is imported by fifteen
 * or more `'use client'` modules. A static edge from here to
 * `lib/tenancy/context.ts` therefore puts everything that module imports —
 * `lib/db/client.ts`, and through it `pg` — into the **browser** bundle.
 * Importing it directly was the first version of this change, and
 * `npm run build` fails with seven unresolved Node builtins, naming exactly
 * that chain. Neither `type-check`, `lint` nor the Vitest run can see it; the
 * guard that can is in `tests/unit/lib/admin/logs.tenancy.test.ts`.
 *
 * So the dependency is inverted: `lib/tenancy/context.ts` — which is
 * server-only and already imports the logger — registers a resolver here at
 * its module scope. The resolver is module-local, **not** on `globalThis`,
 * because an `AsyncLocalStorage` belongs to the module instance that created
 * it; sharing one across bundles would read another realm's store.
 *
 * Tenancy posture: org-keyed — every entry carries the org it was produced in
 * and the query filters to the reader's (lib/tenancy/process-state.ts).
 */

import type { LogEntry } from '@/types/admin';

/**
 * What this module needs to know about tenancy, and nothing more.
 *
 * `orgId` is the org of the current call stack (`null` outside any scope);
 * `multi` is whether the install runs more than one org.
 */
export interface LogTenancy {
  orgId: () => string | null;
  multi: () => boolean;
}

let tenancy: LogTenancy | null = null;

/**
 * Teach the buffer whose call stack it is running in. Called by
 * `lib/tenancy/context.ts` at its module scope, so any realm that can enter an
 * org can also stamp and filter.
 *
 * **Unregistered means `multi`**, which is the confining answer, and it took
 * two review rounds to land on it. The first version read "no resolver" as
 * "single-tenant, show everything", justified by "a realm without the tenancy
 * module is a realm where nothing entered an org" — wrong, because under
 * `NODE_ENV !== 'production'` the ring is shared across module instances
 * through `globalThis`, so an unregistered realm can hold fully stamped
 * entries another realm wrote. The second read the mode from
 * `process.env.TENANCY_MODE` instead, which moved the fail-open rather than
 * removing it: two readers of one variable, and any divergence answers
 * "single" and shows every org's lines.
 *
 * So there is **one** reader of the mode, the same `isMultiTenant()`
 * everything else uses, reached through this registration — and no resolver
 * means the strict answer. The cost is that a realm which never loaded the
 * tenancy module hides stamped entries it holds; that is `next dev` only
 * (production gives each realm its own ring), it is not a leak, and the
 * reading path — the admin logs route, whose guard imports the tenancy module
 * — always has a resolver.
 *
 * **The writer side has the same realm split**: a realm that stamps without a
 * resolver writes `null` onto lines produced inside a real org scope, so in
 * `next dev` at `multi` they vanish from their own org's page. Also not a
 * leak, and also only reachable where the buffer is shared.
 *
 * **A timer is stamped where it was armed, not where it fires.** An
 * `AsyncLocalStorage` propagates into `setInterval`, so a timer that outlives
 * the request which armed it would attribute every line it writes to that one
 * org — for the life of the process, where the holder is a lazily constructed
 * singleton. Those timers are armed through `runDetached`
 * (`lib/tenancy/context.ts`, §108 t-715), so their lines are unstamped and read
 * like any other line produced outside a scope. A timer whose lifetime *is* its
 * unit of work keeps the org it was armed in, which for it is the right answer.
 */
export function registerLogTenancy(bridge: LogTenancy | null): void {
  tenancy = bridge;
}

/**
 * Maximum number of log entries to keep in memory
 */
const MAX_BUFFER_SIZE = 1000;

/**
 * Ring buffer for log entries
 *
 * Uses a global to persist across hot reloads in development.
 */
const globalForLogs = globalThis as unknown as {
  logBuffer: LogEntry[] | undefined;
  logIdCounter: number | undefined;
};

const logBuffer: LogEntry[] = globalForLogs.logBuffer ?? [];

// Persist the buffer in development so it survives hot reloads.
if (process.env.NODE_ENV !== 'production') {
  globalForLogs.logBuffer = logBuffer;
}

/**
 * Add a log entry to the buffer
 *
 * If the buffer is full, the oldest entry is removed.
 *
 * The org is read here rather than passed in, so every producer is stamped by
 * the same rule, the logger needs to know nothing about tenancy, and no caller
 * can label a line with an org it is not running in.
 *
 * @param entry - Log entry (without id)
 */
export function addLogEntry(entry: Omit<LogEntry, 'id'> & { id?: string }): void {
  // Keep the counter on the global (by reference) rather than a module-local
  // copy. The buffer is shared across module instances via globalThis, and
  // Next.js evaluates this module more than once per process (e.g. the page RSC
  // bundle and the route-handler bundle). A module-local counter would diverge
  // between instances and emit colliding ids into the one shared buffer.
  const nextId = (globalForLogs.logIdCounter ?? 0) + 1;
  globalForLogs.logIdCounter = nextId;
  const id = entry.id ?? `log_${nextId}`;

  const logEntry: LogEntry = {
    ...entry,
    // Always the call stack's own org, never the caller's word for it. An
    // "honour an explicit orgId" branch stood here for one commit: it had no
    // production caller — the logger's payload type does not carry the field —
    // and what it actually provided was a way for code running in one org to
    // write a line onto another org's Logs page.
    orgId: tenancy?.orgId() ?? null,
    id,
  };

  logBuffer.push(logEntry);

  // Remove oldest entries if buffer is full
  while (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.shift();
  }
}

/**
 * Get log entries with optional filtering and pagination
 *
 * @param options - Filter and pagination options
 * @returns Filtered and paginated log entries with total count
 */
export function getLogEntries(options: {
  level?: 'debug' | 'info' | 'warn' | 'error';
  search?: string;
  page?: number;
  limit?: number;
}): { entries: LogEntry[]; total: number } {
  const { level, search, page = 1, limit = 50 } = options;

  // Whose lines these are. The resolver answers `null` rather than throwing —
  // a platform credential at `multi` enters no org and must get an empty page,
  // not a 500.
  const readerOrgId = tenancy?.orgId() ?? null;
  // Resolved once, not per entry: `isVisibleTo` runs for every line in the
  // ring, and a thousand calls through the registration to answer one question
  // is a thousand answers that cannot differ.
  const multi = tenancy?.multi() ?? true;

  // The scope filter comes first: `total` is what this reader can see, so the
  // pagination below counts their lines and not the process's.
  let filtered = logBuffer.filter((entry) => isVisibleTo(entry, readerOrgId, multi));

  if (level) {
    filtered = filtered.filter((entry) => entry.level === level);
  }

  if (search) {
    const searchLower = search.toLowerCase();
    filtered = filtered.filter(
      (entry) =>
        entry.message.toLowerCase().includes(searchLower) ||
        JSON.stringify(entry.context ?? {})
          .toLowerCase()
          .includes(searchLower) ||
        JSON.stringify(entry.meta ?? {})
          .toLowerCase()
          .includes(searchLower)
    );
  }

  // Sort by timestamp descending (newest first)
  filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const total = filtered.length;

  // Paginate
  const start = (page - 1) * limit;
  const entries = filtered.slice(start, start + limit);

  return { entries, total };
}

/**
 * May this reader see this entry?
 *
 * Two arms, and the second is the one that keeps `single` behaving exactly as
 * it did. An unstamped entry — no tenant scope when it was produced — is
 * everyone's at `single`, where there is one org and nothing to confine, and
 * nobody's at `multi` except a reader who is also outside an org.
 */
function isVisibleTo(entry: LogEntry, readerOrgId: string | null, multi: boolean): boolean {
  // At `single` the page shows the process's lines, exactly as it always has.
  // The narrower rule below would have been *nearly* right there — the install
  // org reading its own lines plus the unstamped ones — and wrong in the one
  // case that matters: `forEachOrg` iterates every ACTIVE org in BOTH modes,
  // so a single-mode install holding a second org (which the org API allows)
  // stamps that org's job lines with it, and they would have vanished from the
  // page. Same gate as the per-org retention windows (§108 t-713): the
  // per-org behaviour applies where there is something to confine.
  if (!multi) return true;
  return (entry.orgId ?? null) === readerOrgId;
}

/**
 * Clear all log entries from the buffer
 *
 * Useful for testing or manual cleanup.
 */
export function clearLogBuffer(): void {
  logBuffer.length = 0;
  globalForLogs.logIdCounter = 0;
}

/**
 * Get the current buffer size — every entry in the process, whatever org
 * produced it. Deliberately unscoped: this is the ring's own occupancy, used
 * to reason about eviction, not a count of what anyone can read.
 *
 * @returns Number of entries in the buffer
 */
export function getBufferSize(): number {
  return logBuffer.length;
}

/**
 * Get the maximum buffer size
 *
 * @returns Maximum number of entries the buffer can hold
 */
export function getMaxBufferSize(): number {
  return MAX_BUFFER_SIZE;
}
