/**
 * CapabilityForm — Function Definition Tab Tests
 *
 * Test Coverage:
 * - Builder mode: clicking "Add parameter" appends a row
 * - Filling name/type/description/required updates the live preview
 * - Trash button removes a row
 * - Toggle Builder → JSON: textarea contains serialized compiled JSON
 * - JSON editor with invalid JSON shows inline error
 * - JSON editor with valid-but-complex shape (enum) writes state but
 *   toggling back to Builder shows the "schema has features" banner and
 *   Builder toggle stays disabled
 * - Submit payload includes the correctly compiled functionDefinition
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

async function openFunctionTab(user: ReturnType<typeof userEvent.setup>) {
  render(<CapabilityForm mode="create" availableCategories={['api']} />);
  await user.click(screen.getByRole('tab', { name: /function definition/i }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CapabilityForm — Function Definition tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Visual builder ─────────────────────────────────────────────────────────

  describe('visual builder', () => {
    it('starts with no parameters', async () => {
      const user = userEvent.setup();
      await openFunctionTab(user);

      expect(screen.getByText(/No parameters defined yet/i)).toBeInTheDocument();
    });

    it('clicking "Add parameter" appends a row', async () => {
      const user = userEvent.setup();
      await openFunctionTab(user);

      await user.click(screen.getByRole('button', { name: /add parameter/i }));

      await waitFor(() => {
        expect(screen.queryByText(/No parameters defined yet/i)).not.toBeInTheDocument();
        expect(screen.getByPlaceholderText('name')).toBeInTheDocument();
      });
    });

    it('adding two parameters shows two rows', async () => {
      const user = userEvent.setup();
      await openFunctionTab(user);

      await user.click(screen.getByRole('button', { name: /add parameter/i }));
      await user.click(screen.getByRole('button', { name: /add parameter/i }));

      await waitFor(() => {
        const nameInputs = screen.getAllByPlaceholderText('name');
        expect(nameInputs).toHaveLength(2);
      });
    });

    it('trash button removes a parameter row', async () => {
      const user = userEvent.setup();
      await openFunctionTab(user);

      await user.click(screen.getByRole('button', { name: /add parameter/i }));
      await user.click(screen.getByRole('button', { name: /add parameter/i }));

      // Remove the first row
      const removeButtons = screen.getAllByRole('button', { name: /remove parameter/i });
      await user.click(removeButtons[0]);

      await waitFor(() => {
        const nameInputs = screen.getAllByPlaceholderText('name');
        expect(nameInputs).toHaveLength(1);
      });
    });

    it('filling parameter fields updates the live preview JSON', async () => {
      const user = userEvent.setup();
      await openFunctionTab(user);

      await user.click(screen.getByRole('button', { name: /add parameter/i }));

      const nameInput = screen.getByPlaceholderText('name');
      await user.type(nameInput, 'query');

      // Live preview is a <pre> element always visible below the builder
      await waitFor(() => {
        const preview = document.querySelector('pre');
        expect(preview?.textContent).toContain('query');
      });
    });

    it('live preview contains the OpenAI function definition shape', async () => {
      const user = userEvent.setup();
      await openFunctionTab(user);

      await user.click(screen.getByRole('button', { name: /add parameter/i }));

      const nameInput = screen.getByPlaceholderText('name');
      await user.type(nameInput, 'query_text');

      await waitFor(() => {
        const preview = document.querySelector('pre');
        const content = preview?.textContent ?? '';
        expect(content).toContain('parameters');
        expect(content).toContain('properties');
        expect(content).toContain('query_text');
      });
    });
  });

  // ── Mode toggle Builder → JSON ─────────────────────────────────────────────

  describe('mode toggle', () => {
    it('switching to JSON mode shows a textarea with serialized JSON', async () => {
      const user = userEvent.setup();
      await openFunctionTab(user);

      await user.click(screen.getByRole('button', { name: /add parameter/i }));
      const nameInput = screen.getByPlaceholderText('name');
      await user.type(nameInput, 'test_param');

      // Switch to JSON mode
      await user.click(screen.getByRole('button', { name: /^json$/i }));

      await waitFor(() => {
        const textarea = screen.getByRole('textbox', { name: /json editor/i });
        expect(textarea).toBeInTheDocument();
        const value = (textarea as HTMLTextAreaElement).value;
        expect(value).toContain('test_param');
        expect(value).toContain('parameters');
      });
    });

    it('switching back to Builder shows the visual builder', async () => {
      const user = userEvent.setup();
      await openFunctionTab(user);

      await user.click(screen.getByRole('button', { name: /^json$/i }));
      await user.click(screen.getByRole('button', { name: /^builder$/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add parameter/i })).toBeInTheDocument();
      });
    });
  });

  // ── JSON editor validation ─────────────────────────────────────────────────

  describe('JSON editor', () => {
    it('invalid JSON shows an inline error', async () => {
      const user = userEvent.setup();
      await openFunctionTab(user);

      await user.click(screen.getByRole('button', { name: /^json$/i }));

      const textarea = screen.getByRole('textbox', { name: /json editor/i });
      // Use fireEvent.change because userEvent.type treats { as a keyboard modifier
      fireEvent.change(textarea, { target: { value: '{ invalid json }' } });

      await waitFor(() => {
        // Error is a <p class="text-destructive text-xs"> rendered below the textarea
        const errorEl = document.querySelector('p.text-destructive');
        expect(errorEl).toBeTruthy();
        expect(errorEl?.textContent).toBeTruthy();
      });
    });

    it('JSON with unsupported shape (enum) sets visualDisabled banner when switching back', async () => {
      const user = userEvent.setup();
      await openFunctionTab(user);

      await user.click(screen.getByRole('button', { name: /^json$/i }));

      const complexSchema = JSON.stringify({
        name: 'test_fn',
        description: 'A test function',
        parameters: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['active', 'inactive'], // unsupported — has 'enum' key
              description: 'Status',
            },
          },
          required: [],
        },
      });

      const textarea = screen.getByRole('textbox', { name: /json editor/i });
      // Use fireEvent.change because userEvent.type treats { as a keyboard modifier
      fireEvent.change(textarea, { target: { value: complexSchema } });

      // Wait for debounce
      await act(async () => {
        await new Promise((r) => setTimeout(r, 300));
      });

      // Try to switch back to visual mode
      await user.click(screen.getByRole('button', { name: /^builder$/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/schema has features the builder can't represent/i)
        ).toBeInTheDocument();
      });
    });
  });

  // ── Submit payload ─────────────────────────────────────────────────────────

  describe('submit payload includes functionDefinition', () => {
    it('submit payload includes the compiled functionDefinition', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'cap-1', name: 'Cap', slug: 'cap' });

      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);

      // Fill basic required fields
      await user.click(screen.getByRole('tab', { name: /basic/i }));
      await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Search Tool');
      await user.type(
        screen.getByRole('textbox', { name: /^description/i }),
        'Search the knowledge base'
      );

      // Pick category — scope to the Radix listbox portal to avoid hidden native options
      const categoryTriggers = screen.getAllByRole('combobox');
      const categoryTrigger =
        categoryTriggers.find((t) => t.id === 'category') ?? categoryTriggers[0];
      await user.click(categoryTrigger);
      const listbox = await screen.findByRole('listbox');
      await user.click(within(listbox).getByRole('option', { name: /^api$/i }));

      // Go to function tab and add a parameter
      await user.click(screen.getByRole('tab', { name: /function definition/i }));
      await user.click(screen.getByRole('button', { name: /add parameter/i }));
      const nameInput = screen.getByPlaceholderText('name');
      await user.type(nameInput, 'query');

      // Go to execution tab and add handler
      await user.click(screen.getByRole('tab', { name: /execution/i }));
      await user.type(
        screen.getByRole('textbox', { name: /execution handler/i }),
        'SearchCapability'
      );

      // Submit
      await user.click(screen.getByRole('button', { name: /create capability/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/capabilities'),
          expect.objectContaining({
            body: expect.objectContaining({
              functionDefinition: expect.objectContaining({
                parameters: expect.objectContaining({
                  type: 'object',
                  properties: expect.objectContaining({
                    query: expect.any(Object),
                  }),
                }),
              }),
            }),
          })
        );
      });
    });
  });
});
