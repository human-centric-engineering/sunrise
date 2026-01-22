/**
 * Admin Log Buffer (Phase 4.4)
 *
 * In-memory ring buffer for storing recent log entries.
 * Used by the admin logs viewer to display application logs.
 *
 * Note: This is an in-memory buffer that resets on server restart.
 * For production use, consider integrating with a log aggregation
 * service (DataDog, CloudWatch, etc.).
 */

import type { LogEntry } from '@/types/admin';

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
let logIdCounter = globalForLogs.logIdCounter ?? 0;

// Persist in development
if (process.env.NODE_ENV !== 'production') {
  globalForLogs.logBuffer = logBuffer;
  globalForLogs.logIdCounter = logIdCounter;
}

/**
 * Add a log entry to the buffer
 *
 * If the buffer is full, the oldest entry is removed.
 *
 * @param entry - Log entry (without id)
 */
export function addLogEntry(entry: Omit<LogEntry, 'id'> & { id?: string }): void {
  const id = entry.id ?? `log_${++logIdCounter}`;

  // Update the counter in globals for dev persistence
  if (process.env.NODE_ENV !== 'production') {
    globalForLogs.logIdCounter = logIdCounter;
  }

  const logEntry: LogEntry = {
    ...entry,
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

  // Filter entries
  let filtered = [...logBuffer];

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
 * Clear all log entries from the buffer
 *
 * Useful for testing or manual cleanup.
 */
export function clearLogBuffer(): void {
  logBuffer.length = 0;
  logIdCounter = 0;

  if (process.env.NODE_ENV !== 'production') {
    globalForLogs.logIdCounter = 0;
  }
}

/**
 * Get the current buffer size
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
