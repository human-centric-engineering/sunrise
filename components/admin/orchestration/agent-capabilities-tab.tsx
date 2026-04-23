'use client';

/**
 * AgentCapabilitiesTab (Phase 4 Session 4.2)
 *
 * Tab 4 body of the AgentForm. Two-column layout:
 *
 *   - Left ("Attached")  — `AiAgentCapability` pivot rows for this agent.
 *     Each row has an `isEnabled` Switch, a Configure button (opens a small
 *     dialog with a JSON `customConfig` editor + a `customRateLimit` input),
 *     and a Detach button.
 *   - Right ("Available") — every `AiCapability` not currently attached.
 *     Each row has an Attach button.
 *
 * All mutations hit the Phase 3 pivot routes and refetch the left column.
 * Errors render inline — nothing toasts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import type { AiAgentCapability, AiCapability } from '@/types/prisma';

type AttachedLink = AiAgentCapability & { capability: AiCapability };

export interface AgentCapabilitiesTabProps {
  agentId: string;
}

export function AgentCapabilitiesTab({ agentId }: AgentCapabilitiesTabProps) {
  const [attached, setAttached] = useState<AttachedLink[] | null>(null);
  const [catalogue, setCatalogue] = useState<AiCapability[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configureTarget, setConfigureTarget] = useState<AttachedLink | null>(null);
  const [usage, setUsage] = useState<Record<string, number> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchUsage = useCallback(async () => {
    try {
      const data = await apiClient.get<{ usage: Record<string, number> }>(
        API.ADMIN.ORCHESTRATION.agentCapabilitiesUsage(agentId)
      );
      setUsage(data.usage);
    } catch {
      // Usage is non-critical — silently ignore fetch failures
    }
  }, [agentId]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [links, caps] = await Promise.all([
        apiClient.get<AttachedLink[]>(API.ADMIN.ORCHESTRATION.agentCapabilities(agentId)),
        apiClient.get<AiCapability[]>(API.ADMIN.ORCHESTRATION.CAPABILITIES),
      ]);
      setAttached(links);
      setCatalogue(caps);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not load capabilities.');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void fetchAll();
    void fetchUsage();
  }, [fetchAll, fetchUsage]);

  useEffect(() => {
    intervalRef.current = setInterval(() => void fetchUsage(), 15_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchUsage]);

  const handleAttach = useCallback(
    async (capabilityId: string) => {
      try {
        await apiClient.post(API.ADMIN.ORCHESTRATION.agentCapabilities(agentId), {
          body: { capabilityId },
        });
        await fetchAll();
      } catch (err) {
        setError(err instanceof APIClientError ? err.message : 'Could not attach capability.');
      }
    },
    [agentId, fetchAll]
  );

  const handleDetach = useCallback(
    async (capId: string) => {
      try {
        await apiClient.delete(API.ADMIN.ORCHESTRATION.agentCapabilityById(agentId, capId));
        await fetchAll();
      } catch (err) {
        setError(err instanceof APIClientError ? err.message : 'Could not detach capability.');
      }
    },
    [agentId, fetchAll]
  );

  const handleToggleEnabled = useCallback(
    async (link: AttachedLink, nextEnabled: boolean) => {
      try {
        await apiClient.patch(
          API.ADMIN.ORCHESTRATION.agentCapabilityById(agentId, link.capabilityId),
          {
            body: { isEnabled: nextEnabled },
          }
        );
        await fetchAll();
      } catch (err) {
        setError(err instanceof APIClientError ? err.message : 'Could not update capability.');
      }
    },
    [agentId, fetchAll]
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading capabilities…
      </div>
    );
  }

  const attachedIds = new Set(attached?.map((l) => l.capabilityId) ?? []);
  const available = catalogue?.filter((c) => !attachedIds.has(c.id)) ?? [];

  function usageBadge(link: AttachedLink) {
    const calls = usage?.[link.capability.slug] ?? 0;
    const limit = link.customRateLimit ?? link.capability.rateLimit;

    if (limit == null) {
      if (calls === 0) return null;
      return (
        <Badge variant="outline" className="text-muted-foreground text-xs font-normal">
          {calls} calls/min
        </Badge>
      );
    }

    const ratio = calls / limit;
    let colorClass = 'text-muted-foreground';
    if (ratio >= 1) colorClass = 'text-red-600';
    else if (ratio >= 0.8) colorClass = 'text-amber-600';

    return (
      <Badge variant="outline" className={`text-xs font-normal ${colorClass}`}>
        {calls} / {limit} /min
      </Badge>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="border-destructive/50 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {/* Attached */}
        <section className="rounded-md border">
          <header className="border-b px-3 py-2 text-sm font-medium">Attached</header>
          {attached && attached.length > 0 ? (
            <ul className="divide-y">
              {attached.map((link) => (
                <li key={link.id} className="flex items-center justify-between gap-2 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{link.capability.name}</p>
                      {usageBadge(link)}
                    </div>
                    <p className="text-muted-foreground truncate font-mono text-xs">
                      {link.capability.slug}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={link.isEnabled}
                      onCheckedChange={(v) => void handleToggleEnabled(link, v)}
                      aria-label={`Toggle ${link.capability.name}`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfigureTarget(link)}
                    >
                      Configure
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-red-600"
                      onClick={() => void handleDetach(link.capabilityId)}
                    >
                      Detach
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground p-3 text-sm">No capabilities attached yet.</p>
          )}
        </section>

        {/* Available */}
        <section className="rounded-md border">
          <header className="border-b px-3 py-2 text-sm font-medium">Available</header>
          {available.length > 0 ? (
            <ul className="divide-y">
              {available.map((cap) => (
                <li key={cap.id} className="flex items-center justify-between gap-2 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{cap.name}</p>
                    <p className="text-muted-foreground truncate font-mono text-xs">{cap.slug}</p>
                    {cap.description && (
                      <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                        {cap.description}
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleAttach(cap.id)}
                  >
                    Attach
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground p-3 text-sm">
              Every capability is already attached.
            </p>
          )}
        </section>
      </div>

      <ConfigureDialog
        link={configureTarget}
        onOpenChange={(open) => {
          if (!open) setConfigureTarget(null);
        }}
        onSaved={() => {
          setConfigureTarget(null);
          void fetchAll();
        }}
        agentId={agentId}
      />
    </div>
  );
}

interface ConfigureDialogProps {
  link: AttachedLink | null;
  agentId: string;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

function ConfigureDialog({ link, agentId, onOpenChange, onSaved }: ConfigureDialogProps) {
  const [configText, setConfigText] = useState('');
  const [rateLimit, setRateLimit] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (link) {
      setConfigText(link.customConfig ? JSON.stringify(link.customConfig, null, 2) : '');
      setRateLimit(link.customRateLimit ? String(link.customRateLimit) : '');
      setError(null);
    }
  }, [link]);

  async function handleSave() {
    if (!link) return;
    setSaving(true);
    setError(null);
    try {
      let customConfig: unknown = undefined;
      if (configText.trim()) {
        try {
          customConfig = JSON.parse(configText);
        } catch {
          setError('customConfig is not valid JSON.');
          setSaving(false);
          return;
        }
      }
      const customRateLimit = rateLimit.trim() === '' ? undefined : Number(rateLimit);
      if (
        customRateLimit !== undefined &&
        (!Number.isFinite(customRateLimit) || customRateLimit < 1)
      ) {
        setError('Rate limit must be a positive number.');
        setSaving(false);
        return;
      }

      await apiClient.patch(
        API.ADMIN.ORCHESTRATION.agentCapabilityById(agentId, link.capabilityId),
        {
          body: { customConfig, customRateLimit },
        }
      );
      onSaved();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not save capability config.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!link} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure {link?.capability.name}</DialogTitle>
          <DialogDescription>
            Per-agent overrides for this capability. These merge over the capability&apos;s defaults
            at dispatch time.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="custom-config">
              Custom config (JSON){' '}
              <FieldHelp title="Custom config">
                JSON key-value pairs passed to the capability handler when it runs. The expected
                shape depends on the capability — open the capability&apos;s edit page and look at
                the Execution tab for supported keys. Leave as <code>{'{}'}</code> to use the
                capability&apos;s defaults.
              </FieldHelp>
            </Label>
            <Textarea
              id="custom-config"
              rows={8}
              value={configText}
              onChange={(e) => setConfigText(e.target.value)}
              className="font-mono text-xs"
              placeholder="{}"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="custom-rate-limit">
              Custom rate limit (calls/min){' '}
              <FieldHelp title="Rate limit override">
                Override the capability&apos;s global rate limit for this agent only. Leave blank to
                inherit the limit set on the capability itself.
              </FieldHelp>
            </Label>
            <Input
              id="custom-rate-limit"
              type="number"
              min={1}
              value={rateLimit}
              onChange={(e) => setRateLimit(e.target.value)}
              placeholder="Leave blank to inherit"
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
