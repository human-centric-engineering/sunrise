/**
 * OtherOrgUsage (§107 t-752)
 *
 * One line saying how many agents in OTHER organisations use a shared
 * setting — a provider model, a capability. Shared settings serve every org,
 * so the usage the admin pages show is counted across all of them; the
 * caller's own agents are listed by name, and another org's only as this
 * number, because their names are that org's business. Renders nothing at
 * zero, which is always the case on a single-org install.
 *
 * Server-safe (no hooks), so a server page and a client table use it alike.
 */

import { cn } from '@/lib/utils';

export interface OtherOrgUsageProps {
  /** Agents in other organisations; nothing renders at 0. */
  count: number;
  /** Say "…and N more" after a list of the caller's own agents. */
  afterList?: boolean;
  className?: string;
}

/** "N agent(s)". */
export function agentCount(count: number): string {
  return `${count} agent${count === 1 ? '' : 's'}`;
}

/**
 * Agents using a shared setting in every org: the caller's, which a row
 * lists, plus other orgs', which it counts. The one sum behind every count,
 * "in use" filter, sort and delete-disabled state on these pages.
 */
export function agentsInEveryOrg(row: { agents?: unknown[]; otherOrgAgentCount?: number }): number {
  return (row.agents?.length ?? 0) + (row.otherOrgAgentCount ?? 0);
}

export function OtherOrgUsage({ count, afterList = false, className }: OtherOrgUsageProps) {
  if (count <= 0) return null;
  return (
    <p className={cn('text-muted-foreground text-xs', className)}>
      {afterList ? '…and ' : ''}
      {agentCount(count)} in other organisations
      {afterList ? '' : ` ${count === 1 ? 'uses' : 'use'} it`}. They are counted, not named.
    </p>
  );
}
