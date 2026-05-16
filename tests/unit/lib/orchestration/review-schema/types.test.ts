import { describe, expect, it } from 'vitest';

import {
  badgeSpecSchema,
  fieldSpecSchema,
  reviewSchemaSchema,
  reviewSectionSchema,
} from '@/lib/orchestration/review-schema/types';

describe('reviewSchemaSchema', () => {
  it('parses a minimal valid schema with one flat section', () => {
    const result = reviewSchemaSchema.safeParse({
      sections: [
        {
          id: 'items',
          title: 'Items',
          source: '{{step.output.values}}',
          itemKey: 'id',
          itemTitle: '{{item.name}}',
          fields: [{ key: 'name', label: 'Name', display: 'text' }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('parses a nested section with subItems', () => {
    const result = reviewSchemaSchema.safeParse({
      sections: [
        {
          id: 'models',
          title: 'Models',
          source: '{{step.output.models}}',
          itemKey: 'id',
          itemTitle: '{{item.name}}',
          subItems: {
            source: 'item.changes',
            itemKey: 'field',
            fields: [{ key: 'field', label: 'Field', display: 'text' }],
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a section with neither fields nor subItems', () => {
    const result = reviewSchemaSchema.safeParse({
      sections: [
        {
          id: 'x',
          title: 'X',
          source: '{{s.output.v}}',
          itemKey: 'id',
          itemTitle: '{{item.id}}',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty sections array', () => {
    const result = reviewSchemaSchema.safeParse({ sections: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a section id that is not a JS-identifier-style key', () => {
    // Section id becomes an approvalPayload property — reject characters
    // that would force consumers to bracket-quote the key.
    const result = reviewSectionSchema.safeParse({
      id: 'has-hyphens',
      title: 'X',
      source: '{{s.output.v}}',
      itemKey: 'id',
      itemTitle: '{{item.id}}',
      fields: [{ key: 'name', label: 'Name', display: 'text' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('fieldSpecSchema', () => {
  it('parses every display variant', () => {
    for (const display of ['text', 'badge', 'pre', 'enum', 'number', 'boolean', 'textarea']) {
      const result = fieldSpecSchema.safeParse({ key: 'k', label: 'L', display });
      expect(result.success, `display=${display}`).toBe(true);
    }
  });

  it('rejects an unknown display variant', () => {
    const result = fieldSpecSchema.safeParse({ key: 'k', label: 'L', display: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('accepts optional editable / readonly / enum hints', () => {
    const result = fieldSpecSchema.safeParse({
      key: 'k',
      label: 'L',
      display: 'enum',
      editable: true,
      readonly: false,
      enumValuesFrom: 'TIER_ROLES',
      enumValuesByFieldKey: 'field',
      enumValues: ['a', 'b'],
    });
    expect(result.success).toBe(true);
  });
});

describe('badgeSpecSchema', () => {
  it('requires a key, label is optional', () => {
    expect(badgeSpecSchema.safeParse({ key: 'confidence' }).success).toBe(true);
    expect(badgeSpecSchema.safeParse({ key: 'confidence', label: 'conf' }).success).toBe(true);
    expect(badgeSpecSchema.safeParse({ label: 'no key' }).success).toBe(false);
  });
});
