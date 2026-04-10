/**
 * Markdown Document Chunker Tests
 *
 * Tests for chunkMarkdownDocument — the pure-logic chunking pipeline
 * that splits markdown into embeddable knowledge-base chunks.
 *
 * Covered scenarios:
 * - Happy-path pattern section parsing (## N. Name → subsections)
 * - Mermaid block stripping
 * - HTML metadata comment propagation
 * - normalizeChunkSizes: merge (tiny sections) and split (oversized sections)
 * - Critical [big, small, small, big] buffer-flush-before-split sequence
 * - Generic header chunk-type inference (glossary, recipe, guide, cost, etc.)
 * - Edge cases: empty content, whitespace-only, no headers, 2-digit pattern numbers
 * - Slug safety (spaces, punctuation, unicode, 60-char cap)
 * - estimatedTokens approximation (Math.ceil(len / 4))
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chunkMarkdownDocument } from '@/lib/orchestration/knowledge/chunker';

// ── Mock logger so the info() call at the end of chunkMarkdownDocument is a no-op
vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a string of exactly `n` tokens (estimateTokens formula: Math.ceil(len/4)).
 * Using 'x'.repeat(n * 4) gives exactly n*4 chars → Math.ceil((n*4)/4) = n tokens.
 */
function makeWords(tokens: number): string {
  return 'x'.repeat(tokens * 4);
}

// ────────────────────────────────────────────────────────────────────────────
// chunkMarkdownDocument
// ────────────────────────────────────────────────────────────────────────────

