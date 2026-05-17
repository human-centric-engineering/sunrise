/**
 * StructuredApprovalView Component Tests
 *
 * Test Coverage:
 * - Renders Approve and Reject buttons
 * - Header summary reflects total candidate count
 * - Empty-data state message renders when all sections have zero items
 * - Toggling one item to Reject decrements the accepted counter
 * - Toggling all items to Reject leaves "0 of N" and disables Approve
 * - Clicking "Approve selected" calls onRequestApprove with buildApprovalPayload output
 * - Clicking "Reject" calls onRequestReject
 * - submitting prop disables both buttons
 * - Section whose source fails renders SectionFallback with "fallback view" badge
 * - Successful section + failing section both render (no full abort)
 * - Nested section's sub-items count toward total candidate, not parent items
 *
 * NOTE: gatherSectionItems and buildApprovalPayload are NOT mocked — they are
 * pure functions with their own unit tests; letting them run for real verifies
 * that the component wires them correctly.
 *
 * @see components/admin/orchestration/approvals/structured-approval-view.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { StructuredApprovalView } from '@/components/admin/orchestration/approvals/structured-approval-view';
import type { ReviewSchema } from '@/lib/orchestration/review-schema/types';
import type { ExecutionTraceEntry } from '@/types/orchestration';

// ─── Trace helpers ─────────────────────────────────────────────────────────────

function traceEntry(overrides: Partial<ExecutionTraceEntry>): ExecutionTraceEntry {
  return {
    stepId: 'step1',
    stepType: 'agent_call',
    label: 'Step',
    status: 'completed',
    output: null,
    tokensUsed: 0,
    costUsd: 0,
    startedAt: '2026-05-05T00:00:00.000Z',
    completedAt: '2026-05-05T00:00:01.000Z',
    durationMs: 100,
    ...overrides,
  };
}

// ─── Schema + trace fixtures ───────────────────────────────────────────────────

/**
 * A flat section with `n` model items. Produces a trace entry with the step
 * id `discover_new_models` whose output is `{ newModels: [...] }`.
 */
function makeFlatFixture(n: number): { trace: ExecutionTraceEntry[]; schema: ReviewSchema } {
  const models = Array.from({ length: n }, (_, i) => ({
    slug: `model-${i}`,
    name: `Model ${i}`,
    providerSlug: 'openai',
  }));

  return {
    trace: [
      traceEntry({
        stepId: 'discover_new_models',
        output: { newModels: models },
      }),
    ],
    schema: {
      sections: [
        {
          id: 'newModels',
          title: 'New Models',
          source: '{{discover_new_models.output.newModels}}',
          itemKey: 'slug',
          itemTitle: '{{item.name}}',
          fields: [{ key: 'name', label: 'Name', display: 'text' }],
        },
      ],
    },
  };
}

/**
 * A nested-items fixture: one parent model with `subCount` sub-item changes.
 * Parent is keyed by `model_id`; sub-items by `field`.
 */
function makeNestedFixture(subCount: number): {
  trace: ExecutionTraceEntry[];
  schema: ReviewSchema;
} {
  const changes = Array.from({ length: subCount }, (_, i) => ({
    field: `field_${i}`,
    proposedValue: `value_${i}`,
  }));

  return {
    trace: [
      traceEntry({
        stepId: 'refine_models',
        output: {
          models: [
            {
              model_id: 'm1',
              modelName: 'Claude Sonnet',
              changes,
            },
          ],
        },
      }),
    ],
    schema: {
      sections: [
        {
          id: 'modelChanges',
          title: 'Model Changes',
          source: '{{refine_models.output.models}}',
          itemKey: 'model_id',
          itemTitle: '{{item.modelName}}',
          subItems: {
            source: 'item.changes',
            itemKey: 'field',
            fields: [
              { key: 'field', label: 'Field', display: 'text', readonly: true },
              { key: 'proposedValue', label: 'Proposed', display: 'text' },
            ],
          },
        },
      ],
    },
  };
}

/**
 * A schema whose source points to a step that does not exist in the trace.
 * This causes gatherSectionItems to return an error, triggering SectionFallback.
 */
