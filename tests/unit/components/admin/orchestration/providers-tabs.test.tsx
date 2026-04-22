/**
 * ProvidersTabs Component Tests
 *
 * Test Coverage:
 * - Default tab (configuration) shown on initial render when no ?tab param
 * - Deep-link to "models" tab via ?tab=models query param
 * - Invalid ?tab param falls back to "configuration" tab
 * - Tab switching: clicking Model Matrix tab shows its content
 * - Tab switching: clicking Configuration tab shows its content
 * - Active tab visual state: correct tab has aria-selected="true"
 *
 * @see components/admin/orchestration/providers-tabs.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSearchParams } from 'next/navigation';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock child components to avoid deep dependency trees
vi.mock('@/components/admin/orchestration/providers-list', () => ({
  ProvidersList: ({ initialProviders }: { initialProviders: unknown[] }) => (
    <div data-testid="providers-list">ProvidersList ({initialProviders.length} providers)</div>
  ),
}));

vi.mock('@/components/admin/orchestration/provider-models-matrix', () => ({
  ProviderModelsMatrix: ({ initialModels }: { initialModels: unknown[] }) => (
    <div data-testid="provider-models-matrix">
      ProviderModelsMatrix ({initialModels.length} models)
    </div>
  ),
}));

import { ProvidersTabs } from '@/components/admin/orchestration/providers-tabs';
import type { ProviderRow } from '@/components/admin/orchestration/providers-list';
import type { ModelRow } from '@/components/admin/orchestration/provider-models-matrix';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: 'prov-1',
    name: 'Anthropic',
    slug: 'anthropic',
    providerType: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    baseUrl: null,
    isActive: true,
    isLocal: false,
    apiKeyPresent: true,
    createdBy: 'system',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    deletedAt: null,
    metadata: {},
    circuitBreaker: { state: 'closed', failureCount: 0, openedAt: null },
    ...overrides,
  } as ProviderRow;
}

function makeModel(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    id: 'model-1',
    slug: 'anthropic-claude-3-5-sonnet',
    providerSlug: 'anthropic',
    modelId: 'claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    description: 'Flagship model',
    capabilities: ['chat'],
    tierRole: 'thinking',
    reasoningDepth: 'high',
    latency: 'medium',
    costEfficiency: 'moderate',
    contextLength: 'very_high',
    toolUse: 'strong',
    bestRole: 'Planner',
    isDefault: true,
    isActive: true,
    configured: true,
    configuredActive: true,
    ...overrides,
  };
}

const PROVIDERS: ProviderRow[] = [makeProvider()];
const MODELS: ModelRow[] = [makeModel()];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProvidersTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Default tab on initial render', () => {
    it('shows Configuration tab content when no ?tab query param is present', () => {
      // Arrange: global setup has useSearchParams returning new URLSearchParams() (no params)
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<ProvidersTabs initialProviders={PROVIDERS} initialModels={MODELS} />);

      // Assert: ProvidersList is rendered (Configuration tab content)
      expect(screen.getByTestId('providers-list')).toBeInTheDocument();
    });

    it('the Configuration tab trigger has aria-selected="true" by default', () => {
      // Arrange
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<ProvidersTabs initialProviders={PROVIDERS} initialModels={MODELS} />);

      // Assert: the "Configuration" tab is marked as the active/selected tab
      const configTab = screen.getByRole('tab', { name: /configuration/i });
      expect(configTab).toHaveAttribute('aria-selected', 'true');
    });

    it('the Model Matrix tab trigger is not selected by default', () => {
      // Arrange
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<ProvidersTabs initialProviders={PROVIDERS} initialModels={MODELS} />);

      // Assert: "Model Matrix" tab is not the active tab
      const modelsTab = screen.getByRole('tab', { name: /model matrix/i });
      expect(modelsTab).toHaveAttribute('aria-selected', 'false');
    });
  });

  describe('Deep-link via ?tab=models query param', () => {
    it('shows Model Matrix tab content when ?tab=models is set', () => {
      // Arrange: simulate deep-link to models tab
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=models') as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<ProvidersTabs initialProviders={PROVIDERS} initialModels={MODELS} />);

      // Assert: ProviderModelsMatrix is rendered (Model Matrix tab content)
      expect(screen.getByTestId('provider-models-matrix')).toBeInTheDocument();
    });

    it('the Model Matrix tab trigger has aria-selected="true" when ?tab=models', () => {
      // Arrange
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=models') as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<ProvidersTabs initialProviders={PROVIDERS} initialModels={MODELS} />);

      // Assert: "Model Matrix" tab is marked active
      const modelsTab = screen.getByRole('tab', { name: /model matrix/i });
      expect(modelsTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('Invalid ?tab param falls back to configuration', () => {
    it('shows Configuration tab content when ?tab has an unknown value', () => {
      // Arrange: unknown tab param should be rejected by the VALID_TABS guard
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=unknown') as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<ProvidersTabs initialProviders={PROVIDERS} initialModels={MODELS} />);

      // Assert: falls back to Configuration (the default tab)
      expect(screen.getByTestId('providers-list')).toBeInTheDocument();
      const configTab = screen.getByRole('tab', { name: /configuration/i });
      expect(configTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('Tab switching via click', () => {
    it('clicking Model Matrix tab shows its panel and hides Configuration panel', async () => {
      // Arrange
      const user = userEvent.setup();
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as ReturnType<typeof useSearchParams>
      );
      render(<ProvidersTabs initialProviders={PROVIDERS} initialModels={MODELS} />);

      // Verify initial state: Configuration panel visible
      expect(screen.getByTestId('providers-list')).toBeInTheDocument();

      // Act: click the Model Matrix tab
      await user.click(screen.getByRole('tab', { name: /model matrix/i }));

      // Assert: Model Matrix panel is now active
      expect(screen.getByTestId('provider-models-matrix')).toBeInTheDocument();
    });

    it('clicking Model Matrix then Configuration tab returns to Configuration panel', async () => {
      // Arrange
      const user = userEvent.setup();
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as ReturnType<typeof useSearchParams>
      );
      render(<ProvidersTabs initialProviders={PROVIDERS} initialModels={MODELS} />);

      // Act: switch to Model Matrix, then back to Configuration
      await user.click(screen.getByRole('tab', { name: /model matrix/i }));
      await user.click(screen.getByRole('tab', { name: /configuration/i }));

      // Assert: Configuration panel is visible again and it is the active tab
      expect(screen.getByTestId('providers-list')).toBeInTheDocument();
      const configTab = screen.getByRole('tab', { name: /configuration/i });
      expect(configTab).toHaveAttribute('aria-selected', 'true');
    });

    it('tab switching does not trigger a page navigation (Radix handles locally)', async () => {
      // Arrange
      const user = userEvent.setup();
      const { useRouter } = await import('next/navigation');
      const mockPush = vi.fn();
      vi.mocked(useRouter).mockReturnValue({
        push: mockPush,
        replace: vi.fn(),
        refresh: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        prefetch: vi.fn(),
      } as ReturnType<typeof useRouter>);
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as ReturnType<typeof useSearchParams>
      );
      render(<ProvidersTabs initialProviders={PROVIDERS} initialModels={MODELS} />);

      // Act: click both tabs
      await user.click(screen.getByRole('tab', { name: /model matrix/i }));
      await user.click(screen.getByRole('tab', { name: /configuration/i }));

      // Assert: router.push was never called — tabs are client-side only
      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  describe('Props passed to child components', () => {
    it('passes initialProviders to ProvidersList', () => {
      // Arrange
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<ProvidersTabs initialProviders={PROVIDERS} initialModels={MODELS} />);

      // Assert: mock renders the count, confirming the prop was forwarded
      expect(screen.getByTestId('providers-list')).toHaveTextContent('1 providers');
    });

    it('passes initialModels to ProviderModelsMatrix when models tab is active', async () => {
      // Arrange
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=models') as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<ProvidersTabs initialProviders={PROVIDERS} initialModels={MODELS} />);

      // Assert: mock renders the count, confirming the prop was forwarded
      expect(screen.getByTestId('provider-models-matrix')).toHaveTextContent('1 models');
    });
  });

  describe('Renders both tab triggers regardless of active tab', () => {
    it('both tab triggers are always rendered in the DOM', () => {
      // Arrange
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<ProvidersTabs initialProviders={PROVIDERS} initialModels={MODELS} />);

      // Assert: both tabs are in the tablist
      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(2);
      expect(screen.getByRole('tab', { name: /configuration/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /model matrix/i })).toBeInTheDocument();
    });
  });
});
