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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Tip } from '@/components/ui/tooltip';
import { SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { logger } from '@/lib/logging';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import { McpScope, ALL_MCP_SCOPES } from '@/types/mcp';
import { apiKeyRowSchema, type ApiKeyRow } from '@/lib/validations/mcp';
import { z } from 'zod';

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
  // Create and revoke fail inside their dialogs; a row's Rotate above the table.
  const createFailure = useSaveFailure({
    fallback: 'Could not create the API key. Try again.',
    fields: NO_SERVER_FIELDS,
  });
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const revokeFailure = useSaveFailure({
    fallback: 'Could not revoke the key. Try again.',
    fields: NO_SERVER_FIELDS,
  });
  const listFailure = useSaveFailure({
    fallback: 'Could not rotate the key. Try again.',
    fields: NO_SERVER_FIELDS,
  });

  /**
   * Re-reads the list after a save. The save already happened, so a failed
   * read is logged rather than reported as the save failing: the new key's
   * plaintext is on screen by then.
   */
  async function refreshKeys() {
    try {
      const rawList = await apiClient.get<unknown>(API.ADMIN.ORCHESTRATION.MCP_KEYS, {
        params: { page: 1, limit: 50 },
      });
      setKeys(z.array(apiKeyRowSchema).parse(rawList));
    } catch (err) {
      logger.error('mcp-keys-list: refresh after a save failed', err);
    }
  }

  async function handleCreate() {
    if (!newKeyName.trim() || newKeyScopes.length === 0) return;
    setCreating(true);
    createFailure.clear();
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
      setNewKeyName('');
      setNewKeyScopes([McpScope.TOOLS_LIST, McpScope.TOOLS_EXECUTE]);
      setNewKeyExpiry('');
      setNewKeyRateLimit('');
    } catch (err) {
      // A refused rate limit (§111 t-811) says what the limit is; it shows.
      createFailure.report(err);
      return;
    } finally {
      setCreating(false);
    }
    // Full row data for the new key.
    await refreshKeys();
  }

  async function handleRevoke(keyId: string) {
    revokeFailure.clear();
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.mcpKeyById(keyId), {
        body: { isActive: false },
      });
      setKeys((prev) => prev.map((k) => (k.id === keyId ? { ...k, isActive: false } : k)));
      setRevokeId(null);
    } catch (err) {
      revokeFailure.report(err);
    }
  }

  async function handleRotate(keyId: string) {
    setRotatingId(keyId);
    listFailure.clear();
    try {
      const data = await apiClient.post<{ plaintextKey: string }>(
        API.ADMIN.ORCHESTRATION.mcpKeyRotate(keyId)
      );
      setRotatedPlaintext({ keyId, plaintext: data.plaintextKey });
    } catch (err) {
      listFailure.report(err);
      return;
    } finally {
      setRotatingId(null);
    }
    // The rotated key's new prefix.
    await refreshKeys();
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
          createFailure.clear();
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
                    A descriptive name to identify this key (e.g. &quot;Cursor&quot;, &quot;CI
                    Pipeline&quot;).
                  </FieldHelp>
                </Label>
                <Input
                  id="key-name"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="e.g. Cursor"
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

          <SaveError failure={createFailure.failure} />

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

      <SaveError failure={listFailure.failure} />

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
                            <AlertDialog
                              open={revokeId === key.id}
                              onOpenChange={(open) => {
                                revokeFailure.clear();
                                setRevokeId(open ? key.id : null);
                              }}
                            >
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive text-xs"
                                >
                                  Revoke
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Revoke API key?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This will immediately invalidate the key. Any MCP clients using
                                    it will lose access. This action cannot be undone.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <SaveError failure={revokeFailure.failure} />
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                    onClick={(e) => {
                                      // Closes only on success, so a failure stays readable here.
                                      e.preventDefault();
                                      void handleRevoke(key.id);
                                    }}
                                  >
                                    Revoke
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
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
