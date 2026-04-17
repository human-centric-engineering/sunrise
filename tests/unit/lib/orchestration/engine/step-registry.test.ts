/**
 * Unit Tests: Step Registry
 *
 * Test Coverage:
 * - Every KNOWN_STEP_TYPES entry has a matching STEP_REGISTRY entry
 * - Every entry has a non-empty label, description, and an icon
 * - route has 2 outputs, parallel has 3, every other entry has 1
 * - Every entry has 1 input
 * - getStepMetadata returns correct entries or undefined
 * - STEP_CATEGORY_ORDER contains all four categories
 * - STEP_CATEGORY_COLOURS has a mapping for each category
 *
 * @see lib/orchestration/engine/step-registry.ts
 */

import { describe, it, expect } from 'vitest';

import {
  STEP_REGISTRY,
  STEP_CATEGORY_ORDER,
  STEP_CATEGORY_COLOURS,
  getStepMetadata,
  type StepCategory,
} from '@/lib/orchestration/engine/step-registry';
import { KNOWN_STEP_TYPES } from '@/types/orchestration';

describe('STEP_REGISTRY', () => {
  it('has an entry for every KNOWN_STEP_TYPE', () => {
    const registeredTypes = new Set(STEP_REGISTRY.map((e) => e.type));
    for (const knownType of KNOWN_STEP_TYPES) {
      expect(registeredTypes.has(knownType), `missing registry entry for "${knownType}"`).toBe(
        true
      );
    }
  });

  it('has 12 entries matching the known step types count', () => {
    expect(STEP_REGISTRY.length).toBe(KNOWN_STEP_TYPES.length);
  });

  describe('every entry', () => {
    it.each([...STEP_REGISTRY])('$type has a non-empty label', (entry) => {
      expect(typeof entry.label).toBe('string');
      expect(entry.label.trim().length).toBeGreaterThan(0);
    });

    it.each([...STEP_REGISTRY])('$type has a non-empty description', (entry) => {
      expect(typeof entry.description).toBe('string');
      expect(entry.description.trim().length).toBeGreaterThan(0);
    });

    it.each([...STEP_REGISTRY])('$type has an icon', (entry) => {
      // Icons are Lucide React components — they may be function or object (forwardRef)
      expect(entry.icon).not.toBeNull();
      expect(entry.icon).not.toBeUndefined();
      const t = typeof entry.icon;
      expect(['function', 'object']).toContain(t);
    });

    it.each([...STEP_REGISTRY])('$type has exactly 1 input', (entry) => {
      expect(entry.inputs).toBe(1);
    });
  });

  describe('output counts', () => {
    it('route has 2 outputs', () => {
      const entry = STEP_REGISTRY.find((e) => e.type === 'route');
      expect(entry?.outputs).toBe(2);
    });

    it('guard has 2 outputs', () => {
      const entry = STEP_REGISTRY.find((e) => e.type === 'guard');
      expect(entry?.outputs).toBe(2);
    });

    it('parallel has 3 outputs', () => {
      const entry = STEP_REGISTRY.find((e) => e.type === 'parallel');
      expect(entry?.outputs).toBe(3);
    });

    it('all other entries have exactly 1 output', () => {
      const multiOutput = new Set(['route', 'parallel', 'guard']);
      const others = STEP_REGISTRY.filter((e) => !multiOutput.has(e.type));
      for (const entry of others) {
        expect(entry.outputs, `${entry.type} should have 1 output`).toBe(1);
      }
    });
  });
});

describe('getStepMetadata', () => {
  it('returns the LLM Call entry for "llm_call"', () => {
    const meta = getStepMetadata('llm_call');
    expect(meta).toBeDefined();
    expect(meta?.type).toBe('llm_call');
    expect(meta?.label).toBe('LLM Call');
  });

  it('returns undefined for an unknown type', () => {
    const meta = getStepMetadata('nope');
    expect(meta).toBeUndefined();
  });

  it('returns the correct entry for each known type', () => {
    for (const knownType of KNOWN_STEP_TYPES) {
      const meta = getStepMetadata(knownType);
      expect(meta, `missing metadata for "${knownType}"`).toBeDefined();
      expect(meta?.type).toBe(knownType);
    }
  });
});

describe('STEP_CATEGORY_ORDER', () => {
  const expectedCategories: StepCategory[] = ['agent', 'decision', 'input', 'output'];

  it('contains all four category values', () => {
    for (const cat of expectedCategories) {
      expect(STEP_CATEGORY_ORDER).toContain(cat);
    }
  });

  it('has exactly 4 categories', () => {
    expect(STEP_CATEGORY_ORDER.length).toBe(4);
  });
});

describe('STEP_CATEGORY_COLOURS', () => {
  const expectedCategories: StepCategory[] = ['agent', 'decision', 'input', 'output'];

  it('has a colour mapping for each category', () => {
    for (const cat of expectedCategories) {
      const colours = STEP_CATEGORY_COLOURS[cat];
      expect(colours, `missing colours for "${cat}"`).toBeDefined();
    }
  });

  it('each colour mapping has bg, border, text, and iconBg keys', () => {
    for (const cat of expectedCategories) {
      const colours = STEP_CATEGORY_COLOURS[cat];
      expect(typeof colours.bg).toBe('string');
      expect(typeof colours.border).toBe('string');
      expect(typeof colours.text).toBe('string');
      expect(typeof colours.iconBg).toBe('string');
    }
  });
});
