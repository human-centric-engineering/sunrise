'use client';

/**
 * Chain step editor — deliberately minimal in Session 5.1b.
 *
 * The Chain pattern's sub-step list is best edited visually (add / reorder
 * / remove mini-steps), which is a meaningful amount of UI surface. That
 * editor lands in Session 5.1c. For now the panel explains the situation
 * and the user can still drop chain nodes onto the canvas for layout.
 */

import type { EditorProps } from './index';

export interface ChainConfig extends Record<string, unknown> {
  steps?: unknown[];
}

export function ChainEditor(_props: EditorProps<ChainConfig>) {
  return (
    <div className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-xs leading-relaxed">
      The chain sub-step editor arrives in <strong>Session 5.1c</strong>. You can still drop Chain
      blocks onto the canvas to sketch the shape of a workflow — each one executes as a placeholder
      until its sub-steps are configured.
    </div>
  );
}
