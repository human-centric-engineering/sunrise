/**
 * HTML document parser.
 *
 * Web pages fetched by URL arrive as raw HTML. Without this parser the
 * markup (scripts, stylesheets, nav chrome) would be chunked verbatim and
 * the document title would fall back to the URL. We use jsdom to:
 *   - extract a real title (<title> → og:title → first <h1>), and
 *   - pull the main article text, stripping boilerplate (nav/header/footer/
 *     aside/script/style) and converting block structure to plain text with
 *     markdown headings so the existing markdown chunker can split on them.
 *
 * jsdom does not execute scripts or fetch subresources here (we never set
 * runScripts/resources), so parsing untrusted remote HTML is safe.
 */

import { JSDOM } from 'jsdom';
// Shared with `epub-parser.ts` — both formats are markup that has to come out
// as chunkable text, and keeping two implementations is how they drift.
import { cleanInline, extractText } from '@/lib/orchestration/knowledge/parsers/dom-text';
import type { ParsedDocument, ParsedSection } from '@/lib/orchestration/knowledge/parsers/types';

/** Elements that never carry article content — removed before extraction. */
const NOISE_SELECTOR =
  'script, style, noscript, iframe, nav, header, footer, aside, form, svg, button, template';

export function parseHtml(buffer: Buffer, fileName: string): ParsedDocument {
  const warnings: string[] = [];
  const html = buffer.toString('utf-8');
  const dom = new JSDOM(html);
  const { document: doc, window: win } = dom.window;

  // Title: prefer <title>, then OpenGraph, then first heading, then filename.
  const title =
    cleanInline(doc.querySelector('title')?.textContent) ||
    cleanInline(doc.querySelector('meta[property="og:title"]')?.getAttribute('content')) ||
    cleanInline(doc.querySelector('h1')?.textContent) ||
    fileName.replace(/\.[^.]+$/, '');

  const author =
    cleanInline(doc.querySelector('meta[name="author"]')?.getAttribute('content')) || undefined;

  // Strip boilerplate before extracting content.
  doc.querySelectorAll(NOISE_SELECTOR).forEach((el) => el.remove());

  // Prefer a semantic content container; fall back to <body>.
  const body = doc.body ?? doc.documentElement;
  const main = doc.querySelector('article') ?? doc.querySelector('main') ?? body;

  let text = main ? extractText(main, win) : '';

  // If the semantic container was nearly empty (e.g. content lives outside
  // <article>), fall back to the full body.
  if (text.length < 200 && body && main !== body) {
    const bodyText = extractText(body, win);
    if (bodyText.length > text.length) text = bodyText;
  }

  if (text.length === 0) {
    warnings.push('No readable text content found in the HTML page.');
  }

  const sections: ParsedSection[] = [{ title: '', content: text, order: 0 }];
  const metadata: Record<string, string> = { format: 'html' };
  if (author) metadata.author = author;

  return {
    title,
    author,
    sections,
    fullText: text,
    metadata,
    warnings,
  };
}
