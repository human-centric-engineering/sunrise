'use client';

/**
 * MCP Settings Form Component
 *
 * Form for editing McpServerConfig singleton values.
 */

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';

interface McpSettings {
  isEnabled: boolean;
  serverName: string;
  serverVersion: string;
  maxSessionsPerKey: number;
  globalRateLimit: number;
  auditRetentionDays: number;
}

interface McpSettingsFormProps {
  initialSettings: McpSettings | null;
}

export function McpSettingsForm({ initialSettings }: McpSettingsFormProps) {
  const [form, setForm] = useState({
    serverName: initialSettings?.serverName ?? 'Sunrise MCP Server',
    serverVersion: initialSettings?.serverVersion ?? '1.0.0',
    maxSessionsPerKey: initialSettings?.maxSessionsPerKey ?? 5,
    globalRateLimit: initialSettings?.globalRateLimit ?? 60,
    auditRetentionDays: initialSettings?.auditRetentionDays ?? 90,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.MCP_SETTINGS, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Server Configuration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="serverName">Server Name</Label>
            <Input
              id="serverName"
              value={form.serverName}
              onChange={(e) => setForm((f) => ({ ...f, serverName: e.target.value }))}
            />
          </div>
          <div>
            <Label htmlFor="serverVersion">Server Version</Label>
            <Input
              id="serverVersion"
              value={form.serverVersion}
              onChange={(e) => setForm((f) => ({ ...f, serverVersion: e.target.value }))}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="globalRateLimit">
              Global Rate Limit
              <FieldHelp title="Global Rate Limit">
                Maximum requests per minute per API key across all MCP methods. Individual tools can
                have stricter per-tool limits.
              </FieldHelp>
            </Label>
            <Input
              id="globalRateLimit"
              type="number"
              min={1}
              max={10000}
              value={form.globalRateLimit}
              onChange={(e) =>
                setForm((f) => ({ ...f, globalRateLimit: parseInt(e.target.value, 10) || 60 }))
              }
            />
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
              value={form.maxSessionsPerKey}
              onChange={(e) =>
                setForm((f) => ({ ...f, maxSessionsPerKey: parseInt(e.target.value, 10) || 5 }))
              }
            />
          </div>
          <div>
            <Label htmlFor="auditRetentionDays">
              Audit Retention Days
              <FieldHelp title="Audit Retention">
                Number of days to retain MCP audit logs. Cleanup is manual — use the &quot;Purge Old
                Logs&quot; button on the Audit Log page to delete entries older than this threshold.
                Set to 0 to keep logs forever.
              </FieldHelp>
            </Label>
            <Input
              id="auditRetentionDays"
              type="number"
              min={0}
              max={3650}
              value={form.auditRetentionDays}
              onChange={(e) =>
                setForm((f) => ({ ...f, auditRetentionDays: parseInt(e.target.value, 10) || 90 }))
              }
            />
            <p className="text-muted-foreground mt-1 text-xs">0 = keep forever</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
          {saved && <span className="text-sm text-green-600">Settings saved</span>}
        </div>
      </CardContent>
    </Card>
  );
}
