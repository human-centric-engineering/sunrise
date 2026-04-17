'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Database, Eye, Search } from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DEFAULT_KNOWLEDGE_TAB,
  KNOWLEDGE_TAB_TITLES,
  KNOWLEDGE_TAB_VALUES,
  type KnowledgeTab,
} from '@/lib/constants/knowledge';
import { useTrackedUrlTabs } from '@/lib/hooks/use-tracked-url-tabs';
import type { AiKnowledgeDocument } from '@/types/orchestration';

import { ManageTab } from './manage-tab';
import { ExploreTab } from './explore-tab';
import { VisualizeTab } from './visualize-tab';
import { ErrorsTab } from './errors-tab';

export type KnowledgeScope = 'all' | 'system' | 'app';

const SCOPE_OPTIONS: { value: KnowledgeScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'system', label: 'System' },
  { value: 'app', label: 'App' },
];

interface KnowledgeViewProps {
  documents: AiKnowledgeDocument[];
}

export function KnowledgeView({ documents }: KnowledgeViewProps) {
  const router = useRouter();
  const [scope, setScope] = useState<KnowledgeScope>('all');

  const { activeTab, setActiveTab } = useTrackedUrlTabs<KnowledgeTab>({
    defaultTab: DEFAULT_KNOWLEDGE_TAB,
    allowedTabs: [...KNOWLEDGE_TAB_VALUES],
    titles: KNOWLEDGE_TAB_TITLES,
  });

  const refresh = useCallback(() => {
    router.refresh();
  }, [router]);

  // The API scope param — undefined means "all"
  const apiScope = scope === 'all' ? undefined : scope;

  // Filter documents client-side for the Manage tab (server-fetched on page load)
  const filteredDocuments = useMemo(() => {
    if (scope === 'all') return documents;
    return documents.filter((d) => d.scope === scope);
  }, [documents, scope]);

  return (
    <div className="space-y-4">
      {/* Scope selector */}
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground text-xs font-medium">Scope</span>
        <div className="bg-muted inline-flex items-center rounded-lg p-1">
          {SCOPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setScope(opt.value)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                scope === opt.value
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as KnowledgeTab)}
        className="space-y-6"
      >
        <TabsList>
          <TabsTrigger value="manage" className="gap-1.5">
            <Database className="h-3.5 w-3.5" />
            Manage
          </TabsTrigger>
          <TabsTrigger value="explore" className="gap-1.5">
            <Search className="h-3.5 w-3.5" />
            Explore
          </TabsTrigger>
          <TabsTrigger value="visualize" className="gap-1.5">
            <Eye className="h-3.5 w-3.5" />
            Visualize
          </TabsTrigger>
          <TabsTrigger value="errors" className="gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            Errors
          </TabsTrigger>
        </TabsList>

        <TabsContent value="manage">
          <ManageTab documents={filteredDocuments} onRefresh={refresh} />
        </TabsContent>

        <TabsContent value="explore">
          <ExploreTab scope={apiScope} />
        </TabsContent>

        <TabsContent value="visualize">
          <VisualizeTab scope={apiScope} />
        </TabsContent>

        <TabsContent value="errors">
          <ErrorsTab scope={apiScope} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
