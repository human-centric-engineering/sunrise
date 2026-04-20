'use client';

/**
 * MCP API Keys List Component
 *
 * CRUD for MCP API keys with one-time plaintext display on creation,
 * key rotation, expiry, and per-key rate limit override.
 */

import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Tip } from '@/components/ui/tooltip';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { McpScope, ALL_MCP_SCOPES } from '@/types/mcp';

interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  isActive: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  rateLimitOverride: number | null;
  createdAt: string;
  creator: { name: string; email: string };
}

interface McpKeysListProps {
  initialKeys: ApiKeyRow[];
}

const SCOPE_LABELS: Record<string, string> = {
  [McpScope.TOOLS_LIST]: 'List Tools',
  [McpScope.TOOLS_EXECUTE]: 'Execute Tools',
  [McpScope.RESOURCES_READ]: 'Read Resources',
  [McpScope.PROMPTS_READ]: 'Read Prompts',
};

export function McpKeysList({ initialKeys }: McpKeysListProps) {
  const [keys, setKeys] = useState(initialKeys);
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>([
    McpScope.TOOLS_LIST,
    McpScope.TOOLS_EXECUTE,
  ]);
  const [newKeyExpiry, setNewKeyExpiry] = useState('');
  const [newKeyRateLimit, setNewKeyRateLimit] = useState('');
  const [showPlaintext, setShowPlaintext] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotatedPlaintext, setRotatedPlaintext] = useState<{
    keyId: string;
    plaintext: string;
  } | null>(null);

  async function handleCreate() {
    if (!newKeyName.trim() || newKeyScopes.length === 0) return;
    setCreating(true);
    try {
      const body: Record<string, unknown> = {
        name: newKeyName.trim(),
        scopes: newKeyScopes,
      };
      if (newKeyExpiry) body.expiresAt = newKeyExpiry;
      if (newKeyRateLimit) body.rateLimitOverride = parseInt(newKeyRateLimit, 10);

      const data = await apiClient.post<{ plaintext: string }>(API.ADMIN.ORCHESTRATION.MCP_KEYS, {
        body,
      });
      setShowPlaintext(data.plaintext);

      // Refetch to get full row data
      const listData = await apiClient.get<ApiKeyRow[]>(API.ADMIN.ORCHESTRATION.MCP_KEYS, {
        params: { page: 1, limit: 50 },
      });
      setKeys(listData);
      setNewKeyName('');
      setNewKeyScopes([McpScope.TOOLS_LIST, McpScope.TOOLS_EXECUTE]);
      setNewKeyExpiry('');
      setNewKeyRateLimit('');
    } catch {
      // apiClient throws — error is surfaced to user via the dialog remaining open
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(keyId: string) {
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.mcpKeyById(keyId), {
        body: { isActive: false },
      });
      setKeys((prev) => prev.map((k) => (k.id === keyId ? { ...k, isActive: false } : k)));
    } catch {
      // silent — row stays unchanged
    }
  }

  async function handleRotate(keyId: string) {
    setRotatingId(keyId);
    try {
      const data = await apiClient.post<{ plaintextKey: string }>(
        API.ADMIN.ORCHESTRATION.mcpKeyRotate(keyId)
      );
      setRotatedPlaintext({ keyId, plaintext: data.plaintextKey });

      // Refetch to update prefix
      const listData = await apiClient.get<ApiKeyRow[]>(API.ADMIN.ORCHESTRATION.MCP_KEYS, {
        params: { page: 1, limit: 50 },
      });
      setKeys(listData);
    } catch {
      // silent
    } finally {
      setRotatingId(null);
    }
  }

  function toggleScope(scope: string) {
    setNewKeyScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  }

  function isExpired(expiresAt: string | null): boolean {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  }

  return (
    <div className="space-y-4">
      {/* Rotated key plaintext dialog */}
      <Dialog
        open={rotatedPlaintext !== null}
        onOpenChange={(open) => {
          if (!open) setRotatedPlaintext(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Key Rotated</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-amber-600 dark:text-amber-400">
              Copy this new key now — it will not be shown again. The previous key is immediately
              invalidated.
            </p>
            <div className="bg-muted rounded-md p-3">
              <code className="text-xs break-all">{rotatedPlaintext?.plaintext}</code>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(rotatedPlaintext?.plaintext ?? '')}
            >
              Copy to Clipboard
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create Key Dialog */}
      <Dialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open);
          if (!open) setShowPlaintext(null);
        }}
      >
        <DialogTrigger asChild>
          <Button size="sm">Create API Key</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{showPlaintext ? 'API Key Created' : 'Create MCP API Key'}</DialogTitle>
          </DialogHeader>

          {showPlaintext ? (
            <div className="space-y-4">
              <p className="text-sm text-amber-600 dark:text-amber-400">
                Copy this key now — it will not be shown again.
              </p>
              <div className="bg-muted rounded-md p-3">
                <code className="text-xs break-all">{showPlaintext}</code>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void navigator.clipboard.writeText(showPlaintext)}
              >
                Copy to Clipboard
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <Label htmlFor="key-name">
                  Name
                  <FieldHelp title="Key Name">
                    A descriptive name to identify this key (e.g. &quot;Claude Desktop&quot;,
                    &quot;CI Pipeline&quot;).
                  </FieldHelp>
                </Label>
                <Input
                  id="key-name"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="e.g. Claude Desktop"
                />
              </div>

              <div>
                <Label>
                  Scopes
                  <FieldHelp title="Key Scopes">
                    Controls what this API key can do. Start with the minimum scopes needed.
                    <code className="text-xs">tools:execute</code> allows calling tools.
                    <code className="text-xs">tools:list</code> allows listing available tools.
                  </FieldHelp>
                </Label>
                <div className="mt-2 space-y-2">
                  {ALL_MCP_SCOPES.map((scope) => (
                    <div key={scope} className="flex items-center gap-2">
                      <Checkbox
                        id={`scope-${scope}`}
                        checked={newKeyScopes.includes(scope)}
                        onCheckedChange={() => toggleScope(scope)}
                      />
                      <Label htmlFor={`scope-${scope}`} className="text-sm font-normal">
                        <code className="text-xs">{scope}</code>
                        <span className="text-muted-foreground ml-2 text-xs">
                          {SCOPE_LABELS[scope]}
                        </span>
                      </Label>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <Label htmlFor="key-expiry">
                  Expiry
                  <FieldHelp title="Key Expiry">
                    Optional expiration date. After this date the key will be rejected. Leave blank
                    for no expiry.
                  </FieldHelp>
                </Label>
                <Input
                  id="key-expiry"
                  type="datetime-local"
                  value={newKeyExpiry}
                  onChange={(e) => setNewKeyExpiry(e.target.value)}
                />
              </div>

              <div>
                <Label htmlFor="key-rate-limit">
                  Rate Limit Override
                  <FieldHelp title="Per-Key Rate Limit">
                    Override the global rate limit for this specific key. Leave blank to use the
                    server-wide default. Value is requests per minute.
                  </FieldHelp>
                </Label>
                <Input
                  id="key-rate-limit"
                  type="number"
                  min={1}
                  max={10000}
                  value={newKeyRateLimit}
                  onChange={(e) => setNewKeyRateLimit(e.target.value)}
                  placeholder="e.g. 120"
                />
              </div>
            </div>
          )}

          <DialogFooter>
            {!showPlaintext && (
              <Button
                onClick={() => void handleCreate()}
                disabled={!newKeyName.trim() || newKeyScopes.length === 0 || creating}
              >
                {creating ? 'Creating...' : 'Create Key'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Keys Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Tip label="A descriptive label you chose when creating the key">
                  <span>Name</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="First characters of the key — used to identify it (full key is never stored)">
                  <span>Key Prefix</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Permissions granted to this key (e.g. tools:execute, resources:read)">
                  <span>Scopes</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Active keys can authenticate — revoked keys are permanently disabled">
                  <span>Status</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="When this key expires — blank means no expiry">
                  <span>Expires</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Per-key requests/min override — blank uses global limit">
                  <span>Rate Limit</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="When an MCP client last used this key to make a request">
                  <span>Last Used</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="When this API key was created">
                  <span>Created</span>
                </Tip>
              </TableHead>
              <TableHead className="w-[140px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-muted-foreground py-8 text-center">
                  No API keys yet. Create one to allow MCP clients to connect.
                </TableCell>
              </TableRow>
            ) : (
              keys.map((key) => {
                const expired = isExpired(key.expiresAt);
                return (
                  <TableRow
                    key={key.id}
                    className={!key.isActive || expired ? 'opacity-50' : undefined}
                  >
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell>
                      <code className="text-xs">{key.keyPrefix}...</code>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {key.scopes.map((s) => (
                          <Badge key={s} variant="outline" className="text-[10px]">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      {expired ? (
                        <Badge variant="secondary">Expired</Badge>
                      ) : (
                        <Badge variant={key.isActive ? 'default' : 'destructive'}>
                          {key.isActive ? 'Active' : 'Revoked'}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {key.rateLimitOverride ? `${key.rateLimitOverride}/min` : 'default'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {new Date(key.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {key.isActive && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void handleRotate(key.id)}
                              disabled={rotatingId === key.id}
                              className="text-xs"
                            >
                              {rotatingId === key.id ? 'Rotating...' : 'Rotate'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void handleRevoke(key.id)}
                              className="text-destructive text-xs"
                            >
                              Revoke
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
