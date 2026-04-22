'use client';

/**
 * VersionHistoryPanel
 *
 * Timeline of workflow definition versions with expandable diffs.
 * Reads from the `workflowDefinitionHistory` JSON array on the workflow.
 */

import * as React from 'react';
import { ChevronDown, ChevronRight, History, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { VersionDiffViewer } from '@/components/admin/orchestration/workflows/version-diff-viewer';

interface HistoryEntry {
  definition: Record<string, unknown>;
  changedAt: string;
  changedBy: string;
}

interface VersionHistoryPanelProps {
  history: HistoryEntry[];
  currentDefinition: Record<string, unknown>;
  onRestore?: (definition: Record<string, unknown>) => void;
}

export function VersionHistoryPanel({
  history,
  currentDefinition,
  onRestore,
}: VersionHistoryPanelProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState<number | null>(null);

  if (history.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4" />
            Version History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            No version history yet. History is recorded each time the workflow definition is saved.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Show entries in reverse chronological order (newest first)
  const entries = [...history].reverse();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4" />
          Version History
          <FieldHelp title="Workflow version history">
            Each save snapshots the previous definition. Expand a version to see what changed, or
            restore it to roll back.
          </FieldHelp>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {entries.map((entry, idx) => {
          const isExpanded = expanded === idx;
          const versionNumber = history.length - idx;
          const date = new Date(entry.changedAt);
          // Compare this entry against the next (more recent) version, or current
          const newerDef = idx === 0 ? currentDefinition : entries[idx - 1].definition;

          return (
            <div key={`${entry.changedAt}-${idx}`} className="rounded-md border">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                onClick={() => setExpanded(isExpanded ? null : idx)}
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="font-medium">v{versionNumber}</span>
                <span className="text-muted-foreground text-xs">
                  {date.toLocaleDateString()} {date.toLocaleTimeString()}
                </span>
                <span className="text-muted-foreground ml-auto text-xs">{entry.changedBy}</span>
              </button>

              {isExpanded && (
                <div className="border-t px-3 py-2">
                  <VersionDiffViewer before={entry.definition} after={newerDef} />
                  {onRestore && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => onRestore(entry.definition)}
                    >
                      <RotateCcw className="mr-1 h-3 w-3" />
                      Restore this version
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
