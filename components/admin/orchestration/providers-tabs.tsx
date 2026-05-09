'use client';

/**
 * ProvidersTabs — tabbed container for the Providers page.
 *
 * Tab 1: Configuration — card grid of AiProviderConfig rows (operational config).
 * Tab 2: Model Matrix — flat table of AiProviderModel rows (selection heuristic).
 *
 * Tab state is URL-synced via `useUrlTabs` so that:
 *   - Deep links work (`?tab=models` lands on the matrix)
 *   - Clicking the sidebar nav item while on a sub-tab resets to the
 *     default — without URL sync the uncontrolled Radix Tabs holds
 *     its previous tab even when the operator "goes home" via the nav.
 *   - Browser back/forward navigates between tabs.
 *   - The default tab is rendered with no `?tab=` param for clean URLs.
 */

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProvidersList, type ProviderRow } from '@/components/admin/orchestration/providers-list';
import {
  ProviderModelsMatrix,
  type ModelRow,
} from '@/components/admin/orchestration/provider-models-matrix';
import { useUrlTabs } from '@/lib/hooks/use-url-tabs';

interface ProvidersTabsProps {
  initialProviders: ProviderRow[];
  initialModels: ModelRow[];
}

const ALLOWED_TABS = ['configuration', 'models'] as const;
type ProvidersTab = (typeof ALLOWED_TABS)[number];

export function ProvidersTabs({ initialProviders, initialModels }: ProvidersTabsProps) {
  const { activeTab, setActiveTab } = useUrlTabs<ProvidersTab>({
    defaultTab: 'configuration',
    allowedTabs: ALLOWED_TABS,
  });

  return (
    <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ProvidersTab)}>
      <TabsList>
        <TabsTrigger value="configuration">Configuration</TabsTrigger>
        <TabsTrigger value="models">Model Matrix</TabsTrigger>
      </TabsList>

      <TabsContent value="configuration">
        <ProvidersList initialProviders={initialProviders} />
      </TabsContent>

      <TabsContent value="models">
        <ProviderModelsMatrix initialModels={initialModels} />
      </TabsContent>
    </Tabs>
  );
}
