'use client';

/**
 * WebhookTestButton — sends a test ping event to the configured URL.
 */

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

interface TestResult {
  success: boolean;
  statusCode: number | null;
  durationMs: number;
  error: string | null;
}

export interface WebhookTestButtonProps {
  webhookId: string;
}

export function WebhookTestButton({ webhookId }: WebhookTestButtonProps) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const handleTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await apiClient.post<TestResult>(API.ADMIN.ORCHESTRATION.webhookTest(webhookId));
      setResult(res);
    } catch {
      setResult({ success: false, statusCode: null, durationMs: 0, error: 'Request failed' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" onClick={() => void handleTest()} disabled={testing}>
        {testing ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Sending…
          </>
        ) : (
          <>
            <Send className="mr-2 h-4 w-4" />
            Send test event
          </>
        )}
      </Button>

      {result && (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            result.success
              ? 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950'
              : 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950'
          }`}
        >
          <div className="flex items-center gap-2 font-medium">
            {result.success ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span className="text-green-700 dark:text-green-300">
                  Ping delivered ({result.statusCode}) in {result.durationMs}ms
                </span>
              </>
            ) : (
              <>
                <AlertTriangle className="h-4 w-4 text-red-600" />
                <span className="text-red-700 dark:text-red-300">
                  {result.error ?? `Failed with status ${result.statusCode}`}
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
