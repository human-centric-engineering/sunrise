/**
 * Unit Tests: Pattern attribution constants.
 *
 * @see lib/orchestration/knowledge/attribution.ts
 */

import { describe, it, expect } from 'vitest';

import {
  PATTERN_ATTRIBUTION_LINE,
  PATTERN_ATTRIBUTION_TEXT,
} from '@/lib/orchestration/knowledge/attribution';

describe('pattern attribution constants', () => {
  it('exposes the canonical attribution text including author and book title', () => {
    expect(PATTERN_ATTRIBUTION_TEXT).toBe('Agentic Design Patterns by Antonio Gullí');
  });

  it('renders the attribution line as a complete sentence ending with a period', () => {
    expect(PATTERN_ATTRIBUTION_LINE).toBe('Adapted from Agentic Design Patterns by Antonio Gullí.');
    expect(PATTERN_ATTRIBUTION_LINE.endsWith('.')).toBe(true);
  });

  it('embeds the attribution text inside the rendered line so the source stays consistent', () => {
    expect(PATTERN_ATTRIBUTION_LINE).toContain(PATTERN_ATTRIBUTION_TEXT);
  });
});
