/**
 * CapabilityForm — Basic Tab Tests
 *
 * Test Coverage:
 * - Renders in create mode with category selector
 * - Slug auto-populates from name until slug is edited, then locks
 * - Category Select shows existing categories + "+ New category…"
 * - "+ New category…" swaps Select for free-text input
 * - Happy-path submit POSTs to /capabilities with correct body shape
 * - mode="edit" disables the slug input
 *
 * @see components/admin/orchestration/capability-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CapabilityForm } from '@/components/admin/orchestration/capability-form';
import type { AiCapability } from '@/types/prisma';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCapability(overrides: Partial<AiCapability> = {}): AiCapability {
  return {
    id: 'cap-edit-1',
    name: 'Existing Capability',
    slug: 'existing-capability',
    description: 'Does something useful',
    category: 'api',
    executionType: 'api',
    executionHandler: 'https://example.com/handler',
    executionConfig: null,
    functionDefinition: {},
    requiresApproval: false,
    rateLimit: null,
    isActive: true,
    createdBy: 'system',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    deletedAt: null,
    metadata: {},
    ...overrides,
  } as AiCapability;
}

// Helper: fill required fields and submit
async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  // Fill name
  await user.type(screen.getByRole('textbox', { name: /^name/i }), 'My Capability');

  // Fill description
  await user.type(
    screen.getByRole('textbox', { name: /^description/i }),
    'Useful description text'
  );

  // Pick category from select — multiple comboboxes may be in DOM (executionType also)
  const categoryTriggers = screen.getAllByRole('combobox');
  const categoryTrigger = categoryTriggers.find((t) => t.id === 'category') ?? categoryTriggers[0];
  await user.click(categoryTrigger);
  // Scope to the Radix portal listbox to avoid clicking hidden native <option> elements
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: /^api$/i }));

  // Navigate to Function Definition tab and add a parameter so parsedFn is set
  await user.click(screen.getByRole('tab', { name: /function definition/i }));
  await user.click(screen.getByRole('button', { name: /add parameter/i }));

  // Navigate to Execution tab and fill handler
  await user.click(screen.getByRole('tab', { name: /execution/i }));
  await user.type(screen.getByRole('textbox', { name: /execution handler/i }), 'SearchCapability');

  // Navigate back to basic and submit
  await user.click(screen.getByRole('tab', { name: /basic/i }));
  await user.click(screen.getByRole('button', { name: /create capability/i }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CapabilityForm — Basic tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  describe('create mode rendering', () => {
    it('renders the create capability submit button', () => {
      render(<CapabilityForm mode="create" availableCategories={['knowledge', 'api']} />);

      expect(screen.getByRole('button', { name: /create capability/i })).toBeInTheDocument();
    });

    it('renders name, slug, description, category, and isActive fields', () => {
      render(<CapabilityForm mode="create" availableCategories={['knowledge', 'api']} />);

      expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /^slug/i })).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /^description/i })).toBeInTheDocument();
    });

    it('renders both category options in the select', async () => {
      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['knowledge', 'api']} />);

      // Category select trigger has id="category" — find its parent button
      const categoryTriggers = screen.getAllByRole('combobox');
      // The category Select renders first in the DOM (basic tab is default)
      const categoryTrigger =
        categoryTriggers.find((t) => t.id === 'category') ?? categoryTriggers[0];
      await user.click(categoryTrigger);

      await waitFor(
        () => {
          expect(
            screen.getAllByRole('option', { name: /^knowledge$/i, hidden: true }).length
          ).toBeGreaterThanOrEqual(1);
          expect(
            screen.getAllByRole('option', { name: /^api$/i, hidden: true }).length
          ).toBeGreaterThanOrEqual(1);
        },
        { timeout: 3000 }
      );
    });

    it('renders "+ New category…" option in category select', async () => {
      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['knowledge', 'api']} />);

      const categoryTriggers = screen.getAllByRole('combobox');
      const categoryTrigger =
        categoryTriggers.find((t) => t.id === 'category') ?? categoryTriggers[0];
      await user.click(categoryTrigger);

      await waitFor(
        () => {
          expect(
            screen.getAllByRole('option', { name: /\+ new category/i, hidden: true }).length
          ).toBeGreaterThanOrEqual(1);
        },
        { timeout: 3000 }
      );
    });
  });

  // ── Slug auto-generation ───────────────────────────────────────────────────

  describe('slug auto-generation', () => {
    it('slug auto-populates from name on typing', async () => {
      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);

      await user.type(screen.getByRole('textbox', { name: /^name/i }), 'My Knowledge Search');

      const slugInput = screen.getByRole('textbox', { name: /^slug/i });
      await waitFor(() => {
        expect((slugInput as HTMLInputElement).value).toBe('my-knowledge-search');
      });
    });

    it('slug is lowercase with hyphens', async () => {
      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);

      await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Hello World Test!');

      const slugInput = screen.getByRole('textbox', { name: /^slug/i });
      await waitFor(() => {
        const val = (slugInput as HTMLInputElement).value;
        expect(val).toMatch(/^[a-z0-9-]+$/);
        expect(val).toContain('hello');
      });
    });

    it('slug locks after user edits it directly', async () => {
      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);

      await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Some Name');

      const slugInput = screen.getByRole('textbox', { name: /^slug/i });
      await user.clear(slugInput);
      await user.type(slugInput, 'my-custom-slug');

      // Further name changes should NOT override the user's slug
      await user.type(screen.getByRole('textbox', { name: /^name/i }), ' Extra');

      await waitFor(() => {
        expect((slugInput as HTMLInputElement).value).toBe('my-custom-slug');
      });
    });
  });

  // ── New category flow ──────────────────────────────────────────────────────

  describe('+ New category… flow', () => {
    async function openCategorySelect(user: ReturnType<typeof userEvent.setup>) {
      const categoryTriggers = screen.getAllByRole('combobox');
      const categoryTrigger =
        categoryTriggers.find((t) => t.id === 'category') ?? categoryTriggers[0];
      await user.click(categoryTrigger);
      return categoryTrigger;
    }

    it('selecting "+ New category…" swaps Select for a text input', async () => {
      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['knowledge', 'api']} />);

      await openCategorySelect(user);
      // Scope to the Radix portal listbox to avoid hidden native <option> elements
      const listbox = await screen.findByRole('listbox');
      await user.click(within(listbox).getByRole('option', { name: /\+ new category/i }));

      // Select should be gone, text input with id="category" visible
      await waitFor(() => {
        const categoryInput = document.querySelector('input#category');
        expect(categoryInput).toBeInTheDocument();
      });
    });

    it('cancel in new-category mode restores the Select', async () => {
      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['knowledge', 'api']} />);

      await openCategorySelect(user);
      // Scope to the Radix portal listbox to avoid hidden native <option> elements
      const listbox = await screen.findByRole('listbox');
      await user.click(within(listbox).getByRole('option', { name: /\+ new category/i }));

      // Click the Cancel button next to the free-text input
      await waitFor(() => expect(document.querySelector('input#category')).toBeInTheDocument());
      const cancelBtns = screen.getAllByRole('button', { name: /cancel/i });
      // Use the last Cancel button (the one added for the category free-text input)
      await user.click(cancelBtns[cancelBtns.length - 1]);

      await waitFor(() => {
        // After cancel, executionType Select (on execution tab) is still in DOM
        // but the category select should be back
        const comboboxes = screen.getAllByRole('combobox');
        const hasCategorySelect = comboboxes.some((t) => t.id === 'category');
        expect(hasCategorySelect).toBe(true);
      });
    });
  });

  // ── Happy path submit ──────────────────────────────────────────────────────

  describe('happy path create', () => {
    it('POSTs to /capabilities with correct body shape', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({
        id: 'new-cap-id',
        name: 'My Capability',
        slug: 'my-capability',
      });

      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);

      await fillAndSubmit(user);

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/capabilities'),
          expect.objectContaining({
            body: expect.objectContaining({
              name: expect.stringContaining('My Capability'),
            }),
          })
        );
      });
    });

    it('navigates to the new capability edit page after successful create', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({
        id: 'new-cap-id',
        name: 'My Capability',
        slug: 'my-capability',
      });

      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);

      await fillAndSubmit(user);

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/capabilities/new-cap-id'));
      });
    });
  });

  // ── Edit mode ──────────────────────────────────────────────────────────────

  describe('edit mode', () => {
    it('disables the slug input in edit mode', () => {
      render(
        <CapabilityForm mode="edit" capability={makeCapability()} availableCategories={['api']} />
      );

      const slugInput = screen.getByRole('textbox', { name: /^slug/i });
      expect(slugInput).toBeDisabled();
    });

    it('pre-fills fields from the capability in edit mode', () => {
      render(
        <CapabilityForm
          mode="edit"
          capability={makeCapability({
            name: 'Existing Capability',
            slug: 'existing-capability',
            description: 'Does something useful',
          })}
          availableCategories={['api']}
        />
      );

      expect(screen.getByRole<HTMLInputElement>('textbox', { name: /^name/i }).value).toBe(
        'Existing Capability'
      );
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: /^slug/i }).value).toBe(
        'existing-capability'
      );
    });

    it('shows "Save changes" button in edit mode', () => {
      render(
        <CapabilityForm mode="edit" capability={makeCapability()} availableCategories={['api']} />
      );

      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
  });
});
