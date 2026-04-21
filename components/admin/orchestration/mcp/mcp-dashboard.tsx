'use client';

/**
 * MCP Dashboard Component
 *
 * Shows master toggle, quick stats, and links to sub-pages.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Wrench, Database, Key, FileText, Settings, Activity } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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

interface McpDashboardProps {
  initialSettings: McpSettings | null;
  stats: { tools: number; resources: number; keys: number };
}

const DEFAULT_SETTINGS: McpSettings = {
  isEnabled: false,
  serverName: 'Sunrise MCP Server',
  serverVersion: '1.0.0',
  maxSessionsPerKey: 5,
  globalRateLimit: 60,
  auditRetentionDays: 90,
};

export function McpDashboard({ initialSettings, stats }: McpDashboardProps) {
  const [settings, setSettings] = useState<McpSettings>(initialSettings ?? DEFAULT_SETTINGS);
  const [toggling, setToggling] = useState(false);

  async function handleToggle(enabled: boolean) {
    const prev = settings;
    setSettings((s) => ({ ...s, isEnabled: enabled }));
    setToggling(true);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.MCP_SETTINGS, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled: enabled }),
      });
      if (res.ok) {
        const raw: unknown = await res.json();
        if (
          typeof raw === 'object' &&
          raw !== null &&
          'success' in raw &&
          (raw as Record<string, unknown>).success === true &&
          'data' in raw
        ) {
          setSettings((raw as Record<string, unknown>).data as McpSettings);
        } else {
          setSettings(prev);
        }
      } else {
        setSettings(prev);
      }
    } catch {
      setSettings(prev);
    } finally {
      setToggling(false);
    }
  }

  const quickLinks = [
    {
      href: '/admin/orchestration/mcp/tools',
      label: 'Exposed Tools',
      icon: Wrench,
      count: stats.tools,
      description:
        'Choose which capabilities (actions) external AI clients can call — e.g. send email, run queries',
    },
    {
      href: '/admin/orchestration/mcp/resources',
      label: 'Resources',
      icon: Database,
      count: stats.resources,
      description:
        'Expose read-only data endpoints — knowledge base, agent configs, workflows — for clients to browse',
    },
    {
      href: '/admin/orchestration/mcp/keys',
      label: 'API Keys',
      icon: Key,
      count: stats.keys,
      description:
        'Create bearer tokens that clients use to authenticate. Each key has scoped permissions',
    },
    {
      href: '/admin/orchestration/mcp/audit',
      label: 'Audit Log',
      icon: FileText,
      count: null,
      description: 'Review every MCP operation — who called what, when, and whether it succeeded',
    },
    {
      href: '/admin/orchestration/mcp/settings',
      label: 'Settings',
      icon: Settings,
      count: null,
      description: 'Configure rate limits, max sessions per key, and audit log retention',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Master Toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <Activity className="h-5 w-5" />
            Server Status
            <Badge variant={settings.isEnabled ? 'default' : 'secondary'}>
              {settings.isEnabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </CardTitle>
          <CardDescription>
            {settings.isEnabled
              ? `Accepting connections at /api/v1/mcp — ${settings.serverName} v${settings.serverVersion}`
              : 'MCP server is disabled. External clients cannot connect.'}
          </CardDescription>
          <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs">
            <span>
              Protocol: <strong className="text-foreground">MCP 2024-11-05</strong>
            </span>
            <span>
              Transport: <strong className="text-foreground">Streamable HTTP</strong>
            </span>
            <span>
              Messages: <strong className="text-foreground">JSON-RPC 2.0</strong>
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              id="mcp-enabled"
              checked={settings.isEnabled}
              onCheckedChange={(checked) => void handleToggle(checked)}
              disabled={toggling}
              aria-label="Enable MCP server"
            />
            <Label htmlFor="mcp-enabled" className="text-sm">
              {settings.isEnabled ? 'Server is accepting MCP connections' : 'Enable MCP server'}
            </Label>
            <FieldHelp title="MCP Server Status">
              When disabled, all MCP clients receive 503 Service Unavailable. Existing sessions are
              not terminated but cannot make new requests.
            </FieldHelp>
          </div>
        </CardContent>
      </Card>

      {/* Quick Links */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {quickLinks.map((link) => {
          const Icon = link.icon;
          return (
            <Link key={link.href} href={link.href} className="h-full">
              <Card className="hover:border-primary/50 h-full transition-colors">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-sm font-medium">
                    <span className="flex items-center gap-2">
                      <Icon className="h-4 w-4" />
                      {link.label}
                    </span>
                    {link.count !== null && <Badge variant="secondary">{link.count}</Badge>}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground text-xs">{link.description}</p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      {/* Connection Info */}
      {settings.isEnabled && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Client Configuration</CardTitle>
            <CardDescription>
              Add this to your MCP client&apos;s config file (e.g.{' '}
              <code className="text-xs">claude_desktop_config.json</code> for Claude Desktop, or{' '}
              <code className="text-xs">.cursor/mcp.json</code> for Cursor)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted overflow-x-auto rounded-md p-4 text-xs">
              {JSON.stringify(
                {
                  mcpServers: {
                    sunrise: {
                      url: '{YOUR_APP_URL}/api/v1/mcp',
                      headers: {
                        Authorization: 'Bearer smcp_YOUR_API_KEY',
                      },
                    },
                  },
                },
                null,
                2
              )}
            </pre>
            <p className="text-muted-foreground mt-3 text-xs">
              Replace <code>{'YOUR_APP_URL'}</code> with your deployment URL and{' '}
              <code>{'smcp_YOUR_API_KEY'}</code> with a key from the API Keys page.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Getting Started — show when nothing is configured yet */}
      {stats.tools === 0 && stats.keys === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Getting Started</CardTitle>
            <CardDescription>
              Set up your MCP server in three steps so external AI clients can use your capabilities
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="text-muted-foreground space-y-3 text-sm">
              <li className="flex gap-3">
                <span className="bg-primary text-primary-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                  1
                </span>
                <div>
                  <p className="text-foreground font-medium">Expose tools or resources</p>
                  <p>
                    Go to <strong>Exposed Tools</strong> to select which capabilities clients can
                    call, or <strong>Resources</strong> to share read-only data like your knowledge
                    base.
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="bg-primary text-primary-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                  2
                </span>
                <div>
                  <p className="text-foreground font-medium">Create an API key</p>
                  <p>
                    Go to <strong>API Keys</strong> and create a key with the scopes the client
                    needs (e.g. <code className="text-xs">tools:list</code> +{' '}
                    <code className="text-xs">tools:execute</code>). Copy the key — it is shown only
                    once.
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <span className="bg-primary text-primary-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                  3
                </span>
                <div>
                  <p className="text-foreground font-medium">Enable the server and connect</p>
                  <p>
                    Toggle the server on at the top of this page. Once enabled, a connection snippet
                    will appear above that you can copy into your MCP client&apos;s config file.
                  </p>
                </div>
              </li>
            </ol>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
