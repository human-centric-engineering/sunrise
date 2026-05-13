/**
 * Knowledge Constants Tests
 *
 * Test Coverage:
 * - KNOWLEDGE_TABS values match expected string literals
 * - KNOWLEDGE_TAB_VALUES contains all four tab values
 * - DEFAULT_KNOWLEDGE_TAB is 'manage'
 * - KNOWLEDGE_TAB_TITLES contains a title for every tab value
 * - Title strings include expected keywords
 * - KnowledgeTab type is satisfied by all KNOWLEDGE_TABS values
 *
 * @see lib/constants/knowledge.ts
 */

import { describe, it, expect } from 'vitest';

import {
  KNOWLEDGE_TABS,
  KNOWLEDGE_TAB_VALUES,
  DEFAULT_KNOWLEDGE_TAB,
  KNOWLEDGE_TAB_TITLES,
  type KnowledgeTab,
} from '@/lib/constants/knowledge';

describe('KNOWLEDGE_TABS', () => {
  it('has MANAGE value "manage"', () => {
    expect(KNOWLEDGE_TABS.MANAGE).toBe('manage');
  });

  it('has TAGS value "tags"', () => {
    expect(KNOWLEDGE_TABS.TAGS).toBe('tags');
  });

  it('has EXPLORE value "explore"', () => {
    expect(KNOWLEDGE_TABS.EXPLORE).toBe('explore');
  });

  it('has VISUALIZE value "visualize"', () => {
    expect(KNOWLEDGE_TABS.VISUALIZE).toBe('visualize');
  });

  it('has ERRORS value "errors"', () => {
    expect(KNOWLEDGE_TABS.ERRORS).toBe('errors');
  });

  it('contains exactly 5 entries (added Tags when knowledge-access-control shipped)', () => {
    expect(Object.keys(KNOWLEDGE_TABS)).toHaveLength(5);
  });
});

describe('KNOWLEDGE_TAB_VALUES', () => {
  it('contains all five tab string values', () => {
    expect(KNOWLEDGE_TAB_VALUES).toContain('manage');
    expect(KNOWLEDGE_TAB_VALUES).toContain('tags');
    expect(KNOWLEDGE_TAB_VALUES).toContain('explore');
    expect(KNOWLEDGE_TAB_VALUES).toContain('visualize');
    expect(KNOWLEDGE_TAB_VALUES).toContain('errors');
  });

  it('has length 5', () => {
    expect(KNOWLEDGE_TAB_VALUES).toHaveLength(5);
  });

  it('contains no duplicates', () => {
    const unique = new Set(KNOWLEDGE_TAB_VALUES);
    expect(unique.size).toBe(KNOWLEDGE_TAB_VALUES.length);
  });
});

describe('DEFAULT_KNOWLEDGE_TAB', () => {
  it('is "manage"', () => {
    expect(DEFAULT_KNOWLEDGE_TAB).toBe('manage');
  });

  it('is one of the valid tab values', () => {
    expect(KNOWLEDGE_TAB_VALUES).toContain(DEFAULT_KNOWLEDGE_TAB);
  });
});

describe('KNOWLEDGE_TAB_TITLES', () => {
  it('has a title for every tab value', () => {
    for (const tab of KNOWLEDGE_TAB_VALUES) {
      expect(KNOWLEDGE_TAB_TITLES[tab as KnowledgeTab]).toBeDefined();
    }
  });

  it('manage title contains "Manage"', () => {
    expect(KNOWLEDGE_TAB_TITLES.manage).toContain('Manage');
  });

  it('explore title contains "Explore"', () => {
    expect(KNOWLEDGE_TAB_TITLES.explore).toContain('Explore');
  });

  it('visualize title contains "Visualize"', () => {
    expect(KNOWLEDGE_TAB_TITLES.visualize).toContain('Visualize');
  });

  it('errors title contains "Errors"', () => {
    expect(KNOWLEDGE_TAB_TITLES.errors).toContain('Errors');
  });

  it('all titles contain "Knowledge Base"', () => {
    for (const tab of KNOWLEDGE_TAB_VALUES) {
      expect(KNOWLEDGE_TAB_TITLES[tab as KnowledgeTab]).toContain('Knowledge Base');
    }
  });

  it('all titles are non-empty strings', () => {
    for (const tab of KNOWLEDGE_TAB_VALUES) {
      const title = KNOWLEDGE_TAB_TITLES[tab as KnowledgeTab];
      expect(typeof title).toBe('string');
      expect(title.length).toBeGreaterThan(0);
    }
  });
});
