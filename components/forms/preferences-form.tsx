'use client';

/**
 * Email Preferences Form
 *
 * Form for managing email notification preferences.
 * Security alerts cannot be disabled.
 *
 * Phase 3.2: User Management
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Loader2, CheckCircle2, ShieldCheck } from 'lucide-react';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useAnalytics, EVENTS } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SaveError } from '@/components/forms/form-error';
import { useTimeout } from '@/lib/hooks/use-timeout';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import type { UserPreferences } from '@/types';

interface PreferencesFormProps {
  preferences: UserPreferences;
}

export function PreferencesForm({ preferences }: PreferencesFormProps) {
  const t = useTranslations('account.preferences');
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const save = useSaveFailure({
    fallback: t('saveFailed'),
    fields: NO_SERVER_FIELDS,
  });
  const [success, setSuccess] = useState(false);
  const schedule = useTimeout();
  const { track } = useAnalytics();

  // Local state for toggles
  const [marketing, setMarketing] = useState(preferences.email.marketing);
  const [productUpdates, setProductUpdates] = useState(preferences.email.productUpdates);

  const handleSave = async () => {
    try {
      setIsLoading(true);
      save.clear();
      setSuccess(false);

      await apiClient.patch<UserPreferences>(API.USERS.ME_PREFERENCES, {
        body: {
          email: {
            marketing,
            productUpdates,
            securityAlerts: true, // Always true
          },
        },
      });

      // Track preferences update
      void track(EVENTS.PREFERENCES_UPDATED, { marketing, product_updates: productUpdates });

      setSuccess(true);
      router.refresh();

      // Reset success after 3 seconds
      schedule(() => setSuccess(false), 3000);
    } catch (err) {
      save.report(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Marketing Emails */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="marketing" className="flex items-center gap-1 text-base">
            {t('marketing')}
            <FieldHelp title={t('marketingHelpTitle')}>{t('marketingHelp')}</FieldHelp>
          </Label>
          <p className="text-muted-foreground text-sm">{t('marketingHint')}</p>
        </div>
        <Switch
          id="marketing"
          checked={marketing}
          onCheckedChange={setMarketing}
          disabled={isLoading}
        />
      </div>

      {/* Product Updates */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="productUpdates" className="flex items-center gap-1 text-base">
            {t('productUpdates')}
            <FieldHelp title={t('productUpdatesHelpTitle')}>{t('productUpdatesHelp')}</FieldHelp>
          </Label>
          <p className="text-muted-foreground text-sm">{t('productUpdatesHint')}</p>
        </div>
        <Switch
          id="productUpdates"
          checked={productUpdates}
          onCheckedChange={setProductUpdates}
          disabled={isLoading}
        />
      </div>

      {/* Security Alerts (always on) */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <Label htmlFor="securityAlerts" className="flex items-center gap-1 text-base">
              {t('securityAlerts')}
              <FieldHelp title={t('securityAlertsHelpTitle')}>{t('securityAlertsHelp')}</FieldHelp>
            </Label>
            <ShieldCheck className="text-primary h-4 w-4" />
          </div>
          <p className="text-muted-foreground text-sm">{t('securityAlertsHint')}</p>
        </div>
        <Switch
          id="securityAlerts"
          checked={true}
          disabled={true}
          aria-label={t('securityAlertsAria')}
        />
      </div>

      <p className="text-muted-foreground text-xs">{t('securityNote')}</p>

      <SaveError failure={save.failure} />

      {/* Success message */}
      {success && (
        <div className="flex items-center gap-2 rounded-md bg-green-50 p-3 text-sm text-green-900 dark:bg-green-950/50 dark:text-green-300">
          <CheckCircle2 className="h-4 w-4" />
          {t('success')}
        </div>
      )}

      {/* Save button */}
      <Button onClick={() => void handleSave()} disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('saving')}
          </>
        ) : (
          t('save')
        )}
      </Button>
    </div>
  );
}
