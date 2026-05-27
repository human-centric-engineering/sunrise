/**
 * Tests for the admin nav registry (Seam 4 — fork-readiness).
 *
 * The registry is a thin, synchronous Map-backed store; there is nothing to
 * mock. We test the real implementation directly — that is the strongest
 * possible anti-green-bar stance for pure in-memory logic.
 *
 * Source: lib/admin-nav/registry.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ComponentType } from 'react';
import {
  registerNavSection,
  getRegisteredNavSections,
  __resetNavRegistryForTests,
  type NavItem,
  type NavSection,
} from '@/lib/admin-nav/registry';

// Stub icon: satisfies the ComponentType<{ className?: string }> contract
// without pulling in React or any icon library.
const StubIcon: ComponentType<{ className?: string }> = () => null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeItem(label: string, href: string): NavItem {
  return { href, label, icon: StubIcon, description: `${label} description` };
}

function makeSection(title: string, ...labels: string[]): NavSection {
  return {
    title,
    items: labels.map((label) => makeItem(label, `/admin/${label.toLowerCase()}`)),
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetNavRegistryForTests();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getRegisteredNavSections', () => {
  it('returns an empty array when nothing has been registered', () => {
    // Arrange — registry was cleared by beforeEach.
    // Act
    const result = getRegisteredNavSections();
    // Assert
    expect(result).toEqual([]);
  });
});

describe('registerNavSection', () => {
  it('a single registration is visible in getRegisteredNavSections()', () => {
    // Arrange
    const section = makeSection('Analytics', 'Reports', 'Dashboards');

    // Act
    registerNavSection(section);
    const result = getRegisteredNavSections();

    // Assert — the registry stored and returned the section we gave it.
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe('Analytics');
    expect(result[0]?.items).toHaveLength(2);
    expect(result[0]?.items?.[0]?.label).toBe('Reports');
  });

  it('preserves first-registration order across multiple registrations', () => {
    // Arrange — register three distinct sections.
    registerNavSection(makeSection('Alpha'));
    registerNavSection(makeSection('Beta'));
    registerNavSection(makeSection('Gamma'));

    // Act
    const result = getRegisteredNavSections();

    // Assert — titles come back in the order they were registered.
    expect(result.map((s) => s.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('re-registering the same title replaces the content but keeps the original insertion position (HMR-safe)', () => {
    // Arrange — register three sections; then re-register the second one.
    registerNavSection(makeSection('First', 'ItemA'));
    registerNavSection(makeSection('Second', 'ItemA'));
    registerNavSection(makeSection('Third', 'ItemA'));

    // Re-register "Second" with new content — position must not change.
    const updated = makeSection('Second', 'ItemB', 'ItemC');
    registerNavSection(updated);

    // Act
    const result = getRegisteredNavSections();

    // Assert — order is still First → Second → Third …
    expect(result.map((s) => s.title)).toEqual(['First', 'Second', 'Third']);
    // … and "Second" now has the updated items.
    const second = result[1];
    expect(second?.items?.map((i) => i.label)).toEqual(['ItemB', 'ItemC']);
  });

  it('returned array is a copy — mutating it does not affect the registry', () => {
    // Arrange
    registerNavSection(makeSection('Immutable', 'Item'));

    // Act — get a copy and mutate it.
    const copy = getRegisteredNavSections();
    copy.push(makeSection('Injected'));

    // Assert — a fresh read must not include the injected section.
    const freshRead = getRegisteredNavSections();
    expect(freshRead).toHaveLength(1);
    expect(freshRead[0]?.title).toBe('Immutable');
  });
});
