/**
 * ProviderModelUses (§136 t-1065)
 *
 * On a provider model's edit page: where the model is in its retirement, and
 * everything that uses it — agents and workflows (the caller's org's by name,
 * other orgs' counted), and the install settings that name it. The data is
 * the model route's `lifecycle` and `uses` (`GET /provider-models/:id`).
 *
 * An agent whose model the platform picks says so: it moves off a retiring
 * model on its own. The embedding settings say they are not moved with the
 * rest, since changing the embedding model means re-embedding (§132).
 *
 * Server-safe (no hooks).
 */

import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { agentCount } from '@/components/admin/orchestration/other-org-usage';
import type {
  SettingsPin,
  SettingsPinSlot,
} from '@/lib/orchestration/model-lifecycle/settings-pins';
import type { ModelLifecycleState } from '@/lib/orchestration/model-lifecycle/state';

export interface ProviderModelLifecycleData {
  state: ModelLifecycleState;
  replacement: {
    id: string;
    name: string;
    modelId: string;
    /** Read so the page can say when a stored replacement has stopped qualifying. */
    isActive?: boolean;
    retiresAt?: string | null;
  } | null;
}

export interface ProviderModelUsesData {
  agents: Array<{ id: string; name: string; followsPlatform: boolean }>;
  workflows: Array<{ id: string; name: string }>;
  otherOrgAgents: number;
  otherOrgAgentsFollowingPlatform: number;
  otherOrgWorkflows: number;
  settings: SettingsPin[];
}

const SLOT_LABEL: Record<SettingsPinSlot, string> = {
  routing: 'Default model for routing',
  chat: 'Default model for chat',
  reasoning: 'Default model for reasoning',
  embeddings: 'Default model for embeddings',
  audio: 'Default model for audio',
  confidential: 'Model for confidential messages',
  active_embedding: 'Active embedding model',
};

/** "1 March 2027", in UTC, as the day is stored. */
function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Why a stored replacement no longer qualifies, or `null`. The rows can change
 * after the replacement was chosen (§136 t-1064), so it is checked as shown.
 */
function replacementProblem(replacement: {
  isActive?: boolean;
  retiresAt?: string | null;
}): string | null {
  if (replacement.isActive === false) return 'It has been turned off';
  if (replacement.retiresAt) return 'It is itself being retired';
  return null;
}

function workflowCount(count: number): string {
  return `${count} workflow${count === 1 ? '' : 's'}`;
}

export interface ProviderModelUsesProps {
  retiresAt: string | null;
  lifecycle: ProviderModelLifecycleData;
  uses: ProviderModelUsesData;
}

export function ProviderModelUses({ retiresAt, lifecycle, uses }: ProviderModelUsesProps) {
  const nothing =
    uses.agents.length +
      uses.otherOrgAgents +
      uses.workflows.length +
      uses.otherOrgWorkflows +
      uses.settings.length ===
    0;
  const { state, replacement } = lifecycle;

  return (
    <section aria-labelledby="model-uses-heading" className="space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="model-uses-heading" className="text-sm font-medium">
          Retirement and uses
        </h2>
        {state === 'retiring' && retiresAt && (
          <Badge
            variant="outline"
            className="border-amber-500/60 text-amber-700 dark:text-amber-300"
          >
            Retiring on {formatDay(retiresAt)}
          </Badge>
        )}
        {state === 'retired' && retiresAt && (
          <Badge variant="destructive">Retired on {formatDay(retiresAt)}</Badge>
        )}
      </div>

      {state !== 'current' && (
        <p className="text-sm">
          {replacement ? (
            <>
              Replacement:{' '}
              <Link
                href={`/admin/orchestration/provider-models/${replacement.id}`}
                className="font-medium hover:underline"
              >
                {replacement.name}
              </Link>{' '}
              <span className="text-muted-foreground">({replacement.modelId})</span>
              {replacementProblem(replacement) && (
                <span className="text-destructive block text-xs">
                  {replacementProblem(replacement)}: choose another before moving anything to it.
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">No replacement named yet.</span>
          )}
        </p>
      )}

      {nothing ? (
        <p className="text-muted-foreground text-sm">Nothing uses this model.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <h3 className="text-muted-foreground text-xs font-medium uppercase">Agents</h3>
            {uses.agents.length === 0 && uses.otherOrgAgents === 0 && (
              <p className="text-muted-foreground text-sm">None</p>
            )}
            <ul className="space-y-1 text-sm">
              {uses.agents.map((agent) => (
                <li key={agent.id} className="flex flex-wrap items-center gap-1">
                  <Link
                    href={`/admin/orchestration/agents/${agent.id}`}
                    className="hover:underline"
                  >
                    {agent.name}
                  </Link>
                  {agent.followsPlatform && (
                    <Badge
                      variant="outline"
                      className="text-[10px] font-normal"
                      title="Sunrise picks this agent's model, and moves it off a retiring model on its own."
                    >
                      follows the platform
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
            {uses.otherOrgAgents > 0 && (
              <p className="text-muted-foreground text-xs">
                {agentCount(uses.otherOrgAgents)} in other organisations
                {uses.otherOrgAgentsFollowingPlatform > 0
                  ? `, ${uses.otherOrgAgentsFollowingPlatform} following the platform`
                  : ''}
                . They are counted, not named.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <h3 className="text-muted-foreground text-xs font-medium uppercase">Workflows</h3>
            {uses.workflows.length === 0 && uses.otherOrgWorkflows === 0 && (
              <p className="text-muted-foreground text-sm">None</p>
            )}
            <ul className="space-y-1 text-sm">
              {uses.workflows.map((workflow) => (
                <li key={workflow.id}>
                  <Link
                    href={`/admin/orchestration/workflows/${workflow.id}`}
                    className="hover:underline"
                  >
                    {workflow.name}
                  </Link>
                </li>
              ))}
            </ul>
            {uses.otherOrgWorkflows > 0 && (
              <p className="text-muted-foreground text-xs">
                {workflowCount(uses.otherOrgWorkflows)} in other organisations. They are counted,
                not named.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <h3 className="text-muted-foreground text-xs font-medium uppercase">Settings</h3>
            {uses.settings.length === 0 && <p className="text-muted-foreground text-sm">None</p>}
            <ul className="space-y-1 text-sm">
              {uses.settings.map((pin) => (
                <li key={pin.slot}>
                  {SLOT_LABEL[pin.slot]}
                  {pin.source === 'suggested' && (
                    <span className="text-muted-foreground"> (the system&apos;s suggestion)</span>
                  )}
                  {pin.movedBy === 'embedding_switch' && (
                    <p className="text-muted-foreground text-xs">
                      Not moved with the others: changing the embedding model means re-embedding
                      every document.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
