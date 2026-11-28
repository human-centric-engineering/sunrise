'use client';

/**
 * The named tiers an org admin may grant a MEMBER, as ticks (t-1123).
 *
 * Used by the invite form and by a member's console-access dialog. The tiers
 * and their words come from `GET /api/v1/orgs/[id]/members`
 * (`grantableTiers`), already in the viewer's language: the app named them
 * with `registerAdminTier()`. Renders nothing for an empty list, so an
 * install whose app registered no grantable tier shows no new control.
 */

import { Checkbox } from '@/components/ui/checkbox';

/** One tier an org admin may grant, named for the reader. */
export interface GrantableTier {
  name: string;
  label: string;
  description?: string;
}

export interface TierChecklistProps {
  tiers: GrantableTier[];
  /** The ticked tiers' names. */
  value: string[];
  onChange: (next: string[]) => void;
  /** Prefixes each checkbox's id, so two lists on one page do not collide. */
  idPrefix: string;
  disabled?: boolean;
}

export function TierChecklist({ tiers, value, onChange, idPrefix, disabled }: TierChecklistProps) {
  if (tiers.length === 0) return null;
  const ticked = new Set(value);
  // In the tiers' own order, whatever order they were ticked in.
  const toggle = (name: string, on: boolean) =>
    onChange(tiers.map((t) => t.name).filter((n) => (n === name ? on : ticked.has(n))));

  return (
    <ul className="space-y-2">
      {tiers.map((tier) => {
        const id = `${idPrefix}-${tier.name}`;
        return (
          <li key={tier.name} className="flex items-start gap-2">
            <Checkbox
              id={id}
              className="mt-0.5"
              checked={ticked.has(tier.name)}
              disabled={disabled}
              onCheckedChange={(on) => toggle(tier.name, on)}
              aria-describedby={tier.description ? `${id}-description` : undefined}
            />
            <div className="text-sm">
              <label htmlFor={id} className="font-medium">
                {tier.label}
              </label>
              {tier.description && (
                <p id={`${id}-description`} className="text-muted-foreground">
                  {tier.description}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
