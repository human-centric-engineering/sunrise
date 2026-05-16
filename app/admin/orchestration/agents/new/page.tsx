import type { Metadata } from 'next';
import Link from 'next/link';

import { AgentForm } from '@/components/admin/orchestration/agent-form';
import {
  getAgentModels,
  getEffectiveAgentDefaults,
  getProviders,
} from '@/lib/orchestration/prefetch-helpers';

export const metadata: Metadata = {
  title: 'New agent · AI Orchestration',
  description: 'Create a new AI agent.',
};

/**
 * Admin — New agent page (Phase 4 Session 4.2).
 *
 * Thin server shell that prefetches the provider list and the curated
 * provider matrix (chat + reasoning capabilities only) so the AgentForm's
 * Model tab hydrates with no loading flicker. Restricted to the same
 * matrix the settings page uses, so an agent can only be configured with
 * models the operator has actually added — avoids the runtime "provider
 * unavailable" trap that the broader registry view permitted. Both
 * fetches are null-safe — on failure the form falls back to free-text
 * inputs with a warning banner.
 */

export default async function NewAgentPage() {
  const [providers, models, effectiveDefaults] = await Promise.all([
    getProviders(),
    getAgentModels(),
    getEffectiveAgentDefaults({ provider: '', model: '' }),
  ]);

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <Link href="/admin/orchestration/agents" className="hover:underline">
          Agents
        </Link>
        {' / '}
        <span>New</span>
      </nav>

      <AgentForm
        mode="create"
        providers={providers}
        models={models}
        effectiveDefaults={effectiveDefaults}
      />
    </div>
  );
}
