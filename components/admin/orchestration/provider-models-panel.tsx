'use client';

/**
 * ProviderModelsPanel (Phase 4 Session 4.3)
 *
 * Model catalogue for a single provider, rendered inside a dialog on
 * the providers list page. Fetches `GET /providers/:id/models` on
 * mount. Local providers (`isLocal: true`) hide pricing columns
 * because pricing is N/A for self-hosted inference.
 *
 * Errors are never raw — the server route already sanitizes the
 * upstream SDK error; we layer a friendly fallback on top.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

export interface ProviderModelInfo {
  id: string;
  name: string;
  provider: string;
  tier: string;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  maxContext: number;
  supportsTools: boolean;
  available?: boolean;
}

interface ProviderModelsResponse {
  providerId: string;
  slug: string;
  models: ProviderModelInfo[];
}

export interface ProviderModelsPanelProps {
  providerId: string;
  providerName: string;
  isLocal: boolean;
  /** Whether the provider's API key env var is set. When false, skips the live fetch. */
  apiKeyPresent?: boolean;
}

export function ProviderModelsPanel({
  providerId,
  providerName,
  isLocal,
  apiKeyPresent = true,
}: ProviderModelsPanelProps) {
  const [models, setModels] = useState<ProviderModelInfo[] | null>(null);
  const [loading, setLoading] = useState(apiKeyPresent);
  const [error, setError] = useState<string | null>(null);

  const fetchModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<ProviderModelsResponse>(
        API.ADMIN.ORCHESTRATION.providerModels(providerId)
      );
      setModels(response.models ?? []);
    } catch {
      setError("Couldn't load models. Check the server logs for details.");
      setModels(null);
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  useEffect(() => {
    if (!apiKeyPresent) return;
    void fetchModels();
  }, [fetchModels, apiKeyPresent]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">{providerName}</h3>
          <p className="text-muted-foreground text-xs">
            {isLocal ? 'Local provider — pricing not applicable.' : 'Live model catalogue.'}
          </p>
        </div>
        {apiKeyPresent && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void fetchModels()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh models
          </Button>
        )}
      </div>

      {!apiKeyPresent && (
        <div className="text-muted-foreground py-6 text-center text-sm">
          No API key configured for this provider. Set the environment variable and restart to fetch
          the live model catalogue.
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {loading && !models && (
        <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading models…
        </div>
      )}

      {models && models.length === 0 && !loading && (
        <p className="text-muted-foreground py-6 text-center text-sm">
          No models reported by this provider.
        </p>
      )}

      {models && models.length > 0 && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Context</TableHead>
                <TableHead>Tier</TableHead>
                {!isLocal && (
                  <>
                    <TableHead className="text-right">Input $/1M</TableHead>
                    <TableHead className="text-right">Output $/1M</TableHead>
                  </>
                )}
                <TableHead className="text-right">Available</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="font-medium">{m.name}</div>
                    <div className="text-muted-foreground font-mono text-xs">{m.id}</div>
                  </TableCell>
                  <TableCell className="text-xs">{m.maxContext.toLocaleString()} tok</TableCell>
                  <TableCell>
                    <span className="text-xs capitalize">{m.tier}</span>
                  </TableCell>
                  {!isLocal && (
                    <>
                      <TableCell className="text-right text-xs tabular-nums">
                        ${m.inputCostPerMillion.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        ${m.outputCostPerMillion.toFixed(2)}
                      </TableCell>
                    </>
                  )}
                  <TableCell className="text-right">
                    {m.available === false ? (
                      <span className="text-muted-foreground text-xs">—</span>
                    ) : (
                      <span className="text-xs text-green-600">✓</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
