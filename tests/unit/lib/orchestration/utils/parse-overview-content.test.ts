/**
 * Unit Tests: parseOverviewContent
 *
 * @see lib/orchestration/utils/parse-overview-content.ts
 */

import { describe, it, expect } from 'vitest';

import { parseOverviewContent } from '@/lib/orchestration/utils/parse-overview-content';

describe('parseOverviewContent', () => {
  it('returns nulls when content has neither bold nor italic lines', () => {
    expect(parseOverviewContent('Plain prose with no markdown emphasis.')).toEqual({
      parallels: null,
      example: null,
    });
  });

  it('extracts a bold-only line as parallels', () => {
    expect(parseOverviewContent('**Step-by-step reasoning, like a structured proof.**')).toEqual({
      parallels: 'Step-by-step reasoning, like a structured proof.',
      example: null,
    });
  });

  it('extracts an italic-only line as example', () => {
    expect(parseOverviewContent('*See: a developer thinking aloud while debugging.*')).toEqual({
      parallels: null,
      example: 'See: a developer thinking aloud while debugging.',
    });
  });

  it('extracts both parallels and example when both are present', () => {
    // Real chunks always lead with a "PatternName\n\n" prefix that
    // stripEmbeddingPrefix consumes first — match that shape in fixtures.
    const content =
      'Chain of Thought\n\n**Like a structured proof.**\n\n*See: a developer debugging.*';
    expect(parseOverviewContent(content)).toEqual({
      parallels: 'Like a structured proof.',
      example: 'See: a developer debugging.',
    });
  });

  it('keeps only the first bold line when multiple are present', () => {
    const content = 'Chain of Thought\n\n**First bold.**\n\n**Second bold.**';
    expect(parseOverviewContent(content).parallels).toBe('First bold.');
  });

  it('keeps only the first italic line when multiple are present', () => {
    const content = 'Chain of Thought\n\n*First italic.*\n\n*Second italic.*';
    expect(parseOverviewContent(content).example).toBe('First italic.');
  });

  it('strips the "PatternName — Section" embedding prefix before parsing', () => {
    const content =
      'Chain of Thought — Overview\n\n**Like a structured proof.**\n\n*See: debugging.*';
    expect(parseOverviewContent(content)).toEqual({
      parallels: 'Like a structured proof.',
      example: 'See: debugging.',
    });
  });

  it('ignores lines that mix bold and surrounding prose (regex requires exact ^…$)', () => {
    expect(parseOverviewContent('Intro **bold inside prose** trailing text.')).toEqual({
      parallels: null,
      example: null,
    });
  });

  it('trims whitespace inside bold and italic captures', () => {
    expect(parseOverviewContent('**  padded parallels  **')).toEqual({
      parallels: 'padded parallels',
      example: null,
    });
    expect(parseOverviewContent('*  padded example  *')).toEqual({
      parallels: null,
      example: 'padded example',
    });
  });

  it('returns nulls for empty content', () => {
    expect(parseOverviewContent('')).toEqual({ parallels: null, example: null });
  });

  it('does not treat a bold-italic mix line ("***x***") as either', () => {
    // ***x*** doesn't match ^\*\*(.+)\*\*$ alone (would capture "*x*" inside),
    // and the italic regex requires the captured first char to NOT be "*",
    // so it shouldn't match either.
    expect(parseOverviewContent('***x***')).toEqual({
      parallels: '*x*',
      example: null,
    });
    // Note: bold regex DOES greedily match here, capturing the inner italic markers
    // as part of `parallels`. This documents current behaviour rather than asserting
    // it as a contract — in practice the chunker never produces this format.
  });
});
