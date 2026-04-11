'use client';

/**
 * Parallel step editor — timeout and straggler strategy.
 *
 * The branch list is implicit (defined by the outgoing edges on the
 * canvas); this editor only controls join semantics. Session 5.2 will
 * wire the actual concurrent executor — `timeoutMs` and
 * `stragglerStrategy` are currently accepted-and-ignored by the backend.
 */

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';

import type { EditorProps } from './index';

export interface ParallelConfig extends Record<string, unknown> {
  timeoutMs?: number;
  stragglerStrategy?: 'wait-all' | 'best-effort';
  branches?: unknown[];
}

export function ParallelEditor({ config, onChange }: EditorProps<ParallelConfig>) {
  const timeoutMs = config.timeoutMs ?? 60000;
  const strategy = config.stragglerStrategy ?? 'wait-all';

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="parallel-timeout" className="flex items-center text-xs">
          Timeout (ms){' '}
          <FieldHelp title="Branch timeout">
            How long each parallel branch has to finish before it counts as a straggler. Default:{' '}
            <code>60000</code> (60 seconds).
          </FieldHelp>
        </Label>
        <Input
          id="parallel-timeout"
          type="number"
          min={0}
          step={1000}
          value={timeoutMs}
          onChange={(e) => onChange({ timeoutMs: Number(e.target.value) })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="parallel-strategy" className="flex items-center text-xs">
          Straggler strategy{' '}
          <FieldHelp title="Straggler strategy">
            <strong>Wait for all</strong> blocks until every branch completes.{' '}
            <strong>Best effort</strong> joins as soon as the timeout fires and returns whatever is
            ready — missing branches yield <code>null</code>.
          </FieldHelp>
        </Label>
        <Select
          value={strategy}
          onValueChange={(value) =>
            onChange({ stragglerStrategy: value as 'wait-all' | 'best-effort' })
          }
        >
          <SelectTrigger id="parallel-strategy">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="wait-all">Wait for all branches</SelectItem>
            <SelectItem value="best-effort">Best effort (return partial)</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
