/**
 * EvaluationTrendChart component tests.
 *
 * Covers:
 *  - returns null when fewer than 2 points (not enough for a trend)
 *  - renders the card with the title and data caption when ≥2 points exist
 *  - recharts prop-forwarding: data mapping, Line dataKey/stroke/name/connectNulls
 *  - aria-label on the role="img" wrapper
 *  - null metric values (connectNulls happy path)
 *  - defensive undefined/null guard on the points prop
 *
 * Recharts is mocked with introspectable pass-through divs so that
 * ResponsiveContainer's real 0×0 jsdom behaviour cannot silently hide
 * child Line elements from assertions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  EvaluationTrendChart,
  type EvaluationTrendPoint,
} from '@/components/admin/orchestration/evaluation-trend-chart';

// ---------------------------------------------------------------------------
// recharts mock — introspectable pass-through divs
//
// ResponsiveContainer MUST render children at usable size (not 0×0).
// LineChart captures `data` as a JSON attr and exposes data-testid="line-chart".
// Line captures key props as data-* attrs for contract assertions.
// YAxis and Tooltip capture their formatter callbacks in module-level variables
// so tests can invoke them directly to assert correctness.
// Other components are no-op divs; they just need to not crash.
// ---------------------------------------------------------------------------

// Module-level variables to capture formatter callbacks for direct invocation in tests.
let capturedTickFormatter: ((v: unknown) => string) | undefined;
let capturedTooltipFormatter: ((value: unknown, name: unknown) => [string, string]) | undefined;

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  LineChart: ({
    children,
    data,
  }: {
    children: React.ReactNode;
    data: Record<string, unknown>[];
  }) => (
    <div data-testid="line-chart" data-data={JSON.stringify(data)}>
      {children}
    </div>
  ),
  Line: ({
    dataKey,
    stroke,
    name,
    connectNulls,
  }: {
    dataKey: string;
    stroke: string;
    name: string;
    connectNulls: boolean;
  }) => (
    <div
      data-testid="line"
      data-line-key={dataKey}
      data-stroke={stroke}
      data-name={name}
      data-connect-nulls={String(connectNulls)}
    />
  ),
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: ({ tickFormatter }: { tickFormatter?: (v: unknown) => string }) => {
    capturedTickFormatter = tickFormatter;
    return <div data-testid="y-axis" />;
  },
  Tooltip: ({ formatter }: { formatter?: (value: unknown, name: unknown) => [string, string] }) => {
    capturedTooltipFormatter = formatter;
    return <div data-testid="tooltip" />;
  },
  Legend: () => <div data-testid="legend" />,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POINT_A: EvaluationTrendPoint = {
  sessionId: 'sess-a',
  title: 'Eval A',
  completedAt: '2026-04-01T10:00:00Z',
  avgFaithfulness: 0.9,
  avgGroundedness: 0.85,
  avgRelevance: 0.95,
  scoredLogCount: 5,
};

const POINT_B: EvaluationTrendPoint = {
  sessionId: 'sess-b',
  title: 'Eval B',
  completedAt: '2026-04-15T10:00:00Z',
  avgFaithfulness: 0.92,
  avgGroundedness: 0.88,
  avgRelevance: 0.96,
  scoredLogCount: 8,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EvaluationTrendChart', () => {
  // Finding 8: removed vi.clearAllMocks() — the recharts mock uses static JSX factory
  // functions with no vi.fn()s, so clearAllMocks() has nothing to clear. Instead we
  // reset the module-level captured state (introduced for Finding 2) before each test.
  beforeEach(() => {
    capturedTickFormatter = undefined;
    capturedTooltipFormatter = undefined;
  });

  // --- Kept verbatim (lines 41, 46, 51, 57 of the original file) ---

  it('renders nothing when fewer than 2 points are supplied', () => {
    const { container } = render(<EvaluationTrendChart points={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when only one point is supplied', () => {
    const { container } = render(<EvaluationTrendChart points={[POINT_A]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the card with title and noisy-scores caption when ≥2 points exist', () => {
    render(<EvaluationTrendChart points={[POINT_A, POINT_B]} />);
    expect(screen.getByText('Evaluation quality over time')).toBeInTheDocument();
    expect(screen.getByText(/noisy below ~20 messages/i)).toBeInTheDocument();
  });

  it('respects a custom title prop', () => {
    render(<EvaluationTrendChart points={[POINT_A, POINT_B]} title="Custom Title" />);
    expect(screen.getByText('Custom Title')).toBeInTheDocument();
  });

  // --- Added: recharts mock setup verification ---

  describe('recharts prop forwarding', () => {
    it('passes mapped data to LineChart with date and metric keys', () => {
      // Arrange
      render(<EvaluationTrendChart points={[POINT_A, POINT_B]} />);

      // Act
      const lineChart = screen.getByTestId('line-chart');
      const data = JSON.parse(lineChart.getAttribute('data-data') ?? '[]') as Record<
        string,
        unknown
      >[];

      // Assert: two data points with the correct shape (date string + metric keys)
      expect(data).toHaveLength(2);
      // The mapped shape must include the metric keys — the component is responsible
      // for extracting avgFaithfulness → faithfulness, etc.
      expect(data[0]).toMatchObject({
        faithfulness: POINT_A.avgFaithfulness,
        groundedness: POINT_A.avgGroundedness,
        relevance: POINT_A.avgRelevance,
      });
      expect(data[1]).toMatchObject({
        faithfulness: POINT_B.avgFaithfulness,
        groundedness: POINT_B.avgGroundedness,
        relevance: POINT_B.avgRelevance,
      });
      // date field must be a non-empty string (formatted date)
      expect(typeof data[0].date).toBe('string');
      expect((data[0].date as string).length).toBeGreaterThan(0);
    });

    it('mounts exactly three Line elements', () => {
      // Arrange + Act
      render(<EvaluationTrendChart points={[POINT_A, POINT_B]} />);

      // Assert
      const lines = screen.getAllByTestId('line');
      expect(lines).toHaveLength(3);
    });

    it('Line stroke colours match the COLOURS constants', () => {
      // Arrange + Act
      render(<EvaluationTrendChart points={[POINT_A, POINT_B]} />);

      // Assert: check each expected colour appears in a line's stroke attribute
      const lines = screen.getAllByTestId('line');
      const strokes = lines.map((l) => l.getAttribute('data-stroke'));
      expect(strokes).toContain('#10b981'); // faithfulness — emerald-500
      expect(strokes).toContain('#3b82f6'); // groundedness — blue-500
      expect(strokes).toContain('#a855f7'); // relevance — purple-500
    });

    it('Line names match Faithfulness, Groundedness and Relevance', () => {
      // Arrange + Act
      render(<EvaluationTrendChart points={[POINT_A, POINT_B]} />);

      // Assert
      const lines = screen.getAllByTestId('line');
      const names = lines.map((l) => l.getAttribute('data-name'));
      expect(names).toContain('Faithfulness');
      expect(names).toContain('Groundedness');
      expect(names).toContain('Relevance');
    });

    it('all three Lines forward connectNulls={true}', () => {
      // Arrange + Act
      render(<EvaluationTrendChart points={[POINT_A, POINT_B]} />);

      // Assert: every Line must have data-connect-nulls="true".
      // Mock at L64 stringifies connectNulls; this assertion verifies the prop
      // is forwarded as truthy. The exact string 'true' confirms the boolean
      // was not coerced to a falsy value before being passed to the Line.
      const lines = screen.getAllByTestId('line');
      for (const line of lines) {
        expect(line.getAttribute('data-connect-nulls')).toBe('true');
      }
    });

    // Finding 2: Formatter callbacks — YAxis tickFormatter and Tooltip formatter.
    // The recharts mock captures these at render time into module-level variables
    // so tests can invoke them directly. This catches regressions like switching
    // `toFixed(1)` to `toFixed(2)` on the tick formatter or the Tooltip's null guard.

    it('YAxis tickFormatter formats a numeric value to one decimal place', () => {
      // Arrange: render to trigger capture
      render(<EvaluationTrendChart points={[POINT_A, POINT_B]} />);

      // Assert: formatter is captured and produces the correct output
      expect(capturedTickFormatter).toBeDefined();
      expect(capturedTickFormatter!(0.9)).toBe('0.9');
      expect(capturedTickFormatter!(0)).toBe('0.0');
      expect(capturedTickFormatter!(1)).toBe('1.0');
    });

    it('Tooltip formatter formats a numeric value to two decimal places', () => {
      // Arrange: render to trigger capture
      render(<EvaluationTrendChart points={[POINT_A, POINT_B]} />);

      // Assert: formatter is captured and formats numbers correctly
      expect(capturedTooltipFormatter).toBeDefined();
      const [formattedValue] = capturedTooltipFormatter!(0.9567, 'Faithfulness');
      expect(formattedValue).toBe('0.96');
    });

    it('Tooltip formatter returns "n/a" for non-numeric values (null metric guard)', () => {
      // Arrange: render to trigger capture
      render(<EvaluationTrendChart points={[POINT_A, POINT_B]} />);

      // Assert: non-numeric values fall through to the 'n/a' branch
      expect(capturedTooltipFormatter).toBeDefined();
      const [nullFormatted] = capturedTooltipFormatter!(null, 'Faithfulness');
      expect(nullFormatted).toBe('n/a');
      const [undefinedFormatted] = capturedTooltipFormatter!(undefined, 'Groundedness');
      expect(undefinedFormatted).toBe('n/a');
    });

    it('Tooltip formatter returns the metric name as the label', () => {
      // Arrange: render to trigger capture
      render(<EvaluationTrendChart points={[POINT_A, POINT_B]} />);

      // Assert: second element of the tuple is the stringified name
      expect(capturedTooltipFormatter).toBeDefined();
      const [, label] = capturedTooltipFormatter!(0.85, 'Groundedness');
      expect(label).toBe('Groundedness');
    });

    it('Tooltip formatter handles undefined name gracefully (returns empty string)', () => {
      // Arrange: render to trigger capture
      render(<EvaluationTrendChart points={[POINT_A, POINT_B]} />);

      // Assert: undefined name yields empty string via String(name ?? '')
      expect(capturedTooltipFormatter).toBeDefined();
      const [, label] = capturedTooltipFormatter!(0.85, undefined);
      expect(label).toBe('');
    });
  });

  // --- Added: aria-label on the role="img" wrapper ---

  describe('accessibility — role="img" wrapper', () => {
    it('aria-label matches the default title', () => {
      // Arrange + Act
      render(<EvaluationTrendChart points={[POINT_A, POINT_B]} />);

      // Assert: the wrapping div has the expected accessible name
      const imgWrapper = screen.getByRole('img', { name: 'Evaluation quality over time' });
      expect(imgWrapper).toBeInTheDocument();
    });

    it('aria-label matches a custom title', () => {
      // Arrange + Act
      render(<EvaluationTrendChart points={[POINT_A, POINT_B]} title="Custom Chart Title" />);

      // Assert
      const imgWrapper = screen.getByRole('img', { name: 'Custom Chart Title' });
      expect(imgWrapper).toBeInTheDocument();
    });
  });

  // --- Added: null metric values (connectNulls happy path) ---

  describe('null metric values', () => {
    it('renders without crash when some metric values are null on a point', () => {
      // Arrange: point with all metrics null — the chart should still render
      // because connectNulls=true bridges the gap
      const POINT_NULL: EvaluationTrendPoint = {
        sessionId: 'sess-null',
        title: 'Eval Null',
        completedAt: '2026-04-08T10:00:00Z',
        avgFaithfulness: null,
        avgGroundedness: null,
        avgRelevance: null,
        scoredLogCount: 0,
      };

      // Act
      render(<EvaluationTrendChart points={[POINT_A, POINT_NULL]} />);

      // Assert: chart renders (card wrapper is present)
      expect(screen.getByTestId('evaluation-trend-chart')).toBeInTheDocument();

      // Assert: null values are passed through to the LineChart data as null
      const lineChart = screen.getByTestId('line-chart');
      const data = JSON.parse(lineChart.getAttribute('data-data') ?? '[]') as Record<
        string,
        unknown
      >[];
      expect(data[1].faithfulness).toBeNull();
      expect(data[1].groundedness).toBeNull();
      expect(data[1].relevance).toBeNull();
    });
  });

  // --- Added: defensive undefined/null guard ---

  describe('defensive points guard', () => {
    it('returns null when points is undefined', () => {
      // Arrange + Act: TypeScript forbids passing undefined to a required prop,
      // but the source has an explicit `points ?? []` guard for JS callers.
      // We cast to bypass TS so we can exercise the runtime guard.
      const { container } = render(<EvaluationTrendChart points={undefined as any} />);

      // Assert
      expect(container.firstChild).toBeNull();
    });

    it('returns null when points is null', () => {
      // Arrange + Act
      const { container } = render(<EvaluationTrendChart points={null as any} />);

      // Assert
      expect(container.firstChild).toBeNull();
    });
  });
});
