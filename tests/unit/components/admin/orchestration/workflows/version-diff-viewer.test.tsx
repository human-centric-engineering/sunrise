/**
 * Unit Test: VersionDiffViewer
 *
 * Pure React component — no mocks needed.
 *
 * Key behaviours:
 * - Identical objects → renders "No changes"
 * - Added key → green "+" line
 * - Removed key → red "-" line
 * - Changed primitive → old red "-" + new green "+"
 * - Nested object change → dotted path (parent.child)
 * - Array treated atomically (not recursed into)
 * - String > 80 chars → truncated with "..."
 * - Null value → rendered as "null"
 *
 * @see components/admin/orchestration/workflows/version-diff-viewer.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VersionDiffViewer } from '@/components/admin/orchestration/workflows/version-diff-viewer';

describe('VersionDiffViewer', () => {
  describe('No changes', () => {
    it('renders "No changes" when before and after are identical', () => {
      render(
        <VersionDiffViewer
          before={{ name: 'test', steps: [] }}
          after={{ name: 'test', steps: [] }}
        />
      );

      expect(screen.getByText('No changes')).toBeInTheDocument();
    });

    it('renders "No changes" for two empty objects', () => {
      render(<VersionDiffViewer before={{}} after={{}} />);

      expect(screen.getByText('No changes')).toBeInTheDocument();
    });
  });

  describe('Added keys', () => {
    it('shows a green "+" line for a newly added key', () => {
      render(<VersionDiffViewer before={{}} after={{ description: 'New description' }} />);

      const addedLine = screen.getByText(/\+ description: New description/);
      expect(addedLine).toBeInTheDocument();
    });

    it('added line has emerald (green) color class', () => {
      render(<VersionDiffViewer before={{}} after={{ tag: 'v2' }} />);

      const addedSpan = screen.getByText(/\+ tag: v2/);
      expect(addedSpan.className).toContain('text-emerald');
    });
  });

  describe('Removed keys', () => {
    it('shows a red "-" line for a removed key', () => {
      render(<VersionDiffViewer before={{ description: 'Old description' }} after={{}} />);

      const removedLine = screen.getByText(/- description: Old description/);
      expect(removedLine).toBeInTheDocument();
    });

    it('removed line has red color class', () => {
      render(<VersionDiffViewer before={{ tag: 'v1' }} after={{}} />);

      const removedSpan = screen.getByText(/- tag: v1/);
      expect(removedSpan.className).toContain('text-red');
    });
  });

  describe('Changed primitives', () => {
    it('shows both old (-) and new (+) lines for a changed string', () => {
      render(<VersionDiffViewer before={{ name: 'old-name' }} after={{ name: 'new-name' }} />);

      expect(screen.getByText(/- name: old-name/)).toBeInTheDocument();
      expect(screen.getByText(/\+ name: new-name/)).toBeInTheDocument();
    });

    it('shows both lines for a changed number', () => {
      render(<VersionDiffViewer before={{ timeout: 30 }} after={{ timeout: 60 }} />);

      expect(screen.getByText(/- timeout: 30/)).toBeInTheDocument();
      expect(screen.getByText(/\+ timeout: 60/)).toBeInTheDocument();
    });

    it('shows both lines for a changed boolean', () => {
      render(<VersionDiffViewer before={{ enabled: true }} after={{ enabled: false }} />);

      expect(screen.getByText(/- enabled: true/)).toBeInTheDocument();
      expect(screen.getByText(/\+ enabled: false/)).toBeInTheDocument();
    });
  });

  describe('Nested objects', () => {
    it('renders nested path as parent.child notation', () => {
      render(
        <VersionDiffViewer before={{ config: { retries: 3 } }} after={{ config: { retries: 5 } }} />
      );

      expect(screen.getByText(/- config\.retries: 3/)).toBeInTheDocument();
      expect(screen.getByText(/\+ config\.retries: 5/)).toBeInTheDocument();
    });

    it('renders deeply nested path with multiple dots', () => {
      render(
        <VersionDiffViewer before={{ a: { b: { c: 'old' } } }} after={{ a: { b: { c: 'new' } } }} />
      );

      expect(screen.getByText(/- a\.b\.c: old/)).toBeInTheDocument();
      expect(screen.getByText(/\+ a\.b\.c: new/)).toBeInTheDocument();
    });

    it('shows nested added key with correct path', () => {
      render(
        <VersionDiffViewer before={{ config: {} }} after={{ config: { newField: 'value' } }} />
      );

      expect(screen.getByText(/\+ config\.newField: value/)).toBeInTheDocument();
    });
  });

  describe('Array handling', () => {
    it('treats arrays atomically — shows changed entry without recursing', () => {
      render(
        <VersionDiffViewer before={{ steps: ['a', 'b'] }} after={{ steps: ['a', 'b', 'c'] }} />
      );

      // Should show the steps path as changed (atomic), not individual element diffs
      expect(screen.getByText(/- steps:/)).toBeInTheDocument();
      expect(screen.getByText(/\+ steps:/)).toBeInTheDocument();
    });

    it('shows "No changes" when arrays are identical', () => {
      render(<VersionDiffViewer before={{ items: [1, 2, 3] }} after={{ items: [1, 2, 3] }} />);

      expect(screen.getByText('No changes')).toBeInTheDocument();
    });
  });

  describe('Long string truncation', () => {
    it('truncates strings longer than 80 characters with "..."', () => {
      const longString = 'a'.repeat(100);
      render(<VersionDiffViewer before={{}} after={{ description: longString }} />);

      // Should show only first 80 chars + "..."
      const truncated = `${'a'.repeat(80)}...`;
      expect(screen.getByText(new RegExp(truncated))).toBeInTheDocument();
    });

    it('does not truncate strings of exactly 80 characters', () => {
      const exactString = 'b'.repeat(80);
      render(<VersionDiffViewer before={{}} after={{ label: exactString }} />);

      expect(screen.getByText(new RegExp(exactString + '$'))).toBeInTheDocument();
    });
  });

  describe('Null values', () => {
    it('renders null value as the string "null"', () => {
      render(<VersionDiffViewer before={{}} after={{ optional: null }} />);

      expect(screen.getByText(/\+ optional: null/)).toBeInTheDocument();
    });

    it('renders removed null value as "null"', () => {
      render(<VersionDiffViewer before={{ optional: null }} after={{}} />);

      expect(screen.getByText(/- optional: null/)).toBeInTheDocument();
    });
  });

  describe('Multiple changes', () => {
    it('renders all changes when multiple fields differ', () => {
      render(
        <VersionDiffViewer
          before={{ name: 'old', timeout: 10 }}
          after={{ name: 'new', timeout: 10, tag: 'v2' }}
        />
      );

      expect(screen.getByText(/- name: old/)).toBeInTheDocument();
      expect(screen.getByText(/\+ name: new/)).toBeInTheDocument();
      expect(screen.getByText(/\+ tag: v2/)).toBeInTheDocument();
      expect(screen.queryByText(/timeout/)).not.toBeInTheDocument();
    });
  });
});
