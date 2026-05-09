/**
 * Setup-required banner
 *
 * Server component. Renders nothing once the operator has at least one
 * provider configured. On a fresh install (no providers yet), shows an
 * informational card pointing the operator at the auto-opened setup
 * wizard in the page header.
 *
 * The wizard itself is opened by the dashboard page passing
 * `forceOpen` to `SetupWizardLauncher` — keeping that as the single
 * source of dialog truth avoids two wizards racing on mount.
 */

import { Sparkles } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';

export interface SetupRequiredBannerProps {
  hasProvider: boolean;
}

export function SetupRequiredBanner({
  hasProvider,
}: SetupRequiredBannerProps): React.ReactElement | null {
  if (hasProvider) return null;

  return (
    <Card
      data-testid="setup-required-banner"
      className="border-primary/30 bg-primary/5 dark:bg-primary/10"
    >
      <CardContent className="flex items-start gap-3 p-4">
        <Sparkles className="text-primary mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div className="flex-1 text-sm">
          <p className="font-medium">No LLM provider is configured yet.</p>
          <p className="text-muted-foreground">
            The setup wizard has opened to walk you through it — it will detect any API keys
            you&apos;ve set in <code>.env</code> and suggest a chat model for your agents.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
