'use client';

/**
 * ProviderTestButton (Phase 4 Session 4.3)
 *
 * Shared "Test connection" control for provider configurations.
 * Consumed by both `AgentForm` (Model tab) and `ProviderForm` (below
 * the fields on edit). Encapsulates the POST + sanitized result
 * display so both forms never forward raw provider/SDK error text to
 * the DOM.
 *
 * Props:
 *
 *   - `providerId` — the `AiProviderConfig.id` to test. `null` when the
 *     caller hasn't resolved a saved provider row yet (e.g. create
 *     mode, or the agent picked a slug that isn't configured yet).
 *     Disables the button with a friendly hint.
 *
 *   - `onResult` — optional callback invoked after every completed
 *     attempt with `{ ok }`. Lets the parent drive a status dot (as in
 *     `<ProvidersList>`).
 */

import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { getCachedTestResult, setCachedTestResult } from '@/lib/orchestration/provider-test-cache';

export interface ProviderTestButtonProps {
  providerId: string | null;
  onResult?: (ok: boolean) => void;
  disabledMessage?: string;
}

type TestResult = { ok: true; modelCount: number } | { ok: false; message: string } | null;

export function ProviderTestButton({
  providerId,
  onResult,
  disabledMessage = 'No saved provider config — save it first.',
}: ProviderTestButtonProps) {
  const [result, setResult] = useState<TestResult>(null);
  const [testing, setTesting] = useState(false);

  // On mount (and whenever the providerId changes), hydrate from the
  // localStorage cache. Lets the green check + dot survive navigation
  // without re-hitting the provider — bounded by the cache TTL.
  useEffect(() => {
    if (!providerId) {
      setResult(null);
      return;
    }
    const cached = getCachedTestResult(providerId);
    if (cached?.ok) {
      setResult({ ok: true, modelCount: cached.modelCount });
      onResult?.(true);
    } else {
      setResult(null);
    }
    // `onResult` intentionally omitted — re-hydrating only when the id
    // changes. Adding it would re-fire on every parent rerender, which
    // would clobber a freshly-clicked test result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const handleTest = useCallback(async () => {
    if (!providerId) {
      setResult({ ok: false, message: disabledMessage });
      onResult?.(false);
      return;
    }
    setTesting(true);
    setResult(null);
    try {
      // The server returns `{ ok, models: string[], error? }` from
      // `providerManager.testProvider`. The model count is the length of
      // that array — there's no separate `modelCount` field.
      const response = await apiClient.post<{ ok: boolean; models?: string[] }>(
        API.ADMIN.ORCHESTRATION.providerTest(providerId)
      );
      if (!response.ok) {
        setResult({
          ok: false,
          message: "Couldn't reach this provider. Check the server logs for details.",
        });
        // Persist so the red dot survives navigation too — TTL the same.
        setCachedTestResult(providerId, { ok: false, modelCount: 0 });
        onResult?.(false);
        return;
      }
      const modelCount = response.models?.length ?? 0;
      setResult({ ok: true, modelCount });
      setCachedTestResult(providerId, { ok: true, modelCount });
      onResult?.(true);
    } catch {
      // Never forward raw provider/SDK error text to the UI — the
      // server route already sanitizes it, but we layer a friendly
      // fallback on top regardless.
      setResult({
        ok: false,
        message: "Couldn't reach this provider. Check the server logs for details.",
      });
      onResult?.(false);
    } finally {
      setTesting(false);
    }
  }, [providerId, onResult, disabledMessage]);

  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void handleTest()}
        disabled={testing}
      >
        {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Test connection
      </Button>
      {result && result.ok && (
        // Model count lives in the card body's meta section already —
        // the inline label here was duplicating it and crowding the
        // footer. A bare check icon is enough acknowledgement that the
        // test ran; the dot color (driven by `onResult`) carries the
        // ongoing connected/disconnected status.
        <span
          className="flex items-center gap-1 text-sm text-green-600"
          aria-label={`Connection succeeded — ${result.modelCount} models available`}
          title={`${result.modelCount} models available`}
        >
          <Check className="h-4 w-4" aria-hidden="true" />
        </span>
      )}
      {result && !result.ok && (
        <span className="flex items-center gap-1 text-sm text-red-600">
          <X className="h-4 w-4" />
          {result.message}
        </span>
      )}
    </div>
  );
}
