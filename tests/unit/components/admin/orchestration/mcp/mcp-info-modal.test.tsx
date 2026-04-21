import { describe, it, expect } from 'vitest';
import { render, screen, waitForElementToBeRemoved, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { McpInfoModal } from '@/components/admin/orchestration/mcp/mcp-info-modal';

describe('McpInfoModal', () => {
  it('renders trigger button with aria-label including title', () => {
    // Arrange & Act
    render(
      <McpInfoModal title="What is MCP?">
        <p>Body</p>
      </McpInfoModal>
    );

    // Assert
    expect(screen.getByRole('button', { name: 'Info: What is MCP?' })).toBeInTheDocument();
  });

  it('opens dialog and shows title text when trigger is clicked', async () => {
    // Arrange
    const user = userEvent.setup();
    render(
      <McpInfoModal title="What is MCP?">
        <p>Body</p>
      </McpInfoModal>
    );

    // Act
    await user.click(screen.getByRole('button', { name: 'Info: What is MCP?' }));

    // Assert
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(
      within(dialog).getByRole('heading', { name: 'What is MCP?', level: 2 })
    ).toBeInTheDocument();
  });

  it('renders children inside the dialog content after opening', async () => {
    // Arrange
    const user = userEvent.setup();
    render(
      <McpInfoModal title="Server Info">
        <p>This is the detailed description.</p>
      </McpInfoModal>
    );

    // Act
    await user.click(screen.getByRole('button', { name: 'Info: Server Info' }));

    // Assert
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('This is the detailed description.')).toBeInTheDocument();
  });

  it('keeps independent open state for multiple instances', async () => {
    // Arrange
    const user = userEvent.setup();
    render(
      <>
        <McpInfoModal title="Modal A">
          <p>Content A</p>
        </McpInfoModal>
        <McpInfoModal title="Modal B">
          <p>Content B</p>
        </McpInfoModal>
      </>
    );

    // Act — open Modal A
    await user.click(screen.getByRole('button', { name: 'Info: Modal A' }));

    // Assert — only Modal A's dialog is open
    const dialogA = await screen.findByRole('dialog');
    expect(within(dialogA).getByRole('heading', { name: 'Modal A', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Modal B', level: 2 })).not.toBeInTheDocument();
  });

  it('closes the dialog when Escape is pressed', async () => {
    // Arrange
    const user = userEvent.setup();
    render(
      <McpInfoModal title="Escape Test">
        <p>Body</p>
      </McpInfoModal>
    );

    // Act — open dialog
    await user.click(screen.getByRole('button', { name: 'Info: Escape Test' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();

    // Act — press Escape; Radix may close synchronously or asynchronously under jsdom
    await user.keyboard('{Escape}');

    // Assert — dialog is gone (handle both sync and async removal)
    if (screen.queryByRole('dialog')) {
      await waitForElementToBeRemoved(() => screen.queryByRole('dialog'));
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