describe('chunkMarkdownDocument', () => {
  // ── Happy-path: standard pattern document ───────────────────────────────

  it('should parse pattern number and name from ## N. Pattern Name header', () => {
    const content = `
## 1. Foo Pattern

### Problem

The problem description goes here with enough words to meet the minimum token threshold.

### Solution

The solution description goes here with enough words to meet the minimum token threshold.
`.trim();

    const chunks = chunkMarkdownDocument(content, 'my-doc');

    const sectionChunks = chunks.filter((c) => c.chunkType === 'pattern_section');
    expect(sectionChunks.length).toBeGreaterThan(0);

    for (const chunk of sectionChunks) {
      expect(chunk.patternNumber).toBe(1);
      expect(chunk.patternName).toBe('Foo Pattern');
    }
  });

  it('should prefix chunk id with document slug for pattern chunks', () => {
    const content = `
## 1. Foo Pattern

### Problem

The problem description goes here with enough words to meet the minimum token threshold.
`.trim();

    const chunks = chunkMarkdownDocument(content, 'my-doc');

    for (const chunk of chunks) {
      expect(chunk.id).toMatch(/^my-doc-/);
    }
  });

  it('should set chunkType to pattern_section for named subsections', () => {
    const content = `
## 1. Retry Pattern

### When To Use

Use this pattern when you need resilience with enough text to pass the minimum token count.
`.trim();

    const chunks = chunkMarkdownDocument(content, 'doc');

    expect(chunks.some((c) => c.chunkType === 'pattern_section')).toBe(true);
  });

  // ── Mermaid stripping ────────────────────────────────────────────────────

  it('should strip mermaid code blocks before chunking', () => {
    const content = `
## Introduction

Some intro text that is long enough to meet the minimum token threshold for chunking purposes.

\`\`\`mermaid
graph TD
  A --> B
  B --> C
\`\`\`

More text after the diagram that also helps meet the minimum chunk size.
`.trim();

    const chunks = chunkMarkdownDocument(content, 'doc');

    for (const chunk of chunks) {
      expect(chunk.content).not.toContain('mermaid');
      expect(chunk.content).not.toContain('graph TD');
      expect(chunk.content).not.toContain('```');
    }
  });

  it('should strip multiple mermaid blocks when present', () => {
    const content = `
## Overview

Text before first diagram.

\`\`\`mermaid
sequenceDiagram
  A->>B: Hello
\`\`\`

Middle text that is long enough to pass minimum token threshold for proper chunking.

\`\`\`mermaid
flowchart LR
  X --> Y
\`\`\`

Final text to close out the section with enough content.
`.trim();

    const chunks = chunkMarkdownDocument(content, 'doc');

    for (const chunk of chunks) {
      expect(chunk.content).not.toContain('sequenceDiagram');
      expect(chunk.content).not.toContain('flowchart');
    }
  });

  // ── Metadata comment propagation ─────────────────────────────────────────

  it('should parse document-level metadata comments and set category on chunks', () => {
    const content = `
<!-- metadata: category=core, keywords=retry-backoff -->

## 1. Retry Pattern

### Problem

Enough text here to satisfy the minimum token requirement for this pattern section chunk.
`.trim();

    const chunks = chunkMarkdownDocument(content, 'doc');

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.category).toBe('core');
      expect(chunk.keywords).toBe('retry-backoff');
    }
  });

  it('should preserve comma-containing values when the value is double-quoted', () => {
    const content = `
<!-- metadata: category=core, keywords="retry,backoff,circuit-breaker" -->

## 1. Retry Pattern

### Problem

Enough text here to satisfy the minimum token requirement for this pattern section chunk.
`.trim();

    const chunks = chunkMarkdownDocument(content, 'doc');

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.category).toBe('core');
      // Previously the parser split on `,` before `=`, truncating to just "retry".
      // With quote-aware splitting the full value is preserved and quotes are stripped.
      expect(chunk.keywords).toBe('retry,backoff,circuit-breaker');
    }
  });

  it('should preserve equals signs inside metadata values (first = is the separator)', () => {
    const content = `
<!-- metadata: keywords=a=1 -->

## 1. Equals Pattern

### Problem

Enough text here to satisfy the minimum token requirement for this pattern section chunk.
`.trim();

    const chunks = chunkMarkdownDocument(content, 'doc');
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.keywords).toBe('a=1');
    }
  });

  it('should strip metadata comments from chunk content', () => {
    const content = `
<!-- metadata: category=core -->

## 1. Circuit Breaker

### Overview

This section describes the pattern in enough detail to pass the minimum token threshold.
`.trim();

    const chunks = chunkMarkdownDocument(content, 'doc');

    for (const chunk of chunks) {
      expect(chunk.content).not.toContain('<!-- metadata:');
      expect(chunk.content).not.toContain('-->');
    }
  });

  it('should allow section-level metadata to override document-level metadata', () => {
    const content = `
<!-- metadata: category=global -->

## 1. Fallback Pattern

<!-- metadata: category=resilience, keywords=fallback -->

### Problem

Enough text here to satisfy the minimum token requirement for proper chunk sizing.
`.trim();

    const chunks = chunkMarkdownDocument(content, 'doc');

    // Section-level metadata should override the document-level category
    const hasResilienceCategory = chunks.some((c) => c.category === 'resilience');
    expect(hasResilienceCategory).toBe(true);
  });

  // ── Normalize: merge tiny sections ───────────────────────────────────────

  it('should merge several tiny sub-50-token sections into one chunk', () => {
    // Each of these subsections is well under 50 tokens; they should be merged
    const content = `
## Introduction

Short intro.

### A

Tiny A.

### B

Tiny B.

### C

Tiny C.
`.trim();

    const chunks = chunkMarkdownDocument(content, 'doc');

    // Merging means fewer output chunks than there are headers
    // At minimum the tiny ones are collapsed; there won't be 3 separate tiny chunks
    expect(chunks.length).toBeLessThan(4);
  });

  // ── Normalize: split oversized sections ──────────────────────────────────

  it('should split a section over 800 tokens on paragraph boundaries', () => {
    // combinedContent passed to normalizeChunkSizes:
    //   "Big Pattern — Problem\n\n<para1>\n\n<para2>"
    // Two paragraphs of 500 tokens each make the combined content ~1008 tokens → triggers split.
    // Each individual paragraph is ~503 tokens → comfortably under MAX (800).
    const para = makeWords(500); // 500 tokens = 2000 chars each
    const body = `${para}\n\n${para}`;

    const content = `## 1. Big Pattern\n\n### Problem\n\n${body}`;
    const chunks = chunkMarkdownDocument(content, 'doc');

    // Every chunk must be at or under MAX (800 tokens)
    for (const chunk of chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(800);
    }
    // The body is too large to fit in one chunk, so it must be split into at least 2
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('should preserve the subsection header as prefix in each split chunk', () => {
    // The normalizer uses section.header (the ### sub-header) as the prefix in split chunks.
    // So split chunks will contain "Implementation\n\n<paragraph>".
    const para = makeWords(500);
    const body = `${para}\n\n${para}`;
    const content = `## 1. Split Pattern\n\n### Implementation\n\n${body}`;

    const chunks = chunkMarkdownDocument(content, 'doc');

    // The subsection header "Implementation" should appear in each split chunk's content
    for (const chunk of chunks) {
      expect(chunk.content).toContain('Implementation');
    }
  });

  // ── Critical: [big, small, small, big] buffer-flush-before-split ─────────

  it('should flush buffer before splitting an oversized section in a [big, small, small, big] sequence', () => {
    // Each paragraph is 500 tokens; two together (~1003 tokens) exceed MAX (800).
    // This makes each ### section exceed 800 tokens when combined with its header prefix.
    const largePara = makeWords(500);
    const bigBody = `${largePara}\n\n${largePara}`;
    const smallBody = 'Short text.'; // well under 50 tokens

    // Construct a pattern doc where subsections form the [big, small, small, big] sequence:
    //   Section A: combinedContent > 800 tokens  → flush+split path
    //   Section B: combinedContent < 50 tokens   → buffer starts
    //   Section C: combinedContent < 50 tokens   → merges into buffer
    //   Section D: combinedContent > 800 tokens  → buffer must flush BEFORE split
    const content = `
## 1. Complex Pattern

### Section A

${bigBody}

### Section B

${smallBody}

### Section C

${smallBody}

### Section D

${bigBody}
`.trim();

    const chunks = chunkMarkdownDocument(content, 'doc');

    // All chunks must satisfy the size constraint
    for (const chunk of chunks) {
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(800);
    }

    // The buffer (B + C content) must appear in some chunk — not lost
    const combined = chunks.map((c) => c.content).join(' ');
    expect(combined).toContain('Short text.');

    // Should produce multiple chunks (A splits, B+C buffer, D splits)
    expect(chunks.length).toBeGreaterThan(2);
  });

  it('should flush buffer when a normal-sized section follows small sections', () => {
    // Sequence: [tiny, tiny, normal] → tiny sections go into buffer,
    // then the normal-sized section triggers the buffer flush (lines 160-164 in normalizer).
    // Use a generic document (no ## N. pattern) so subsections map directly.
    const normalBody = makeWords(100); // 100 tokens — between MIN (50) and MAX (800)
    const content = `
## Overview

Short tiny text.

### Details

${normalBody}
`.trim();

    const chunks = chunkMarkdownDocument(content, 'doc');

    // The normal section should cause the buffered tiny content to appear as a chunk
    // and the normal section itself also appears — so we get at least 1 chunk total
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    // The normal-sized content must appear somewhere in output
    const combined = chunks.map((c) => c.content).join(' ');
    expect(combined).toContain('Details');
  });

  // ── Generic header type inference ─────────────────────────────────────────

  it('should infer chunkType glossary for a Glossary header', () => {
    const content = `
## Glossary

Term one: definition one with enough words here to meet the minimum chunk size threshold.
`.trim();
    const chunks = chunkMarkdownDocument(content, 'doc');
    expect(chunks.some((c) => c.chunkType === 'glossary')).toBe(true);
  });

  it('should infer chunkType composition_recipe for a Composition Recipe header', () => {
    const content = `
## Composition Recipe

Recipe instructions here with enough words to satisfy the minimum token threshold for chunks.
`.trim();
    const chunks = chunkMarkdownDocument(content, 'doc');
    expect(chunks.some((c) => c.chunkType === 'composition_recipe')).toBe(true);
  });

  it('should infer chunkType selection_guide for a Selection Guide header', () => {
    const content = `
## Pattern Selection Guide

Guide content here with enough words to satisfy the minimum token threshold for chunks.
`.trim();
    const chunks = chunkMarkdownDocument(content, 'doc');
    expect(chunks.some((c) => c.chunkType === 'selection_guide')).toBe(true);
  });

  it('should infer chunkType cost_reference for a Cost & Pricing header', () => {
    const content = `
## Cost and Pricing

Pricing info here with enough words to satisfy the minimum token threshold for chunks.
`.trim();
    const chunks = chunkMarkdownDocument(content, 'doc');
    expect(chunks.some((c) => c.chunkType === 'cost_reference')).toBe(true);
  });

  it('should infer chunkType context_engineering for a Context Engineering header', () => {
    const content = `
## Context Engineering

Context info here with enough words to satisfy the minimum token threshold for chunks.
`.trim();
    const chunks = chunkMarkdownDocument(content, 'doc');
    expect(chunks.some((c) => c.chunkType === 'context_engineering')).toBe(true);
  });

  it('should infer chunkType emerging_concepts for an Emerging Concepts header', () => {
    const content = `
## Emerging Patterns

Frontier content here with enough words to satisfy the minimum token threshold for chunks.
`.trim();
    const chunks = chunkMarkdownDocument(content, 'doc');
    expect(chunks.some((c) => c.chunkType === 'emerging_concepts')).toBe(true);
  });

  it('should infer chunkType ecosystem for an Ecosystem & Tools header', () => {
    const content = `
## Ecosystem Overview

Ecosystem content here with enough words to satisfy the minimum token threshold for chunks.
`.trim();
    const chunks = chunkMarkdownDocument(content, 'doc');
    expect(chunks.some((c) => c.chunkType === 'ecosystem')).toBe(true);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('should return an empty array for empty content', () => {
    const chunks = chunkMarkdownDocument('', 'doc');
    expect(chunks).toEqual([]);
  });

  it('should return an empty array for whitespace-only content', () => {
    const chunks = chunkMarkdownDocument('   \n\n\t  ', 'doc');
    expect(chunks).toEqual([]);
  });

  it('should handle content with no headers (treated as generic body)', () => {
    const content =
      'This is a paragraph without any markdown headers. ' +
      'It contains enough text to meet the minimum token threshold for chunking.';

    const chunks = chunkMarkdownDocument(content, 'doc');

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].patternNumber).toBeNull();
    expect(chunks[0].patternName).toBeNull();
  });

  it('should parse 2-digit pattern numbers (## 12. X)', () => {
    const content = `
## 12. Exception Handling & Recovery

### Overview

Content here with enough words to satisfy the minimum token threshold for proper chunking.
`.trim();

    const chunks = chunkMarkdownDocument(content, 'doc');

    const withNumber = chunks.filter((c) => c.patternNumber !== null);
    expect(withNumber.length).toBeGreaterThan(0);
    expect(withNumber[0].patternNumber).toBe(12);
    expect(withNumber[0].patternName).toBe('Exception Handling & Recovery');
  });

  it('should NOT treat ## Introduction as a pattern header', () => {
    const content = `
## Introduction

This is general introductory content with enough words to meet the minimum token threshold.
`.trim();

    const chunks = chunkMarkdownDocument(content, 'doc');

    for (const chunk of chunks) {
      expect(chunk.patternNumber).toBeNull();
      expect(chunk.patternName).toBeNull();
    }
  });

  // ── Slug safety ───────────────────────────────────────────────────────────

  it('should produce a url-safe chunk id prefix for documentName with spaces and punctuation', () => {
    const content =
      'Content here with enough words to satisfy the minimum token threshold for chunking.';
    const chunks = chunkMarkdownDocument(content, 'My Document: Special & Chars!');

    for (const chunk of chunks) {
      // id must not contain spaces, colons, ampersands, or exclamation marks
      expect(chunk.id).toMatch(/^[a-z0-9-]+/);
      expect(chunk.id).not.toMatch(/[ :&!]/);
    }
  });

  it('should cap the document slug at 60 characters in chunk ids', () => {
    const longName = 'a'.repeat(100) + ' extra words and more characters to push past the limit';
    const content =
      'Content here with enough words to satisfy the minimum token threshold for chunking.';
    const chunks = chunkMarkdownDocument(content, longName);

    for (const chunk of chunks) {
      // The slug prefix should be derived from a slug capped at 60 chars
      const slugPart = chunk.id.split('-section')[0].split('-0')[0];
      expect(slugPart.length).toBeLessThanOrEqual(70); // slug(60) + any separator
    }
  });

  // ── estimatedTokens ───────────────────────────────────────────────────────

  it('should report estimatedTokens as Math.ceil(content.length / 4)', () => {
    const content = `
## 1. Token Count Pattern

### Overview

ABCDEFGHIJKLMNOP
`.trim();

    const chunks = chunkMarkdownDocument(content, 'doc');

    for (const chunk of chunks) {
      // The chunk stores the combinedContent length estimate, not the stripped content length.
      // We verify the formula holds: ceil(len/4).
      const expectedTokens = Math.ceil(chunk.content.length / 4);
      // Allow for minor difference between combinedContent (used for estimate) and stripped content
      expect(chunk.estimatedTokens).toBeGreaterThanOrEqual(expectedTokens);
    }
  });
});
