/**
 * ProviderModelUses (§136 t-1065)
 *
 * On a provider model's edit page: where the model is in its retirement, and
 * everything that uses it — agents and workflows (the caller's org's by name,
 * other orgs' counted), and the install settings that name it. The data is
 * the model route's `lifecycle` and `uses` (`GET /provider-models/:id`).
 *
 * An agent whose model the platform picks says so: it moves off a retiring
 * model on its own. Everything else moves with the page's `action`, the move
 * dialog (§136 t-1066). The embedding settings say they are not moved with the
 * rest, since changing the embedding model means re-embedding (§132). The
 * app's own uses, when it reports any (§136 t-1067), are listed after the
 * rest: the app moves those itself.
 *
 * Server-safe (no hooks).
 */

import type { ReactNode } from 'react';
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
  /** `byIdOnly`: every step pinning the model names its id alone (§136 t-1068). */
  workflows: Array<{ id: string; name: string; byIdOnly: boolean }>;
  otherOrgAgents: number;
  otherOrgAgentsFollowingPlatform: number;
  otherOrgWorkflows: number;
  /** How many of `otherOrgWorkflows` pin it by id alone. */
  otherOrgWorkflowsByIdOnly: number;
  settings: SettingsPin[];
  /** Other providers that offer the same model id (§136 t-1065). */
  sharedWith: string[];
  /** The app's own uses in the caller's org, as it reports them (§136 t-1067). */
  appPins?: Array<{ label: string; where: string }>;
  /** The app's uses in other orgs, counted. */
  otherOrgAppPins?: number;
  /** Some org's report of the app's uses failed. */
  appPinsUnavailable?: boolean;
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
  /**
   * Shown beside the heading: the move (§136 t-1066). Rendered whatever the
   * uses, so a dialog open across the page's refresh stays mounted; it decides
   * itself when to show its trigger (`modelHasUses`).
   */
  action?: ReactNode;
}

/**
 * Whether anything uses the model: an agent or workflow in any org, a
 * setting, or a use the app reports.
 */
export function modelHasUses(uses: ProviderModelUsesData): boolean {
  return (
    uses.agents.length +
      uses.otherOrgAgents +
      uses.workflows.length +
      uses.otherOrgWorkflows +
      uses.settings.length +
      (uses.appPins?.length ?? 0) +
      (uses.otherOrgAppPins ?? 0) >
    0
  );
}

/** The app's own uses (§136 t-1067): named in the caller's org, counted elsewhere. */
function AppUses({ uses }: { uses: ProviderModelUsesData }) {
  const own = uses.appPins ?? [];
  const elsewhere = uses.otherOrgAppPins ?? 0;
  if (own.length === 0 && elsewhere === 0 && !uses.appPinsUnavailable) return null;
  return (
    <div className="space-y-1">
      <h3 className="text-muted-foreground text-xs font-medium uppercase">In the app</h3>
      <ul className="space-y-1 text-sm">
        {own.map((pin, i) => (
          <li key={`${pin.label}-${i}`}>
            {pin.label}
            <p className="text-muted-foreground text-xs">{pin.where}</p>
          </li>
        ))}
      </ul>
      {elsewhere > 0 && (
        <p className="text-muted-foreground text-xs">
          {elsewhere} in other organisations. They are counted, not named.
        </p>
      )}
      {(own.length > 0 || elsewhere > 0) && (
        <p className="text-muted-foreground text-xs">
          The app sets these itself, so moving the model’s uses does not change them.
        </p>
      )}
      {uses.appPinsUnavailable && (
        <p className="text-muted-foreground text-xs">
          The app’s own uses could not all be read, so there may be more.
        </p>
      )}
    </div>
  );
}

export function ProviderModelUses({ retiresAt, lifecycle, uses, action }: ProviderModelUsesProps) {
  const nothing = !modelHasUses(uses);
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
        {/* Always rendered: an open move dialog must outlive the refresh that
            follows a move, after which nothing may use the model. The dialog
            hides its own trigger then. */}
        {action && <div className="ml-auto">{action}</div>}
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
        <p className="text-muted-foreground text-sm">
          {uses.appPinsUnavailable
            ? 'Nothing Sunrise can see uses this model.'
            : 'Nothing uses this model.'}
        </p>
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
                      title="Sunrise picks this agent's model, and moves it off a retiring model on its own when another one it can use is available."
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
                  {workflow.byIdOnly && uses.sharedWith.length > 0 && (
                    <span title="Named by model id alone">*</span>
                  )}
                </li>
              ))}
            </ul>
            {uses.otherOrgWorkflows > 0 && (
              <p className="text-muted-foreground text-xs">
                {workflowCount(uses.otherOrgWorkflows)} in other organisations
                {uses.sharedWith.length > 0 && uses.otherOrgWorkflowsByIdOnly > 0
                  ? ` (${uses.otherOrgWorkflowsByIdOnly} by model id alone)`
                  : ''}
                . They are counted, not named.
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
                  {pin.byIdOnly && uses.sharedWith.length > 0 && (
                    <span title="Named by model id alone">*</span>
                  )}
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

      <AppUses uses={uses} />

      {!nothing &&
        uses.sharedWith.length > 0 &&
        (uses.workflows.some((workflow) => workflow.byIdOnly) ||
          uses.otherOrgWorkflowsByIdOnly > 0 ||
          uses.settings.some((pin) => pin.byIdOnly)) && (
          <p className="text-muted-foreground text-xs">
            The uses marked * name this model by its id alone, with no provider, which{' '}
            {uses.sharedWith.join(', ')} also {uses.sharedWith.length === 1 ? 'offers' : 'offer'}.
            They may run on that provider&apos;s model instead, so they are listed here too.
          </p>
        )}
    </section>
  );
}
