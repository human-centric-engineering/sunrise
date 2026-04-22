/**
 * CapabilityForm — Safety Tab Tests
 *
 * Test Coverage:
 * - requiresApproval Switch round-trips on submit
 * - rateLimit empty input → undefined in payload; "60" → 60
 * - Edit mode with usedBy renders "Used by N agents" chip card
 *   with every agent's name
 *
 * @see components/admin/orchestration/capability-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CapabilityForm } from '@/components/admin/orchestration/capability-form';
import type { AiCapability } from '@/types/prisma';

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCapability(overrides: Partial<AiCapability> = {}): AiCapability {
  return {
    id: 'cap-1',
    name: 'Existing Cap',
    slug: 'existing-cap',
    description: 'Useful capability',
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

const USED_BY = [
  { id: 'agent-1', name: 'Alpha Bot', slug: 'alpha-bot' },
  { id: 'agent-2', name: 'Beta Bot', slug: 'beta-bot' },
  { id: 'agent-3', name: 'Gamma Bot', slug: 'gamma-bot' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function openSafetyTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: /safety/i }));
}

/** Fill required fields across other tabs before submitting. */
async function fillRequiredFieldsForSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: /basic/i }));

  const nameInput = screen.getByRole('textbox', { name: /^name/i });
  if (!(nameInput as HTMLInputElement).value) {
    await user.type(nameInput, 'Test Capability');
  }
  const descInput = screen.getByRole('textbox', { name: /^description/i });
  if (!(descInput as HTMLTextAreaElement).value) {
    await user.type(descInput, 'A useful description');
  }

  // Pick a category
  const selects = screen.getAllByRole('combobox');
  const categorySelect = selects.find((s) => s.getAttribute('id') === 'category') ?? selects[0];
  await user.click(categorySelect);
  // Scope to the Radix portal listbox to avoid hidden native option elements
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: /^api$/i }));

  // Function definition tab
  await user.click(screen.getByRole('tab', { name: /function definition/i }));
  await user.click(screen.getByRole('button', { name: /add parameter/i }));
  await user.type(screen.getByPlaceholderText('name'), 'query');

  // Execution tab
  await user.click(screen.getByRole('tab', { name: /execution/i }));
  const handlerInput = screen.getByRole('textbox', { name: /execution handler/i });
  if (!(handlerInput as HTMLInputElement).value) {
    await user.type(handlerInput, 'SearchCapability');
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CapabilityForm — Safety tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── requiresApproval ───────────────────────────────────────────────────────

  describe('requiresApproval switch', () => {
    it('renders requiresApproval switch defaulting to off', async () => {
      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);
      await openSafetyTab(user);

      // Radix Switch renders role="switch" with aria-checked; find by id
      const approvalSwitch = document.getElementById('requiresApproval');
      expect(approvalSwitch).not.toBeNull();
      // Radix Switch uses aria-checked, not .checked
      expect(approvalSwitch?.getAttribute('aria-checked')).toBe('false');
    });

    it('requiresApproval=true round-trips in submit payload', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'cap-1', name: 'Cap', slug: 'cap' });

      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);

      await openSafetyTab(user);

      // Toggle requiresApproval on
      const approvalSwitch = document.getElementById('requiresApproval') as HTMLElement;
      await user.click(approvalSwitch);

      await fillRequiredFieldsForSubmit(user);

      // Submit from safety tab
      await user.click(screen.getByRole('tab', { name: /safety/i }));
      await user.click(screen.getByRole('button', { name: /create capability/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: expect.objectContaining({
              requiresApproval: true,
            }),
          })
        );
      });
    });
  });

  // ── approvalTimeoutMs ──────────────────────────────────────────────────────

  describe('approvalTimeoutMs input', () => {
    it('approval timeout field is hidden when requiresApproval is off', async () => {
      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);
      await openSafetyTab(user);

      expect(
        screen.queryByRole('spinbutton', { name: /approval timeout/i })
      ).not.toBeInTheDocument();
    });

    it('approval timeout field appears when requiresApproval is toggled on', async () => {
      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);
      await openSafetyTab(user);

      const approvalSwitch = document.getElementById('requiresApproval') as HTMLElement;
      await user.click(approvalSwitch);

      expect(screen.getByRole('spinbutton', { name: /approval timeout/i })).toBeInTheDocument();
    });

    it('approvalTimeoutMs value round-trips in submit payload', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'cap-1', name: 'Cap', slug: 'cap' });

      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);

      await openSafetyTab(user);

      // Toggle approval on to reveal the timeout field
      const approvalSwitch = document.getElementById('requiresApproval') as HTMLElement;
      await user.click(approvalSwitch);

      await user.type(screen.getByRole('spinbutton', { name: /approval timeout/i }), '30000');

      await fillRequiredFieldsForSubmit(user);
      await user.click(screen.getByRole('tab', { name: /safety/i }));
      await user.click(screen.getByRole('button', { name: /create capability/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: expect.objectContaining({
              approvalTimeoutMs: 30000,
            }),
          })
        );
      });
    });

    it('empty approvalTimeoutMs → null in submit payload', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'cap-1', name: 'Cap', slug: 'cap' });

      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);

      await openSafetyTab(user);

      const approvalSwitch = document.getElementById('requiresApproval') as HTMLElement;
      await user.click(approvalSwitch);

      // Leave timeout empty
      await fillRequiredFieldsForSubmit(user);
      await user.click(screen.getByRole('tab', { name: /safety/i }));
      await user.click(screen.getByRole('button', { name: /create capability/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: expect.objectContaining({
              approvalTimeoutMs: null,
            }),
          })
        );
      });
    });
  });

  // ── rateLimit ─────────────────────────────────────────────────────────────

  describe('rateLimit input', () => {
    it('empty rateLimit → undefined in submit payload', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'cap-1', name: 'Cap', slug: 'cap' });

      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);

      await fillRequiredFieldsForSubmit(user);

      await user.click(screen.getByRole('tab', { name: /safety/i }));
      // Leave rateLimit empty
      await user.click(screen.getByRole('button', { name: /create capability/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: expect.objectContaining({
              rateLimit: undefined,
            }),
          })
        );
      });
    });

    it('rateLimit value "60" → 60 in submit payload', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ id: 'cap-1', name: 'Cap', slug: 'cap' });

      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);

      await fillRequiredFieldsForSubmit(user);

      await user.click(screen.getByRole('tab', { name: /safety/i }));
      await user.type(screen.getByRole('spinbutton', { name: /rate limit/i }), '60');

      await user.click(screen.getByRole('button', { name: /create capability/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: expect.objectContaining({
              rateLimit: 60,
            }),
          })
        );
      });
    });
  });

  // ── Used by agents chip card ───────────────────────────────────────────────

  describe('usedBy agents chip card (edit mode)', () => {
    it('renders "Used by 3 agents" heading when usedBy has 3 entries', async () => {
      const user = userEvent.setup();
      render(
        <CapabilityForm
          mode="edit"
          capability={makeCapability()}
          usedBy={USED_BY}
          availableCategories={['api']}
        />
      );

      await openSafetyTab(user);

      expect(screen.getByText(/used by 3 agents/i)).toBeInTheDocument();
    });

    it('renders all agent names in the chip card', async () => {
      const user = userEvent.setup();
      render(
        <CapabilityForm
          mode="edit"
          capability={makeCapability()}
          usedBy={USED_BY}
          availableCategories={['api']}
        />
      );

      await openSafetyTab(user);

      expect(screen.getByText('Alpha Bot')).toBeInTheDocument();
      expect(screen.getByText('Beta Bot')).toBeInTheDocument();
      expect(screen.getByText('Gamma Bot')).toBeInTheDocument();
    });

    it('does NOT render chip card when usedBy is empty', async () => {
      const user = userEvent.setup();
      render(
        <CapabilityForm
          mode="edit"
          capability={makeCapability()}
          usedBy={[]}
          availableCategories={['api']}
        />
      );

      await openSafetyTab(user);

      expect(screen.queryByText(/used by/i)).not.toBeInTheDocument();
    });

    it('does NOT render chip card in create mode', async () => {
      const user = userEvent.setup();
      render(<CapabilityForm mode="create" availableCategories={['api']} />);

      await openSafetyTab(user);

      expect(screen.queryByText(/used by/i)).not.toBeInTheDocument();
    });
  });
});
