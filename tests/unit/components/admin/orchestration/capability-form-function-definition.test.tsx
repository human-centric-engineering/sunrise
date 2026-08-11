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
import type { AiCapability } from '@/types/prisma';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: () => createMockRouter(),
    useSearchParams: () => ({ get: () => null }),
  };
});

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
      await user.click(screen.getByRole('button', { name: /^json editor$/i }));

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

      await user.click(screen.getByRole('button', { name: /^json editor$/i }));
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

      await user.click(screen.getByRole('button', { name: /^json editor$/i }));

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

    it('JSON with integer type and extra keys (minLength) allows switching to Builder', async () => {
      const user = userEvent.setup();
      await openFunctionTab(user);

      await user.click(screen.getByRole('button', { name: /^json editor$/i }));

      const schemaWithExtras = JSON.stringify({
        name: 'search_knowledge_base',
        description: 'Search the knowledge base.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query.',
              minLength: 1,
              maxLength: 500,
            },
            limit: {
              type: 'integer',
              description: 'Max results.',
              minimum: 1,
              maximum: 50,
            },
          },
          required: ['query'],
        },
      });

      const textarea = screen.getByRole('textbox', { name: /json editor/i });
      fireEvent.change(textarea, { target: { value: schemaWithExtras } });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 300));
      });

      // Should be able to switch back to Builder
      await user.click(screen.getByRole('button', { name: /^builder$/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add parameter/i })).toBeInTheDocument();
      });

      // Banner should NOT be shown
      expect(
        screen.queryByText(/schema has features the builder can't represent/i)
      ).not.toBeInTheDocument();
    });

    it('JSON with unsupported shape (enum) sets visualDisabled banner when switching back', async () => {
      const user = userEvent.setup();
      await openFunctionTab(user);

      await user.click(screen.getByRole('button', { name: /^json editor$/i }));

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

    it('"Reset to Builder" button re-enables visual mode after complex JSON', async () => {
      const user = userEvent.setup();
      await openFunctionTab(user);

      // Switch to JSON editor and enter complex schema with enum
      await user.click(screen.getByRole('button', { name: /^json editor$/i }));

      const complexSchema = JSON.stringify({
        name: 'test_fn',
        description: 'A test function',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['a', 'b'], description: 'Status' },
          },
          required: [],
        },
      });

      const textarea = screen.getByRole('textbox', { name: /json editor/i });
      fireEvent.change(textarea, { target: { value: complexSchema } });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 300));
      });

      // Try to switch back — banner should appear
      await user.click(screen.getByRole('button', { name: /^builder$/i }));
      await waitFor(() => {
        expect(
          screen.getByText(/schema has features the builder can't represent/i)
        ).toBeInTheDocument();
      });

      // Click "Reset to Builder" button
      await user.click(screen.getByRole('button', { name: /reset to builder/i }));

      // Visual mode should be re-enabled — "Add parameter" button visible, banner gone
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add parameter/i })).toBeInTheDocument();
        expect(
          screen.queryByText(/schema has features the builder can't represent/i)
        ).not.toBeInTheDocument();
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
  // ── Round-trip fidelity of a stored definition (#509) ───────────────────────
  //
  // The form used to re-narrow a loaded `functionDefinition` through the visual
  // builder's own shape — `properties: record(object({ type, description }))`
  // — and Zod strips unknown keys, so `enum`, `items`, `minLength` and every
  // nested schema silently disappeared. An untouched Save then wrote the
  // stripped copy back. Every seeded capability carries at least one of those.
  //
  // It was unreachable only by accident: the old client slug regex was
  // hyphen-only, so a seeded underscore slug failed validation and blocked
  // submit. #509 fixed the regex, which removed the brake — these two cases
  // exist so the lossy narrow cannot come back with it.
  describe('stored definitions survive an untouched save', () => {
    const RICH_DEFINITION = {
      name: 'escalate_to_human',
      description: 'Escalate to a human.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why.', minLength: 1, maxLength: 1000 },
          priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Urgency.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags.' },
        },
        required: ['reason'],
      },
    };

    // The slug must equal `functionDefinition.name` (#509) or the form's own
    // pre-submit check refuses the save — correctly, and for a different
    // reason than the one under test here.
    function makeRichCapability(functionDefinition: { name: string }): AiCapability {
      return {
        id: 'cap-rich',
        name: 'Escalate To Human',
        slug: functionDefinition.name,
        description: 'Escalate to a human.',
        category: 'support',
        executionType: 'internal',
        executionHandler: 'EscalateToHumanCapability',
        executionConfig: null,
        functionDefinition,
        requiresApproval: false,
        rateLimit: null,
        isActive: true,
        createdBy: 'system',
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
        deletedAt: null,
        metadata: {},
      } as unknown as AiCapability;
    }

    // This fixture contains `enum`/`items`, which force JSON mode — so on its
    // own it does NOT cover the Builder path. The next case does; keep both.
    it('keeps enum, items and length constraints through a save (JSON mode)', async () => {
      const user = userEvent.setup();
      render(
        <CapabilityForm
          mode="edit"
          capability={makeRichCapability(RICH_DEFINITION)}
          availableCategories={['support']}
        />
      );

      await user.click(screen.getByRole('button', { name: /save|update/i }));

      const { apiClient } = await import('@/lib/api/client');
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: expect.objectContaining({ functionDefinition: RICH_DEFINITION }),
          })
        );
      });
    });

    it('leaves a builder-representable definition alone until it is edited', async () => {
      // The case the JSON-mode test above cannot reach. `get_pattern_detail`
      // IS reverse-compilable — `tryReverseCompile` tolerates
      // `minimum`/`maximum` and maps `integer` to `number` — so the form opens
      // in Visual mode, and the recompile effect used to fire on MOUNT and
      // overwrite the stored definition with the builder's lossy rendering.
      // Pressing Save without touching anything rewrote the schema:
      // `integer` became `number` (so a model may emit 1.5 for a pattern
      // number) and the bounds vanished.
      const BUILDER_REPRESENTABLE = {
        name: 'get_pattern_detail',
        description: 'Return every chunk for one pattern.',
        parameters: {
          type: 'object',
          properties: {
            pattern_number: {
              type: 'integer',
              description: 'The pattern number (1-999).',
              minimum: 1,
              maximum: 999,
            },
          },
          required: ['pattern_number'],
        },
      };

      const user = userEvent.setup();
      render(
        <CapabilityForm
          mode="edit"
          capability={makeRichCapability(BUILDER_REPRESENTABLE)}
          availableCategories={['support']}
        />
      );

      await user.click(screen.getByRole('button', { name: /save|update/i }));

      const { apiClient } = await import('@/lib/api/client');
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: expect.objectContaining({ functionDefinition: BUILDER_REPRESENTABLE }),
          })
        );
      });
    });

    // The point of the merge: the builder owns four fields per parameter, and
    // an edit to one of them must not delete the ones it cannot show.
    it('keeps bounds and integer-ness when only a description is edited', async () => {
      const STORED = {
        name: 'get_pattern_detail',
        description: 'Return every chunk for one pattern.',
        parameters: {
          type: 'object',
          properties: {
            pattern_number: {
              type: 'integer',
              description: 'The pattern number (1-999).',
              minimum: 1,
              maximum: 999,
            },
          },
          required: ['pattern_number'],
        },
      };

      const user = userEvent.setup();
      render(
        <CapabilityForm
          mode="edit"
          capability={makeRichCapability(STORED)}
          availableCategories={['support']}
        />
      );

      // Edit through the BUILDER — the path that used to rebuild each
      // parameter from scratch and drop everything it had no slot for.
      await user.click(screen.getByRole('tab', { name: /function/i }));
      const descInput = screen.getByDisplayValue('The pattern number (1-999).');
      await user.clear(descInput);
      await user.type(descInput, 'Which pattern to fetch.');

      await user.click(screen.getByRole('button', { name: /save|update/i }));

      const { apiClient } = await import('@/lib/api/client');
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalled();
      });
      const body = vi.mocked(apiClient.patch).mock.calls[0]?.[1] as {
        body: { functionDefinition: { parameters: { properties: Record<string, unknown> } } };
      };
      expect(body.body.functionDefinition.parameters.properties.pattern_number).toEqual({
        type: 'integer',
        description: 'Which pattern to fetch.',
        minimum: 1,
        maximum: 999,
      });
    });

    it('drops the stored keywords when the admin changes the parameter type', async () => {
      // The one case where losing them is right: `minLength` on a field that
      // just stopped being a string is nonsense, and the admin chose it.
      const STORED = {
        name: 'get_pattern_detail',
        description: 'd',
        parameters: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'A label.', minLength: 1, maxLength: 40 },
          },
          required: [],
        },
      };

      const user = userEvent.setup();
      render(
        <CapabilityForm
          mode="edit"
          capability={makeRichCapability(STORED)}
          availableCategories={['support']}
        />
      );

      await user.click(screen.getByRole('tab', { name: /function/i }));
      // The parameter-row type select has no accessible name; it is the only
      // combobox on this tab. Scope the option lookup to the Radix portal, as
      // the category-select tests above do.
      const combos = screen.getAllByRole('combobox');
      await user.click(combos[combos.length - 1]);
      const listbox = await screen.findByRole('listbox');
      await user.click(within(listbox).getByRole('option', { name: /^number$/i }));

      await user.click(screen.getByRole('button', { name: /save|update/i }));

      const { apiClient } = await import('@/lib/api/client');
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalled();
      });
      const body = vi.mocked(apiClient.patch).mock.calls[0]?.[1] as {
        body: { functionDefinition: { parameters: { properties: Record<string, unknown> } } };
      };
      expect(body.body.functionDefinition.parameters.properties.label).toEqual({
        type: 'number',
        description: 'A label.',
      });
    });

    it('preserves an untouched divergent row apart from repairing its name', async () => {
      // A legacy row whose stored name differs from its slug, carrying a
      // top-level key the API accepts. Opening it and saving used to rewrite
      // the definition — the mount-time slug mirror re-triggered the recompile
      // that the mount-skip exists to prevent — and dropped `strict`.
      const DIVERGENT = {
        name: 'custom_kb_search',
        description: 'Search.',
        parameters: { type: 'object', properties: {}, required: [] },
        strict: true,
      };

      const user = userEvent.setup();
      render(
        <CapabilityForm
          mode="edit"
          capability={{
            ...makeRichCapability({ name: 'search_knowledge_base' }),
            functionDefinition: DIVERGENT,
          }}
          availableCategories={['support']}
        />
      );

      await user.click(screen.getByRole('button', { name: /save|update/i }));

      const { apiClient } = await import('@/lib/api/client');
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalled();
      });
      const body = vi.mocked(apiClient.patch).mock.calls[0]?.[1] as {
        body: { functionDefinition: Record<string, unknown> };
      };
      // Only the name moved, to satisfy the #509 invariant.
      expect(body.body.functionDefinition).toEqual({
        ...DIVERGENT,
        name: 'search_knowledge_base',
      });
    });

    it('compiles the first builder edit after opening in JSON mode', async () => {
      // The mount-skip flag was consumed inside the `visual` branch, so a form
      // opening in JSON mode returned with it still armed and then swallowed
      // the first compile once the admin reached the builder. "Reset to
      // Builder" emptied the table on screen while the payload still carried
      // the original parameters.
      const WITH_ENUM = {
        name: 'escalate_to_human',
        description: 'Escalate.',
        parameters: {
          type: 'object',
          properties: { priority: { type: 'string', enum: ['low', 'high'], description: 'U.' } },
          required: [],
        },
      };

      const user = userEvent.setup();
      render(
        <CapabilityForm
          mode="edit"
          capability={makeRichCapability(WITH_ENUM)}
          availableCategories={['support']}
        />
      );

      await user.click(screen.getByRole('tab', { name: /function/i }));
      await user.click(screen.getByRole('button', { name: /reset to builder/i }));
      await user.click(screen.getByRole('button', { name: /save|update/i }));

      const { apiClient } = await import('@/lib/api/client');
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalled();
      });
      const body = vi.mocked(apiClient.patch).mock.calls[0]?.[1] as {
        body: { functionDefinition: { parameters: { properties: Record<string, unknown> } } };
      };
      // The reset emptied the table, so the payload must be empty too — screen
      // and payload agreeing is the whole point.
      expect(body.body.functionDefinition.parameters.properties).toEqual({});
    });

    it('can save a stored definition that predates the required fields', async () => {
      // `description`/`parameters` were optional on create until #509, and the
      // documented example omitted `parameters`. Removing the mount compile
      // left such a row unsaveable — the submit guard blamed a missing
      // function name that was plainly present.
      const PARTIAL = { name: 'legacy_tool' };

      const user = userEvent.setup();
      render(
        <CapabilityForm
          mode="edit"
          capability={{
            ...makeRichCapability({ name: 'legacy_tool' }),
            functionDefinition: PARTIAL,
          }}
          availableCategories={['support']}
        />
      );

      await user.click(screen.getByRole('button', { name: /save|update/i }));

      const { apiClient } = await import('@/lib/api/client');
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalled();
      });
    });

    it('saves JSON edits made inside the debounce window', async () => {
      // The JSON parse is debounced 200ms. Saving inside that window used to
      // persist the PREVIOUS definition, report "Saved", and then let the
      // stale timer write the unsaved JSON back into state — leaving the admin
      // looking at edits marked as saved that never were. Submit now flushes
      // the pending parse and uses its result.
      const user = userEvent.setup();
      render(
        <CapabilityForm
          mode="edit"
          capability={makeRichCapability({ name: 'legacy_tool' })}
          availableCategories={['support']}
        />
      );

      await user.click(screen.getByRole('tab', { name: /function/i }));
      await user.click(screen.getByRole('button', { name: /^json editor$/i }));

      const textarea = screen.getByRole('textbox', { name: /json editor/i });
      const edited = JSON.stringify({
        name: 'legacy_tool',
        description: 'Edited inside the debounce.',
        parameters: { type: 'object', properties: {}, required: [] },
      });
      fireEvent.change(textarea, { target: { value: edited } });

      // No waiting — press Save while the 200ms timer is still pending.
      await user.click(screen.getByRole('button', { name: /save|update/i }));

      const { apiClient } = await import('@/lib/api/client');
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalled();
      });
      const body = vi.mocked(apiClient.patch).mock.calls[0]?.[1] as {
        body: { functionDefinition: { description: string } };
      };
      expect(body.body.functionDefinition.description).toBe('Edited inside the debounce.');
    });

    it('can still save a definition the visual builder cannot represent', async () => {
      // A property with no `type` fails the builder shape outright. That used
      // to leave `parsedFn` null, so submit was refused with "Function
      // definition requires at least a function name" — leaving the admin
      // unable to edit the description, rate limit or active flag either.
      const UNBUILDABLE = {
        name: 'call_external_api',
        description: 'Call an API.',
        parameters: {
          type: 'object',
          properties: { body: { description: 'Request body, any shape.' } },
          required: [],
        },
      };

      const user = userEvent.setup();
      render(
        <CapabilityForm
          mode="edit"
          capability={makeRichCapability(UNBUILDABLE)}
          availableCategories={['support']}
        />
      );

      await user.click(screen.getByRole('button', { name: /save|update/i }));

      const { apiClient } = await import('@/lib/api/client');
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: expect.objectContaining({ functionDefinition: UNBUILDABLE }),
          })
        );
      });
    });
  });
});
