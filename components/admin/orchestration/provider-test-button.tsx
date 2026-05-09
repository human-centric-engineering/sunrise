'use client';

/**
 * ProviderTestButton
 *
 * Shared "Test connection" control for provider configurations.
 * Consumed by both `AgentForm` (Model tab) / `ProviderForm` (uncontrolled
 * mode — manages its own state) and `<ProvidersList>` (controlled mode —
 * the parent owns the result so an auto-probe or reactivate clears the
 * stale red X without unmounting the button).
 *
 * Encapsulates the POST + sanitized result display so callers never
 * forward raw provider/SDK error text to the DOM.
 *
 * Modes:
 *
 *   - **Uncontrolled** — `result` prop is undefined. The component holds
 *     its own state, hydrates from `provider-test-cache` on mount, and
 *     updates on user click. Used by ProviderForm where there's only one
 *     provider visible at a time and no sibling logic to coordinate with.
 *
 *   - **Controlled** — parent passes `result` (plus `onResult` and
 *     optionally `onTestStart`) and owns the truth. Internal state is
 *     ignored for display. Lets ProvidersList drive the same UI from
 *     three sources — manual click, mount-time auto-probe, and the
 *     reactivate / breaker-reset flows that clear stale results.
 *
 * Props:
 *
 *   - `providerId` — the `AiProviderConfig.id` to test. `null` when the
 *     caller hasn't resolved a saved provider row yet (e.g. create mode,
 *     or the agent picked a slug that isn't configured yet).
 *
 *   - `result` — controlled mode. Pass the current result (or `null` for
 *     "not tested yet") to take ownership of display.
 *
 *   - `onResult` — called after every completed attempt with
 *     `{ ok, message? }`. Lets the parent drive a status dot, a sibling
 *     error row, or a model-count display.
 *
 *   - `onTestStart` — fires the moment the user clicks the button, before
 *     the network round-trip. Lets the parent clear stale state (e.g.
 *     wipe a previous failure message) so the UI doesn't flash an old
 *     error while the new test is in flight.
 *
 *   - `inlineMessage` — when `false`, suppresses the failure message
 *     text inline (icons still render). Used by ProvidersList which
 *     renders the message in a full-width row below the card footer.
 */

import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { getCachedTestResult, setCachedTestResult } from '@/lib/orchestration/provider-test-cache';

export type ProviderTestResult = { ok: true; modelCount: number } | { ok: false; message: string };

export interface ProviderTestButtonProps {
  providerId: string | null;
  /** Controlled mode — when defined (including `null`), parent owns display state. */
  result?: ProviderTestResult | null;
  onResult?: (result: ProviderTestResult) => void;
  /** Fires on user-initiated test start so parent can clear stale state. */
  onTestStart?: () => void;
  /** When false, skip the inline failure message text. Defaults to true. */
  inlineMessage?: boolean;
  disabledMessage?: string;
}

const FALLBACK_FAILURE_MESSAGE = "Couldn't reach this provider. Check the server logs for details.";

export function ProviderTestButton({
  providerId,
  result: controlledResult,
  onResult,
  onTestStart,
  inlineMessage = true,
  disabledMessage = 'No saved provider config — save it first.',
}: ProviderTestButtonProps) {
  const [internalResult, setInternalResult] = useState<ProviderTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  // `controlledResult === undefined` means the caller didn't pass the
  // prop at all → uncontrolled mode. `null` is a valid controlled value
  // ("no result yet"), so we explicitly check for `undefined`.
  const isControlled = controlledResult !== undefined;
  const display = isControlled ? controlledResult : internalResult;

  // Uncontrolled hydration: pull a recent cache entry so the green
  // check survives navigation. Skipped in controlled mode — the parent
  // hydrates its own state from the cache.
  useEffect(() => {
    if (isControlled) return;
    if (!providerId) {
      setInternalResult(null);
      return;
    }
    const cached = getCachedTestResult(providerId);
    if (cached?.ok) {
      const hydrated = { ok: true as const, modelCount: cached.modelCount };
      setInternalResult(hydrated);
      onResult?.(hydrated);
    } else {
      setInternalResult(null);
    }
    // `onResult` intentionally omitted — re-hydrating only when the id
    // changes. Adding it would re-fire on every parent rerender, which
    // would clobber a freshly-clicked test result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, isControlled]);

  const handleTest = useCallback(async () => {
    onTestStart?.();
    if (!providerId) {
      const failed = { ok: false as const, message: disabledMessage };
      if (!isControlled) setInternalResult(failed);
      onResult?.(failed);
      return;
    }
    setTesting(true);
    if (!isControlled) setInternalResult(null);
    try {
      // The server returns `{ ok, models: string[], error? }` from
      // `providerManager.testProvider`. The model count is the length of
      // that array — there's no separate `modelCount` field.
      const response = await apiClient.post<{ ok: boolean; models?: string[] }>(
        API.ADMIN.ORCHESTRATION.providerTest(providerId)
      );
      if (!response.ok) {
        const failed = { ok: false as const, message: FALLBACK_FAILURE_MESSAGE };
        if (!isControlled) setInternalResult(failed);
        setCachedTestResult(providerId, { ok: false, modelCount: 0 });
        onResult?.(failed);
        return;
      }
      const modelCount = response.models?.length ?? 0;
      const success = { ok: true as const, modelCount };
      if (!isControlled) setInternalResult(success);
      setCachedTestResult(providerId, { ok: true, modelCount });
      onResult?.(success);
    } catch {
      // Never forward raw provider/SDK error text to the UI — the
      // server route already sanitizes it, but we layer a friendly
      // fallback on top regardless.
      const failed = { ok: false as const, message: FALLBACK_FAILURE_MESSAGE };
      if (!isControlled) setInternalResult(failed);
      onResult?.(failed);
    } finally {
      setTesting(false);
    }
  }, [providerId, onResult, onTestStart, isControlled, disabledMessage]);

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
      {display && display.ok && (
        // Bare check icon — model count lives elsewhere (card body or
        // aria-label) so we don't crowd the footer with a duplicate
        // "N models available" string.
        <span
          className="flex items-center gap-1 text-sm text-green-600"
          aria-label={`Connection succeeded — ${display.modelCount} models available`}
          title={`${display.modelCount} models available`}
        >
          <Check className="h-4 w-4" aria-hidden="true" />
        </span>
      )}
      {display && !display.ok && (
        <span className="flex items-center gap-1 text-sm text-red-600">
          <X className="h-4 w-4 shrink-0" aria-hidden="true" />
          {inlineMessage && <span>{display.message}</span>}
        </span>
      )}
    </div>
  );
}
