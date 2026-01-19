/**
 * Cookie Consent Configuration Tests
 *
 * Tests for the cookie consent configuration module:
 * - CONSENT_VERSION constant
 * - CONSENT_STORAGE_KEY constant
 * - DEFAULT_CONSENT_STATE structure
 * - COOKIE_CATEGORIES definitions
 * - BANNER_DELAY_MS constant
 * - isConsentEnabled() function
 *
 * Phase 3.5: Landing Page & Marketing
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CONSENT_VERSION,
  CONSENT_STORAGE_KEY,
  DEFAULT_CONSENT_STATE,
  COOKIE_CATEGORIES,
  BANNER_DELAY_MS,
  isConsentEnabled,
} from '@/lib/consent/config';

describe('CONSENT_VERSION', () => {
  it('should be a number', () => {
    expect(typeof CONSENT_VERSION).toBe('number');
  });

  it('should be positive', () => {
    expect(CONSENT_VERSION).toBeGreaterThan(0);
  });

  it('should be an integer', () => {
    expect(Number.isInteger(CONSENT_VERSION)).toBe(true);
  });

  it('should have the expected value', () => {
    expect(CONSENT_VERSION).toBe(1);
  });
});

describe('CONSENT_STORAGE_KEY', () => {
  it('should be a string', () => {
    expect(typeof CONSENT_STORAGE_KEY).toBe('string');
  });

  it('should have the expected value', () => {
    expect(CONSENT_STORAGE_KEY).toBe('cookie-consent');
  });

  it('should not be empty', () => {
    expect(CONSENT_STORAGE_KEY.length).toBeGreaterThan(0);
  });
});

describe('DEFAULT_CONSENT_STATE', () => {
  it('should have correct structure', () => {
    expect(DEFAULT_CONSENT_STATE).toHaveProperty('essential');
    expect(DEFAULT_CONSENT_STATE).toHaveProperty('optional');
    expect(DEFAULT_CONSENT_STATE).toHaveProperty('timestamp');
    expect(DEFAULT_CONSENT_STATE).toHaveProperty('version');
  });

  it('should have essential set to true', () => {
    expect(DEFAULT_CONSENT_STATE.essential).toBe(true);
  });

  it('should have optional set to false', () => {
    expect(DEFAULT_CONSENT_STATE.optional).toBe(false);
  });

  it('should have timestamp set to null', () => {
    expect(DEFAULT_CONSENT_STATE.timestamp).toBeNull();
  });

  it('should have version matching CONSENT_VERSION', () => {
    expect(DEFAULT_CONSENT_STATE.version).toBe(CONSENT_VERSION);
  });

  it('should not have extra properties', () => {
    const keys = Object.keys(DEFAULT_CONSENT_STATE);
    expect(keys).toHaveLength(4);
    expect(keys).toEqual(expect.arrayContaining(['essential', 'optional', 'timestamp', 'version']));
  });
});

describe('COOKIE_CATEGORIES', () => {
  it('should be an array', () => {
    expect(Array.isArray(COOKIE_CATEGORIES)).toBe(true);
  });

  it('should have exactly 2 categories', () => {
    expect(COOKIE_CATEGORIES).toHaveLength(2);
  });

  describe('essential category', () => {
    it('should exist', () => {
      const essential = COOKIE_CATEGORIES.find((cat) => cat.id === 'essential');
      expect(essential).toBeDefined();
    });

    it('should have correct id', () => {
      const essential = COOKIE_CATEGORIES.find((cat) => cat.id === 'essential');
      expect(essential?.id).toBe('essential');
    });

    it('should have a name', () => {
      const essential = COOKIE_CATEGORIES.find((cat) => cat.id === 'essential');
      expect(essential?.name).toBe('Essential');
    });

    it('should have a description', () => {
      const essential = COOKIE_CATEGORIES.find((cat) => cat.id === 'essential');
      expect(essential?.description).toBeDefined();
      expect(essential?.description.length).toBeGreaterThan(0);
    });

    it('should be required', () => {
      const essential = COOKIE_CATEGORIES.find((cat) => cat.id === 'essential');
      expect(essential?.required).toBe(true);
    });

    it('should have all expected properties', () => {
      const essential = COOKIE_CATEGORIES.find((cat) => cat.id === 'essential');
      expect(essential).toHaveProperty('id');
      expect(essential).toHaveProperty('name');
      expect(essential).toHaveProperty('description');
      expect(essential).toHaveProperty('required');
    });
  });

  describe('optional category', () => {
    it('should exist', () => {
      const optional = COOKIE_CATEGORIES.find((cat) => cat.id === 'optional');
      expect(optional).toBeDefined();
    });

    it('should have correct id', () => {
      const optional = COOKIE_CATEGORIES.find((cat) => cat.id === 'optional');
      expect(optional?.id).toBe('optional');
    });

    it('should have a name', () => {
      const optional = COOKIE_CATEGORIES.find((cat) => cat.id === 'optional');
      expect(optional?.name).toBe('Analytics & Marketing');
    });

    it('should have a description', () => {
      const optional = COOKIE_CATEGORIES.find((cat) => cat.id === 'optional');
      expect(optional?.description).toBeDefined();
      expect(optional?.description.length).toBeGreaterThan(0);
    });

    it('should not be required', () => {
      const optional = COOKIE_CATEGORIES.find((cat) => cat.id === 'optional');
      expect(optional?.required).toBe(false);
    });

    it('should have all expected properties', () => {
      const optional = COOKIE_CATEGORIES.find((cat) => cat.id === 'optional');
      expect(optional).toHaveProperty('id');
      expect(optional).toHaveProperty('name');
      expect(optional).toHaveProperty('description');
      expect(optional).toHaveProperty('required');
    });
  });

  it('should have unique category IDs', () => {
    const ids = COOKIE_CATEGORIES.map((cat) => cat.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('should have only one required category', () => {
    const requiredCategories = COOKIE_CATEGORIES.filter((cat) => cat.required);
    expect(requiredCategories).toHaveLength(1);
  });
});

describe('BANNER_DELAY_MS', () => {
  it('should be a number', () => {
    expect(typeof BANNER_DELAY_MS).toBe('number');
  });

  it('should be positive', () => {
    expect(BANNER_DELAY_MS).toBeGreaterThan(0);
  });

  it('should be an integer', () => {
    expect(Number.isInteger(BANNER_DELAY_MS)).toBe(true);
  });

  it('should have the expected value', () => {
    expect(BANNER_DELAY_MS).toBe(500);
  });

  it('should be a reasonable delay (less than 5 seconds)', () => {
    expect(BANNER_DELAY_MS).toBeLessThan(5000);
  });
});

describe('isConsentEnabled', () => {
  beforeEach(() => {
    // Reset environment variable mock before each test
    vi.unstubAllEnvs();
  });

  describe('browser environment', () => {
    it('should return true by default (when env var is not set)', () => {
      // Mock browser environment
      vi.stubGlobal('window', {});

      const result = isConsentEnabled();
      expect(result).toBe(true);
    });

    it('should return true when env var is not "false"', () => {
      // Mock browser environment
      vi.stubGlobal('window', {});
      vi.stubEnv('NEXT_PUBLIC_COOKIE_CONSENT_ENABLED', 'true');

      const result = isConsentEnabled();
      expect(result).toBe(true);
    });

    it('should return true when env var is undefined', () => {
      // Mock browser environment
      vi.stubGlobal('window', {});
      vi.stubEnv('NEXT_PUBLIC_COOKIE_CONSENT_ENABLED', undefined);

      const result = isConsentEnabled();
      expect(result).toBe(true);
    });

    it('should return true when env var is empty string', () => {
      // Mock browser environment
      vi.stubGlobal('window', {});
      vi.stubEnv('NEXT_PUBLIC_COOKIE_CONSENT_ENABLED', '');

      const result = isConsentEnabled();
      expect(result).toBe(true);
    });

    it('should return false when env var is "false"', () => {
      // Mock browser environment
      vi.stubGlobal('window', {});
      vi.stubEnv('NEXT_PUBLIC_COOKIE_CONSENT_ENABLED', 'false');

      const result = isConsentEnabled();
      expect(result).toBe(false);
    });

    it('should return true when env var is "FALSE" (case sensitive)', () => {
      // Mock browser environment
      vi.stubGlobal('window', {});
      vi.stubEnv('NEXT_PUBLIC_COOKIE_CONSENT_ENABLED', 'FALSE');

      const result = isConsentEnabled();
      expect(result).toBe(true);
    });

    it('should return true when env var is "0"', () => {
      // Mock browser environment
      vi.stubGlobal('window', {});
      vi.stubEnv('NEXT_PUBLIC_COOKIE_CONSENT_ENABLED', '0');

      const result = isConsentEnabled();
      expect(result).toBe(true);
    });
  });

  describe('server environment', () => {
    it('should return true when not in browser', () => {
      // Mock server environment (no window)
      vi.stubGlobal('window', undefined);

      const result = isConsentEnabled();
      expect(result).toBe(true);
    });

    it('should return true when not in browser, regardless of env var', () => {
      // Mock server environment (no window)
      vi.stubGlobal('window', undefined);
      vi.stubEnv('NEXT_PUBLIC_COOKIE_CONSENT_ENABLED', 'false');

      const result = isConsentEnabled();
      expect(result).toBe(true);
    });
  });
});
