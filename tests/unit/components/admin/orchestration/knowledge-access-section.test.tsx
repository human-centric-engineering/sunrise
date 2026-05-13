/**
 * KnowledgeAccessSection Component Tests
 *
 * Test Coverage:
 * - Renders "Knowledge access" label and mode radio buttons
 * - Full access radio is checked by default when mode="full"
 * - Restricted radio is checked when mode="restricted"
 * - Clicking "Full access" radio calls onModeChange("full")
 * - Clicking "Restricted" radio calls onModeChange("restricted")
 * - Tags and Documents MultiSelects not rendered in "full" mode
 * - Tags and Documents MultiSelects rendered in "restricted" mode
 * - Tags loaded from API on mount via useEffect
 * - Non-fatal: tag load failure does not crash (MultiSelect shows empty options)
 * - Warning shown when restricted with no tags and no documents selected
 * - Warning not shown when restricted with at least one tag
 * - Warning not shown when restricted with at least one document
 * - Warning not shown in "full" mode
 * - Document labels pre-fetched when documentIds is non-empty on mount
 * - Non-fatal: document label fetch failure does not crash
 * - Handles rawTagIds / rawDocumentIds being undefined (coerces to [])
 * - loadDocumentOptions called with query when MultiSelect async search fires
 *
 * @see components/admin/orchestration/knowledge-access-section.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { KnowledgeAccessSection } from '@/components/admin/orchestration/knowledge-access-section';
import type { KnowledgeAccessMode } from '@/components/admin/orchestration/knowledge-access-section';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
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

// Stub MultiSelect to a simplified version so we can test the outer component
// without worrying about popover internals, while still letting onChange wire work.
vi.mock('@/components/ui/multi-select', () => ({
  MultiSelect: ({
    id,
    value,
    onChange,
    options,
    placeholder,
    loadOptions,
    'aria-label': _ariaLabel,
  }: {
    id?: string;
    value: string[];
    onChange: (v: string[]) => void;
    options?: Array<{ value: string; label: string }>;
    placeholder?: string;
    loadOptions?: (q: string) => Promise<Array<{ value: string; label: string }>>;
    'aria-label'?: string;
  }) => {
    function handleLoad(): void {
      if (!loadOptions) return;
      void loadOptions('test-query').then((result) => {
        result.forEach((r) => {
          const el = document.createElement('span');
          el.textContent = r.label;
          el.setAttribute('data-loaded', 'true');
          document.body.appendChild(el);
        });
      });
    }
    return (
      <div data-testid={id ?? 'multi-select'}>
        <span data-testid={`${id}-placeholder`}>{placeholder}</span>
        {(options ?? []).map((o) => (
          <button
            key={o.value}
            data-testid={`opt-${o.value}`}
            onClick={() => onChange([...value, o.value])}
          >
            {o.label}
          </button>
        ))}
        {/* Expose loadOptions so tests can invoke it */}
        {loadOptions ? (
          <button data-testid={`${id}-load`} onClick={handleLoad}>
            load
          </button>
        ) : null}
      </div>
    );
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { apiClient } from '@/lib/api/client';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TAG_A = { id: 'tag-a', slug: 'sales', name: 'Sales', description: 'Sales content' };
const TAG_B = { id: 'tag-b', slug: 'support', name: 'Support', description: null };

const DOC_A = { id: 'doc-a', name: 'Sales Guide', fileName: 'sales.pdf' };
const DOC_B = { id: 'doc-b', name: 'Support Manual', fileName: 'support.pdf' };

