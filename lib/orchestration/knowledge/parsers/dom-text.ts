/**
 * DOM-based plain-text extraction, shared by the HTML and EPUB parsers.
 *
 * Both formats are markup that has to come out as text a chunker can split.
 * `html-parser.ts` has always done that with jsdom; `epub-parser.ts` used a
 * chain of regex replacements until CodeQL objected on #613 with five
 * high-severity findings.
 *
 * Three of those were real, measured against the old code rather than assumed:
 *
 *   - `<[^>]+>` does not match `</script >`, so a script block written with a
 *     space before the bracket survived removal and its BODY landed in the
 *     knowledge base as text — `<script >alert(1)</script >` came out as
 *     `alert(1)`.
 *   - `&amp;` was unescaped ahead of `&lt;`, so the literal text `&amp;lt;`
 *     double-unescaped to `<`.
 *   - Only six entities were decoded, so `Caf&eacute;` reached the chunker
 *     verbatim — every book not written in English.
 *
 * The other two — the "incomplete multi-character sanitization" pair, about
 * removing an element splicing a `<scr` onto an `ipt>` — do **not** produce a
 * live tag through either implementation. They are theoretical for this sink.
 * The rewrite is worth it on the first three; do not claim it fixed five bugs.
 *
 * A real parse also reads better: entities are decoded by the parser rather
 * than by six hand-written `.replace()` calls, `<head>` is excluded
 * structurally rather than by a regex, and headings become markdown, which
 * `chunkMarkdownDocument()` splits on.
 */

import { JSDOM } from 'jsdom';

/** Block-level tags that should force a line break around their text. */
const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'SECTION',
  'ARTICLE',
  'UL',
  'OL',
  'TABLE',
  'TR',
  'BLOCKQUOTE',
  'PRE',
  'FIGURE',
  'FIGCAPTION',
  'HR',
  'MAIN',
]);

/**
 * Collapse runs of spaces/tabs but preserve intentional newlines.
 *
 * `\u00A0` (from `&nbsp;`) is folded into an ordinary space. A real parser
 * decodes the entity faithfully, which is correct but unhelpful downstream —
 * a non-breaking space is not what anyone searches for, and it survives into
 * embeddings as a different character from the space it looks like.
 */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function cleanInline(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Walk a DOM subtree and emit plain text, using `textContent` for leaf nodes
 * (which decodes HTML entities) and inserting newlines / markdown headings
 * around block elements.
 */
export function domToText(root: Node, win: JSDOM['window'], out: string[]): void {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === win.Node.TEXT_NODE) {
      out.push(child.textContent ?? '');
      continue;
    }
    if (child.nodeType !== win.Node.ELEMENT_NODE) continue;

    const el = child as Element;
    const tag = el.tagName.toUpperCase();
    const heading = /^H([1-6])$/.exec(tag);

    if (heading) {
      out.push(`\n\n${'#'.repeat(Number(heading[1]))} ${cleanInline(el.textContent)}\n\n`);
      continue;
    }
    if (tag === 'BR') {
      out.push('\n');
      continue;
    }
    if (tag === 'LI') {
      out.push('\n- ');
      domToText(el, win, out);
      continue;
    }
    if (BLOCK_TAGS.has(tag)) {
      out.push('\n');
      domToText(el, win, out);
      out.push('\n');
      continue;
    }
    // Inline element — recurse without adding breaks.
    domToText(el, win, out);
  }
}

export function extractText(el: Element, win: JSDOM['window']): string {
  const out: string[] = [];
  domToText(el, win, out);
  return normalizeWhitespace(out.join(''));
}

/**
 * One jsdom window, reused as a host for `DOMParser`.
 *
 * A book is parsed one chapter at a time, and constructing a `JSDOM` is the
 * expensive part — `DOMParser.parseFromString` returns an independent
 * `Document` each call, so the window can be shared without the documents
 * interacting. Created lazily so importing this module does not pull jsdom
 * into a process that never parses anything.
 */
let sharedWindow: JSDOM['window'] | null = null;

function getWindow(): JSDOM['window'] {
  sharedWindow ??= new JSDOM('').window;
  return sharedWindow;
}

/** Elements that never carry readable text. */
const NON_TEXT_SELECTOR = 'script, style, noscript, template';

/**
 * Parse a standalone HTML/XHTML document and return its body as plain text.
 *
 * `<head>` is excluded structurally — the parser puts it in `document.head`,
 * not `document.body` — which is why the EPUB parser no longer needs a regex
 * to stop each chapter's `<title>` being repeated ahead of its `<h1>`.
 *
 * jsdom does not execute scripts or fetch subresources here (we never set
 * `runScripts`/`resources`), so parsing untrusted markup is safe.
 */
export function extractTextFromHtml(html: string): string {
  const win = getWindow();
  const doc = win.document.implementation.createHTMLDocument('');
  doc.documentElement.innerHTML = html;

  for (const el of Array.from(doc.querySelectorAll(NON_TEXT_SELECTOR))) {
    el.remove();
  }

  return extractText(doc.body, win);
}
