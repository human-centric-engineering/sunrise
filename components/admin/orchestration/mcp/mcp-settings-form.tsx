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
import { FieldHelp } from '@/components/ui/field-help';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

interface McpSettings {
  isEnabled: boolean;
  serverName: string;
  serverVersion: string;
  maxSessionsPerKey: number;
  globalRateLimit: number;
  auditRetentionDays: number;
}

export type { McpSettings };

interface McpSettingsFormProps {
  initialSettings: McpSettings | null;
}

const mcpSettingsFormSchema = z.object({
  serverName: z.string().min(1, 'Required').max(100).trim(),
  serverVersion: z.string().min(1, 'Required').max(20).trim(),
  maxSessionsPerKey: z.coerce.number().int().min(1, 'Min 1').max(100, 'Max 100'),
  globalRateLimit: z.coerce.number().int().min(1, 'Min 1').max(10000, 'Max 10,000'),
  auditRetentionDays: z.coerce.number().int().min(0, 'Min 0').max(3650, 'Max 3,650'),
});

type McpSettingsFormInput = z.input<typeof mcpSettingsFormSchema>;
type McpSettingsFormData = z.output<typeof mcpSettingsFormSchema>;

export function McpSettingsForm({ initialSettings }: McpSettingsFormProps) {
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty, isSubmitting },
    reset,
  } = useForm<McpSettingsFormInput>({
    resolver: zodResolver(mcpSettingsFormSchema),
    defaultValues: {
      serverName: initialSettings?.serverName ?? 'Sunrise MCP Server',
      serverVersion: initialSettings?.serverVersion ?? '1.0.0',
      maxSessionsPerKey: initialSettings?.maxSessionsPerKey ?? 5,
      globalRateLimit: initialSettings?.globalRateLimit ?? 60,
      auditRetentionDays: initialSettings?.auditRetentionDays ?? 90,
    },
  });

  const onSubmit = async (data: McpSettingsFormData) => {
    setSaved(false);
    setError(null);
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.MCP_SETTINGS, { body: data });
      setSaved(true);
      reset(data as unknown as McpSettingsFormInput);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      if (err instanceof APIClientError) {
        setError(err.message);
      } else {
        setError('Could not save settings. Try again in a moment.');
      }
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit as Parameters<typeof handleSubmit>[0])(e)}>
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
              <Label htmlFor="maxSessionsPerKey">
                Max Sessions Per Key
                <FieldHelp title="Max Sessions Per Key">
                  Maximum concurrent MCP sessions allowed per API key. Prevents a single key from
                  exhausting server resources.
                </FieldHelp>
              </Label>
              <Input
                id="maxSessionsPerKey"
                type="number"
                min={1}
                max={100}
                {...register('maxSessionsPerKey')}
              />
              {errors.maxSessionsPerKey && (
                <p className="mt-1 text-xs text-red-600">{errors.maxSessionsPerKey.message}</p>
              )}
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

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!isDirty || isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Save Settings'}
            </Button>
            {saved && <span className="text-sm text-green-600">Saved</span>}
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
