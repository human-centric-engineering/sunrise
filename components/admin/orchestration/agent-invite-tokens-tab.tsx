'use client';

/**
 * AgentInviteTokensTab
 *
 * Manage invite tokens for invite_only agents. Shows a table of existing
 * tokens with status, usage, and revoke actions. Includes a create form
 * with optional label, max uses, and expiry.
 */

import { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

interface InviteToken {
  id: string;
  token: string;
  label: string | null;
  maxUses: number | null;
  useCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface AgentInviteTokensTabProps {
  agentId: string;
}

function tokenStatus(t: InviteToken): 'active' | 'revoked' | 'expired' | 'exhausted' {
  if (t.revokedAt) return 'revoked';
  if (t.expiresAt && new Date(t.expiresAt) < new Date()) return 'expired';
  if (t.maxUses != null && t.useCount >= t.maxUses) return 'exhausted';
  return 'active';
}

function StatusBadge({ status }: { status: ReturnType<typeof tokenStatus> }) {
  const variants: Record<typeof status, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    active: 'default',
    revoked: 'destructive',
    expired: 'secondary',
    exhausted: 'secondary',
  };
  return (
    <Badge variant={variants[status]} className="text-xs capitalize">
      {status}
    </Badge>
  );
}

export function AgentInviteTokensTab({ agentId }: AgentInviteTokensTabProps) {
  const [tokens, setTokens] = useState<InviteToken[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Create form state
  const [newLabel, setNewLabel] = useState('');
  const [newMaxUses, setNewMaxUses] = useState('');
  const [newExpiresAt, setNewExpiresAt] = useState('');

  const fetchTokens = useCallback(async () => {
    try {
      const data = await apiClient.get<{ tokens: InviteToken[] }>(
        API.ADMIN.ORCHESTRATION.agentInviteTokens(agentId)
      );
      setTokens(data.tokens);
      setError(null);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to load tokens');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void fetchTokens();
  }, [fetchTokens]);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (newLabel.trim()) body.label = newLabel.trim();
      if (newMaxUses) body.maxUses = parseInt(newMaxUses, 10);
      if (newExpiresAt) body.expiresAt = new Date(newExpiresAt).toISOString();

      await apiClient.post(API.ADMIN.ORCHESTRATION.agentInviteTokens(agentId), { body });
      setShowCreate(false);
      setNewLabel('');
      setNewMaxUses('');
      setNewExpiresAt('');
      await fetchTokens();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to create token');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (tokenId: string) => {
    setRevoking(tokenId);
    setError(null);
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.agentInviteTokenById(agentId, tokenId));
      await fetchTokens();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to revoke token');
    } finally {
      setRevoking(null);
    }
  };

  const handleCopy = async (token: string, id: string) => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError('Could not copy to clipboard. Your browser may require a secure (HTTPS) context.');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">Invite tokens</h3>
            <FieldHelp title="When to use invite tokens">
              Invite tokens control who can chat with this agent. Common uses:
              <br />
              <br />
              <strong>Client access</strong> — Create a token per client so each gets a unique link
              to their agent.
              <br />
              <br />
              <strong>Beta testing</strong> — Issue expiring tokens to testers before making an
              agent public.
              <br />
              <br />
              <strong>Partner integrations</strong> — Give partners a token with a usage cap to
              embed in their app.
              <br />
              <br />
              <strong>Paid tiers</strong> — Gate premium agents behind tokens issued to paying
              customers.
              <br />
              <br />
              Each token can have an optional label, usage limit, and expiry date. Revoked tokens
              stop working immediately.
            </FieldHelp>
          </div>
          <p className="text-muted-foreground text-xs">
            {tokens?.length
              ? `${tokens.filter((t) => tokenStatus(t) === 'active').length} active of ${tokens.length} total`
              : 'No tokens yet'}
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          Create token
        </Button>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
          {error}
        </div>
      )}

      {tokens && tokens.length > 0 ? (
        <div className="rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="px-3 py-2 font-medium">Label</th>
                <th className="px-3 py-2 font-medium">Token</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Usage</th>
                <th className="px-3 py-2 font-medium">Expires</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const status = tokenStatus(t);
                return (
                  <tr key={t.id} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      {t.label || <span className="text-muted-foreground italic">No label</span>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <code className="text-xs">
                          {t.token.slice(0, 8)}…{t.token.slice(-4)}
                        </code>
                        <button
                          type="button"
                          onClick={() => void handleCopy(t.token, t.id)}
                          className="text-muted-foreground hover:text-foreground"
                          title="Copy full token"
                          aria-label={`Copy token ${t.label || t.token.slice(0, 8)}`}
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                        {copied === t.id && <span className="text-xs text-green-600">Copied</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={status} />
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {t.useCount}
                      {t.maxUses ? ` / ${t.maxUses}` : ''}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {t.expiresAt ? (
                        new Date(t.expiresAt).toLocaleDateString()
                      ) : (
                        <span className="text-muted-foreground">Never</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {new Date(t.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2">
                      {status === 'active' && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleRevoke(t.id)}
                          disabled={revoking === t.id}
                          className="text-destructive hover:text-destructive h-7 px-2"
                          aria-label={`Revoke token ${t.label || t.token.slice(0, 8)}`}
                        >
                          {revoking === t.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-muted-foreground rounded-md border p-6 text-center text-sm">
          No invite tokens yet. Create one to give users access to this agent.
        </div>
      )}

      {/* Create token dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create invite token</DialogTitle>
            <DialogDescription>
              Generate a new token that grants access to this agent. All fields are optional.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="token-label">
                Label{' '}
                <FieldHelp title="Token label">
                  A name to help you identify this token later, e.g. &ldquo;Acme Corp&rdquo; or
                  &ldquo;Beta testers batch 2&rdquo;. Only visible to admins.
                </FieldHelp>
              </Label>
              <Input
                id="token-label"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="e.g. Acme Corp"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="token-max-uses">
                Max uses{' '}
                <FieldHelp title="Usage limit">
                  The maximum number of times this token can be used to start a conversation. Once
                  reached, the token stops working. Leave blank for unlimited uses.
                </FieldHelp>
              </Label>
              <Input
                id="token-max-uses"
                type="number"
                min={1}
                value={newMaxUses}
                onChange={(e) => setNewMaxUses(e.target.value)}
                placeholder="Unlimited"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="token-expires">
                Expires{' '}
                <FieldHelp title="Expiry date">
                  The token will stop working after this date. Leave blank for a token that never
                  expires.
                </FieldHelp>
              </Label>
              <Input
                id="token-expires"
                type="date"
                value={newExpiresAt}
                onChange={(e) => setNewExpiresAt(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleCreate()} disabled={creating}>
              {creating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating…
                </>
              ) : (
                'Create token'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
