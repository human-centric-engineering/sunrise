// @vitest-environment happy-dom

/**
 * DatasetNewTabs component tests.
 *
 * Coverage:
 *  - Both tab triggers render with the correct labels and icons (FileUp, Sparkles)
 *  - Default tab is "upload" — DatasetUploadForm is visible on initial mount
 *  - Clicking "Generate from description" tab switches to GenerateFromDescriptionForm
 *    and hides the upload form
 *  - `agents={null}` (failed to load): the generate tab shows a load-failed
 *    alert in place of the form; the upload tab still works
 *
 * Child forms are mocked to simple markers so we don't pull in their full
 * dependency graphs (react-hook-form, Zod, API clients, etc.).
 *
 * @see components/admin/orchestration/evaluations-foundations/dataset-new-tabs.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/components/admin/orchestration/evaluations-foundations/dataset-upload-form', () => ({
  DatasetUploadForm: () => <div data-testid="upload-form-marker">UPLOAD</div>,
}));

vi.mock(
  '@/components/admin/orchestration/evaluations-foundations/generate-from-description-form',
  () => ({
    GenerateFromDescriptionForm: ({ agents }: { agents: unknown[] }) => (
      <div data-testid="generate-form-marker">GENERATE {agents.length}</div>
    ),
  })
);

// Import after mocks are declared so vi.mock hoisting wires up before the
// component module resolves its imports.
import { DatasetNewTabs } from '@/components/admin/orchestration/evaluations-foundations/dataset-new-tabs';

describe('DatasetNewTabs', () => {
  it('renders both tab triggers with the correct labels', () => {
    render(<DatasetNewTabs agents={[]} />);

    // Both triggers must be present — guards against a label rename or a
    // missing trigger in the TabsList.
    expect(screen.getByRole('tab', { name: /Upload file/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Generate from description/i })).toBeInTheDocument();
  });

  it('shows the upload form on initial mount (default tab is "upload")', () => {
    render(<DatasetNewTabs agents={[]} />);

    // The upload marker must be visible without any interaction.
    expect(screen.getByTestId('upload-form-marker')).toBeInTheDocument();
    // The generate form should not yet be visible in the DOM
    // (Radix hides inactive tab content).
    expect(screen.queryByTestId('generate-form-marker')).not.toBeInTheDocument();
  });

  it('switches to the generate form when the "Generate from description" tab is clicked', async () => {
    const user = userEvent.setup();
    const mockAgents = [{ id: 'a1', name: 'Agent One', slug: 'agent-one' }];

    render(<DatasetNewTabs agents={mockAgents} />);

    await user.click(screen.getByRole('tab', { name: /Generate from description/i }));

    // After the tab switch the generate marker is visible and carries the
    // agent count — proving the `agents` prop was forwarded correctly.
    expect(screen.getByTestId('generate-form-marker')).toBeInTheDocument();
    expect(screen.getByText(`GENERATE ${mockAgents.length}`)).toBeInTheDocument();

    // The upload form is no longer rendered.
    expect(screen.queryByTestId('upload-form-marker')).not.toBeInTheDocument();
  });

  // ── A failed agent load shows in the generate tab only (#518) ────────────

  it('shows a load-failed alert in the generate tab when agents is null', async () => {
    const user = userEvent.setup();
    render(<DatasetNewTabs agents={null} />);

    // The upload tab is untouched by the agent failure.
    expect(screen.getByTestId('upload-form-marker')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Generate from description/i }));

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the agents.");
    // Never the form, whose empty-list state says "create an agent".
    expect(screen.queryByTestId('generate-form-marker')).not.toBeInTheDocument();
  });

  it('shows no alert when the agent list loaded, even empty', async () => {
    const user = userEvent.setup();
    render(<DatasetNewTabs agents={[]} />);

    await user.click(screen.getByRole('tab', { name: /Generate from description/i }));

    expect(screen.getByText('GENERATE 0')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