function makeBrokenSectionFixture(): { trace: ExecutionTraceEntry[]; schema: ReviewSchema } {
  return {
    trace: [
      // The trace has no step named 'missing_step'
      traceEntry({ stepId: 'other_step', output: {} }),
    ],
    schema: {
      sections: [
        {
          id: 'brokenSection',
          title: 'Broken Section',
          source: '{{missing_step.output.items}}',
          itemKey: 'id',
          itemTitle: '{{item.id}}',
          fields: [{ key: 'id', label: 'ID', display: 'text' }],
        },
      ],
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('StructuredApprovalView', () => {
  describe('initial render', () => {
    it('renders Approve selected and Reject buttons', () => {
      const { trace, schema } = makeFlatFixture(1);

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt={null}
          onRequestApprove={vi.fn()}
          onRequestReject={vi.fn()}
        />
      );

      // "Approve selected" is unique — one button at the header level
      expect(screen.getByRole('button', { name: /approve selected/i })).toBeInTheDocument();
      // "Reject" appears in both the header and per item — assert at least one present
      const rejectButtons = screen.getAllByRole('button', { name: /reject/i });
      expect(rejectButtons.length).toBeGreaterThanOrEqual(1);
    });

    it('header summary shows "{N} of {N}" candidate changes for a flat section', () => {
      // 3 items → "3 of 3 changes will be applied on approve"
      const { trace, schema } = makeFlatFixture(3);

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt={null}
          onRequestApprove={vi.fn()}
          onRequestReject={vi.fn()}
        />
      );

      // The component renders: "{accepted} of {total} change(s) will be applied on approve."
      expect(screen.getByText('3 of 3')).toBeInTheDocument();
    });

    it('shows singular "change" for exactly 1 item', () => {
      const { trace, schema } = makeFlatFixture(1);

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt={null}
          onRequestApprove={vi.fn()}
          onRequestReject={vi.fn()}
        />
      );

      expect(screen.getByText(/1 of 1/)).toBeInTheDocument();
      expect(screen.getByText(/change will be applied/)).toBeInTheDocument();
    });

    it('renders empty-data message when all sections parse but have zero items', () => {
      // Produce a trace with a real step outputting an empty array
      const trace = [
        traceEntry({
          stepId: 'discover_new_models',
          output: { newModels: [] },
        }),
      ];
      const schema: ReviewSchema = {
        sections: [
          {
            id: 'newModels',
            title: 'New Models',
            source: '{{discover_new_models.output.newModels}}',
            itemKey: 'slug',
            itemTitle: '{{item.name}}',
            fields: [{ key: 'name', label: 'Name', display: 'text' }],
          },
        ],
      };

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt={null}
          onRequestApprove={vi.fn()}
          onRequestReject={vi.fn()}
        />
      );

      expect(screen.getByText(/audit produced no proposed changes/i)).toBeInTheDocument();
    });
  });

  describe('selection mechanics', () => {
    it('rejecting one item decrements the accepted counter by 1', async () => {
      const user = userEvent.setup();
      // 2 items — start at "2 of 2", reject one → "1 of 2"
      const { trace, schema } = makeFlatFixture(2);

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt={null}
          onRequestApprove={vi.fn()}
          onRequestReject={vi.fn()}
        />
      );

      // Should start at 2 of 2
      expect(screen.getByText('2 of 2')).toBeInTheDocument();

      // Click the first "Reject" button (one per item)
      const rejectButtons = screen.getAllByRole('button', { name: 'Reject' });
      // The header "Reject" button has a different label context — filter to the
      // item-level ones rendered inside the section list
      const itemRejectButton = rejectButtons.find((btn) => !btn.closest('header'));
      expect(itemRejectButton).toBeDefined();
      await user.click(itemRejectButton!);

      await waitFor(() => {
        expect(screen.getByText('1 of 2')).toBeInTheDocument();
      });
    });

    it('rejecting all items leaves "0 of N" and disables Approve selected button', async () => {
      const user = userEvent.setup();
      const { trace, schema } = makeFlatFixture(1);

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt={null}
          onRequestApprove={vi.fn()}
          onRequestReject={vi.fn()}
        />
      );

      const rejectButtons = screen.getAllByRole('button', { name: 'Reject' });
      const itemRejectButton = rejectButtons.find((btn) => !btn.closest('header'));
      await user.click(itemRejectButton!);

      await waitFor(() => {
        expect(screen.getByText('0 of 1')).toBeInTheDocument();
      });

      // "Approve selected" should now be disabled since acceptedTotal === 0
      expect(screen.getByRole('button', { name: /approve selected/i })).toBeDisabled();
    });
  });

  describe('submission', () => {
    it('clicking Approve selected calls onRequestApprove with correct buildApprovalPayload shape', async () => {
      const user = userEvent.setup();
      const onRequestApprove = vi.fn<(payload: Record<string, unknown[]>) => void>();
      const { trace, schema } = makeFlatFixture(2);

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt={null}
          onRequestApprove={onRequestApprove}
          onRequestReject={vi.fn()}
        />
      );

      await user.click(screen.getByRole('button', { name: /approve selected/i }));

      expect(onRequestApprove).toHaveBeenCalledOnce();

      // The payload must be keyed by section id and contain both accepted items
      const payload = onRequestApprove.mock.calls[0][0];
      expect(payload).toHaveProperty('newModels');
      // Both items accepted by default → array of 2 projected items
      expect(Array.isArray(payload.newModels)).toBe(true);
      expect(payload.newModels.length).toBe(2);
      // Each projected item must carry the original fields (not internal __key)
      const first = payload.newModels[0] as Record<string, unknown>;
      expect(first).toHaveProperty('slug');
      expect(first).not.toHaveProperty('__key');
    });

    it('clicking Approve selected after rejecting an item sends only accepted items in payload', async () => {
      const user = userEvent.setup();
      const onRequestApprove = vi.fn<(payload: Record<string, unknown[]>) => void>();
      const { trace, schema } = makeFlatFixture(3);

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt={null}
          onRequestApprove={onRequestApprove}
          onRequestReject={vi.fn()}
        />
      );

      // Reject the first item
      const rejectButtons = screen.getAllByRole('button', { name: 'Reject' });
      const itemRejectButton = rejectButtons.find((btn) => !btn.closest('header'));
      await user.click(itemRejectButton!);

      await waitFor(() => {
        expect(screen.getByText('2 of 3')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /approve selected/i }));

      const payload = onRequestApprove.mock.calls[0][0];
      expect(payload.newModels.length).toBe(2);
    });

    it('clicking Reject calls onRequestReject', async () => {
      const user = userEvent.setup();
      const onRequestReject = vi.fn();
      const { trace, schema } = makeFlatFixture(1);

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt={null}
          onRequestApprove={vi.fn()}
          onRequestReject={onRequestReject}
        />
      );

      // The header "Reject" button is inside <header> element
      const rejectButtons = screen.getAllByRole('button', { name: 'Reject' });
      const headerRejectButton = rejectButtons.find((btn) => btn.closest('header'));
      expect(headerRejectButton).toBeDefined();
      await user.click(headerRejectButton!);

      expect(onRequestReject).toHaveBeenCalledOnce();
    });

    it('submitting prop disables both Approve selected and Reject buttons', () => {
      const { trace, schema } = makeFlatFixture(1);

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt={null}
          onRequestApprove={vi.fn()}
          onRequestReject={vi.fn()}
          submitting
        />
      );

      expect(screen.getByRole('button', { name: /approve selected/i })).toBeDisabled();
      // The Reject button in the header should also be disabled
      const rejectButtons = screen.getAllByRole('button', { name: 'Reject' });
      const headerRejectButton = rejectButtons.find((btn) => btn.closest('header'));
      expect(headerRejectButton).toBeDisabled();
    });
  });

  describe('fallback rendering', () => {
    it('a section whose source does not resolve renders SectionFallback with "fallback view" badge', () => {
      const { trace, schema } = makeBrokenSectionFixture();

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt="## Fallback Markdown"
          onRequestApprove={vi.fn()}
          onRequestReject={vi.fn()}
        />
      );

      // The SectionFallback renders a badge with text "fallback view"
      expect(screen.getByText('fallback view')).toBeInTheDocument();
    });

    it('fallback section renders the fallbackPrompt markdown content', () => {
      const { trace, schema } = makeBrokenSectionFixture();

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt="Fallback instructions here"
          onRequestApprove={vi.fn()}
          onRequestReject={vi.fn()}
        />
      );

      expect(screen.getByText('Fallback instructions here')).toBeInTheDocument();
    });

    it('renders "No fallback content available" when fallbackPrompt is null and section errors', () => {
      const { trace, schema } = makeBrokenSectionFixture();

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt={null}
          onRequestApprove={vi.fn()}
          onRequestReject={vi.fn()}
        />
      );

      expect(screen.getByText('No fallback content available.')).toBeInTheDocument();
    });

    it('a successful section and a failing section both render (no full abort)', () => {
      // Schema with two sections: one resolvable, one broken
      const trace = [
        traceEntry({
          stepId: 'discover_new_models',
          output: { newModels: [{ slug: 'a', name: 'Alpha' }] },
        }),
        // No step for 'missing_step' — second section will fail
      ];
      const schema: ReviewSchema = {
        sections: [
          {
            id: 'newModels',
            title: 'New Models',
            source: '{{discover_new_models.output.newModels}}',
            itemKey: 'slug',
            itemTitle: '{{item.name}}',
            fields: [{ key: 'name', label: 'Name', display: 'text' }],
          },
          {
            id: 'deactivations',
            title: 'Deactivations',
            source: '{{missing_step.output.items}}',
            itemKey: 'id',
            itemTitle: '{{item.id}}',
            fields: [{ key: 'id', label: 'ID', display: 'text' }],
          },
        ],
      };

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt="Fallback for deactivations"
          onRequestApprove={vi.fn()}
          onRequestReject={vi.fn()}
        />
      );

      // Successful section renders its item title (appears in header p + field span)
      const alphaMatches = screen.getAllByText('Alpha');
      expect(alphaMatches.length).toBeGreaterThanOrEqual(1);
      // Failing section renders fallback view
      expect(screen.getByText('fallback view')).toBeInTheDocument();
    });
  });

  describe('nested sub-items count', () => {
    it('nested section sub-items are counted as candidates, not parent items', () => {
      // 1 parent model with 3 sub-item changes → total candidate = 3, not 1
      const { trace, schema } = makeNestedFixture(3);

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt={null}
          onRequestApprove={vi.fn()}
          onRequestReject={vi.fn()}
        />
      );

      // The component should report "3 of 3" (sub-items), not "1 of 1" (parents)
      expect(screen.getByText('3 of 3')).toBeInTheDocument();
    });

    it('rejecting a sub-item decrements the accepted count', async () => {
      // Drives the nested-item rejection branch in summariseSelection:
      // when a sub-state has decision === 'reject', it's subtracted from
      // the accepted count. Without this test, that branch is unreached.
      const user = userEvent.setup();
      const { trace, schema } = makeNestedFixture(3);

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt={null}
          onRequestApprove={vi.fn()}
          onRequestReject={vi.fn()}
        />
      );

      // The nested table renders a Reject button per sub-row. Find the
      // first one and click it.
      const rejectButtons = screen.getAllByRole('button', { name: 'Reject' });
      // The first Reject button is on the section header (parent item).
      // Sub-row Rejects come after — pick one of the sub-row Reject buttons.
      // Click the LAST one to ensure we land inside the sub-row table.
      const subRowReject = rejectButtons[rejectButtons.length - 1];
      await user.click(subRowReject);

      // 1 sub-item rejected → 2 of 3.
      expect(screen.getByText('2 of 3')).toBeInTheDocument();
    });

    it('rejecting the parent of a nested section drops all its sub-items from the count', async () => {
      // Drives the parent-rejected path: when the parent's decision is
      // 'reject', sub-items are still candidates but none are accepted.
      // Button order in the DOM:
      //   [0] top-level "Reject the whole approval" (in the page header)
      //   [1] parent item Reject (in the section row header)
      //   [2..] one per sub-row in the nested table
      const user = userEvent.setup();
      const { trace, schema } = makeNestedFixture(3);

      render(
        <StructuredApprovalView
          trace={trace}
          schema={schema}
          fallbackPrompt={null}
          onRequestApprove={vi.fn()}
          onRequestReject={vi.fn()}
        />
      );

      const allRejects = screen.getAllByRole('button', { name: 'Reject' });
      await user.click(allRejects[1]);

      expect(screen.getByText('0 of 3')).toBeInTheDocument();
    });
  });
});
