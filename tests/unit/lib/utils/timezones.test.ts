/**
 * Timezone Utility Tests
 *
 * Tests for the timezone utility functions in lib/utils/timezones.ts
 * - TIMEZONES - Array of timezone options
 * - getTimezonesByRegion() - Groups timezones by region
 * - getTimezoneRegions() - Returns region names in display order
 * - findTimezone() - Finds timezone by IANA identifier
 */

import { describe, it, expect } from 'vitest';
import {
  TIMEZONES,
  getTimezonesByRegion,
  getTimezoneRegions,
  findTimezone,
} from '@/lib/utils/timezones';

describe('TIMEZONES', () => {
  describe('structure and content', () => {
    it('should be a non-empty array', () => {
      expect(Array.isArray(TIMEZONES)).toBe(true);
      expect(TIMEZONES.length).toBeGreaterThan(0);
    });

    it('should contain valid TimezoneOption objects', () => {
      TIMEZONES.forEach((tz) => {
        expect(tz).toHaveProperty('value');
        expect(tz).toHaveProperty('label');
        expect(tz).toHaveProperty('region');
        expect(typeof tz.value).toBe('string');
        expect(typeof tz.label).toBe('string');
        expect(typeof tz.region).toBe('string');
      });
    });

    it('should have non-empty values for all properties', () => {
      TIMEZONES.forEach((tz) => {
        expect(tz.value.length).toBeGreaterThan(0);
        expect(tz.label.length).toBeGreaterThan(0);
        expect(tz.region.length).toBeGreaterThan(0);
      });
    });

    it('should include UTC timezone', () => {
      const utc = TIMEZONES.find((tz) => tz.value === 'UTC');
      expect(utc).toBeDefined();
      expect(utc?.region).toBe('UTC');
      expect(utc?.label).toBe('UTC (Coordinated Universal Time)');
    });
  });

  describe('IANA timezone identifiers', () => {
    it('should use valid IANA format for timezone values', () => {
      TIMEZONES.forEach((tz) => {
        if (tz.value === 'UTC') {
          expect(tz.value).toBe('UTC');
        } else {
          // IANA format: Continent/City or Continent/Region/City
          expect(tz.value).toMatch(/^[A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/);
        }
      });
    });

    it('should have no duplicate timezone values', () => {
      const values = TIMEZONES.map((tz) => tz.value);
      const uniqueValues = new Set(values);
      expect(values.length).toBe(uniqueValues.size);
    });

    it('should include major world cities', () => {
      const majorCities = [
        'America/New_York',
        'America/Los_Angeles',
        'Europe/London',
        'Europe/Paris',
        'Asia/Tokyo',
        'Asia/Shanghai',
        'Australia/Sydney',
      ];

      majorCities.forEach((city) => {
        const timezone = TIMEZONES.find((tz) => tz.value === city);
        expect(timezone).toBeDefined();
      });
    });
  });

  describe('regions', () => {
    it('should include all expected regions', () => {
      const expectedRegions = [
        'UTC',
        'Africa',
        'America',
        'Asia',
        'Atlantic',
        'Australia',
        'Europe',
        'Indian',
        'Pacific',
      ];

      const regions = [...new Set(TIMEZONES.map((tz) => tz.region))];

      expectedRegions.forEach((region) => {
        expect(regions).toContain(region);
      });
    });

    it('should have timezones for each region', () => {
      const regions = [...new Set(TIMEZONES.map((tz) => tz.region))];

      regions.forEach((region) => {
        const timezonesInRegion = TIMEZONES.filter((tz) => tz.region === region);
        expect(timezonesInRegion.length).toBeGreaterThan(0);
      });
    });
  });

  describe('labels', () => {
    it('should have human-readable labels', () => {
      TIMEZONES.forEach((tz) => {
        // Labels should not be the same as values (should be human-readable)
        if (tz.value !== 'UTC') {
          expect(tz.label).not.toBe(tz.value);
        }
      });
    });

    it('should have labels without continent prefix for most cities', () => {
      const newYork = TIMEZONES.find((tz) => tz.value === 'America/New_York');
      expect(newYork?.label).toContain('New York');
      expect(newYork?.label).not.toContain('America/');
    });

    it('should handle underscores in city names', () => {
      const newYork = TIMEZONES.find((tz) => tz.value === 'America/New_York');
      expect(newYork?.label).not.toContain('_');
    });
  });
});

describe('getTimezonesByRegion()', () => {
  describe('basic functionality', () => {
    it('should return an object', () => {
      const result = getTimezonesByRegion();
      expect(typeof result).toBe('object');
      expect(result).not.toBeNull();
    });

    it('should group timezones by region', () => {
      const result = getTimezonesByRegion();

      Object.keys(result).forEach((region) => {
        expect(Array.isArray(result[region])).toBe(true);
        result[region].forEach((tz) => {
          expect(tz.region).toBe(region);
        });
      });
    });

    it('should include all timezones', () => {
      const result = getTimezonesByRegion();
      const allTimezones = Object.values(result).flat();
      expect(allTimezones.length).toBe(TIMEZONES.length);
    });

    it('should include all regions', () => {
      const result = getTimezonesByRegion();
      const expectedRegions = [
        'UTC',
        'Africa',
        'America',
        'Asia',
        'Atlantic',
        'Australia',
        'Europe',
        'Indian',
        'Pacific',
      ];

      expectedRegions.forEach((region) => {
        expect(result).toHaveProperty(region);
      });
    });
  });

  describe('region grouping', () => {
    it('should group UTC separately', () => {
      const result = getTimezonesByRegion();
      expect(result.UTC).toBeDefined();
      expect(result.UTC.length).toBe(1);
      expect(result.UTC[0].value).toBe('UTC');
    });

    it('should group all American timezones together', () => {
      const result = getTimezonesByRegion();
      expect(result.America).toBeDefined();
      expect(result.America.length).toBeGreaterThan(0);

      result.America.forEach((tz) => {
        expect(tz.value.startsWith('America/')).toBe(true);
        expect(tz.region).toBe('America');
      });
    });

    it('should group all European timezones together', () => {
      const result = getTimezonesByRegion();
      expect(result.Europe).toBeDefined();
      expect(result.Europe.length).toBeGreaterThan(0);

      result.Europe.forEach((tz) => {
        expect(tz.value.startsWith('Europe/')).toBe(true);
        expect(tz.region).toBe('Europe');
      });
    });

    it('should group all Asian timezones together', () => {
      const result = getTimezonesByRegion();
      expect(result.Asia).toBeDefined();
      expect(result.Asia.length).toBeGreaterThan(0);

      result.Asia.forEach((tz) => {
        expect(tz.value.startsWith('Asia/')).toBe(true);
        expect(tz.region).toBe('Asia');
      });
    });
  });

  describe('data integrity', () => {
    it('should not have any empty region arrays', () => {
      const result = getTimezonesByRegion();

      Object.values(result).forEach((timezones) => {
        expect(timezones.length).toBeGreaterThan(0);
      });
    });

    it('should preserve timezone properties', () => {
      const result = getTimezonesByRegion();

      Object.values(result)
        .flat()
        .forEach((tz) => {
          expect(tz).toHaveProperty('value');
          expect(tz).toHaveProperty('label');
          expect(tz).toHaveProperty('region');
        });
    });

    it('should not modify original TIMEZONES array', () => {
      const originalLength = TIMEZONES.length;
      const originalFirstValue = TIMEZONES[0].value;

      getTimezonesByRegion();

      expect(TIMEZONES.length).toBe(originalLength);
      expect(TIMEZONES[0].value).toBe(originalFirstValue);
    });
  });

  describe('consistency', () => {
    it('should return the same result on multiple calls', () => {
      const result1 = getTimezonesByRegion();
      const result2 = getTimezonesByRegion();

      expect(Object.keys(result1).sort()).toEqual(Object.keys(result2).sort());

      Object.keys(result1).forEach((region) => {
        expect(result1[region].length).toBe(result2[region].length);
      });
    });
  });
});

describe('getTimezoneRegions()', () => {
  describe('basic functionality', () => {
    it('should return an array', () => {
      const result = getTimezoneRegions();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return non-empty array', () => {
      const result = getTimezoneRegions();
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return all region names', () => {
      const result = getTimezoneRegions();
      const expectedRegions = [
        'UTC',
        'Africa',
        'America',
        'Asia',
        'Atlantic',
        'Australia',
        'Europe',
        'Indian',
        'Pacific',
      ];

      expect(result).toEqual(expectedRegions);
    });
  });

  describe('ordering', () => {
    it('should return regions in specific display order', () => {
      const result = getTimezoneRegions();

      expect(result[0]).toBe('UTC');
      expect(result[1]).toBe('Africa');
      expect(result[2]).toBe('America');
      expect(result[3]).toBe('Asia');
      expect(result[4]).toBe('Atlantic');
      expect(result[5]).toBe('Australia');
      expect(result[6]).toBe('Europe');
      expect(result[7]).toBe('Indian');
      expect(result[8]).toBe('Pacific');
    });

    it('should have UTC as first region', () => {
      const result = getTimezoneRegions();
      expect(result[0]).toBe('UTC');
    });

    it('should maintain consistent order across calls', () => {
      const result1 = getTimezoneRegions();
      const result2 = getTimezoneRegions();

      expect(result1).toEqual(result2);
    });
  });

  describe('data integrity', () => {
    it('should contain only strings', () => {
      const result = getTimezoneRegions();

      result.forEach((region) => {
        expect(typeof region).toBe('string');
      });
    });

    it('should have no duplicate regions', () => {
      const result = getTimezoneRegions();
      const uniqueRegions = new Set(result);

      expect(result.length).toBe(uniqueRegions.size);
    });

    it('should have no empty strings', () => {
      const result = getTimezoneRegions();

      result.forEach((region) => {
        expect(region.length).toBeGreaterThan(0);
      });
    });
  });

  describe('completeness', () => {
    it('should include all regions present in TIMEZONES', () => {
      const result = getTimezoneRegions();
      const regionsInTimezones = [...new Set(TIMEZONES.map((tz) => tz.region))];

      regionsInTimezones.forEach((region) => {
        expect(result).toContain(region);
      });
    });

    it('should return exactly 9 regions', () => {
      const result = getTimezoneRegions();
      expect(result.length).toBe(9);
    });
  });
});

describe('findTimezone()', () => {
  describe('finding existing timezones', () => {
    it('should find UTC', () => {
      const result = findTimezone('UTC');

      expect(result).toBeDefined();
      expect(result?.value).toBe('UTC');
      expect(result?.label).toBe('UTC (Coordinated Universal Time)');
      expect(result?.region).toBe('UTC');
    });

    it('should find America/New_York', () => {
      const result = findTimezone('America/New_York');

      expect(result).toBeDefined();
      expect(result?.value).toBe('America/New_York');
      expect(result?.label).toContain('New York');
      expect(result?.region).toBe('America');
    });

    it('should find Europe/London', () => {
      const result = findTimezone('Europe/London');

      expect(result).toBeDefined();
      expect(result?.value).toBe('Europe/London');
      expect(result?.label).toBe('London');
      expect(result?.region).toBe('Europe');
    });

    it('should find Asia/Tokyo', () => {
      const result = findTimezone('Asia/Tokyo');

      expect(result).toBeDefined();
      expect(result?.value).toBe('Asia/Tokyo');
      expect(result?.label).toBe('Tokyo');
      expect(result?.region).toBe('Asia');
    });

    it('should find Australia/Sydney', () => {
      const result = findTimezone('Australia/Sydney');

      expect(result).toBeDefined();
      expect(result?.value).toBe('Australia/Sydney');
      expect(result?.label).toBe('Sydney');
      expect(result?.region).toBe('Australia');
    });

    it('should find timezone with multi-part name', () => {
      const result = findTimezone('America/Argentina/Buenos_Aires');

      expect(result).toBeDefined();
      expect(result?.value).toBe('America/Argentina/Buenos_Aires');
      expect(result?.region).toBe('America');
    });
  });

  describe('not finding non-existent timezones', () => {
    it('should return undefined for non-existent timezone', () => {
      const result = findTimezone('Invalid/Timezone');
      expect(result).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
      const result = findTimezone('');
      expect(result).toBeUndefined();
    });

    it('should return undefined for partial match', () => {
      const result = findTimezone('America/New');
      expect(result).toBeUndefined();
    });

    it('should return undefined for case-insensitive match', () => {
      const result = findTimezone('america/new_york');
      expect(result).toBeUndefined();
    });

    it('should return undefined for timezone without continent', () => {
      const result = findTimezone('New_York');
      expect(result).toBeUndefined();
    });

    it('should return undefined for random string', () => {
      const result = findTimezone('RandomString123');
      expect(result).toBeUndefined();
    });
  });

  describe('case sensitivity', () => {
    it('should be case-sensitive for value matching', () => {
      const result = findTimezone('EUROPE/LONDON');
      expect(result).toBeUndefined();
    });

    it('should require exact match for value', () => {
      const result = findTimezone('Europe/london');
      expect(result).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle timezone with underscores', () => {
      const result = findTimezone('America/New_York');
      expect(result).toBeDefined();
      expect(result?.value).toBe('America/New_York');
    });

    it('should handle timezone with hyphens in label', () => {
      const result = findTimezone('America/St_Johns');
      expect(result).toBeDefined();
      expect(result?.value).toBe('America/St_Johns');
    });

    it('should handle Indian Ocean region', () => {
      const result = findTimezone('Indian/Maldives');
      expect(result).toBeDefined();
      expect(result?.region).toBe('Indian');
    });

    it('should handle Pacific region timezones', () => {
      const result = findTimezone('Pacific/Auckland');
      expect(result).toBeDefined();
      expect(result?.region).toBe('Pacific');
    });

    it('should handle Atlantic region timezones', () => {
      const result = findTimezone('Atlantic/Azores');
      expect(result).toBeDefined();
      expect(result?.region).toBe('Atlantic');
    });
  });

  describe('return value structure', () => {
    it('should return TimezoneOption object with all properties', () => {
      const result = findTimezone('UTC');

      expect(result).toHaveProperty('value');
      expect(result).toHaveProperty('label');
      expect(result).toHaveProperty('region');
    });

    it('should return undefined (not null) for non-existent timezone', () => {
      const result = findTimezone('Invalid/Timezone');
      expect(result).toBeUndefined();
      expect(result).not.toBeNull();
    });
  });

  describe('consistency', () => {
    it('should return the same result for multiple calls with same input', () => {
      const result1 = findTimezone('Europe/Paris');
      const result2 = findTimezone('Europe/Paris');

      expect(result1).toEqual(result2);
    });

    it('should return reference to object in TIMEZONES array', () => {
      const result = findTimezone('Asia/Tokyo');
      const directFind = TIMEZONES.find((tz) => tz.value === 'Asia/Tokyo');

      expect(result).toEqual(directFind);
    });
  });
});

describe('integration tests', () => {
  describe('cross-function consistency', () => {
    it('should have regions from getTimezoneRegions() match those in getTimezonesByRegion()', () => {
      const regions = getTimezoneRegions();
      const groupedTimezones = getTimezonesByRegion();

      regions.forEach((region) => {
        expect(groupedTimezones).toHaveProperty(region);
      });
    });

    it('should be able to find all timezones from TIMEZONES array', () => {
      TIMEZONES.forEach((tz) => {
        const found = findTimezone(tz.value);
        expect(found).toBeDefined();
        expect(found?.value).toBe(tz.value);
      });
    });

    it('should group all TIMEZONES entries exactly once', () => {
      const grouped = getTimezonesByRegion();
      const allGroupedTimezones = Object.values(grouped).flat();

      expect(allGroupedTimezones.length).toBe(TIMEZONES.length);
    });

    it('should have no timezones in unknown regions', () => {
      const regions = getTimezoneRegions();

      TIMEZONES.forEach((tz) => {
        expect(regions).toContain(tz.region);
      });
    });
  });

  describe('real-world usage scenarios', () => {
    it('should support common timezone lookup workflow', () => {
      // Get all regions
      const regions = getTimezoneRegions();
      expect(regions.length).toBeGreaterThan(0);

      // Group timezones by region
      const grouped = getTimezonesByRegion();
      expect(Object.keys(grouped).length).toBe(regions.length);

      // Find a specific timezone
      const london = findTimezone('Europe/London');
      expect(london).toBeDefined();
      expect(grouped.Europe).toContainEqual(london);
    });

    it('should support building a timezone selector', () => {
      const regions = getTimezoneRegions();
      const grouped = getTimezonesByRegion();

      // Simulate building option groups
      const optionGroups = regions.map((region) => ({
        label: region,
        options: grouped[region].map((tz) => ({
          value: tz.value,
          label: tz.label,
        })),
      }));

      expect(optionGroups.length).toBe(9);
      optionGroups.forEach((group) => {
        expect(group.options.length).toBeGreaterThan(0);
      });
    });

    it('should support validating user-selected timezone', () => {
      const userSelection = 'America/Chicago';
      const timezone = findTimezone(userSelection);

      expect(timezone).toBeDefined();
      expect(timezone?.value).toBe(userSelection);

      // Validate it exists in grouped timezones
      const grouped = getTimezonesByRegion();
      const inRegion = grouped[timezone!.region].some((tz) => tz.value === userSelection);
      expect(inRegion).toBe(true);
    });

    it('should support finding default timezone', () => {
      // Common default: UTC
      const utc = findTimezone('UTC');
      expect(utc).toBeDefined();
      expect(utc?.region).toBe('UTC');

      const regions = getTimezoneRegions();
      expect(regions[0]).toBe('UTC');
    });
  });
});
