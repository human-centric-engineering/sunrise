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
import { useRouter } from 'next/navigation';
import { Loader2, CheckCircle2, ShieldCheck } from 'lucide-react';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useAnalytics, EVENTS } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { UserPreferences } from '@/types';

interface PreferencesFormProps {
  preferences: UserPreferences;
}

export function PreferencesForm({ preferences }: PreferencesFormProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const { track } = useAnalytics();

  // Local state for toggles
  const [marketing, setMarketing] = useState(preferences.email.marketing);
  const [productUpdates, setProductUpdates] = useState(preferences.email.productUpdates);

  const handleSave = async () => {
    try {
      setIsLoading(true);
      setError(null);
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
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      if (err instanceof APIClientError) {
        setError(err.message || 'Failed to update preferences');
      } else {
        setError('An unexpected error occurred');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Marketing Emails */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="marketing" className="text-base">
            Marketing Emails
          </Label>
          <p className="text-muted-foreground text-sm">
            Receive newsletters, promotions, and product news.
          </p>
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
          <Label htmlFor="productUpdates" className="text-base">
            Product Updates
          </Label>
          <p className="text-muted-foreground text-sm">
            Get notified about new features and improvements.
          </p>
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
            <Label htmlFor="securityAlerts" className="text-base">
              Security Alerts
            </Label>
            <ShieldCheck className="text-primary h-4 w-4" />
          </div>
          <p className="text-muted-foreground text-sm">
            Important security notifications about your account.
          </p>
        </div>
        <Switch
          id="securityAlerts"
          checked={true}
          disabled={true}
          aria-label="Security alerts are always enabled"
        />
      </div>

      <p className="text-muted-foreground text-xs">
        Security alerts cannot be disabled for your protection.
      </p>

      {/* Error message */}
      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      )}

      {/* Success message */}
      {success && (
        <div className="flex items-center gap-2 rounded-md bg-green-50 p-3 text-sm text-green-900 dark:bg-green-950/50 dark:text-green-300">
          <CheckCircle2 className="h-4 w-4" />
          Preferences saved successfully
        </div>
      )}

      {/* Save button */}
      <Button onClick={() => void handleSave()} disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Saving...
          </>
        ) : (
          'Save Preferences'
        )}
      </Button>
    </div>
  );
}