function makeProps(
  overrides: Partial<{
    mode: KnowledgeAccessMode;
    tagIds: string[];
    documentIds: string[];
    onModeChange: (v: KnowledgeAccessMode) => void;
    onTagsChange: (v: string[]) => void;
    onDocumentsChange: (v: string[]) => void;
  }> = {}
) {
  return {
    mode: overrides.mode ?? 'full',
    tagIds: overrides.tagIds ?? [],
    documentIds: overrides.documentIds ?? [],
    onModeChange: overrides.onModeChange ?? vi.fn(),
    onTagsChange: overrides.onTagsChange ?? vi.fn(),
    onDocumentsChange: overrides.onDocumentsChange ?? vi.fn(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KnowledgeAccessSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: tags endpoint returns two tags; documents endpoint returns two docs
    vi.mocked(apiClient.get).mockImplementation((url: string) => {
      if (url.includes('/knowledge/tags')) return Promise.resolve([TAG_A, TAG_B]);
      if (url.includes('/knowledge/documents')) return Promise.resolve([DOC_A, DOC_B]);
      return Promise.resolve([]);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders "Knowledge access" label', async () => {
      await act(async () => {
        render(<KnowledgeAccessSection {...makeProps()} />);
      });

      expect(screen.getByText(/knowledge access/i)).toBeInTheDocument();
    });

    it('renders both radio buttons', async () => {
      await act(async () => {
        render(<KnowledgeAccessSection {...makeProps()} />);
      });

      expect(screen.getByLabelText(/full access/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/restricted/i)).toBeInTheDocument();
    });

    it('Full access radio is checked when mode="full"', async () => {
      await act(async () => {
        render(<KnowledgeAccessSection {...makeProps({ mode: 'full' })} />);
      });

      expect(screen.getByLabelText(/full access/i)).toBeChecked();
      expect(screen.getByLabelText(/restricted/i)).not.toBeChecked();
    });

    it('Restricted radio is checked when mode="restricted"', async () => {
      await act(async () => {
        render(<KnowledgeAccessSection {...makeProps({ mode: 'restricted' })} />);
      });

      expect(screen.getByLabelText(/restricted/i)).toBeChecked();
      expect(screen.getByLabelText(/full access/i)).not.toBeChecked();
    });

    it('does NOT render Tags/Documents controls in "full" mode', async () => {
      await act(async () => {
        render(<KnowledgeAccessSection {...makeProps({ mode: 'full' })} />);
      });

      expect(screen.queryByTestId('knowledge-tags')).not.toBeInTheDocument();
      expect(screen.queryByTestId('knowledge-documents')).not.toBeInTheDocument();
    });

    it('renders Tags and Documents controls in "restricted" mode', async () => {
      await act(async () => {
        render(<KnowledgeAccessSection {...makeProps({ mode: 'restricted' })} />);
      });

      expect(screen.getByTestId('knowledge-tags')).toBeInTheDocument();
      expect(screen.getByTestId('knowledge-documents')).toBeInTheDocument();
    });
  });

  // ── Mode change ────────────────────────────────────────────────────────────

  describe('mode change', () => {
    it('calls onModeChange("full") when Full access radio is clicked', async () => {
      const onModeChange = vi.fn();
      const user = userEvent.setup();

      await act(async () => {
        render(<KnowledgeAccessSection {...makeProps({ mode: 'restricted', onModeChange })} />);
      });

      await user.click(screen.getByLabelText(/full access/i));

      expect(onModeChange).toHaveBeenCalledWith('full');
    });

    it('calls onModeChange("restricted") when Restricted radio is clicked', async () => {
      const onModeChange = vi.fn();
      const user = userEvent.setup();

      await act(async () => {
        render(<KnowledgeAccessSection {...makeProps({ mode: 'full', onModeChange })} />);
      });

      await user.click(screen.getByLabelText(/restricted/i));

      expect(onModeChange).toHaveBeenCalledWith('restricted');
    });
  });

  // ── Tag loading ────────────────────────────────────────────────────────────

  describe('tag loading', () => {
    it('fetches tags from the knowledge/tags endpoint on mount', async () => {
      await act(async () => {
        render(<KnowledgeAccessSection {...makeProps()} />);
      });

      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledWith(expect.stringContaining('/knowledge/tags'));
      });
    });

    it('populates tag options in MultiSelect after load', async () => {
      await act(async () => {
        render(<KnowledgeAccessSection {...makeProps({ mode: 'restricted' })} />);
      });

      await waitFor(() => {
        expect(screen.getByTestId('opt-tag-a')).toBeInTheDocument();
        expect(screen.getByTestId('opt-tag-b')).toBeInTheDocument();
      });
    });

    it('handles tag load failure gracefully (no crash)', async () => {
      vi.mocked(apiClient.get).mockImplementation((url: string) => {
        if (url.includes('/knowledge/tags')) return Promise.reject(new Error('network'));
        return Promise.resolve([]);
      });

      await act(async () => {
        // Should not throw
        render(<KnowledgeAccessSection {...makeProps({ mode: 'restricted' })} />);
      });

      await waitFor(() => {
        // Tags MultiSelect renders but with no options
        expect(screen.getByTestId('knowledge-tags')).toBeInTheDocument();
      });
    });

    it('does not set tags if cancelled (cleanup)', async () => {
      let resolveTagFetch!: (v: unknown) => void;
      vi.mocked(apiClient.get).mockReturnValue(
        new Promise((r) => {
          resolveTagFetch = r;
        })
      );

      const { unmount } = render(<KnowledgeAccessSection {...makeProps()} />);

      // Unmount before the fetch resolves
      unmount();

      // Resolve after unmount — should not throw / setState on unmounted component
      await act(async () => {
        resolveTagFetch([TAG_A]);
      });
    });
  });

  // ── Document label pre-fetch ───────────────────────────────────────────────

  describe('document label pre-fetch', () => {
    it('fetches documents when documentIds is non-empty on mount', async () => {
      await act(async () => {
        render(
          <KnowledgeAccessSection {...makeProps({ mode: 'restricted', documentIds: ['doc-a'] })} />
        );
      });

      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledWith(expect.stringContaining('/knowledge/documents'));
      });
    });

    it('does not fetch documents when documentIds is empty', async () => {
      await act(async () => {
        render(<KnowledgeAccessSection {...makeProps({ documentIds: [] })} />);
      });

      await waitFor(() => {
        // Only the tags fetch should have been called
        const docCalls = vi.mocked(apiClient.get).mock.calls.filter((args) => {
          const url = args[0];
          return url.includes('/knowledge/documents') && !url.includes('/tags');
        });
        expect(docCalls).toHaveLength(0);
      });
    });

    it('handles document label fetch failure gracefully', async () => {
      vi.mocked(apiClient.get).mockImplementation((url: string) => {
        if (url.includes('/knowledge/tags')) return Promise.resolve([TAG_A]);
        if (url.includes('/knowledge/documents')) return Promise.reject(new Error('fail'));
        return Promise.resolve([]);
      });

      await act(async () => {
        // Should not throw
        render(
          <KnowledgeAccessSection {...makeProps({ mode: 'restricted', documentIds: ['doc-a'] })} />
        );
      });

      await waitFor(() => {
        expect(screen.getByTestId('knowledge-documents')).toBeInTheDocument();
      });
    });

    it('does not set document labels if cancelled (cleanup)', async () => {
      let resolveFetch!: (v: unknown) => void;
      vi.mocked(apiClient.get).mockImplementation((url: string) => {
        if (url.includes('/knowledge/tags')) return Promise.resolve([]);
        return new Promise((r) => {
          resolveFetch = r;
        });
      });

      const { unmount } = render(
        <KnowledgeAccessSection {...makeProps({ documentIds: ['doc-a'] })} />
      );

      unmount();

      await act(async () => {
        resolveFetch([DOC_A]);
      });
    });
  });

  // ── Empty restricted warning ───────────────────────────────────────────────

  describe('empty restricted warning', () => {
    it('shows warning when restricted with no tags and no documents', async () => {
      await act(async () => {
        render(
          <KnowledgeAccessSection
            {...makeProps({ mode: 'restricted', tagIds: [], documentIds: [] })}
          />
        );
      });

      expect(screen.getByText(/no grants selected/i)).toBeInTheDocument();
    });

    it('does NOT show warning when restricted with at least one tag', async () => {
      await act(async () => {
        render(
          <KnowledgeAccessSection
            {...makeProps({ mode: 'restricted', tagIds: ['tag-a'], documentIds: [] })}
          />
        );
      });

      expect(screen.queryByText(/no grants selected/i)).not.toBeInTheDocument();
    });

    it('does NOT show warning when restricted with at least one document', async () => {
      await act(async () => {
        render(
          <KnowledgeAccessSection
            {...makeProps({ mode: 'restricted', tagIds: [], documentIds: ['doc-a'] })}
          />
        );
      });

      expect(screen.queryByText(/no grants selected/i)).not.toBeInTheDocument();
    });

    it('does NOT show warning in "full" mode', async () => {
      await act(async () => {
        render(
          <KnowledgeAccessSection {...makeProps({ mode: 'full', tagIds: [], documentIds: [] })} />
        );
      });

      expect(screen.queryByText(/no grants selected/i)).not.toBeInTheDocument();
    });
  });

  // ── undefined coercion ────────────────────────────────────────────────────

  describe('undefined coercion', () => {
    it('treats undefined tagIds as empty array without crashing', async () => {
      await act(async () => {
        render(
          <KnowledgeAccessSection
            mode="restricted"
            tagIds={undefined as unknown as string[]}
            documentIds={[]}
            onModeChange={vi.fn()}
            onTagsChange={vi.fn()}
            onDocumentsChange={vi.fn()}
          />
        );
      });

      // Warning should show (effectively no tags selected)
      expect(screen.getByText(/no grants selected/i)).toBeInTheDocument();
    });

    it('treats undefined documentIds as empty array without crashing', async () => {
      await act(async () => {
        render(
          <KnowledgeAccessSection
            mode="restricted"
            tagIds={[]}
            documentIds={undefined as unknown as string[]}
            onModeChange={vi.fn()}
            onTagsChange={vi.fn()}
            onDocumentsChange={vi.fn()}
          />
        );
      });

      expect(screen.getByText(/no grants selected/i)).toBeInTheDocument();
    });
  });

  // ── loadDocumentOptions ────────────────────────────────────────────────────

  describe('loadDocumentOptions', () => {
    it('calls apiClient.get with the correct search params', async () => {
      vi.mocked(apiClient.get).mockImplementation((url: string) => {
        if (url.includes('/knowledge/tags')) return Promise.resolve([]);
        return Promise.resolve([DOC_A, DOC_B]);
      });

      const user = userEvent.setup();
      await act(async () => {
        render(<KnowledgeAccessSection {...makeProps({ mode: 'restricted' })} />);
      });

      // Trigger loadOptions via the stub button
      await user.click(screen.getByTestId('knowledge-documents-load'));

      await waitFor(() => {
        const calls = vi.mocked(apiClient.get).mock.calls;
        const docSearchCall = calls.find((args) => {
          const url = args[0];
          return url.includes('/knowledge/documents') && url.includes('q=test-query');
        });
        expect(docSearchCall).toBeDefined();
      });
    });

    it('returns empty array when loadDocumentOptions API call fails', async () => {
      vi.mocked(apiClient.get).mockImplementation((url: string) => {
        if (url.includes('/knowledge/tags')) return Promise.resolve([]);
        return Promise.reject(new Error('network'));
      });

      const user = userEvent.setup();
      await act(async () => {
        render(<KnowledgeAccessSection {...makeProps({ mode: 'restricted' })} />);
      });

      // Should not throw
      await user.click(screen.getByTestId('knowledge-documents-load'));

      // No crash
      await waitFor(() => {
        expect(screen.getByTestId('knowledge-documents')).toBeInTheDocument();
      });
    });
  });

  // ── onTagsChange / onDocumentsChange wiring ────────────────────────────────

  describe('MultiSelect onChange wiring', () => {
    it('calls onTagsChange when a tag option is clicked', async () => {
      const onTagsChange = vi.fn();
      const user = userEvent.setup();

      await act(async () => {
        render(<KnowledgeAccessSection {...makeProps({ mode: 'restricted', onTagsChange })} />);
      });

      await waitFor(() => screen.getByTestId('opt-tag-a'));

      await user.click(screen.getByTestId('opt-tag-a'));

      expect(onTagsChange).toHaveBeenCalledWith(expect.arrayContaining(['tag-a']));
    });
  });
});
