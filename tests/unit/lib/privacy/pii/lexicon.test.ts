/**
 * The word lists tiers B and C read. Every comparison in those tiers is lower
 * case, so an entry with a capital letter would silently never match; the
 * bundled lists are checked for that and for being what the spec says they
 * are.
 */
import { describe, expect, it } from 'vitest';
import firstNameData from '@/lib/privacy/pii/data/first-names.generated.json';
import surnameData from '@/lib/privacy/pii/data/surnames.generated.json';
import {
  ALLOWLIST,
  COMMON_WORDS,
  FIRST_NAMES,
  isFirstName,
  isSurname,
  ORG_CONNECTORS,
  ORG_SUFFIXES,
  PLACES,
  STREET_SUFFIXES,
  SURNAMES,
  TITLES,
} from '@/lib/privacy/pii/lexicon';

const LISTS = {
  ALLOWLIST,
  COMMON_WORDS,
  FIRST_NAMES,
  ORG_CONNECTORS,
  ORG_SUFFIXES,
  PLACES,
  STREET_SUFFIXES,
  SURNAMES,
  TITLES,
};

describe('lexicon', () => {
  it.each(Object.entries(LISTS))('%s is lower case and has no blank entry', (_, list) => {
    expect(list.size).toBeGreaterThan(0);
    for (const entry of list) {
      expect(entry).toBe(entry.toLowerCase());
      expect(entry.trim()).toBe(entry);
      expect(entry).not.toBe('');
    }
  });

  it('loads the bundled name lists whole', () => {
    // The sizes the spec records; a regeneration that changes them updates both.
    expect(firstNameData.names).toHaveLength(11914);
    expect(surnameData.names).toHaveLength(15001);
    expect(FIRST_NAMES.size).toBe(firstNameData.names.length);
    expect(SURNAMES.size).toBe(surnameData.names.length);
  });

  it('holds the names a UK conversation needs', () => {
    for (const name of ['olivia', 'muhammad', 'siobhan', 'niamh', 'priya', 'kwame', 'gary']) {
      expect(FIRST_NAMES.has(name)).toBe(true);
    }
    for (const name of ['smith', 'jones', 'patel', 'khan', 'nguyen']) {
      expect(SURNAMES.has(name)).toBe(true);
    }
  });

  it('finds a name the lists spell without its apostrophe, or in two parts', () => {
    // The Census lists drop apostrophes: "OBRIEN".
    expect(SURNAMES.has("o'brien")).toBe(false);
    expect(isSurname("o'brien")).toBe(true);
    expect(isSurname('o’brien')).toBe(true);
    expect(isSurname('smith-jones')).toBe(true);
    expect(isSurname('smith-qqzx')).toBe(false);
    expect(isSurname('-')).toBe(false);
    expect(isFirstName('mary-jane')).toBe(true);
    expect(isFirstName('olivia')).toBe(true);
    expect(isFirstName('qqzx')).toBe(false);
  });

  it('keeps a name that is also a word on the stoplist', () => {
    for (const word of ['will', 'may', 'mark', 'grace', 'hope']) {
      expect(FIRST_NAMES.has(word)).toBe(true);
      expect(COMMON_WORDS.has(word)).toBe(true);
    }
  });
});
