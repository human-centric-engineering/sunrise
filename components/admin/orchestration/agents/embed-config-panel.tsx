'use client';

/**
 * EmbedConfigPanel
 *
 * Admin panel for managing embed tokens for an agent.
 * Allows creating tokens, copying embed snippets, and toggling active state.
 */

import * as React from 'react';
import { Copy, Plus, Trash2, Check, ExternalLink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import { Badge } from '@/components/ui/badge';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { escapeHtml } from '@/lib/security/sanitize';

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
    return `<script src="${escapeHtml(appUrl)}/api/v1/embed/widget.js" data-token="${escapeHtml(token)}"></script>`;
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
          Embed Widget
          <FieldHelp title="Embeddable chat widget">
            Generate embed tokens to add a chat widget to external websites. Each token scopes
            access to this agent and can be restricted to specific origins.
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
                <FieldHelp title="CORS origins">
                  Comma-separated list of origins (e.g. https://example.com). Leave blank to allow
                  all origins.
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
          <Button size="sm" onClick={() => void handleCreate()} disabled={creating}>
            <Plus className="mr-1 h-3 w-3" />
            {creating ? 'Creating...' : 'Create Token'}
          </Button>
        </div>

        {/* Token list */}
        {tokens.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            No embed tokens yet. Create one to get started.
          </p>
        ) : (
          <div className="space-y-3">
            {tokens.map((t) => (
              <div key={t.id} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{t.label || 'Untitled'}</span>
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
                      variant="ghost"
                      size="sm"
                      onClick={() => copyToClipboard(getSnippet(t.token), t.id)}
                      title="Copy embed snippet"
                    >
                      {copied === t.id ? (
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleToggle(t.id, !t.isActive)}
                      title={t.isActive ? 'Deactivate' : 'Activate'}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleDelete(t.id)}
                      title="Delete token"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-500" />
                    </Button>
                  </div>
                </div>

                {/* Embed snippet */}
                <div className="bg-muted mt-2 rounded p-2">
                  <code className="text-xs break-all">{getSnippet(t.token)}</code>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
