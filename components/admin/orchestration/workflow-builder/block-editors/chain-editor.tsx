'use client';

/**
 * Chain step editor — placeholder panel.
 *
 * The Chain pattern's sub-step list is best edited visually (add / reorder
 * / remove mini-steps), which is a meaningful amount of UI surface. For now
 * the panel explains the situation and the user can still drop chain nodes
 * onto the canvas for layout.
 */

import { FieldHelp } from '@/components/ui/field-help';

import type { EditorProps } from '@/components/admin/orchestration/workflow-builder/block-editors/index';

export interface ChainConfig extends Record<string, unknown> {
  steps?: unknown[];
}

export function ChainEditor(_props: EditorProps<ChainConfig>) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 text-xs font-medium">
        Chain step{' '}
        <FieldHelp title="Chain steps">
          <p>
            A Chain step composes multiple sub-steps that run <strong>sequentially</strong> — each
            sub-step receives the output of the previous one, forming a pipeline.
          </p>
          <p>
            Visual sub-step configuration is planned for a future session. For now, you can drop
            Chain nodes onto the canvas to sketch your workflow layout.
          </p>
        </FieldHelp>
      </div>
      <div className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-xs leading-relaxed">
        Visual sub-step configuration is not yet available. You can still use Chain nodes on the
        canvas for layout sketching — each one acts as a sequential composition placeholder until
        its sub-steps are configured.
      </div>
    </div>
  );
}
