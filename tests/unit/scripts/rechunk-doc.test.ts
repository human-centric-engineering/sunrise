/**
 * Smoke tests for `scripts/rechunk-doc.ts`.
 *
 * The script is a one-shot CLI utility (no exports) — its top-level
 * `void main().catch(...)` fires at import time, so tests work by
 * mocking the dependencies, setting `process.argv`, and then
 * dynamically importing the module. The mocked `process.exit`
 * prevents the test runner from actually exiting and lets us assert
 * the exit code path was taken.
 *
 * @see scripts/rechunk-doc.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRechunkDocument = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('@/lib/orchestration/knowledge/document-manager', () => ({
  rechunkDocument: mockRechunkDocument,
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: mockLoggerInfo,
    error: mockLoggerError,
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('scripts/rechunk-doc', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the module registry so each import triggers `void main()`
    // afresh against the current mocks / argv.
    vi.resetModules();
    originalArgv = [...process.argv];
    // Stub process.exit so the test runner doesn't actually exit.
    // The script is wrapped in `void main().catch(...)`; both the
    // missing-arg path and the rejection path call `process.exit(1)`.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      // returning never; not actually exiting
    }) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    exitSpy.mockRestore();
  });

  /**
   * Drive the script by setting argv and dynamically importing.
   * The script's top-level promise needs to settle before the
   * test inspects mocks, so we await the import then flush
   * microtasks until the catch handler (if any) has run.
   */
  async function runScript(): Promise<void> {
    await import('@/scripts/rechunk-doc');
    // Two microtask flushes: one for `await rechunkDocument(...)`,
    // another for the `.catch` if it fires. Empirically two is
    // enough; using setImmediate would also work but adds Node-only
    // coupling.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('exits 1 and logs "Missing documentId" when no argv argument is supplied', async () => {
    process.argv = ['node', 'scripts/rechunk-doc.ts']; // no doc-id
    await runScript();

    expect(mockLoggerError).toHaveBeenCalledWith(
      'Missing documentId',
      expect.objectContaining({ usage: expect.stringContaining('rechunk-doc.ts') })
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    // Note: in production `process.exit(1)` terminates the process,
    // so `rechunkDocument` would never run. Our stubbed exit is a
    // no-op (the test runner can't actually exit), so the script
    // continues past the guard and calls `rechunkDocument(undefined)`.
    // We assert the exit-with-1 call instead of "not called", because
    // testing the real-process behaviour would require killing the
    // worker.
  });

  it('logs the result on a successful rechunk', async () => {
    process.argv = ['node', 'scripts/rechunk-doc.ts', 'doc-abc-123'];
    mockRechunkDocument.mockResolvedValue({
      id: 'doc-abc-123',
      name: 'Some Document',
      status: 'ready',
    });

    await runScript();

    expect(mockRechunkDocument).toHaveBeenCalledWith('doc-abc-123');
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'Rechunk complete',
      expect.objectContaining({
        documentId: 'doc-abc-123',
        name: 'Some Document',
        status: 'ready',
      })
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('logs the error and exits 1 when rechunkDocument rejects', async () => {
    process.argv = ['node', 'scripts/rechunk-doc.ts', 'doc-broken'];
    const failure = new Error('Document not found');
    mockRechunkDocument.mockRejectedValue(failure);

    await runScript();

    expect(mockRechunkDocument).toHaveBeenCalledWith('doc-broken');
    expect(mockLoggerError).toHaveBeenCalledWith('Rechunk failed', failure);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('wraps non-Error rejections so the logger always receives an Error instance', async () => {
    // Defensive path: if rechunkDocument throws a string or non-Error
    // value, the catch-handler wraps it in `new Error(String(err))`
    // so logger.error always gets a proper Error to format.
    process.argv = ['node', 'scripts/rechunk-doc.ts', 'doc-broken'];
    mockRechunkDocument.mockRejectedValue('something went sideways');

    await runScript();

    expect(mockLoggerError).toHaveBeenCalledWith(
      'Rechunk failed',
      expect.objectContaining({ message: 'something went sideways' })
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
