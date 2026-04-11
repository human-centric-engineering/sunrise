import type { Metadata } from 'next';

import { WorkflowBuilder } from '@/components/admin/orchestration/workflow-builder/workflow-builder';

export const metadata: Metadata = {
  title: 'New workflow · AI Orchestration',
  description: 'Design a new AI workflow from pattern blocks.',
};

/**
 * Admin — New workflow builder page (Phase 5 Session 5.1a).
 *
 * Renders an empty builder. Save / Validate / Execute wiring lands in
 * Session 5.1b; for now this page exists so admins can click "New
 * workflow" from the list and explore the palette + canvas.
 */
export default function NewWorkflowPage() {
  return <WorkflowBuilder mode="create" />;
}
