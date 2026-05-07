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
import { z } from 'zod';

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
import { parseApiResponse } from '@/lib/api/parse-response';
import type { AiAgentCapability, AiCapability } from '@/types/prisma';

/**
 * Narrow shape of the binding-save response `meta` field. The server
 * sets `meta.warnings.missingEnvVars` when a saved customConfig
 * references env vars that are not currently set on the host.
 * Validating with Zod (rather than asserting via `as`) keeps the
 * client robust against future server-side shape changes — drift
 * trips the parse instead of silently disabling the warning.
 */
const bindingMetaSchema = z.object({
  warnings: z
    .object({
      missingEnvVars: z.array(z.string()),
    })
    .optional(),
});

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
                      aria-label={`Configure ${link.capability.name}`}
                    >
                      Configure
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-red-600"
                      onClick={() => void handleDetach(link.capabilityId)}
                      aria-label={`Detach ${link.capability.name}`}
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
        onSaved={(opts) => {
          // When keepDialogOpen is requested, the dialog renders an
          // inline warning the admin has to acknowledge; the parent
          // still refreshes so the saved state is visible elsewhere.
          if (!opts?.keepDialogOpen) setConfigureTarget(null);
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
  onSaved: (opts?: { keepDialogOpen?: boolean }) => void;
}

function ConfigureDialog({ link, agentId, onOpenChange, onSaved }: ConfigureDialogProps) {
  const [configText, setConfigText] = useState('');
  const [rateLimit, setRateLimit] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Soft warning surfaced from the binding-save API meta when an
  // ${env:VAR} reference points at an unset env var. Save still
  // succeeds — admin may legitimately save before deploying the var.
  const [missingEnvVars, setMissingEnvVars] = useState<string[]>([]);

  useEffect(() => {
    if (link) {
      setConfigText(link.customConfig ? JSON.stringify(link.customConfig, null, 2) : '');
      setRateLimit(link.customRateLimit ? String(link.customRateLimit) : '');
      setError(null);
      setMissingEnvVars([]);
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

      // Use raw fetch + parseApiResponse so we can read the response
      // meta (apiClient.patch unwraps to data only). The save-time
      // missing-env-var warning lives on meta.warnings.missingEnvVars.
      const response = await fetch(
        API.ADMIN.ORCHESTRATION.agentCapabilityById(agentId, link.capabilityId),
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customConfig, customRateLimit }),
        }
      );
      if (!response.ok) {
        const errBody = await parseApiResponse<unknown>(response).catch(() => null);
        const message =
          errBody && !errBody.success
            ? errBody.error.message
            : `Save failed: ${response.statusText}`;
        setError(message);
        setSaving(false);
        return;
      }
      const parsed = await parseApiResponse<unknown>(response);
      const meta = parsed.success ? bindingMetaSchema.safeParse(parsed.meta) : undefined;
      const missing = meta?.success ? (meta.data.warnings?.missingEnvVars ?? []) : [];
      if (missing.length > 0) {
        // Keep the dialog open so the admin sees the warning; refresh
        // the parent list in the background so the saved state is
        // visible elsewhere.
        setMissingEnvVars(missing);
        onSaved({ keepDialogOpen: true });
        return;
      }
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
                <p>
                  JSON key-value pairs passed to the capability handler when it runs. The expected
                  shape depends on the capability — open the capability&apos;s edit page and look at
                  the Execution tab for supported keys. Leave as <code>{'{}'}</code> to use the
                  capability&apos;s defaults.
                </p>
                <p className="mt-2">
                  <strong>Env-var templating.</strong> String values may contain{' '}
                  <code>${'{env:VAR_NAME}'}</code> references — resolved at call time against the
                  running process&apos;s env vars. Useful when the value itself is a credential
                  (e.g. a Slack incoming-webhook URL on <code>forcedUrl</code>, a literal
                  Authorization on <code>forcedHeaders</code>) and you want it to live in env vars
                  only, not in the database. A missing env var fails the call closed; rotation =
                  change one env var, no binding edit.
                </p>
              </FieldHelp>
            </Label>
            <Textarea
              id="custom-config"
              rows={8}
              value={configText}
              onChange={(e) => {
                setConfigText(e.target.value);
                // Hide the post-save warning as soon as the admin
                // edits the config — they're either fixing the env
                // var or changing the binding shape.
                if (missingEnvVars.length > 0) setMissingEnvVars([]);
              }}
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
          {missingEnvVars.length > 0 && (
            <div
              role="status"
              className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950"
              data-testid="missing-env-vars-warning"
            >
              <p className="font-medium text-amber-900 dark:text-amber-100">
                Saved — but {missingEnvVars.length === 1 ? 'an env var is' : 'env vars are'} not set
                in the running process:
              </p>
              <ul className="mt-1 list-disc pl-5 text-amber-900 dark:text-amber-100">
                {missingEnvVars.map((name) => (
                  <li key={name}>
                    <code>{name}</code>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-amber-900 dark:text-amber-100">
                The binding is saved, but calls will fail closed until you set{' '}
                {missingEnvVars.length === 1 ? 'this var' : 'these vars'} on the host and restart
                (or hot-reload, if your runtime supports it).
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {missingEnvVars.length > 0 ? 'Close' : 'Cancel'}
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
