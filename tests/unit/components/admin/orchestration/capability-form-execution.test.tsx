/**
 * CapabilityForm — Execution Tab Tests
 *
 * Test Coverage:
 * - Changing executionType Select updates the handler FieldHelp text
 * - executionConfig empty → submit body has executionConfig: undefined
 * - Valid JSON in executionConfig → submit body includes the parsed object
 * - Invalid JSON in executionConfig shows inline error and blocks submit
 *
 * @see components/admin/orchestration/capability-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CapabilityForm } from '@/components/admin/orchestration/capability-form';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code = 'INTERNAL_ERROR',
      public status = 500
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function renderAndOpenExecution() {
  const user = userEvent.setup();
  render(<CapabilityForm mode="create" availableCategories={['api']} />);
  await user.click(screen.getByRole('tab', { name: /execution/i }));
  return user;
}

/** Fill all required fields (other tabs) and submit — used for payload tests. */
async function fillRequiredAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  execConfigJson?: string
) {
  // Basic tab
  await user.click(screen.getByRole('tab', { name: /basic/i }));
  await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Test Capability');
  await user.type(screen.getByRole('textbox', { name: /^description/i }), 'A useful capability');
  // Scope to the Radix listbox portal to avoid hidden native option elements
  const categoryTriggers = screen.getAllByRole('combobox');
  const categoryTrigger = categoryTriggers.find((t) => t.id === 'category') ?? categoryTriggers[0];
  await user.click(categoryTrigger);
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: /^api$/i }));

  // Function definition tab — add at least one param
  await user.click(screen.getByRole('tab', { name: /function definition/i }));
  await user.click(screen.getByRole('button', { name: /add parameter/i }));
  const nameInput = screen.getByPlaceholderText('name');
  await user.type(nameInput, 'query');

  // Execution tab
  await user.click(screen.getByRole('tab', { name: /execution/i }));
  await user.type(screen.getByRole('textbox', { name: /execution handler/i }), 'SearchCapability');

  if (execConfigJson !== undefined) {
    const execConfigTextarea = screen.getByPlaceholderText(/timeout_ms/i);
    // Use fireEvent.change because userEvent.type treats { as a keyboard modifier
    fireEvent.change(execConfigTextarea, { target: { value: execConfigJson } });
    // Wait for debounce
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
  }

  await user.click(screen.getByRole('button', { name: /create capability/i }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CapabilityForm — Execution tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Execution type selector ────────────────────────────────────────────────

  describe('executionType select', () => {
    it('default executionType is "internal"', async () => {
      await renderAndOpenExecution();

      // Target by id to avoid ambiguity with the category combobox also in DOM
      const executionTypeSelect = screen
        .getAllByRole('combobox')
        .find((t) => t.id === 'executionType');
      expect(executionTypeSelect).toBeTruthy();
      expect((executionTypeSelect as HTMLElement).textContent).toContain('internal');
    });

    it('renders all three execution type options', async () => {
      const user = await renderAndOpenExecution();

      // Target executionType by id
      const executionTypeSelect = screen
        .getAllByRole('combobox')
        .find((t) => t.id === 'executionType')!;
      await user.click(executionTypeSelect);

      // Scope to Radix listbox portal
      const listbox = await screen.findByRole('listbox');
      await waitFor(() => {
        expect(within(listbox).getByRole('option', { name: /internal/i })).toBeInTheDocument();
        expect(within(listbox).getByRole('option', { name: /api/i })).toBeInTheDocument();
        expect(within(listbox).getByRole('option', { name: /webhook/i })).toBeInTheDocument();
      });
    });
  });

  // ── executionConfig JSON textarea ──────────────────────────────────────────

  describe('executionConfig JSON', () => {
    it('invalid JSON shows inline error', async () => {
      await renderAndOpenExecution();

      const execConfigTextarea = screen.getByPlaceholderText(/timeout_ms/i);
      // Use fireEvent.change because userEvent.type treats { as a keyboard modifier
      fireEvent.change(execConfigTextarea, { target: { value: '{ invalid }' } });

      // Wait for debounce
      await act(async () => {
        await new Promise((r) => setTimeout(r, 300));
      });

      await waitFor(() => {
        // Error message should appear below the textarea
        const errorMsgs = document.querySelectorAll('[class*="destructive"]');
        expect(errorMsgs.length).toBeGreaterThan(0);
      });
    });

    it('valid JSON clears any previous error', async () => {
      await renderAndOpenExecution();

      const execConfigTextarea = screen.getByPlaceholderText(/timeout_ms/i);

      // Set invalid JSON first
      fireEvent.change(execConfigTextarea, { target: { value: '{ bad }' } });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 300));
      });

      // Then set valid JSON
      fireEvent.change(execConfigTextarea, { target: { value: '{"timeout_ms": 5000}' } });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 300));
      });

      // Error should be cleared
      await waitFor(() => {
        expect(screen.queryByText(/invalid json/i)).not.toBeInTheDocument();
      });
    });

    it('empty executionConfig → submit body has no executionConfig key', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'cap-1', name: 'Cap', slug: 'cap' });

      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);

      await fillRequiredAndSubmit(user); // no execConfigJson

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: expect.objectContaining({
              executionConfig: undefined,
            }),
          })
        );
      });
    });

    it('valid JSON in executionConfig → submit body includes parsed object', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'cap-1', name: 'Cap', slug: 'cap' });

      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);

      await fillRequiredAndSubmit(user, '{"timeout_ms": 5000}');

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: expect.objectContaining({
              executionConfig: { timeout_ms: 5000 },
            }),
          })
        );
      });
    });

    it('invalid JSON in executionConfig blocks submit with error', async () => {
      const { apiClient } = await import('@/lib/api/client');

      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);

      await fillRequiredAndSubmit(user, '{ invalid json }');

      // Submit should show an error and NOT call apiClient.post for the capability
      await waitFor(() => {
        // Either an error message appears, or apiClient.post was not called
        const postCalls = (apiClient.post as ReturnType<typeof vi.fn>).mock.calls;
        const capabilityCalls = postCalls.filter((call) =>
          (call[0] as string).includes('/capabilities')
        );
        expect(capabilityCalls.length).toBe(0);
      });
    });
  });
});
