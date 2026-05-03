/**
 * Unit Tests: KNOWN_PATTERNS — the canonical 21 Agentic Design Patterns.
 *
 * These tests are the cohesion guarantee for pattern numbering across the
 * codebase. They lock three invariants:
 *
 *  1. Drift catcher — `KNOWN_PATTERNS` agrees with the chunk metadata in
 *     `prisma/seeds/data/chunks/chunks.json`. The chunks are the seed data
 *     loaded into the orchestration knowledge base, sourced from Antonio
 *     Gullí's *Agentic Design Patterns*. If either side changes without the
 *     other, this test fails.
 *
 *  2. Template patterns are valid — every entry in every template's
 *     `patterns[]` array uses a (number, name) pair that matches a
 *     `KNOWN_PATTERNS` entry's `number` and either its `canonicalName` or
 *     one of its registered `aliases`. Catches "Agent Delegation",
 *     "External Call", "Orchestrator" — display names that aren't canonical
 *     patterns at all but were accidentally listed as such.
 *
 *  3. Step-registry pattern references are valid — every `patternNumber`
 *     declared in `STEP_REGISTRY` is one of the known canonical numbers
 *     (1–21). Phase C of the cohesion branch renames this field to
 *     `relatedPatterns: number[]`; this test will be updated to iterate the
 *     array at the same time.
 *
 * @see types/orchestration.ts — KNOWN_PATTERNS, isValidPatternReference()
 * @see prisma/seeds/data/chunks/chunks.json — canonical seed data
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import {
  KNOWN_PATTERNS,
  isValidPatternReference,
  type WorkflowTemplatePattern,
} from '@/types/orchestration';
import { BUILTIN_WORKFLOW_TEMPLATES } from '@/prisma/seeds/data/templates';
// `provider-model-audit` is exported but NOT in BUILTIN_WORKFLOW_TEMPLATES —
// it's seeded separately via 010-model-auditor.ts as a working installed
// workflow (isTemplate: false). Its patterns must still be canonical.
import { PROVIDER_MODEL_AUDIT_TEMPLATE } from '@/prisma/seeds/data/templates/provider-model-audit';
import { STEP_REGISTRY } from '@/lib/orchestration/engine/step-registry';

const ALL_TEMPLATES = [...BUILTIN_WORKFLOW_TEMPLATES, PROVIDER_MODEL_AUDIT_TEMPLATE];

// ---------------------------------------------------------------------------
// Drift catcher: chunks.json ↔ KNOWN_PATTERNS
// ---------------------------------------------------------------------------

/**
 * Minimal Zod schema for the chunk shape we read. Validates at the boundary
 * (per CLAUDE.md "Validate at boundaries — all user input through Zod
 * schemas") so we don't `as`-cast JSON-parsed data.
 */
const PatternOverviewMetadataSchema = z.object({
  type: z.literal('pattern_overview'),
  pattern_number: z.number().int().min(1).max(21),
  pattern_name: z.string().min(1),
});
const ChunkSchema = z.object({
  id: z.string(),
  metadata: z.object({ type: z.string() }).passthrough().optional(),
});
const ChunksFileSchema = z.array(ChunkSchema);

function loadPatternOverviews(): { number: number; name: string }[] {
  const raw = readFileSync(
    resolve(__dirname, '../../../prisma/seeds/data/chunks/chunks.json'),
    'utf-8'
  );
  const parsed = ChunksFileSchema.parse(JSON.parse(raw));
  const overviews: { number: number; name: string }[] = [];
  for (const chunk of parsed) {
    if (chunk.metadata?.type !== 'pattern_overview') continue;
    const meta = PatternOverviewMetadataSchema.parse(chunk.metadata);
    overviews.push({ number: meta.pattern_number, name: meta.pattern_name });
  }
  return overviews;
}

describe('KNOWN_PATTERNS drift catcher (chunks.json ↔ types/orchestration.ts)', () => {
  const overviews = loadPatternOverviews();

  it('chunks.json contains exactly 21 pattern_overview chunks', () => {
    expect(overviews).toHaveLength(21);
  });

  it('KNOWN_PATTERNS contains exactly 21 entries', () => {
    expect(KNOWN_PATTERNS).toHaveLength(21);
  });

  it.each(KNOWN_PATTERNS.map((p) => [p.number, p.canonicalName, p] as const))(
    'KNOWN_PATTERNS[%d] (%s) matches a chunks.json pattern_overview',
    (number, canonicalName) => {
      const match = overviews.find((o) => o.number === number);
      expect(match, `no chunks.json pattern_overview for number ${number}`).toBeDefined();
      expect(match?.name).toBe(canonicalName);
    }
  );

  it('every chunks.json pattern_overview has a KNOWN_PATTERNS entry', () => {
    for (const overview of overviews) {
      const known = KNOWN_PATTERNS.find((p) => p.number === overview.number);
      expect(known, `KNOWN_PATTERNS missing entry for ${overview.number}`).toBeDefined();
      expect(known?.canonicalName).toBe(overview.name);
    }
  });
});

// ---------------------------------------------------------------------------
// Template patterns are valid
// ---------------------------------------------------------------------------

describe('Workflow templates — patterns[] entries are canonical', () => {
  it.each(
    ALL_TEMPLATES.flatMap((t) =>
      t.patterns.map((p): [string, WorkflowTemplatePattern] => [
        `${t.slug}:${p.number}/${p.name}`,
        p,
      ])
    )
  )('%s passes isValidPatternReference()', (_label, pattern) => {
    expect(
      isValidPatternReference(pattern.number, pattern.name),
      `Pattern (${pattern.number}, "${pattern.name}") is not in KNOWN_PATTERNS. ` +
        `Either fix the template, or register the name as an alias on the matching KnownPattern.`
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step-registry pattern references are valid
// ---------------------------------------------------------------------------

describe('STEP_REGISTRY — patternNumber references a canonical pattern', () => {
  // Phase C of the cohesion branch renames `patternNumber` to
  // `relatedPatterns: number[]`. When that lands, swap the iteration to flat
  // every entry's array.
  const knownNumbers = new Set(KNOWN_PATTERNS.map((p) => p.number));

  it.each(
    STEP_REGISTRY.filter((e) => e.patternNumber !== undefined).map(
      (e) => [e.type, e.patternNumber as number] as const
    )
  )('step "%s" patternNumber=%d is one of the canonical 21', (_type, num) => {
    expect(knownNumbers.has(num), `${num} is not in KNOWN_PATTERNS`).toBe(true);
  });
});
