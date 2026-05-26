/**
 * Unit Tests: HTML Parser (parseHtml)
 *
 * Tests the jsdom-based parser that turns a fetched web page into a
 * ParsedDocument: a real title (not the URL) plus the main article text
 * with the surrounding boilerplate (nav/header/footer/script/style) removed.
 *
 * @see lib/orchestration/knowledge/parsers/html-parser.ts
 */

import { describe, it, expect } from 'vitest';
import { parseHtml } from '@/lib/orchestration/knowledge/parsers/html-parser';

function toBuffer(html: string): Buffer {
  return Buffer.from(html, 'utf-8');
}

describe('parseHtml', () => {
  describe('title extraction', () => {
    it('prefers the <title> element', () => {
      const html = `<html><head><title>How Widgets Work</title></head><body><p>Body.</p></body></html>`;
      expect(parseHtml(toBuffer(html), 'page.html').title).toBe('How Widgets Work');
    });

    it('falls back to og:title when <title> is absent', () => {
      const html = `<html><head><meta property="og:title" content="OG Headline" /></head><body><p>Body.</p></body></html>`;
      expect(parseHtml(toBuffer(html), 'page.html').title).toBe('OG Headline');
    });

    it('falls back to the first <h1> when no title metadata exists', () => {
      const html = `<html><body><h1>First Heading</h1><p>Body.</p></body></html>`;
      expect(parseHtml(toBuffer(html), 'page.html').title).toBe('First Heading');
    });

    it('falls back to the filename (extension stripped) when the page has no title', () => {
      const html = `<html><body><p>Just body text.</p></body></html>`;
      expect(parseHtml(toBuffer(html), 'my-article.html').title).toBe('my-article');
    });

    it('does not use the filename/URL as the title when the page has a real title', () => {
      const html = `<html><head><title>Real Title</title></head><body><p>x</p></body></html>`;
      const result = parseHtml(toBuffer(html), 'https%3A%2F%2Fexample.com%2Fa.html');
      expect(result.title).toBe('Real Title');
    });
  });

  describe('content extraction', () => {
    it('strips script, style, nav, header, and footer boilerplate', () => {
      const html = `
        <html><head><title>T</title><style>.x{color:red}</style></head>
        <body>
          <nav>Home About Contact</nav>
          <header>Site banner</header>
          <article><p>The actual article body.</p></article>
          <footer>Copyright 2026</footer>
          <script>console.log('tracking')</script>
        </body></html>`;
      const { fullText } = parseHtml(toBuffer(html), 'page.html');

      expect(fullText).toContain('The actual article body.');
      expect(fullText).not.toContain('Home About Contact');
      expect(fullText).not.toContain('Site banner');
      expect(fullText).not.toContain('Copyright 2026');
      expect(fullText).not.toContain('color:red');
      expect(fullText).not.toContain('tracking');
    });

    it('does not leak raw HTML tags into the extracted text', () => {
      const html = `<html><head><title>T</title></head><body><article><p>Hello <strong>world</strong>.</p></article></body></html>`;
      const { fullText } = parseHtml(toBuffer(html), 'page.html');

      expect(fullText).not.toMatch(/<[^>]+>/);
      expect(fullText).toContain('Hello world.');
    });

    it('decodes HTML entities', () => {
      const html = `<html><head><title>T</title></head><body><article><p>Tom &amp; Jerry &lt;3</p></article></body></html>`;
      expect(parseHtml(toBuffer(html), 'page.html').fullText).toContain('Tom & Jerry <3');
    });

    it('converts headings to markdown so the chunker can split on them', () => {
      const html = `<html><head><title>T</title></head><body><article><h2>Section One</h2><p>Para.</p></article></body></html>`;
      expect(parseHtml(toBuffer(html), 'page.html').fullText).toContain('## Section One');
    });

    it('falls back to <body> when the semantic container is nearly empty', () => {
      const longText = 'word '.repeat(100);
      const html = `<html><head><title>T</title></head><body><article></article><div>${longText}</div></body></html>`;
      expect(parseHtml(toBuffer(html), 'page.html').fullText).toContain('word word');
    });

    it('warns when no readable text is found', () => {
      const html = `<html><head><title>T</title></head><body></body></html>`;
      const result = parseHtml(toBuffer(html), 'page.html');
      expect(result.fullText).toBe('');
      expect(result.warnings).toContain('No readable text content found in the HTML page.');
    });

    it('reports the html format in metadata', () => {
      const html = `<html><head><title>T</title></head><body><p>x</p></body></html>`;
      expect(parseHtml(toBuffer(html), 'page.html').metadata.format).toBe('html');
    });
  });
});
