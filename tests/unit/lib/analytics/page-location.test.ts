// @vitest-environment happy-dom

/**
 * Tests: what of a page's address may reach an analytics provider (t-780).
 *
 * @see lib/analytics/page-location.ts
 */

import { afterEach, describe, it, expect } from 'vitest';
import {
  ATTRIBUTION_QUERY_PARAMS,
  analyticsPageProperties,
  analyticsPath,
  analyticsSearch,
  analyticsUrl,
  currentPagePath,
  currentPageUrl,
} from '@/lib/analytics/page-location';

const TOKEN = 'Xk9fQ2mZp4LrT7vB1nWc8sYd';
const EMAIL_QS = 'email=jane%40example.com';

describe('analyticsUrl', () => {
  it('collapses a token in the path and drops a query email and the fragment', () => {
    expect(analyticsUrl(`https://app.example.com/s/${TOKEN}?${EMAIL_QS}&utm_source=news#top`)).toBe(
      'https://app.example.com/s/[param]?utm_source=news'
    );
  });

  it('keeps every attribution parameter and nothing else', () => {
    const query = ATTRIBUTION_QUERY_PARAMS.map((key) => `${key}=v`).join('&');
    expect(analyticsUrl(`https://app.example.com/p?${query}&ref=x&token=abc`)).toBe(
      `https://app.example.com/p?${query}`
    );
  });

  it('drops userinfo', () => {
    expect(analyticsUrl('https://user:pw@app.example.com/p')).toBe('https://app.example.com/p');
  });

  it('keeps a bare origin bare, and a root path as written', () => {
    expect(analyticsUrl('https://google.com')).toBe('https://google.com');
    expect(analyticsUrl('https://google.com/')).toBe('https://google.com/');
    expect(analyticsUrl('https://google.com?q=secret')).toBe('https://google.com');
  });

  it('keeps a relative URL relative', () => {
    expect(analyticsUrl(`/reset/${TOKEN}?${EMAIL_QS}`)).toBe('/reset/[param]');
  });

  it('returns undefined for an empty, non-http or absent value', () => {
    expect(analyticsUrl('')).toBeUndefined();
    expect(analyticsUrl(undefined)).toBeUndefined();
    expect(analyticsUrl('mailto:jane@example.com')).toBeUndefined();
  });
});

describe('analyticsSearch and analyticsPath', () => {
  it('reduces a query with or without its leading ?', () => {
    expect(analyticsSearch(`?${EMAIL_QS}&utm_campaign=spring`)).toBe('utm_campaign=spring');
    expect(analyticsSearch(`${EMAIL_QS}&UTM_Source=x`)).toBe('UTM_Source=x');
    expect(analyticsSearch(EMAIL_QS)).toBeUndefined();
    expect(analyticsSearch('')).toBeUndefined();
  });

  it('collapses a token-shaped path segment', () => {
    expect(analyticsPath(`/s/${TOKEN}`)).toBe('/s/[param]');
    expect(analyticsPath(undefined)).toBeUndefined();
  });
});

describe('analyticsPageProperties', () => {
  it('reduces url, path, search and referrer and passes everything else through', () => {
    expect(
      analyticsPageProperties({
        title: 'Shared page',
        path: `/s/${TOKEN}`,
        url: `https://app.example.com/s/${TOKEN}?${EMAIL_QS}`,
        search: `${EMAIL_QS}&utm_medium=email`,
        referrer: `https://app.example.com/reset/${TOKEN}?${EMAIL_QS}`,
        plan: 'pro',
      })
    ).toEqual({
      title: 'Shared page',
      path: '/s/[param]',
      url: 'https://app.example.com/s/[param]',
      search: 'utm_medium=email',
      referrer: 'https://app.example.com/reset/[param]',
      plan: 'pro',
    });
  });

  it('leaves absent properties absent, and undefined as undefined', () => {
    expect(analyticsPageProperties({ title: 'x' })).toEqual({ title: 'x' });
    expect(analyticsPageProperties(undefined)).toBeUndefined();
  });
});

describe('current page helpers', () => {
  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('read the reduced address of the page the browser is on', () => {
    window.history.pushState({}, '', `/s/${TOKEN}?${EMAIL_QS}&utm_source=x#frag`);

    expect(currentPageUrl()).toBe(`${window.location.origin}/s/[param]?utm_source=x`);
    expect(currentPagePath()).toBe('/s/[param]');
  });
});
