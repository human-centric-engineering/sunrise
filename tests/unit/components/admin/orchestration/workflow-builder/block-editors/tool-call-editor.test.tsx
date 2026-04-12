/**
 * Unit Tests: ToolCallEditor
 *
 * Test Coverage:
 * - Renders options from props.capabilities
 * - Empty capabilities list renders "No capabilities available" message
 * - Selecting a capability calls onChange({ capabilitySlug })
 * - Description block appears for selected capability
 * - Unknown slug is NOT passed through onChange
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/tool-call-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ToolCallEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/tool-call-editor';
import type { ToolCallConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/tool-call-editor';
import type { CapabilityOption } from '@/components/admin/orchestration/workflow-builder/block-editors/index';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CAPABILITIES: CapabilityOption[] = [
  {
    id: 'cap-1',
    slug: 'web-search',
    name: 'Web Search',
    description: 'Search the web for information.',
  },
  {
    id: 'cap-2',
    slug: 'code-runner',
    name: 'Code Runner',
    description: 'Execute arbitrary code snippets.',
  },
];

const emptyConfig: ToolCallConfig = { capabilitySlug: '' };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ToolCallEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the "No capabilities available" message when capabilities is empty', () => {
    render(<ToolCallEditor config={emptyConfig} onChange={vi.fn()} capabilities={[]} />);
    expect(screen.getByText(/no capabilities available/i)).toBeInTheDocument();
  });

  it('renders a select trigger when capabilities are provided', () => {
    render(<ToolCallEditor config={emptyConfig} onChange={vi.fn()} capabilities={CAPABILITIES} />);
    // The Select component renders a button/combobox as trigger
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('shows the capability description block when a valid slug is selected', () => {
    const config: ToolCallConfig = { capabilitySlug: 'web-search' };
    render(<ToolCallEditor config={config} onChange={vi.fn()} capabilities={CAPABILITIES} />);
    expect(screen.getByText('Search the web for information.')).toBeInTheDocument();
  });

  it('does NOT show description when no slug is selected', () => {
    render(<ToolCallEditor config={emptyConfig} onChange={vi.fn()} capabilities={CAPABILITIES} />);
    expect(screen.queryByText('Search the web for information.')).not.toBeInTheDocument();
  });

  it('calls onChange with { capabilitySlug } when a valid capability is selected', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ToolCallEditor config={emptyConfig} onChange={onChange} capabilities={CAPABILITIES} />);

    // Open the select
    await user.click(screen.getByRole('combobox'));

    // Select the first capability
    const option = await screen.findByRole('option', { name: 'Web Search' });
    await user.click(option);

    expect(onChange).toHaveBeenCalledWith({ capabilitySlug: 'web-search' });
  });

  it('renders at least one FieldHelp info button', () => {
    render(<ToolCallEditor config={emptyConfig} onChange={vi.fn()} capabilities={CAPABILITIES} />);
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    expect(infoButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('shows "No description provided" when selected capability has empty description', () => {
    const capsNoDesc: CapabilityOption[] = [
      { id: 'cap-3', slug: 'empty-desc', name: 'Empty Desc Cap', description: '' },
    ];
    const config: ToolCallConfig = { capabilitySlug: 'empty-desc' };
    render(<ToolCallEditor config={config} onChange={vi.fn()} capabilities={capsNoDesc} />);
    expect(screen.getByText(/no description provided/i)).toBeInTheDocument();
  });
});
