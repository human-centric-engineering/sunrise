'use client';

/**
 * ModelTestButton (Phase 4)
 *
 * Sends a trivial prompt to the selected provider + model combination
 * and reports round-trip latency. Complements `ProviderTestButton`
 * which only tests provider-level connectivity.
 */

import { useCallback, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

export interface ModelTestButtonProps {
  providerId: string | null;
  model: string | null;
  onResult?: (ok: boolean, latencyMs?: number) => void;
}

type TestResult = { ok: true; latencyMs: number } | { ok: false; message: string } | null;

export function ModelTestButton({ providerId, model, onResult }: ModelTestButtonProps) {
  const [result, setResult] = useState<TestResult>(null);
  const [testing, setTesting] = useState(false);

  const disabled = !providerId || !model || testing;

  const handleTest = useCallback(async () => {
    if (!providerId || !model) return;
    setTesting(true);
    setResult(null);
    try {
      const response = await apiClient.post<{ ok: boolean; latencyMs: number | null }>(
        API.ADMIN.ORCHESTRATION.providerTestModel(providerId),
        { body: { model } }
      );
      if (response.ok && response.latencyMs != null) {
        setResult({ ok: true, latencyMs: response.latencyMs });
        onResult?.(true, response.latencyMs);
      } else {
        setResult({
          ok: false,
          message: 'Model did not respond. Check the server logs for details.',
        });
        onResult?.(false);
      }
    } catch {
      setResult({
        ok: false,
        message: 'Model test failed. Check the server logs for details.',
      });
      onResult?.(false);
    } finally {
      setTesting(false);
    }
  }, [providerId, model, onResult]);

  return (
    <div className="flex items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void handleTest()}
        disabled={disabled}
      >
        {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Test model
      </Button>
      {result && result.ok && (
        <span className="flex items-center gap-1 text-sm text-green-600">
          <Check className="h-4 w-4" />
          {result.latencyMs} ms
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
