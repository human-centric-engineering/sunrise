/**
 * Top capabilities panel (Phase 7 Session 7.2)
 *
 * Server component. Displays a ranked list of the most-used capabilities
 * by invocation count with a proportional width bar.
 */

import { Wrench } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface CapabilityUsage {
  slug: string;
  count: number;
}

export interface TopCapabilitiesPanelProps {
  capabilities: CapabilityUsage[] | null;
}

export function TopCapabilitiesPanel({ capabilities }: TopCapabilitiesPanelProps) {
  const display = capabilities ?? [];
  const maxCount = display.length > 0 ? display[0].count : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Top Capabilities</CardTitle>
      </CardHeader>
      <CardContent>
        {display.length === 0 ? (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Wrench className="h-4 w-4" aria-hidden="true" />
            <span>No capability usage recorded</span>
          </div>
        ) : (
          <ul className="space-y-3 text-sm">
            {display.map((cap) => {
              const widthPercent = maxCount > 0 ? (cap.count / maxCount) * 100 : 0;
              return (
                <li key={cap.slug}>
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{cap.slug}</span>
                    <span className="text-muted-foreground text-xs">
                      {cap.count.toLocaleString()}
                    </span>
                  </div>
                  <div className="bg-muted mt-1 h-1.5 w-full rounded-full">
                    <div
                      className="bg-primary h-1.5 rounded-full"
                      style={{ width: `${widthPercent}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
