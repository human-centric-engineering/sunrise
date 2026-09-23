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
 * - at `single`, to everyone — there is one org, so there is nothing to
 *   confine, and hiding them would empty the Logs page of exactly what an
 *   operator opens it for;
 * - at `multi`, only to a reader who is themselves outside an org, which today
 *   means a platform credential. An org admin never sees them.
 *
 * A platform operator therefore has **no** cross-org view through this page at
 * `multi`, which is the owner's ruling (2026-09-23) and §111's to supply.
 *
 * Tenancy posture: org-keyed — every entry carries the org it was produced in
 * and the query filters to the reader's (lib/tenancy/process-state.ts).
 */

import type { LogEntry } from '@/types/admin';
import { getTenantContext, isMultiTenant } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

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
 * the same rule and the logger needs to know nothing about tenancy. An
 * explicit `orgId` on the entry is honoured — a test, or a future caller
 * replaying a line, can say which org it belonged to.
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
    orgId: entry.orgId !== undefined ? entry.orgId : (getTenantContext()?.orgId ?? null),
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

  // Whose lines these are. At `single` the reader is always the install org,
  // including on a request that entered no scope — `requireTenantContext`'s
  // rule, spelled out here because throwing is wrong for a read: a platform
  // credential at `multi` has no org and must get an empty page, not a 500.
  const readerOrgId = isMultiTenant()
    ? (getTenantContext()?.orgId ?? null)
    : (getTenantContext()?.orgId ?? INSTALL_ORG_ID);

  // The scope filter comes first: `total` is what this reader can see, so the
  // pagination below counts their lines and not the process's.
  let filtered = logBuffer.filter((entry) => isVisibleTo(entry, readerOrgId));

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
function isVisibleTo(entry: LogEntry, readerOrgId: string | null): boolean {
  const entryOrgId = entry.orgId ?? null;
  if (entryOrgId === readerOrgId) return true;
  return entryOrgId === null && !isMultiTenant();
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
