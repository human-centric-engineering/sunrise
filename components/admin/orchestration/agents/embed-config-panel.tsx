'use client';

/**
 * EmbedConfigPanel
 *
 * Admin panel for the agent form's Embed tab. Composes two sections:
 *   1. WidgetAppearanceSection — colours, copy, conversation starters
 *      (per-agent widgetConfig)
 *   2. TokensCard — token CRUD (create / toggle / delete) and copy
 *      <script> snippet for partner sites
 */

import * as React from 'react';
import { Copy, Plus, Trash2, Check, Power, PowerOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import { Badge } from '@/components/ui/badge';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { WidgetAppearanceSection } from '@/components/admin/orchestration/agents/widget-appearance-section';

interface EmbedToken {
  id: string;
  token: string;
  label: string | null;
  allowedOrigins: string[];
  isActive: boolean;
  createdAt: string;
  creator: { id: string; name: string | null };
}

interface EmbedConfigPanelProps {
  agentId: string;
  appUrl: string;
}

export function EmbedConfigPanel({ agentId, appUrl }: EmbedConfigPanelProps): React.ReactElement {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-medium">Embed widget</h3>
        <FieldHelp
          title="About embed"
          ariaLabel="About embed"
          contentClassName="w-[28rem] max-w-[calc(100vw-2rem)]"
        >
          <p>
            Embed lets you drop this agent onto a third-party website as a floating chat widget —
            your marketing site, customer portal, help docs, anywhere you control the HTML. The
            widget loads inside a Shadow DOM, so it won&apos;t pick up or clash with the host
            page&apos;s CSS.
          </p>
          <p className="mt-2 font-medium">How to use it:</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5">
            <li>
              Customise look-and-feel in <strong>Widget Appearance</strong> below (colours,
              greeting, conversation starters).
            </li>
            <li>
              In the <strong>Embed tokens</strong> section below, click{' '}
              <strong>Create Token</strong> and restrict it to the origins where the widget will run
              (e.g.
              <code> https://example.com</code>) so the token can&apos;t be lifted and reused
              elsewhere.
            </li>
            <li>
              That token row will show a generated <code>&lt;script&gt;</code> snippet — copy it
              with the copy button and paste it into the partner site&apos;s HTML, just before{' '}
              <code>&lt;/body&gt;</code>. The widget appears automatically on page load.
            </li>
          </ol>
          <p className="mt-2">
            Tokens are revocable: deactivate to pause an embed without deleting it, or delete to
            permanently kill the integration. Each token is scoped to this agent only.
          </p>
        </FieldHelp>
      </div>
      <WidgetAppearanceSection agentId={agentId} />
      <TokensCard agentId={agentId} appUrl={appUrl} />
    </div>
  );
}

function TokensCard({ agentId, appUrl }: EmbedConfigPanelProps): React.ReactElement {
  const [tokens, setTokens] = React.useState<EmbedToken[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [newLabel, setNewLabel] = React.useState('');
  const [newOrigins, setNewOrigins] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [copied, setCopied] = React.useState<string | null>(null);

  const endpoint = API.ADMIN.ORCHESTRATION.agentEmbedTokens(agentId);

  const fetchTokens = React.useCallback(async () => {
    try {
      const data = await apiClient.get<EmbedToken[]>(endpoint);
      setTokens(data);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to load tokens');
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  React.useEffect(() => {
    void fetchTokens();
  }, [fetchTokens]);

  async function handleCreate(): Promise<void> {
    setCreating(true);
    setError(null);
    try {
      const origins = newOrigins
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);

      // Validate each origin is a valid URL
      for (const origin of origins) {
        try {
          new URL(origin);
        } catch {
          setError(
            `Invalid origin URL: "${origin}". Each origin must be a full URL (e.g. https://example.com).`
          );
          setCreating(false);
          return;
        }
      }

      const data = await apiClient.post<EmbedToken>(endpoint, {
        body: {
          label: newLabel || undefined,
          allowedOrigins: origins,
        },
      });
      setTokens((prev) => [data, ...prev]);
      setNewLabel('');
      setNewOrigins('');
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to create token');
    } finally {
      setCreating(false);
    }
  }

  async function handleToggle(tokenId: string, isActive: boolean): Promise<void> {
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.agentEmbedTokenById(agentId, tokenId), {
        body: { isActive },
      });
      setTokens((prev) => prev.map((t) => (t.id === tokenId ? { ...t, isActive } : t)));
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to update token');
    }
  }

  async function handleDelete(tokenId: string): Promise<void> {
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.agentEmbedTokenById(agentId, tokenId));
      setTokens((prev) => prev.filter((t) => t.id !== tokenId));
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to delete token');
    }
  }

  function getSnippet(token: string): string {
    if (!appUrl) {
      return 'NEXT_PUBLIC_APP_URL is not configured — set it in .env.local to generate a valid embed snippet.';
    }
    return `<script src="${appUrl}/api/v1/embed/widget.js" data-token="${token}"></script>`;
  }

  function copyToClipboard(text: string, id: string): void {
    void navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-muted-foreground text-sm">Loading embed tokens...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Embed tokens
          <FieldHelp title="Embed tokens">
            <p>
              Each token authenticates the widget when it loads on a partner site. The widget sends
              the token with every chat request; the server verifies it&apos;s active, scoped to
              this agent, and called from one of its allowed origins.
            </p>
            <p className="mt-2">
              Create one token per integration (e.g. one for your marketing site, one for the
              customer portal) so you can revoke them independently. Toggle <strong>Active</strong>{' '}
              off to pause an embed without losing the token; delete to kill it permanently.
            </p>
          </FieldHelp>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {/* Create form */}
        <div className="space-y-3 rounded-md border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="embed-label" className="text-xs">
                Label (optional)
              </Label>
              <Input
                id="embed-label"
                placeholder="e.g. Marketing site"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="embed-origins" className="flex items-center gap-1 text-xs">
                Allowed origins
                <FieldHelp title="Allowed origins (CORS)">
                  <p>
                    Comma-separated list of websites permitted to use this token — e.g.{' '}
                    <code>https://example.com, https://app.example.com</code>. Requests from any
                    other origin are rejected by CORS, so a leaked token can&apos;t be reused on a
                    site you don&apos;t control.
                  </p>
                  <p className="mt-2">
                    Each entry must be a full origin (scheme + host, no path). Leave blank to allow
                    any origin — only do this for internal testing.
                  </p>
                </FieldHelp>
              </Label>
              <Input
                id="embed-origins"
                placeholder="https://example.com, https://app.example.com"
                value={newOrigins}
                onChange={(e) => setNewOrigins(e.target.value)}
              />
            </div>
          </div>
          <Button type="button" size="sm" onClick={() => void handleCreate()} disabled={creating}>
            <Plus className="mr-1 h-3 w-3" />
            {creating ? 'Creating...' : 'Create Token'}
          </Button>
        </div>

        {/* Token list */}
        <div className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h4 className="text-sm font-medium">Created tokens</h4>
            <span className="text-muted-foreground text-xs">
              {tokens.length === 0
                ? 'none yet'
                : `${tokens.length} ${tokens.length === 1 ? 'token' : 'tokens'}`}
            </span>
          </div>
          {tokens.length === 0 ? (
            <p className="text-muted-foreground rounded-md border border-dashed py-4 text-center text-sm">
              No embed tokens yet. Create one above to get started.
            </p>
          ) : (
            <div className="space-y-3">
              {tokens.map((t) => (
                <div key={t.id} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={
                            t.label ? 'text-sm font-medium' : 'text-muted-foreground text-sm italic'
                          }
                        >
                          {t.label || 'Unlabelled embed token'}
                        </span>
                        <Badge variant={t.isActive ? 'default' : 'secondary'}>
                          {t.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">
                        {t.token}
                      </p>
                      {t.allowedOrigins.length > 0 && (
                        <p className="text-muted-foreground mt-0.5 text-xs">
                          Origins: {t.allowedOrigins.join(', ')}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => copyToClipboard(getSnippet(t.token), t.id)}
                        title="Copy embed snippet"
                        aria-label={`Copy embed snippet for ${t.label || 'token'}`}
                      >
                        {copied === t.id ? (
                          <Check className="h-3.5 w-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleToggle(t.id, !t.isActive)}
                        title={t.isActive ? 'Deactivate' : 'Activate'}
                        aria-label={`${t.isActive ? 'Deactivate' : 'Activate'} ${t.label || 'token'}`}
                      >
                        {t.isActive ? (
                          <Power className="h-3.5 w-3.5" />
                        ) : (
                          <PowerOff className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleDelete(t.id)}
                        title="Delete token"
                        aria-label={`Delete ${t.label || 'token'}`}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </Button>
                    </div>
                  </div>

                  {/* Embed snippet */}
                  <div className="mt-3 space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-muted-foreground text-xs tracking-wide uppercase">
                        Install snippet
                      </p>
                      <p className="text-muted-foreground text-[11px]">
                        Use the <Copy className="-mt-0.5 mr-0.5 inline h-3 w-3" />
                        copy button to grab it
                      </p>
                    </div>
                    <p className="text-muted-foreground text-xs leading-snug">
                      Paste this <code className="font-mono">&lt;script&gt;</code> tag into the HTML
                      of every page on the partner site that should show the chat widget — most
                      teams add it once to the shared site template (just before the closing{' '}
                      <code className="font-mono">&lt;/body&gt;</code> tag, or anywhere inside{' '}
                      <code className="font-mono">&lt;head&gt;</code>). The widget mounts as a small
                      chat bubble in the bottom-right corner of every visited page; no other code is
                      needed. If the site restricts which third-party origins can embed scripts,
                      make sure <code className="font-mono">{appUrl || 'this app'}</code> is on the
                      allow-list.
                    </p>
                    <div className="bg-muted rounded p-2">
                      <code className="text-xs break-all">{getSnippet(t.token)}</code>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
