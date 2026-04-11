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

import { useCallback, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

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

  const handleTest = useCallback(async () => {
    if (!providerId) {
      setResult({ ok: false, message: disabledMessage });
      onResult?.(false);
      return;
    }
    setTesting(true);
    setResult(null);
    try {
      const response = await apiClient.post<{ modelCount: number }>(
        API.ADMIN.ORCHESTRATION.providerTest(providerId)
      );
      setResult({ ok: true, modelCount: response.modelCount ?? 0 });
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
        <span className="flex items-center gap-1 text-sm text-green-600">
          <Check className="h-4 w-4" />
          {result.modelCount} models available
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
