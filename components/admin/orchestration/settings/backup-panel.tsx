'use client';

/**
 * BackupPanel
 *
 * Export/import orchestration configuration. Export downloads a JSON file;
 * import accepts a JSON file via drop zone or file picker.
 */

import * as React from 'react';
import { useState, useCallback, useRef } from 'react';
import { Download, Upload, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { apiClient, APIClientError } from '@/lib/api/client';

interface ImportResult {
  agents: { created: number; updated: number };
  capabilities: { created: number; updated: number };
  workflows: { created: number; updated: number };
  webhooks: { created: number; skipped: number };
  settingsUpdated: boolean;
  warnings: string[];
}

export function BackupPanel() {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/admin/orchestration/backup/export', {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(`Export failed: ${res.status}`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition');
      const match = disposition?.match(/filename="(.+)"/);
      const filename = match?.[1] ?? 'orchestration-backup.json';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }, []);

  const handleImportFile = useCallback(async (file: File) => {
    setImporting(true);
    setError(null);
    setImportResult(null);

    try {
      const text = await file.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        setError('File is not valid JSON');
        setImporting(false);
        return;
      }

      const result = await apiClient.post<ImportResult>(
        '/api/v1/admin/orchestration/backup/import',
        { body: json }
      );
      setImportResult(result);
    } catch (err) {
      if (err instanceof APIClientError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Import failed');
      }
    } finally {
      setImporting(false);
    }
  }, []);

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleImportFile(file);
      if (e.target) e.target.value = '';
    },
    [handleImportFile]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) void handleImportFile(file);
    },
    [handleImportFile]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Backup & Restore
          <FieldHelp title="Backup & Restore" contentClassName="w-80">
            <p>
              Export your orchestration configuration (agents, capabilities, workflows, webhooks,
              settings) as a JSON file. Import a backup to restore or replicate configuration across
              environments.
            </p>
            <p className="mt-2 text-xs">
              <strong>Note:</strong> Webhook secrets are never exported. After importing, you must
              set webhook secrets manually.
            </p>
          </FieldHelp>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Export */}
        <div>
          <h4 className="mb-2 text-sm font-medium">Export Configuration</h4>
          <Button
            onClick={() => void handleExport()}
            disabled={exporting}
            variant="outline"
            className="gap-2"
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {exporting ? 'Exporting…' : 'Download Backup'}
          </Button>
        </div>

        {/* Import */}
        <div>
          <h4 className="mb-2 text-sm font-medium">Import Configuration</h4>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors ${
              dragOver
                ? 'border-primary bg-primary/5'
                : 'border-muted-foreground/25 hover:border-muted-foreground/50'
            }`}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
            }}
          >
            {importing ? (
              <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
            ) : (
              <Upload className="text-muted-foreground h-8 w-8" />
            )}
            <p className="text-muted-foreground mt-2 text-sm">
              {importing ? 'Importing…' : 'Drop a backup JSON file here, or click to browse'}
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={onFileChange}
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Import Result */}
        {importResult && (
          <div className="space-y-2 rounded-md bg-green-50 p-3 text-sm dark:bg-green-950/30">
            <div className="flex items-center gap-2 font-medium text-green-700 dark:text-green-400">
              <CheckCircle2 className="h-4 w-4" />
              Import successful
            </div>
            <ul className="text-muted-foreground space-y-1 text-xs">
              <li>
                Agents: {importResult.agents.created} created, {importResult.agents.updated} updated
              </li>
              <li>
                Capabilities: {importResult.capabilities.created} created,{' '}
                {importResult.capabilities.updated} updated
              </li>
              <li>
                Workflows: {importResult.workflows.created} created,{' '}
                {importResult.workflows.updated} updated
              </li>
              <li>
                Webhooks: {importResult.webhooks.created} created, {importResult.webhooks.skipped}{' '}
                skipped (duplicates)
              </li>
              {importResult.settingsUpdated && <li>Settings updated</li>}
            </ul>
            {importResult.warnings.length > 0 && (
              <div className="mt-2 space-y-1">
                {importResult.warnings.map((w, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400"
                  >
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
