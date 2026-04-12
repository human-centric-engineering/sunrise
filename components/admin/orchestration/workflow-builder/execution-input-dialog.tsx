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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export interface ExecutionInputDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: { inputData: Record<string, unknown>; budgetLimitUsd?: number }) => void;
}

export function ExecutionInputDialog({ open, onOpenChange, onConfirm }: ExecutionInputDialogProps) {
  const [raw, setRaw] = useState('{\n  "query": ""\n}');
  const [budget, setBudget] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleRun = (): void => {
    let parsed: Record<string, unknown>;
    try {
      const result: unknown = JSON.parse(raw);
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        setError('Input must be a JSON object.');
        return;
      }
      parsed = result as Record<string, unknown>;
    } catch {
      setError('Input is not valid JSON.');
      return;
    }

    let budgetLimitUsd: number | undefined;
    if (budget.trim().length > 0) {
      const num = Number(budget);
      if (!Number.isFinite(num) || num <= 0) {
        setError('Budget must be a positive number.');
        return;
      }
      budgetLimitUsd = num;
    }

    setError(null);
    onConfirm({ inputData: parsed, budgetLimitUsd });
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
            <Label htmlFor="execution-input-data">Input data (JSON object)</Label>
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
            <Label htmlFor="execution-budget">Budget cap (USD, optional)</Label>
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleRun}>Run</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
