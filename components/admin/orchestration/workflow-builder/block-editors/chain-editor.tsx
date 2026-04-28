'use client';

/**
 * Chain step editor — placeholder panel.
 *
 * The Chain pattern's sub-step list is best edited visually (add / reorder
 * / remove mini-steps), which is a meaningful amount of UI surface. For now
 * the panel explains the situation and the user can still drop chain nodes
 * onto the canvas for layout.
 */

import type { EditorProps } from '@/components/admin/orchestration/workflow-builder/block-editors/index';

export interface ChainConfig extends Record<string, unknown> {
  steps?: unknown[];
}

export function ChainEditor(_props: EditorProps<ChainConfig>) {
  return (
    <div className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-xs leading-relaxed">
      Sub-step configuration for Chain blocks is not yet available in the visual editor. You can
      still drop Chain blocks onto the canvas to sketch workflow structure — each one executes as a
      placeholder until its sub-steps are configured.
    </div>
  );
}
