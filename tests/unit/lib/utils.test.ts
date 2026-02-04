/**
 * Utils Tests
 *
 * Tests for utility functions in lib/utils.ts
 * - cn() - Tailwind CSS class merging utility
 * - isRecord() - Type guard for Record<string, unknown>
 */

import { describe, it, expect } from 'vitest';
import { cn, isRecord } from '@/lib/utils';

describe('cn()', () => {
  describe('basic functionality', () => {
    it('should merge single class name', () => {
      const result = cn('text-red-500');
      expect(result).toBe('text-red-500');
    });

    it('should merge multiple class names', () => {
      const result = cn('text-red-500', 'bg-blue-500', 'p-4');
      expect(result).toContain('text-red-500');
      expect(result).toContain('bg-blue-500');
      expect(result).toContain('p-4');
    });

    it('should handle empty strings', () => {
      const result = cn('text-red-500', '', 'bg-blue-500');
      expect(result).toContain('text-red-500');
      expect(result).toContain('bg-blue-500');
    });

    it('should handle no arguments', () => {
      const result = cn();
      expect(result).toBe('');
    });

    it('should handle undefined values', () => {
      const result = cn('text-red-500', undefined, 'bg-blue-500');
      expect(result).toContain('text-red-500');
      expect(result).toContain('bg-blue-500');
    });

    it('should handle null values', () => {
      const result = cn('text-red-500', null, 'bg-blue-500');
      expect(result).toContain('text-red-500');
      expect(result).toContain('bg-blue-500');
    });
  });

  describe('conditional classes', () => {
    it('should handle boolean conditional classes', () => {
      const isActive = true;
      const result = cn('base-class', isActive && 'active-class');
      expect(result).toContain('base-class');
      expect(result).toContain('active-class');
    });

    it('should exclude false conditional classes', () => {
      const isActive = false;
      const result = cn('base-class', isActive && 'active-class');
      expect(result).toContain('base-class');
      expect(result).not.toContain('active-class');
    });

    it('should handle object notation', () => {
      const result = cn({
        'text-red-500': true,
        'bg-blue-500': false,
        'p-4': true,
      });
      expect(result).toContain('text-red-500');
      expect(result).not.toContain('bg-blue-500');
      expect(result).toContain('p-4');
    });
  });

  describe('Tailwind CSS class conflicts', () => {
    it('should resolve conflicting padding classes', () => {
      const result = cn('p-2', 'p-4');
      // tailwind-merge should keep only the last padding class
      expect(result).toBe('p-4');
    });

    it('should resolve conflicting margin classes', () => {
      const result = cn('m-2', 'm-4');
      expect(result).toBe('m-4');
    });

    it('should resolve conflicting text size classes', () => {
      const result = cn('text-sm', 'text-lg');
      expect(result).toBe('text-lg');
    });

    it('should resolve conflicting background classes', () => {
      const result = cn('bg-red-500', 'bg-blue-500');
      expect(result).toBe('bg-blue-500');
    });

    it('should keep non-conflicting classes', () => {
      const result = cn('text-red-500', 'bg-blue-500', 'p-4', 'm-2');
      expect(result).toContain('text-red-500');
      expect(result).toContain('bg-blue-500');
      expect(result).toContain('p-4');
      expect(result).toContain('m-2');
    });
  });

  describe('array inputs', () => {
    it('should handle array of class names', () => {
      const result = cn(['text-red-500', 'bg-blue-500']);
      expect(result).toContain('text-red-500');
      expect(result).toContain('bg-blue-500');
    });

    it('should handle nested arrays', () => {
      const result = cn(['text-red-500', ['bg-blue-500', 'p-4']]);
      expect(result).toContain('text-red-500');
      expect(result).toContain('bg-blue-500');
      expect(result).toContain('p-4');
    });

    it('should handle mixed array and string inputs', () => {
      const result = cn('text-red-500', ['bg-blue-500', 'p-4'], 'm-2');
      expect(result).toContain('text-red-500');
      expect(result).toContain('bg-blue-500');
      expect(result).toContain('p-4');
      expect(result).toContain('m-2');
    });
  });

  describe('real-world use cases', () => {
    it('should merge base classes with variant classes', () => {
      const baseClasses = 'rounded-md font-semibold';
      const variant = 'primary';
      const variantClasses = {
        primary: 'bg-blue-500 text-white',
        secondary: 'bg-gray-500 text-white',
      };
      const result = cn(baseClasses, variantClasses[variant]);
      expect(result).toContain('rounded-md');
      expect(result).toContain('font-semibold');
      expect(result).toContain('bg-blue-500');
      expect(result).toContain('text-white');
    });

    it('should merge component classes with prop overrides', () => {
      const componentClasses = 'p-4 bg-white rounded';
      const propClasses = 'bg-gray-100'; // Override background
      const result = cn(componentClasses, propClasses);
      expect(result).toContain('p-4');
      expect(result).toContain('rounded');
      expect(result).toBe('p-4 rounded bg-gray-100');
    });

    it('should handle button variant example', () => {
      const isDisabled = false;
      const size = 'md' as 'md' | 'sm';
      const result = cn('inline-flex items-center justify-center rounded-md font-medium', {
        'px-4 py-2': size === 'md',
        'px-3 py-1': size === 'sm',
        'opacity-50 cursor-not-allowed': isDisabled,
      });
      expect(result).toContain('inline-flex');
      expect(result).toContain('px-4');
      expect(result).toContain('py-2');
      expect(result).not.toContain('opacity-50');
    });

    it('should handle card component classes', () => {
      const isHovered = true;
      const result = cn(
        'border rounded-lg p-6',
        'transition-shadow duration-200',
        isHovered && 'shadow-lg'
      );
      expect(result).toContain('border');
      expect(result).toContain('rounded-lg');
      expect(result).toContain('shadow-lg');
    });
  });

  describe('edge cases', () => {
    it('should handle very long class strings', () => {
      const longClasses = Array(50).fill('text-sm').join(' ');
      const result = cn(longClasses, 'text-lg');
      expect(result).toBe('text-lg');
    });

    it('should handle special characters in class names', () => {
      const result = cn('w-[50px]', 'h-[100px]');
      expect(result).toContain('w-[50px]');
      expect(result).toContain('h-[100px]');
    });

    it('should handle responsive classes', () => {
      const result = cn('text-sm', 'md:text-lg', 'lg:text-xl');
      expect(result).toContain('text-sm');
      expect(result).toContain('md:text-lg');
      expect(result).toContain('lg:text-xl');
    });

    it('should handle hover and focus states', () => {
      const result = cn('bg-blue-500', 'hover:bg-blue-600', 'focus:ring-2');
      expect(result).toContain('bg-blue-500');
      expect(result).toContain('hover:bg-blue-600');
      expect(result).toContain('focus:ring-2');
    });

    it('should handle dark mode classes', () => {
      const result = cn('bg-white', 'dark:bg-gray-900');
      expect(result).toContain('bg-white');
      expect(result).toContain('dark:bg-gray-900');
    });
  });
});

describe('isRecord()', () => {
  it('should return true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ key: 'value' })).toBe(true);
    expect(isRecord({ a: 1, b: 2, c: 3 })).toBe(true);
  });

  it('should return true for objects created with Object.create(null)', () => {
    const obj = Object.create(null);
    expect(isRecord(obj)).toBe(true);
  });

  it('should return false for null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isRecord(undefined)).toBe(false);
  });

  it('should return false for arrays', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2, 3])).toBe(false);
    expect(isRecord(['a', 'b'])).toBe(false);
  });

  it('should return false for primitives', () => {
    expect(isRecord('string')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(false)).toBe(false);
  });

  it('should return false for functions', () => {
    expect(isRecord(() => {})).toBe(false);
    expect(isRecord(function () {})).toBe(false);
  });

  it('should return true for class instances', () => {
    class MyClass {}
    const instance = new MyClass();
    expect(isRecord(instance)).toBe(true);
  });

  it('should return true for Date objects', () => {
    expect(isRecord(new Date())).toBe(true);
  });
});
