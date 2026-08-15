/**
 * Unit Tests: shared DOM text extraction (`dom-text.ts`)
 *
 * This module replaced a chain of regex replacements in `epub-parser.ts` that
 * CodeQL flagged with five high-severity findings. Three of them correspond to
 * output defects that were measured against the old code, and each has a test
 * below built from the input that produced it. The other two — the
 * "incomplete multi-character sanitization" pair, about splicing a `<scr` onto
 * an `ipt>` — do NOT produce a live tag through either implementation; they are
 * theoretical for this sink. The parse is still the right answer, but on the
 * strength of the first three, not the pair. Say so rather than claiming five
 * bugs were fixed.
 *
 * @see lib/orchestration/knowledge/parsers/dom-text.ts
 */

import { describe, it, expect } from 'vitest';

import { extractTextFromHtml } from '@/lib/orchestration/knowledge/parsers/dom-text';

describe('extractTextFromHtml — what defeated the regexes', () => {
  it('cannot leave a tag behind, however the markup is written', () => {
    // `<[^>]+>` does not match a closing tag with a space before the bracket,
    // so this used to emit a literal `</script >` into the knowledge base.
    const text = extractTextFromHtml('<body><p>before</p><script >alert(1)</script >after</body>');

    expect(text).not.toContain('<');
    expect(text).not.toContain('alert(1)');
  });

  it('does not double-unescape entities', () => {
    // `&amp;lt;` means the literal text `&lt;`. Unescaping `&amp;` first and
    // `&lt;` afterwards turned it into `<` — one unescape too many.
    expect(extractTextFromHtml('<body><p>&amp;lt;</p></body>')).toBe('&lt;');
  });

  it('decodes entities the hand-written list never covered', () => {
    // The regex chain knew six entities. A book in any language but English
    // kept the rest as literal source text.
    const text = extractTextFromHtml(
      '<body><p>Caf&eacute; &amp; cr&egrave;me &mdash; 5 &lt; 6</p></body>'
    );

    expect(text).toBe('Café & crème — 5 < 6');
  });
});

describe('extractTextFromHtml — structure', () => {
  it('excludes <head>, so a chapter does not repeat its own title', () => {
    // Structural, not a rule: the parser puts `<head>` in `document.head`,
    // which is not what gets walked. This is what the `<head>` regex was for.
    const text = extractTextFromHtml(
      '<html><head><title>Chapter One</title></head><body><h1>Chapter One</h1><p>Prose.</p></body></html>'
    );

    expect(text.split('Chapter One').length - 1).toBe(1);
  });

  it('drops script, style, noscript and template content', () => {
    const text = extractTextFromHtml(
      '<body><style>.a{color:red}</style><script>var x=1</script>' +
        '<noscript>enable js</noscript><template><p>tpl</p></template><p>kept</p></body>'
    );

    expect(text).toBe('kept');
  });

  it('renders headings as markdown, which the chunker splits on', () => {
    // `chunkMarkdownDocument()` splits on `## ` — so this is what gives a book
    // chapter-shaped chunks rather than arbitrary ones.
    const text = extractTextFromHtml('<body><h2>A Heading</h2><p>Body.</p></body>');

    expect(text).toContain('## A Heading');
  });

  it('separates block elements and honours <br>', () => {
    const text = extractTextFromHtml('<body><p>one</p><p>two</p><div>three<br>four</div></body>');

    expect(text).toBe('one\n\ntwo\n\nthree\nfour');
  });

  it('marks list items', () => {
    expect(extractTextFromHtml('<body><ul><li>one</li><li>two</li></ul></body>')).toBe(
      '- one\n- two'
    );
  });

  it('folds a non-breaking space into an ordinary one', () => {
    // `&nbsp;` decodes faithfully to U+00A0, which is correct and unhelpful:
    // it is not the character anyone searches for, and it reaches embeddings
    // looking like a space but comparing unequal to one.
    const text = extractTextFromHtml('<body><p>a&nbsp;b</p></body>');

    expect(text).toBe('a b');
    expect(text).not.toContain(' ');
  });

  it('returns empty string for markup with no text', () => {
    expect(extractTextFromHtml('<body><img src="x.jpg"/></body>')).toBe('');
  });

  it('handles a fragment with no body wrapper', () => {
    expect(extractTextFromHtml('<p>bare</p>')).toBe('bare');
  });
});
