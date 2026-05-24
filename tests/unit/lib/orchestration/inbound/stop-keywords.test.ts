/**
 * Tests: STOP / START / HELP keyword detection for SMS compliance.
 *
 * Regulated by US TCPA + UK PECR — only first-token matches count, per
 * the regulatory norm. A sentence like "I don't want to STOP using this"
 * is NOT an opt-out. Case-insensitive; trailing punctuation tolerated.
 *
 * @see lib/orchestration/inbound/stop-keywords.ts
 */

import { describe, expect, it } from 'vitest';
import { detectStopIntent } from '@/lib/orchestration/inbound/stop-keywords';

describe('detectStopIntent — opt-out keywords', () => {
  it.each([
    ['STOP', 'stop'],
    ['UNSUBSCRIBE', 'stop'],
    ['CANCEL', 'stop'],
    ['END', 'stop'],
    ['QUIT', 'stop'],
    ['STOPALL', 'stop'],
    ['OPTOUT', 'stop'],
  ])('treats %s as opt-out', (input, expected) => {
    expect(detectStopIntent(input)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(detectStopIntent('stop')).toBe('stop');
    expect(detectStopIntent('Stop')).toBe('stop');
    expect(detectStopIntent('sToP')).toBe('stop');
  });

  it('tolerates a trailing full stop', () => {
    expect(detectStopIntent('STOP.')).toBe('stop');
  });

  it('tolerates a trailing exclamation mark', () => {
    expect(detectStopIntent('STOP!')).toBe('stop');
  });
});

describe('detectStopIntent — opt-in keywords', () => {
  it.each([
    ['START', 'start'],
    ['UNSTOP', 'start'],
    ['YES', 'start'],
    ['OPTIN', 'start'],
  ])('treats %s as opt-in', (input, expected) => {
    expect(detectStopIntent(input)).toBe(expected);
  });
});

describe('detectStopIntent — info keywords', () => {
  it('treats HELP as info', () => {
    expect(detectStopIntent('HELP')).toBe('help');
  });

  it('treats INFO as info', () => {
    expect(detectStopIntent('INFO')).toBe('help');
  });
});

describe('detectStopIntent — non-matching inputs (regulatory critical)', () => {
  it('does not opt-out on a sentence containing STOP mid-text', () => {
    expect(detectStopIntent("I don't want to STOP using this service")).toBeNull();
  });

  it('does not opt-out on STOP later in a sentence', () => {
    expect(detectStopIntent('Please continue, do not STOP')).toBeNull();
  });

  it('does not opt-out when STOP is followed by other text in first word', () => {
    // STOPALL counts; STOPPING does not (the regex strips to "STOPPING").
    expect(detectStopIntent('STOPPING')).toBeNull();
  });

  it('returns null for unrelated message', () => {
    expect(detectStopIntent('Hello, how are you?')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(detectStopIntent('')).toBeNull();
  });

  it('returns null for null', () => {
    expect(detectStopIntent(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(detectStopIntent(undefined)).toBeNull();
  });

  it('returns null for whitespace only', () => {
    expect(detectStopIntent('   ')).toBeNull();
  });

  it('returns null for punctuation only', () => {
    expect(detectStopIntent('!!!')).toBeNull();
  });
});

describe('detectStopIntent — first-token semantics with leading whitespace', () => {
  it('handles leading whitespace before STOP', () => {
    expect(detectStopIntent('  STOP')).toBe('stop');
  });

  it('handles leading newline before STOP', () => {
    expect(detectStopIntent('\nSTOP')).toBe('stop');
  });
});
