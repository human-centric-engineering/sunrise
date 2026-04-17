/**
 * CliAuthoringHint Component Tests
 *
 * Test Coverage:
 * - Renders the banner when not previously dismissed
 * - Renders the resource-specific text in the banner copy
 * - Shows the dismiss button with sr-only label
 * - Hides banner after clicking the dismiss button
 * - Stays hidden when localStorage already holds a recent dismissal timestamp
 * - Reappears after the 28-day dismiss window has elapsed (stale timestamp)
 *
 * @see components/admin/orchestration/cli-authoring-hint.tsx
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CliAuthoringHint } from '@/components/admin/orchestration/cli-authoring-hint';

// ─── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'sunrise.cli-authoring-hint.dismissed-at';
const DISMISS_DURATION_MS = 28 * 24 * 60 * 60 * 1000; // 28 days, mirrors component

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('CliAuthoringHint', () => {
  beforeEach(() => {
    // Start each test with a clean localStorage
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  // ── Visibility when not dismissed ────────────────────────────────────────────

  it('renders the banner when no prior dismissal exists', () => {
    render(<CliAuthoringHint resource="agents" />);

    expect(
      screen.getByText(
        /it is recommended that your engineering team authors them programmatically/i
      )
    ).toBeInTheDocument();
  });

  it('mentions Claude Code in the banner copy', () => {
    render(<CliAuthoringHint resource="workflows" />);

    expect(screen.getByText('Claude Code')).toBeInTheDocument();
  });

  it('includes the resource type in the banner text', () => {
    render(<CliAuthoringHint resource="capabilities" />);

    // The banner says "While you can create and edit {resource} here…"
    expect(screen.getByText(/capabilities/i)).toBeInTheDocument();
  });

  it('renders the dismiss button with accessible sr-only label', () => {
    render(<CliAuthoringHint resource="agents" />);

    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('renders the secondary advisory text about UI purpose', () => {
    render(<CliAuthoringHint resource="agents" />);

    expect(
      screen.getByText(/primarily for visualising, understanding, and managing/i)
    ).toBeInTheDocument();
  });

  // ── Dismissal interaction ────────────────────────────────────────────────────

  it('hides the banner after clicking the dismiss button', async () => {
    const user = userEvent.setup();
    render(<CliAuthoringHint resource="agents" />);

    const btn = screen.getByRole('button', { name: /dismiss/i });
    await user.click(btn);

    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
    expect(
      screen.queryByText(/it is recommended that your engineering team authors them/i)
    ).not.toBeInTheDocument();
  });

  it('writes a numeric timestamp to localStorage on dismiss', async () => {
    const user = userEvent.setup();
    render(<CliAuthoringHint resource="agents" />);

    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    const stored = window.localStorage.getItem(STORAGE_KEY);
    expect(stored).not.toBeNull();
    const parsed = Number(JSON.parse(stored!));
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeGreaterThan(0);
  });

  // ── Respects persisted dismissal ─────────────────────────────────────────────

  it('does not render when dismissed recently (within 28 days)', () => {
    // Write a fresh dismissal timestamp (just now)
    const recentTimestamp = Date.now();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(recentTimestamp));

    render(<CliAuthoringHint resource="agents" />);

    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
  });

  it('renders again when the stored timestamp is older than 28 days', () => {
    // Write a stale dismissal timestamp (29 days ago)
    const staleTimestamp = Date.now() - DISMISS_DURATION_MS - 1000;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(staleTimestamp));

    render(<CliAuthoringHint resource="agents" />);

    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('renders when localStorage has an invalid (non-JSON) value for the key', () => {
    // Corrupt the stored value — the hook falls back to null (initial)
    window.localStorage.setItem(STORAGE_KEY, 'not-valid-json');

    render(<CliAuthoringHint resource="agents" />);

    // With a null fallback, banner should be visible
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  // ── Resource prop variations ─────────────────────────────────────────────────

  it.each(['agents', 'workflows', 'capabilities'])(
    'renders correctly for resource="%s"',
    (resource) => {
      render(<CliAuthoringHint resource={resource} />);

      // Banner is present and mentions the resource
      expect(screen.getByText(new RegExp(`create and edit ${resource}`, 'i'))).toBeInTheDocument();
    }
  );
});
