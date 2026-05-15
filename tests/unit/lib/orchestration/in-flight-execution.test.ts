import { describe, expect, it } from 'vitest';

import {
  IN_FLIGHT_EXECUTION_STORAGE_KEY,
  type InFlightExecutionRef,
} from '@/lib/orchestration/in-flight-execution';

describe('in-flight-execution storage contract', () => {
  it('exposes the versioned localStorage key the dialog and banner share', () => {
    // Both the audit dialog (writer) and the orchestration peek banner
    // (reader) rely on this exact string. Renaming it without updating
    // both sides silently breaks the cross-page handoff — locking the
    // value here turns a subtle UX regression into a test failure.
    expect(IN_FLIGHT_EXECUTION_STORAGE_KEY).toBe('sunrise.orchestration.in-flight-execution.v1');
  });

  it('accepts the documented ref shape', () => {
    // Type-only assertion — guards against accidental field renames in
    // the InFlightExecutionRef interface that would desync writer vs
    // reader without a TypeScript error at the call sites.
    const ref: InFlightExecutionRef = {
      executionId: 'exec_abc',
      label: 'Provider Model Audit',
      startedAt: new Date().toISOString(),
    };
    expect(ref.executionId).toBe('exec_abc');
    expect(ref.label).toBe('Provider Model Audit');
    expect(typeof ref.startedAt).toBe('string');
  });
});
