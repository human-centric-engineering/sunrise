'use client';

/**
 * AgentTestCard — combined provider + model connectivity check.
 *
 * Replaces the two standalone test buttons in the agent form's Model tab
 * with a single card that runs both checks sequentially and explains
 * what each one verifies.
 */

import { useCallback, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

export interface AgentTestCardProps {
  providerId: string | null;
  model: string | null;
}

type StepStatus = 'idle' | 'running' | 'pass' | 'fail';

interface StepState {
  status: StepStatus;
  detail: string | null;
}

export function AgentTestCard({ providerId, model }: AgentTestCardProps) {
  const [connection, setConnection] = useState<StepState>({ status: 'idle', detail: null });
  const [modelTest, setModelTest] = useState<StepState>({ status: 'idle', detail: null });
  const [running, setRunning] = useState(false);

  const handleRun = useCallback(async () => {
    setRunning(true);
    setConnection({ status: 'running', detail: null });
    setModelTest({ status: 'idle', detail: null });

    // Step 1 — provider connectivity
    if (!providerId) {
      setConnection({ status: 'fail', detail: 'No saved provider config — save it first.' });
      setRunning(false);
      return;
    }

    try {
      const res = await apiClient.post<{ modelCount: number }>(
        API.ADMIN.ORCHESTRATION.providerTest(providerId)
      );
      setConnection({ status: 'pass', detail: `${res.modelCount ?? 0} models available` });
    } catch {
      setConnection({
        status: 'fail',
        detail: "Couldn't reach this provider. Check server logs for details.",
      });
      setRunning(false);
      return;
    }

    // Step 2 — model prompt
    if (!model) {
      setModelTest({ status: 'fail', detail: 'No model selected.' });
      setRunning(false);
      return;
    }

    setModelTest({ status: 'running', detail: null });
    try {
      const res = await apiClient.post<{ ok: boolean; latencyMs: number | null }>(
        API.ADMIN.ORCHESTRATION.providerTestModel(providerId),
        { body: { model } }
      );
      if (res.ok && res.latencyMs != null) {
        setModelTest({ status: 'pass', detail: `${res.latencyMs} ms round-trip` });
      } else {
        setModelTest({
          status: 'fail',
          detail: 'Model did not respond. Check server logs for details.',
        });
      }
    } catch {
      setModelTest({
        status: 'fail',
        detail: 'Model test failed. Check server logs for details.',
      });
    } finally {
      setRunning(false);
    }
  }, [providerId, model]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          Connectivity check{' '}
          <FieldHelp title="What does this test?">
            Runs two checks in sequence. First, it verifies that your API key can reach the provider
            and lists available models. Then it sends a trivial prompt to the selected model and
            measures round-trip latency. Both must pass for the agent to work.
          </FieldHelp>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <StepRow label="Provider connection" state={connection} />
        <StepRow label="Model response" state={modelTest} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-1"
          onClick={() => void handleRun()}
          disabled={running}
        >
          {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {running ? 'Testing…' : 'Run check'}
        </Button>
      </CardContent>
    </Card>
  );
}

function StepRow({ label, state }: { label: string; state: StepState }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <StatusIcon status={state.status} />
      <span className={state.status === 'fail' ? 'text-red-600' : undefined}>{label}</span>
      {state.detail && (
        <span
          className={`text-xs ${state.status === 'pass' ? 'text-green-600' : state.status === 'fail' ? 'text-red-600' : 'text-muted-foreground'}`}
        >
          — {state.detail}
        </span>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />;
    case 'pass':
      return <Check className="h-4 w-4 text-green-600" />;
    case 'fail':
      return <X className="h-4 w-4 text-red-600" />;
    default:
      return <div className="bg-muted h-4 w-4 rounded-full" />;
  }
}
