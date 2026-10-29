'use client';

/**
 * MCP Settings Form Component
 *
 * Form for editing McpServerConfig singleton values.
 * Uses react-hook-form + Zod for validation and dirty tracking.
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  SharedSettingsSaveHint,
  useSharedSettingsReadOnly,
} from '@/components/admin/shared-settings-access';
import { FieldHelp } from '@/components/ui/field-help';
import { SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { type McpSettingsResponse } from '@/lib/validations/mcp';
import { useTimeout } from '@/lib/hooks/use-timeout';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';

interface McpSettingsFormProps {
  initialSettings: McpSettingsResponse | null;
}

const mcpSettingsFormSchema = z.object({
  serverName: z.string().trim().min(1, 'Required').max(100),
  serverVersion: z.string().trim().min(1, 'Required').max(20),
  globalRateLimit: z.coerce.number().int().min(1, 'Min 1').max(10000, 'Max 10,000'),
  auditRetentionDays: z.coerce.number().int().min(0, 'Min 0').max(3650, 'Max 3,650'),
});

type McpSettingsFormInput = z.input<typeof mcpSettingsFormSchema>;
type McpSettingsFormData = z.output<typeof mcpSettingsFormSchema>;

/**
 * Server path → the field that shows its message. Only fields that render
 * `errors.x` are listed; every other path joins the summary by Save
 * (`.context/ui/form-errors.md`).
 */
const SERVER_FIELDS: Partial<Record<string, keyof McpSettingsFormInput>> = {
  serverName: 'serverName',
  serverVersion: 'serverVersion',
  globalRateLimit: 'globalRateLimit',
  auditRetentionDays: 'auditRetentionDays',
};

export function McpSettingsForm({ initialSettings }: McpSettingsFormProps) {
  const readOnly = useSharedSettingsReadOnly();
  const [saved, setSaved] = useState(false);
  const schedule = useTimeout();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty, isSubmitting },
    reset,
  } = useForm<McpSettingsFormInput>({
    resolver: zodResolver(mcpSettingsFormSchema),
    defaultValues: {
      serverName: initialSettings?.serverName ?? 'Sunrise MCP Server',
      serverVersion: initialSettings?.serverVersion ?? '1.0.0',
      globalRateLimit: initialSettings?.globalRateLimit ?? 60,
      auditRetentionDays: initialSettings?.auditRetentionDays ?? 90,
    },
  });

  const save = useSaveFailure({
    fallback: 'Could not save settings. Try again in a moment.',
    fields: SERVER_FIELDS,
    setError,
  });

  const onSubmit = async (data: McpSettingsFormData) => {
    setSaved(false);
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.MCP_SETTINGS, { body: data });
      setSaved(true);
      reset(data);
      schedule(() => setSaved(false), 3000);
    } catch (err) {
      save.report(err);
    }
  };

  return (
    <form
      noValidate
      onSubmit={save.submit(async (e) => {
        await handleSubmit(onSubmit as Parameters<typeof handleSubmit>[0], save.invalid)(e);
      })}
    >
      <Card>
        <CardHeader>
          <CardTitle>Server Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="serverName">
                Server Name
                <FieldHelp title="Server Name">
                  Identifies your MCP server in client UIs. Clients see this when listing connected
                  servers.
                </FieldHelp>
              </Label>
              <Input id="serverName" {...register('serverName')} />
              {errors.serverName && (
                <p className="mt-1 text-xs text-red-600">{errors.serverName.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="serverVersion">
                Server Version
                <FieldHelp title="Server Version">
                  Reported during MCP initialization. Use semver (e.g. 1.0.0). Clients may display
                  this for diagnostics.
                </FieldHelp>
              </Label>
              <Input id="serverVersion" {...register('serverVersion')} />
              {errors.serverVersion && (
                <p className="mt-1 text-xs text-red-600">{errors.serverVersion.message}</p>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <Label htmlFor="globalRateLimit">
                Global Rate Limit
                <FieldHelp title="Global Rate Limit">
                  Maximum requests per minute per API key across all MCP methods. Individual tools
                  can have stricter per-tool limits.
                </FieldHelp>
              </Label>
              <Input
                id="globalRateLimit"
                type="number"
                min={1}
                max={10000}
                {...register('globalRateLimit')}
              />
              {errors.globalRateLimit && (
                <p className="mt-1 text-xs text-red-600">{errors.globalRateLimit.message}</p>
              )}
              <p className="text-muted-foreground mt-1 text-xs">requests/min per key</p>
            </div>
            <div>
              <Label htmlFor="auditRetentionDays">
                Audit Retention Days
                <FieldHelp title="Audit Retention">
                  Number of days to retain MCP audit logs. Cleanup is manual — use the &quot;Purge
                  Old Logs&quot; button on the Audit Log page to delete entries older than this
                  threshold. Set to 0 to keep logs forever.
                </FieldHelp>
              </Label>
              <Input
                id="auditRetentionDays"
                type="number"
                min={0}
                max={3650}
                {...register('auditRetentionDays')}
              />
              {errors.auditRetentionDays && (
                <p className="mt-1 text-xs text-red-600">{errors.auditRetentionDays.message}</p>
              )}
              <p className="text-muted-foreground mt-1 text-xs">0 = keep forever</p>
            </div>
          </div>

          <div className="space-y-2">
            <SaveError failure={save.failure} />
            <div className="flex items-center gap-3">
              <SharedSettingsSaveHint />
              <Button type="submit" disabled={readOnly || !isDirty || isSubmitting}>
                {isSubmitting ? 'Saving...' : 'Save Settings'}
              </Button>
              {saved && <span className="text-sm text-green-600">Saved</span>}
            </div>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
