/**
 * LiveEngineDashboard Component Tests
 *
 * Test Coverage:
 * - Renders four cards (Running, Pending, Orphaned, Provider in-flight) with initial data
 * - Empty state copy when all counts are zero
 * - Card links point to the filtered executions list
 * - Auto-refresh polls the live snapshot endpoint and updates the UI
 * - Fetch error keeps last-good snapshot and surfaces an alert banner
 * - Orphaned card has amber border when orphaned count > 0
 * - Provider badge has destructive variant when inFlight > 10
 * - "Last refreshed" line updates after a successful refresh
 *
 * @see components/admin/orchestration/live-engine-dashboard.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import React from 'react';

import {
  LiveEngineDashboard,
  type LiveEngineSnapshotView,
} from '@/components/admin/orchestration/live-engine-dashboard';
import { createMockFetchResponse } from '@/tests/helpers/mocks';

// next/link renders as a plain anchor in the test environment
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_GENERATED_AT = '2026-05-20T10:00:00.000Z';

function makeSnapshot(overrides: Partial<LiveEngineSnapshotView> = {}): LiveEngineSnapshotView {
  return {
    running: { count: 4, p95AgeMs: 3200, maxAgeMs: 8100 },
    queued: { count: 2, maxWaitMs: 45000 },
    orphaned: { count: 0 },
    providers: [{ provider: 'openai', inFlight: 3 }],
    generatedAt: BASE_GENERATED_AT,
    ...overrides,
  };
}

const ZERO_SNAPSHOT: LiveEngineSnapshotView = {
  running: { count: 0, p95AgeMs: null, maxAgeMs: null },
  queued: { count: 0, maxWaitMs: null },
  orphaned: { count: 0 },
  providers: [],
  generatedAt: BASE_GENERATED_AT,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LiveEngineDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Reset timers FIRST — prevents fake-timer leaks cascading into real-timer tests (gotcha #24)
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── 1. Renders all four cards with initial data ─────────────────────────────
  //
  // These tests assert on the initial prop before any async fetch resolves.
  // global.fetch is set per-test to match the initial snapshot so the
  // on-mount refresh doesn't stomp the assertions.

  describe('initial rendering', () => {
    it('renders all four card titles and their counts', () => {
      // Arrange
      const initial = makeSnapshot();
      global.fetch = vi
        .fn()
        .mockResolvedValue(createMockFetchResponse({ success: true, data: initial }));

      // Act
      render(<LiveEngineDashboard initial={initial} pollIntervalMs={60_000} />);

      // Assert — card titles are present from the initial render (synchronous)
      expect(screen.getByText('Running')).toBeInTheDocument();
      expect(screen.getByText('Pending')).toBeInTheDocument();
      expect(screen.getByText('Orphaned')).toBeInTheDocument();
      expect(screen.getByText('Provider in-flight')).toBeInTheDocument();
    });

    it('renders the running count and p95 step age hint when count > 0', () => {
      // Arrange — running.count = 4, p95AgeMs = 3200 (→ 3s)
      const initial = makeSnapshot();
      global.fetch = vi
        .fn()
        .mockResolvedValue(createMockFetchResponse({ success: true, data: initial }));

      // Act
      render(<LiveEngineDashboard initial={initial} pollIntervalMs={60_000} />);

      // Assert — primary count is the initial value before any fetch
      expect(screen.getByText('4')).toBeInTheDocument();
      // Assert — secondary hint includes "p95 step age" only when count > 0
      expect(screen.getByText(/p95 step age/i)).toBeInTheDocument();
    });

    it('renders the pending count', () => {
      const initial = makeSnapshot();
      global.fetch = vi
        .fn()
        .mockResolvedValue(createMockFetchResponse({ success: true, data: initial }));
      render(<LiveEngineDashboard initial={initial} pollIntervalMs={60_000} />);

      // count=2 appears in the Pending card's primary value
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('renders provider slugs and their in-flight counts', () => {
      // Arrange — two providers
      const initial = makeSnapshot({
        providers: [
          { provider: 'openai', inFlight: 3 },
          { provider: 'anthropic', inFlight: 7 },
        ],
      });
      global.fetch = vi
        .fn()
        .mockResolvedValue(createMockFetchResponse({ success: true, data: initial }));

      // Act
      render(<LiveEngineDashboard initial={initial} pollIntervalMs={60_000} />);

      // Assert — both slugs are visible from the initial render
      expect(screen.getByText('openai')).toBeInTheDocument();
      expect(screen.getByText('anthropic')).toBeInTheDocument();
      // Assert — in-flight counts rendered
      expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('7').length).toBeGreaterThanOrEqual(1);
    });

    it('renders the stuck threshold hint with the default 5m', () => {
      const initial = makeSnapshot();
      global.fetch = vi
        .fn()
        .mockResolvedValue(createMockFetchResponse({ success: true, data: initial }));
      render(<LiveEngineDashboard initial={initial} pollIntervalMs={60_000} />);

      // Default stuckThresholdMins=5 → "Stuck threshold: 5m"
      expect(screen.getByText(/Stuck threshold: 5m/i)).toBeInTheDocument();
    });

    it('renders the stuck threshold hint with a custom value', () => {
      const initial = makeSnapshot();
      global.fetch = vi
        .fn()
        .mockResolvedValue(createMockFetchResponse({ success: true, data: initial }));
      render(
        <LiveEngineDashboard initial={initial} stuckThresholdMins={10} pollIntervalMs={60_000} />
      );

      expect(screen.getByText(/Stuck threshold: 10m/i)).toBeInTheDocument();
    });
  });

  // ── 2. Empty state copy ─────────────────────────────────────────────────────

  describe('empty state', () => {
    it('shows all four empty-state messages when counts are zero and providers is empty', () => {
      // Arrange — fetch returns the same zero snapshot so the on-mount refresh
      // doesn't replace the empty state with non-zero data
      global.fetch = vi
        .fn()
        .mockResolvedValue(createMockFetchResponse({ success: true, data: ZERO_SNAPSHOT }));

      render(<LiveEngineDashboard initial={ZERO_SNAPSHOT} pollIntervalMs={60_000} />);

      // Assert — one message per card
      expect(screen.getByText('No executions in flight')).toBeInTheDocument();
      expect(screen.getByText('Nothing waiting to start')).toBeInTheDocument();
      expect(screen.getByText('No orphaned executions')).toBeInTheDocument();
      // ProviderCard renders "No active provider calls." when providers=[]
      expect(screen.getByText(/No active provider calls/i)).toBeInTheDocument();
    });
  });

  // ── 3. Cards link to filtered executions list ───────────────────────────────

  describe('card links', () => {
    it('Running card links to ?status=running', () => {
      const initial = makeSnapshot();
      global.fetch = vi
        .fn()
        .mockResolvedValue(createMockFetchResponse({ success: true, data: initial }));
      render(<LiveEngineDashboard initial={initial} pollIntervalMs={60_000} />);

      // The Running card is the first link containing "Running" text
      const links = screen.getAllByRole('link');
      const runningLink = links.find(
        (l) =>
          l.textContent?.includes('Running') &&
          l.getAttribute('href')?.includes('status=running') &&
          !l.textContent?.includes('Orphaned')
      );

      expect(runningLink).toBeDefined();
      expect(runningLink?.getAttribute('href')).toContain('?status=running');
    });

    it('Pending card links to ?status=pending', () => {
      const initial = makeSnapshot();
      global.fetch = vi
        .fn()
        .mockResolvedValue(createMockFetchResponse({ success: true, data: initial }));
      render(<LiveEngineDashboard initial={initial} pollIntervalMs={60_000} />);

      const links = screen.getAllByRole('link');
      const pendingLink = links.find((l) => l.textContent?.includes('Pending'));

      expect(pendingLink).toBeDefined();
      expect(pendingLink?.getAttribute('href')).toContain('?status=pending');
    });

    it('Orphaned card links to ?status=running', () => {
      const initial = makeSnapshot();
      global.fetch = vi
        .fn()
        .mockResolvedValue(createMockFetchResponse({ success: true, data: initial }));
      render(<LiveEngineDashboard initial={initial} pollIntervalMs={60_000} />);

      const links = screen.getAllByRole('link');
      const orphanedLink = links.find((l) => l.textContent?.includes('Orphaned'));

      expect(orphanedLink).toBeDefined();
      // Per the component source: href="/admin/orchestration/executions?status=running"
      expect(orphanedLink?.getAttribute('href')).toContain('?status=running');
    });
  });

  // ── 4. Auto-refresh updates the snapshot ────────────────────────────────────

  describe('auto-refresh', () => {
    it('calls the live snapshot endpoint after one poll interval and renders updated counts', async () => {
      // Arrange
      vi.useFakeTimers();

      const updatedSnapshot = makeSnapshot({
        running: { count: 9, p95AgeMs: 5000, maxAgeMs: 12000 },
        generatedAt: '2026-05-20T10:01:00.000Z',
      });

      // First call (on-mount run) returns initial data; subsequent calls return
      // the updated snapshot so the timer-triggered refresh delivers new values.
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(createMockFetchResponse({ success: true, data: makeSnapshot() }))
        .mockResolvedValue(createMockFetchResponse({ success: true, data: updatedSnapshot }));

      render(<LiveEngineDashboard initial={makeSnapshot()} pollIntervalMs={1000} />);

      // Flush the on-mount run() call
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Act — advance past the poll interval; advanceTimersByTimeAsync flushes
      // the microtask queue between each fired timer (gotcha #24)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      // Assert — fetch was called with the correct URL (proves the component
      // uses the live snapshot endpoint, not some other URL)
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/v1/admin/orchestration/executions/live',
        expect.objectContaining({ credentials: 'same-origin' })
      );

      // Assert — the component rendered the new count from the fetched snapshot,
      // not just the initial value (proves the fetch result was applied to state).
      // Use getByText (synchronous) — findByRole/waitFor hang under fake timers (gotcha #24).
      expect(screen.getByText('9')).toBeInTheDocument();
    });
  });

  // ── 5. Fetch error keeps last-good snapshot and shows banner ────────────────

  describe('error handling', () => {
    it('shows error banner on fetch failure and keeps the last-good snapshot visible', async () => {
      // Arrange — initial snapshot has running count = 7 (a distinctive value)
      vi.useFakeTimers();

      const initial = makeSnapshot({ running: { count: 7, p95AgeMs: 1000, maxAgeMs: 2000 } });

      // All fetch calls (including the on-mount run) reject to simulate network error
      global.fetch = vi.fn().mockRejectedValue(new Error('network failure'));

      render(<LiveEngineDashboard initial={initial} pollIntervalMs={1000} />);

      // Flush the on-mount run() call and the interval tick
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      // Assert — error banner with role="alert" is present.
      // Use getByRole (synchronous) — waitFor hangs under fake timers (gotcha #24).
      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert.textContent).toMatch(/Live snapshot refresh failed/i);

      // Assert — last-good count (7) is still visible; the component did not
      // replace it with a zero or blank value (proves the snapshot was retained,
      // not overwritten with a failure-default)
      expect(screen.getByText('7')).toBeInTheDocument();
    });
  });

  // ── 6. Orphaned card amber border when count > 0 ────────────────────────────

  describe('orphaned card styling', () => {
    it('applies amber border class to the Orphaned card when orphaned count > 0', () => {
      // Arrange — orphaned.count = 3 → variant="warning"
      const initial = makeSnapshot({ orphaned: { count: 3 } });
      global.fetch = vi
        .fn()
        .mockResolvedValue(createMockFetchResponse({ success: true, data: initial }));

      render(<LiveEngineDashboard initial={initial} pollIntervalMs={60_000} />);

      // The orphaned DrillInCard wraps a Card with border-amber-300 when variant="warning".
      // Walk from the link that contains "Orphaned" to find the amber-bordered Card child.
      const links = screen.getAllByRole('link');
      const orphanedLink = links.find((l) => l.textContent?.includes('Orphaned'));
      expect(orphanedLink).toBeDefined();

      // The amber border is on the Card element inside the Link
      const amberCard = orphanedLink?.querySelector('[class*="border-amber-300"]');
      expect(amberCard).not.toBeNull();
    });

    it('does not apply amber border to the Orphaned card when count is 0', () => {
      // Arrange — orphaned.count = 0 → variant="default"
      const initial = makeSnapshot({ orphaned: { count: 0 } });
      global.fetch = vi
        .fn()
        .mockResolvedValue(createMockFetchResponse({ success: true, data: initial }));

      render(<LiveEngineDashboard initial={initial} pollIntervalMs={60_000} />);

      const links = screen.getAllByRole('link');
      const orphanedLink = links.find((l) => l.textContent?.includes('Orphaned'));
      expect(orphanedLink).toBeDefined();

      const amberCard = orphanedLink?.querySelector('[class*="border-amber-300"]');
      expect(amberCard).toBeNull();
    });
  });

  // ── 7. Provider destructive badge when inFlight > 10 ───────────────────────

  describe('provider badge variant', () => {
    it('renders provider badge with destructive class when inFlight > 10', () => {
      // Arrange — provider with 11 in-flight calls exceeds the threshold
      const initial = makeSnapshot({
        providers: [{ provider: 'high-load', inFlight: 11 }],
      });
      global.fetch = vi
        .fn()
        .mockResolvedValue(createMockFetchResponse({ success: true, data: initial }));

      render(<LiveEngineDashboard initial={initial} pollIntervalMs={60_000} />);

      // The Badge component should have the destructive variant.
      // shadcn Badge renders with a class containing "destructive" for this variant.
      // Find the badge by its text content (the count) and inspect its class.
      const badge = screen.getByText('11');
      expect(badge.className).toMatch(/destructive/);
    });

    it('does not render a destructive badge when inFlight is 10 or fewer', () => {
      // Arrange — provider at exactly 10 stays below the threshold
      const initial = makeSnapshot({
        providers: [{ provider: 'normal-load', inFlight: 10 }],
      });
      global.fetch = vi
        .fn()
        .mockResolvedValue(createMockFetchResponse({ success: true, data: initial }));

      render(<LiveEngineDashboard initial={initial} pollIntervalMs={60_000} />);

      const badge = screen.getByText('10');
      // Should use secondary variant, not destructive
      expect(badge.className).not.toMatch(/destructive/);
    });
  });

  // ── 8. "Last refreshed" time updates after a refresh ────────────────────────

  describe('last refreshed timestamp', () => {
    it('updates the "Last refreshed" time after a successful poll', async () => {
      // Arrange
      vi.useFakeTimers();

      // BASE_GENERATED_AT = '2026-05-20T10:00:00.000Z'
      // laterTime is 5 minutes ahead — toLocaleTimeString() will differ
      const laterTime = '2026-05-20T10:05:00.000Z';
      const initialSnapshot = makeSnapshot();
      const updatedSnapshot = makeSnapshot({ generatedAt: laterTime });

      // On-mount run returns initial; interval tick returns updated
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(createMockFetchResponse({ success: true, data: initialSnapshot }))
        .mockResolvedValue(createMockFetchResponse({ success: true, data: updatedSnapshot }));

      render(<LiveEngineDashboard initial={initialSnapshot} pollIntervalMs={1000} />);

      // Flush the on-mount run()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Capture the time displayed after the initial fetch settles
      const initialTimeText = screen
        .getByText(/Last refreshed/i)
        ?.textContent?.match(/Last refreshed (.+?) ·/)?.[1];

      // Act — advance past one poll interval
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      // Assert — the displayed time changed to reflect the new generatedAt from the
      // fetched snapshot (the component sets lastUpdatedAt from body.data.generatedAt).
      // Use getByText (synchronous) — waitFor hangs under fake timers (gotcha #24).
      const updatedTimeText = screen
        .getByText(/Last refreshed/i)
        ?.textContent?.match(/Last refreshed (.+?) ·/)?.[1];

      expect(updatedTimeText).toBeDefined();
      // The time string should differ because generatedAt advanced 5 minutes
      expect(updatedTimeText).not.toBe(initialTimeText);
    });
  });

  // The card's secondary text passes ages through the internal
  // `formatMs` helper. The base happy-path tests cover the seconds
  // branch indirectly; these cover the minutes and hours branches so
  // a future change to the formatter would surface here instead of
  // silently shipping bad copy ("3600000ms" or similar).
  describe('formatMs branches via card secondary text', () => {
    it('renders ages in minutes when p95 is between 1 minute and 1 hour', () => {
      const snapshot: LiveEngineSnapshotView = {
        running: { count: 1, p95AgeMs: 5 * 60_000, maxAgeMs: 12 * 60_000 },
        queued: { count: 0, maxWaitMs: null },
        orphaned: { count: 0 },
        providers: [],
        generatedAt: new Date('2026-05-20T12:00:00Z').toISOString(),
      };
      render(<LiveEngineDashboard initial={snapshot} pollIntervalMs={0} />);
      expect(screen.getByText(/p95 step age 5m · max 12m/i)).toBeInTheDocument();
    });

    it('renders ages in hours when the max exceeds 1 hour', () => {
      const snapshot: LiveEngineSnapshotView = {
        running: { count: 1, p95AgeMs: 90 * 60_000, maxAgeMs: 2 * 60 * 60_000 },
        queued: { count: 0, maxWaitMs: null },
        orphaned: { count: 0 },
        providers: [],
        generatedAt: new Date('2026-05-20T12:00:00Z').toISOString(),
      };
      render(<LiveEngineDashboard initial={snapshot} pollIntervalMs={0} />);
      // 90 min = 1.5h, 120 min = 2.0h. The formatter uses `toFixed(1)` + 'h'.
      expect(screen.getByText(/p95 step age 1\.5h · max 2\.0h/i)).toBeInTheDocument();
    });

    it('renders the Pending card "Oldest wait" in milliseconds when sub-second', () => {
      const snapshot: LiveEngineSnapshotView = {
        running: { count: 0, p95AgeMs: null, maxAgeMs: null },
        queued: { count: 1, maxWaitMs: 250 },
        orphaned: { count: 0 },
        providers: [],
        generatedAt: new Date('2026-05-20T12:00:00Z').toISOString(),
      };
      render(<LiveEngineDashboard initial={snapshot} pollIntervalMs={0} />);
      expect(screen.getByText(/Oldest wait: 250ms/i)).toBeInTheDocument();
    });
  });

  // When the dashboard is embedded on the executions page, the cards
  // accept an `onCardClick` handler and render as buttons instead of
  // links. The status filter update happens locally (parent's
  // `router.replace`) so there's no navigation — the polling timer
  // keeps running uninterrupted.
  describe('onCardClick (embedded-on-page mode)', () => {
    it('renders cards as buttons when onCardClick is provided', () => {
      const onCardClick = vi.fn();
      const snapshot: LiveEngineSnapshotView = {
        running: { count: 2, p95AgeMs: 60000, maxAgeMs: 120000 },
        queued: { count: 1, maxWaitMs: 5000 },
        orphaned: { count: 1 },
        providers: [],
        generatedAt: new Date('2026-05-20T12:00:00Z').toISOString(),
      };
      render(
        <LiveEngineDashboard initial={snapshot} pollIntervalMs={0} onCardClick={onCardClick} />
      );

      const runningButton = screen.getByRole('button', { name: /running/i });
      const pendingButton = screen.getByRole('button', { name: /pending/i });
      const orphanedButton = screen.getByRole('button', { name: /orphaned/i });
      expect(runningButton.tagName).toBe('BUTTON');
      expect(pendingButton.tagName).toBe('BUTTON');
      expect(orphanedButton.tagName).toBe('BUTTON');

      // fireEvent.click goes straight through React's onClick.
      // userEvent.click simulates pointer events, which interact with
      // shadcn's `<Card>` wrapper in a way that swallows the click
      // under JSDOM — verified by directly fireEvent-ing the same
      // node and seeing the handler fire. We care that the handler
      // is wired correctly to the click event, not which event
      // synthesis library landed us there.
      fireEvent.click(runningButton);
      expect(onCardClick).toHaveBeenCalledWith('running');

      fireEvent.click(pendingButton);
      expect(onCardClick).toHaveBeenCalledWith('pending');

      fireEvent.click(orphanedButton);
      // Orphaned is a strict subset of running — the card filters
      // into the running view, then the operator sorts by step age.
      expect(onCardClick).toHaveBeenCalledWith('running');
      expect(onCardClick).toHaveBeenCalledTimes(3);
    });

    it('renders cards as links to filtered URLs when onCardClick is omitted', () => {
      const snapshot: LiveEngineSnapshotView = {
        running: { count: 1, p95AgeMs: 1000, maxAgeMs: 1000 },
        queued: { count: 0, maxWaitMs: null },
        orphaned: { count: 0 },
        providers: [],
        generatedAt: new Date('2026-05-20T12:00:00Z').toISOString(),
      };
      render(<LiveEngineDashboard initial={snapshot} pollIntervalMs={0} />);

      // Original Link behaviour — anchors with the filter href.
      const runningLink = screen.getByRole('link', { name: /running/i });
      expect(runningLink.tagName).toBe('A');
      expect(runningLink.getAttribute('href')).toContain('status=running');
    });
  });
});
