'use client';

/**
 * ExecutionInputDialog — one-field JSON input collector for kicking
 * off a workflow run.
 *
 * The engine accepts `Record<string, unknown>` as `inputData`. Rather
 * than generate a schema-aware form (inputs aren't typed per workflow
 * in 5.2), we render a single JSON textarea with parse-as-you-type
 * validation. A separate budget field collects the optional
 * `budgetLimitUsd` cap.
 */

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { API } from '@/lib/api/endpoints';
import { apiClient } from '@/lib/api/client';

interface DryRunResult {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}

export interface ExecutionInputDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: { inputData: Record<string, unknown>; budgetLimitUsd?: number }) => void;
  /** Workflow ID — required for dry-run validation. */
  workflowId: string;
}

export function ExecutionInputDialog({
  open,
  onOpenChange,
  onConfirm,
  workflowId,
}: ExecutionInputDialogProps) {
  const [raw, setRaw] = useState('{\n  "query": ""\n}');
  const [budget, setBudget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dryRunning, setDryRunning] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);

  function parseInput(): { inputData: Record<string, unknown>; budgetLimitUsd?: number } | null {
    let parsed: Record<string, unknown>;
    try {
      const result: unknown = JSON.parse(raw);
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        setError('Input must be a JSON object.');
        return null;
      }
      parsed = result as Record<string, unknown>;
    } catch {
      setError('Input is not valid JSON.');
      return null;
    }

    let budgetLimitUsd: number | undefined;
    if (budget.trim().length > 0) {
      const num = Number(budget);
      if (!Number.isFinite(num) || num <= 0) {
        setError('Budget must be a positive number.');
        return null;
      }
      budgetLimitUsd = num;
    }

    setError(null);
    return { inputData: parsed, budgetLimitUsd };
  }

  const handleRun = (): void => {
    const input = parseInput();
    if (input) onConfirm(input);
  };

  const handleDryRun = async (): Promise<void> => {
    const input = parseInput();
    if (!input) return;
    setDryRunning(true);
    setDryRunResult(null);
    try {
      const result = await apiClient.post<DryRunResult>(
        API.ADMIN.ORCHESTRATION.workflowDryRun(workflowId),
        { body: { inputData: input.inputData, budgetLimitUsd: input.budgetLimitUsd } }
      );
      setDryRunResult(result);
    } catch {
      setError('Dry-run request failed.');
    } finally {
      setDryRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Execute workflow</DialogTitle>
          <DialogDescription>
            Provide the input payload and (optionally) a dollar budget cap.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="execution-input-data" className="flex items-center">
              Input data (JSON object){' '}
              <FieldHelp title="Input data">
                A JSON object that becomes the <code>{'{{input}}'}</code> variable in prompt
                templates. Access nested keys with <code>{'{{input.key}}'}</code>. Max 256 KB.
              </FieldHelp>
            </Label>
            <Textarea
              id="execution-input-data"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={10}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="execution-budget" className="flex items-center">
              Budget cap (USD, optional){' '}
              <FieldHelp title="Budget cap">
                The workflow halts when cumulative LLM cost exceeds this amount. A warning fires at
                80% usage. Leave empty for no limit (max $1,000).
              </FieldHelp>
            </Label>
            <Input
              id="execution-budget"
              type="number"
              step="0.01"
              min="0"
              placeholder="e.g. 0.50"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          {dryRunResult && (
            <div
              className={`rounded-md border px-3 py-2 text-sm ${
                dryRunResult.valid
                  ? 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950'
                  : 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950'
              }`}
            >
              <div className="flex items-center gap-2 font-medium">
                {dryRunResult.valid ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <span className="text-green-700 dark:text-green-300">Dry run passed</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-4 w-4 text-red-600" />
                    <span className="text-red-700 dark:text-red-300">Dry run failed</span>
                  </>
                )}
              </div>
              {dryRunResult.errors && dryRunResult.errors.length > 0 && (
                <ul className="mt-1 list-inside list-disc text-xs text-red-600 dark:text-red-400">
                  {dryRunResult.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
              {dryRunResult.warnings && dryRunResult.warnings.length > 0 && (
                <ul className="mt-1 list-inside list-disc text-xs text-yellow-700 dark:text-yellow-400">
                  {dryRunResult.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => void handleDryRun()} disabled={dryRunning}>
            {dryRunning ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Validating…
              </>
            ) : (
              'Dry run'
            )}
          </Button>
          <Button onClick={handleRun}>Run</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
