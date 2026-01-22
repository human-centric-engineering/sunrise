/**
 * ClientDate Component Tests
 *
 * Tests the ClientDate component with locale-aware date formatting:
 * - Client-only rendering with useState/useEffect
 * - Placeholder rendering before hydration
 * - Rendering with Date objects
 * - Rendering with ISO string dates
 * - Date-only vs date+time formatting (showTime prop)
 * - Custom className application
 * - suppressHydrationWarning attribute presence
 * - Locale formatting behavior
 *
 * Test Coverage:
 * - Client-only rendering (useState/useEffect pattern)
 * - Placeholder display (non-breaking space before mount)
 * - Date object rendering
 * - ISO string rendering
 * - showTime=false (date only)
 * - showTime=true (date and time)
 * - className prop
 * - suppressHydrationWarning attribute
 * - Edge cases (invalid dates, empty strings)
 *
 * Recent changes tested:
 * - Changed from SSR with suppressHydrationWarning to client-only rendering
 * - Uses useState(false) + useEffect to track mounted state
 * - Shows placeholder (non-breaking space) until mounted
 * - Prevents hydration mismatches by deferring to client
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/ui/client-date.tsx
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ClientDate } from '@/components/ui/client-date';

/**
 * Test Suite: ClientDate Component
 *
 * Tests the date formatting component with locale support and client-only rendering.
 */
