import { describe, expect, it } from 'vitest';
import { formatterFor, safeTimeZone } from '@/lib/i18n/format';

const WHEN = new Date('2026-11-20T23:30:00Z');

describe('formatterFor', () => {
  it('formats a date for the locale', () => {
    expect(formatterFor('en-GB').dateTime(WHEN, 'short')).toBe('20 Nov 2026');
    expect(formatterFor('en-US').dateTime(WHEN, 'short')).toBe('Nov 20, 2026');
    expect(formatterFor('de').dateTime(WHEN, 'long')).toBe('20. November 2026');
  });

  it('formats in the viewer’s time zone, not the server’s', () => {
    // 23:30 UTC is already the 21st in Tokyo.
    expect(formatterFor('en-GB', 'Asia/Tokyo').dateTime(WHEN, 'short')).toBe('21 Nov 2026');
    expect(formatterFor('en-GB', 'UTC').dateTime(WHEN, 'short')).toBe('20 Nov 2026');
  });

  it('formats numbers and money for the locale', () => {
    expect(formatterFor('en').number(1234.567, 'decimal')).toBe('1,234.57');
    expect(formatterFor('de').number(1234.567, 'decimal')).toBe('1.234,57');
    expect(formatterFor('de').number(12.5, { style: 'currency', currency: 'EUR' })).toBe(
      '12,50\u00a0€'
    );
    expect(formatterFor('en').number(0.42, 'percent')).toBe('42%');
  });
});

describe('safeTimeZone', () => {
  it('keeps a zone Intl knows and replaces one it does not', () => {
    expect(safeTimeZone('Europe/London')).toBe('Europe/London');
    expect(safeTimeZone('Mars/Olympus')).toBe('UTC');
    expect(safeTimeZone(null)).toBe('UTC');
  });
});
