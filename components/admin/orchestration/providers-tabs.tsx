'use client';

/**
 * ProvidersTabs — tabbed container for the Providers page.
 *
 * Tab 1: Configuration — card grid of AiProviderConfig rows (operational config).
 * Tab 2: Model Matrix — flat table of AiProviderModel rows (selection heuristic).
 *
 * Respects `?tab=models` query param for deep-linking (e.g. from redirects).
 */

import { useSearchParams } from 'next/navigation';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProvidersList, type ProviderRow } from '@/components/admin/orchestration/providers-list';
import {
  ProviderModelsMatrix,
  type ModelRow,
} from '@/components/admin/orchestration/provider-models-matrix';

interface ProvidersTabsProps {
  initialProviders: ProviderRow[];
  initialModels: ModelRow[];
}

const VALID_TABS = ['configuration', 'models'] as const;

export function ProvidersTabs({ initialProviders, initialModels }: ProvidersTabsProps) {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const defaultTab = VALID_TABS.includes(tabParam as (typeof VALID_TABS)[number])
    ? (tabParam as string)
    : 'configuration';

  return (
    <Tabs defaultValue={defaultTab}>
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