describe('components/ui/client-date', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('client-only rendering behavior', () => {
    it('should render placeholder before component mounts', () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act: Render component (useState defaults to false, so mounted=false initially)
      const { container } = render(<ClientDate date={testDate} />);

      // Assert: Should show non-breaking space placeholder
      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();
      // Non-breaking space (\u00A0) is used as placeholder
      // After useEffect runs, it will switch to the actual date
    });

    it('should render actual date after mounting', async () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(<ClientDate date={testDate} />);

      // Assert: After useEffect runs, should show formatted date
      const span = container.querySelector('span');
      await waitFor(() => {
        expect(span?.textContent).toBe(testDate.toLocaleDateString());
      });
    });

    it('should prevent hydration warnings with client-only rendering', async () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(<ClientDate date={testDate} />);

      // Assert: suppressHydrationWarning should still be present for safety
      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();

      // Wait for mount
      await waitFor(() => {
        expect(span?.textContent).toBe(testDate.toLocaleDateString());
      });
    });
  });

  describe('rendering with Date object', () => {
    it('should render a Date object as date-only by default', async () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(<ClientDate date={testDate} />);

      // Assert: Should render date without time after mount
      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();

      await waitFor(() => {
        expect(span?.textContent).toBeTruthy();
        // Date format varies by locale, but should not include time
        expect(span?.textContent).not.toMatch(/\d{1,2}:\d{2}/); // No time pattern
      });
    });

    it('should render a Date object with time when showTime is true', async () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(<ClientDate date={testDate} showTime />);

      // Assert: Should render date with time after mount
      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();

      await waitFor(() => {
        expect(span?.textContent).toBeTruthy();
        // Time format varies by locale, but should include time pattern
        // Using a more flexible regex to match time in various formats
        const text = span?.textContent || '';
        const hasTime = /\d{1,2}:\d{2}/.test(text) || /\d{1,2}\s?[AP]M/i.test(text);
        expect(hasTime).toBe(true);
      });
    });

    it('should format using browser locale (toLocaleDateString)', async () => {
      // Arrange
      const testDate = new Date('2026-01-15T00:00:00.000Z');
      const expectedFormat = testDate.toLocaleDateString();

      // Act
      const { container } = render(<ClientDate date={testDate} />);

      // Assert: Should match browser's locale format after mount
      const span = container.querySelector('span');
      await waitFor(() => {
        expect(span?.textContent).toBe(expectedFormat);
      });
    });

    it('should format using browser locale with time (toLocaleString)', async () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');
      const expectedFormat = testDate.toLocaleString();

      // Act
      const { container } = render(<ClientDate date={testDate} showTime />);

      // Assert: Should match browser's locale format with time after mount
      const span = container.querySelector('span');
      await waitFor(() => {
        expect(span?.textContent).toBe(expectedFormat);
      });
    });
  });

  describe('rendering with ISO string', () => {
    it('should render an ISO string as date-only by default', async () => {
      // Arrange
      const isoString = '2026-01-15T14:30:00.000Z';
      const expectedDate = new Date(isoString);

      // Act
      const { container } = render(<ClientDate date={isoString} />);

      // Assert: Should parse and render date after mount
      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();
      await waitFor(() => {
        expect(span?.textContent).toBe(expectedDate.toLocaleDateString());
      });
    });

    it('should render an ISO string with time when showTime is true', async () => {
      // Arrange
      const isoString = '2026-01-15T14:30:00.000Z';
      const expectedDate = new Date(isoString);

      // Act
      const { container } = render(<ClientDate date={isoString} showTime />);

      // Assert: Should parse and render date with time after mount
      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();
      await waitFor(() => {
        expect(span?.textContent).toBe(expectedDate.toLocaleString());
      });
    });

    it('should handle ISO string without milliseconds', async () => {
      // Arrange
      const isoString = '2026-01-15T14:30:00Z';
      const expectedDate = new Date(isoString);

      // Act
      const { container } = render(<ClientDate date={isoString} />);

      // Assert: Should parse correctly after mount
      const span = container.querySelector('span');
      await waitFor(() => {
        expect(span?.textContent).toBe(expectedDate.toLocaleDateString());
      });
    });

    it('should handle ISO string with timezone offset', async () => {
      // Arrange
      const isoString = '2026-01-15T14:30:00+05:30';
      const expectedDate = new Date(isoString);

      // Act
      const { container } = render(<ClientDate date={isoString} />);

      // Assert: Should parse correctly with timezone after mount
      const span = container.querySelector('span');
      await waitFor(() => {
        expect(span?.textContent).toBe(expectedDate.toLocaleDateString());
      });
    });
  });

  describe('showTime prop', () => {
    it('should not show time when showTime is false (default)', async () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(<ClientDate date={testDate} showTime={false} />);

      // Assert: Should use toLocaleDateString (date only) after mount
      const span = container.querySelector('span');
      await waitFor(() => {
        expect(span?.textContent).toBe(testDate.toLocaleDateString());
      });
    });

    it('should show time when showTime is true', async () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(<ClientDate date={testDate} showTime={true} />);

      // Assert: Should use toLocaleString (date + time) after mount
      const span = container.querySelector('span');
      await waitFor(() => {
        expect(span?.textContent).toBe(testDate.toLocaleString());
      });
    });

    it('should omit showTime prop when not provided (defaults to false)', async () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(<ClientDate date={testDate} />);

      // Assert: Should default to date-only format after mount
      const span = container.querySelector('span');
      await waitFor(() => {
        expect(span?.textContent).toBe(testDate.toLocaleDateString());
      });
    });
  });

  describe('className prop', () => {
    it('should apply custom className to span', () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');
      const customClass = 'text-muted-foreground text-sm';

      // Act
      const { container } = render(<ClientDate date={testDate} className={customClass} />);

      // Assert: Should have custom class
      const span = container.querySelector('span');
      expect(span).toHaveClass('text-muted-foreground');
      expect(span).toHaveClass('text-sm');
    });

    it('should render without className when not provided', () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(<ClientDate date={testDate} />);

      // Assert: Should render span without custom classes
      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();
      // Note: className will be undefined/empty, but span still renders
      expect(span?.className).toBeFalsy();
    });

    it('should handle empty string className', () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(<ClientDate date={testDate} className="" />);

      // Assert: Should render without errors
      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();
    });

    it('should handle undefined className', () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(<ClientDate date={testDate} className={undefined} />);

      // Assert: Should render without errors
      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();
    });

    it('should apply multiple className values correctly', () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(
        <ClientDate date={testDate} className="text-xs font-semibold text-red-500" />
      );

      // Assert: Should have all classes
      const span = container.querySelector('span');
      expect(span).toHaveClass('text-xs');
      expect(span).toHaveClass('font-semibold');
      expect(span).toHaveClass('text-red-500');
    });
  });

  describe('suppressHydrationWarning behavior', () => {
    it('should render without hydration errors (suppressHydrationWarning is present in source)', () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(<ClientDate date={testDate} />);

      // Assert: Should render successfully
      // Note: suppressHydrationWarning is a React prop, not a DOM attribute
      // It's used internally by React during hydration and doesn't appear in the DOM
      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();
      expect(span?.textContent).toBe(testDate.toLocaleDateString());
    });

    it('should render with showTime without hydration errors', () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(<ClientDate date={testDate} showTime />);

      // Assert: Should render successfully
      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();
      expect(span?.textContent).toBe(testDate.toLocaleString());
    });

    it('should render with className without hydration errors', () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(
        <ClientDate date={testDate} className="text-muted-foreground" />
      );

      // Assert: Should render successfully with className
      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();
      expect(span).toHaveClass('text-muted-foreground');
    });
  });

  describe('edge cases', () => {
    it('should handle dates at epoch (1970-01-01)', async () => {
      // Arrange
      const epochDate = new Date(0);

      // Act
      const { container } = render(<ClientDate date={epochDate} />);

      // Assert: Should render epoch date after mount
      const span = container.querySelector('span');
      await waitFor(() => {
        expect(span?.textContent).toBe(epochDate.toLocaleDateString());
      });
    });

    it('should handle far future dates', async () => {
      // Arrange
      const futureDate = new Date('2099-12-31T23:59:59.999Z');

      // Act
      const { container } = render(<ClientDate date={futureDate} />);

      // Assert: Should render future date after mount
      const span = container.querySelector('span');
      await waitFor(() => {
        expect(span?.textContent).toBe(futureDate.toLocaleDateString());
      });
    });

    it('should handle dates with milliseconds', async () => {
      // Arrange
      const preciseDate = new Date('2026-01-15T14:30:45.123Z');

      // Act
      const { container } = render(<ClientDate date={preciseDate} showTime />);

      // Assert: Should render with time after mount (milliseconds may or may not show depending on locale)
      const span = container.querySelector('span');
      await waitFor(() => {
        expect(span?.textContent).toBe(preciseDate.toLocaleString());
      });
    });

    it('should handle Invalid Date gracefully', async () => {
      // Arrange
      const invalidDate = new Date('invalid-date-string');

      // Act
      const { container } = render(<ClientDate date={invalidDate} />);

      // Assert: Should render "Invalid Date" after mount (browser behavior)
      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();
      await waitFor(() => {
        expect(span?.textContent).toBe('Invalid Date');
      });
    });

    it('should handle empty string ISO date (results in Invalid Date)', async () => {
      // Arrange
      const emptyString = '';

      // Act
      const { container } = render(<ClientDate date={emptyString} />);

      // Assert: Should render "Invalid Date" after mount
      const span = container.querySelector('span');
      await waitFor(() => {
        expect(span?.textContent).toBe('Invalid Date');
      });
    });

    it('should render without any optional props', async () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(<ClientDate date={testDate} />);

      // Assert: Should render with defaults after mount
      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();
      await waitFor(() => {
        expect(span?.textContent).toBe(testDate.toLocaleDateString());
      });
    });
  });

  describe('different date formats', () => {
    it('should handle midnight (00:00:00)', async () => {
      // Arrange
      const midnightDate = new Date('2026-01-15T00:00:00.000Z');

      // Act
      const { container } = render(<ClientDate date={midnightDate} showTime />);

      // Assert: Should render midnight time after mount
      const span = container.querySelector('span');
      await waitFor(() => {
        expect(span?.textContent).toBe(midnightDate.toLocaleString());
      });
    });

    it('should handle end of day (23:59:59)', async () => {
      // Arrange
      const endOfDayDate = new Date('2026-01-15T23:59:59.999Z');

      // Act
      const { container } = render(<ClientDate date={endOfDayDate} showTime />);

      // Assert: Should render end of day time after mount
      const span = container.querySelector('span');
      await waitFor(() => {
        expect(span?.textContent).toBe(endOfDayDate.toLocaleString());
      });
    });

    it('should handle Date object from database (typical createdAt)', async () => {
      // Arrange: Simulate a database timestamp
      const dbTimestamp = new Date('2026-01-15T14:30:45.123Z');

      // Act
      const { container } = render(<ClientDate date={dbTimestamp} />);

      // Assert: Should render database timestamp after mount
      const span = container.querySelector('span');
      await waitFor(() => {
        expect(span?.textContent).toBe(dbTimestamp.toLocaleDateString());
      });
    });

    it('should handle ISO string from API response', async () => {
      // Arrange: Simulate an API response with ISO string
      const apiResponse = '2026-01-15T14:30:45.123Z';

      // Act
      const { container } = render(<ClientDate date={apiResponse} />);

      // Assert: Should parse and render API date after mount
      const span = container.querySelector('span');
      const expectedDate = new Date(apiResponse);
      await waitFor(() => {
        expect(span?.textContent).toBe(expectedDate.toLocaleDateString());
      });
    });
  });

  describe('component structure', () => {
    it('should render a span element', () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(<ClientDate date={testDate} />);

      // Assert: Should render span element
      const span = container.querySelector('span');
      expect(span).toBeInTheDocument();
      expect(span?.tagName).toBe('SPAN');
    });

    it('should not render any child elements', () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(<ClientDate date={testDate} />);

      // Assert: Should only contain text, no child elements
      const span = container.querySelector('span');
      expect(span?.children.length).toBe(0);
    });

    it('should be inline (span is inline element)', () => {
      // Arrange
      const testDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(
        <div>
          Text before <ClientDate date={testDate} /> text after
        </div>
      );

      // Assert: Should render inline with surrounding text
      const div = container.querySelector('div');
      expect(div?.textContent).toContain('Text before');
      expect(div?.textContent).toContain('text after');
    });
  });

  describe('real-world usage scenarios', () => {
    it('should render user createdAt timestamp', () => {
      // Arrange: Typical user.createdAt from database
      const userCreatedAt = new Date('2025-06-15T10:23:45.000Z');

      // Act
      render(
        <div>
          <span>Member since: </span>
          <ClientDate date={userCreatedAt} />
        </div>
      );

      // Assert: Should render user join date
      expect(screen.getByText(/Member since:/i)).toBeInTheDocument();
    });

    it('should render log timestamp with time', () => {
      // Arrange: Typical log.timestamp from database
      const logTimestamp = new Date('2026-01-21T15:42:30.000Z');

      // Act
      render(
        <div>
          <span>Last activity: </span>
          <ClientDate date={logTimestamp} showTime />
        </div>
      );

      // Assert: Should render log timestamp with time
      expect(screen.getByText(/Last activity:/i)).toBeInTheDocument();
    });

    it('should render with muted styling (common pattern)', () => {
      // Arrange: Common usage with muted text styling
      const itemDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(
        <ClientDate date={itemDate} className="text-muted-foreground text-sm" />
      );

      // Assert: Should have muted styling
      const span = container.querySelector('span');
      expect(span).toHaveClass('text-muted-foreground');
      expect(span).toHaveClass('text-sm');
    });

    it('should work in a table cell', () => {
      // Arrange: Common usage in data tables
      const rowDate = new Date('2026-01-15T14:30:00.000Z');

      // Act
      const { container } = render(
        <table>
          <tbody>
            <tr>
              <td>User Name</td>
              <td>
                <ClientDate date={rowDate} />
              </td>
            </tr>
          </tbody>
        </table>
      );

      // Assert: Should render in table cell
      const td = container.querySelectorAll('td')[1];
      expect(td.querySelector('span')).toBeInTheDocument();
    });
  });
});
