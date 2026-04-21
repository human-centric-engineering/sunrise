'use client';

/**
 * VersionDiffViewer
 *
 * Renders a recursive JSON diff between two workflow definition objects.
 * Shows added, removed, and changed fields with color coding.
 */

import * as React from 'react';

interface DiffEntry {
  path: string;
  type: 'added' | 'removed' | 'changed';
  oldValue?: unknown;
  newValue?: unknown;
}

function computeDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = ''
): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const bVal = before[key];
    const aVal = after[key];

    if (!(key in before)) {
      entries.push({ path, type: 'added', newValue: aVal });
    } else if (!(key in after)) {
      entries.push({ path, type: 'removed', oldValue: bVal });
    } else if (
      typeof bVal === 'object' &&
      typeof aVal === 'object' &&
      bVal !== null &&
      aVal !== null &&
      !Array.isArray(bVal) &&
      !Array.isArray(aVal)
    ) {
      entries.push(
        ...computeDiff(bVal as Record<string, unknown>, aVal as Record<string, unknown>, path)
      );
    } else if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
      entries.push({ path, type: 'changed', oldValue: bVal, newValue: aVal });
    }
  }

  return entries;
}

function formatValue(val: unknown): string {
  if (val === undefined || val === null) return 'null';
  if (typeof val === 'string') return val.length > 80 ? `${val.slice(0, 80)}...` : val;
  return JSON.stringify(val, null, 2).slice(0, 200);
}

interface VersionDiffViewerProps {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export function VersionDiffViewer({ before, after }: VersionDiffViewerProps): React.ReactElement {
  const entries = computeDiff(before, after);

  if (entries.length === 0) {
    return <p className="text-muted-foreground text-xs italic">No changes</p>;
  }

  return (
    <div className="space-y-1 font-mono text-xs">
      {entries.map((entry) => (
        <div key={entry.path} className="rounded px-2 py-0.5">
          {entry.type === 'added' && (
            <span className="text-emerald-600 dark:text-emerald-400">
              + {entry.path}: {formatValue(entry.newValue)}
            </span>
          )}
          {entry.type === 'removed' && (
            <span className="text-red-600 dark:text-red-400">
              - {entry.path}: {formatValue(entry.oldValue)}
            </span>
          )}
          {entry.type === 'changed' && (
            <div>
              <span className="text-red-600 dark:text-red-400">
                - {entry.path}: {formatValue(entry.oldValue)}
              </span>
              <br />
              <span className="text-emerald-600 dark:text-emerald-400">
                + {entry.path}: {formatValue(entry.newValue)}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
