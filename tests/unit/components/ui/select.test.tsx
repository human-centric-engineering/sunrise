/**
 * Select Component Tests
 *
 * Tests the shadcn/ui Select components built on Radix UI primitives:
 * - SelectLabel: Label component for grouping select items
 * - SelectSeparator: Visual separator for organizing select options
 *
 * These tests focus on the uncovered components identified in coverage:
 * - Line 99-104: SelectLabel rendering and className customization
 * - Line 133-138: SelectSeparator rendering and className customization
 *
 * Coverage Strategy:
 * The uncovered lines are the component definitions and their className prop handling.
 * Since Radix Select uses Portals that don't render properly in happy-dom tests,
 * we test the components by verifying they can be instantiated with the correct props
 * and that the className merging logic works correctly.
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/ui/select.tsx
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { createRef } from 'react';
import { SelectLabel, SelectSeparator, SelectGroup } from '@/components/ui/select';

/**
 * Test Suite: SelectLabel Component
 *
 * Tests line 99-104 in select.tsx - the SelectLabel component definition
 */
describe('components/ui/select', () => {
  describe('SelectLabel', () => {
    it('should render without error with default props', () => {
      // Arrange & Act - This executes line 99-104
      // Note: SelectLabel requires SelectGroup context
      const { container } = render(
        <SelectGroup>
          <SelectLabel>Test Label</SelectLabel>
        </SelectGroup>
      );

      // Assert: Component renders (covers the return statement on line 99)
      expect(container.querySelector('div')).toBeTruthy();
      expect(container.textContent).toBe('Test Label');
    });

    it('should apply default className from line 101', () => {
      // Arrange & Act
      const { container } = render(
        <SelectGroup>
          <SelectLabel data-testid="label">Test</SelectLabel>
        </SelectGroup>
      );

      // Assert: Should have default classes defined on line 101
      const element = container.querySelector('[data-testid="label"]') as HTMLElement;
      expect(element).toBeTruthy();
      // The cn() utility merges these classes
      expect(element.className).toContain('px-2');
      expect(element.className).toContain('py-1.5');
      expect(element.className).toContain('text-sm');
      expect(element.className).toContain('font-semibold');
    });

    it('should merge custom className with defaults', () => {
      // Arrange & Act - Tests the className prop on line 98
      const { container } = render(
        <SelectGroup>
          <SelectLabel className="custom-class text-red-500" data-testid="label">
            Custom
          </SelectLabel>
        </SelectGroup>
      );

      // Assert: Should have both custom and default classes
      const element = container.querySelector('[data-testid="label"]') as HTMLElement;
      expect(element.className).toContain('custom-class');
      expect(element.className).toContain('text-red-500');
      // Default classes should still be present (unless overridden by tailwind-merge)
      expect(element.className).toContain('px-2');
      expect(element.className).toContain('font-semibold');
    });

    it('should override conflicting classes via tailwind-merge', () => {
      // Arrange & Act
      const { container } = render(
        <SelectGroup>
          <SelectLabel className="px-4 py-3" data-testid="label">
            Override Padding
          </SelectLabel>
        </SelectGroup>
      );

      // Assert: Custom padding should override defaults
      const element = container.querySelector('[data-testid="label"]') as HTMLElement;
      expect(element.className).toContain('px-4');
      expect(element.className).toContain('py-3');
      // Tailwind-merge should remove px-2 and py-1.5
      expect(element.className).not.toContain('px-2');
      expect(element.className).not.toContain('py-1.5');
    });

    it('should handle empty className', () => {
      // Arrange & Act
      const { container } = render(
        <SelectGroup>
          <SelectLabel className="" data-testid="label">
            Empty
          </SelectLabel>
        </SelectGroup>
      );

      // Assert: Should still have default classes
      const element = container.querySelector('[data-testid="label"]') as HTMLElement;
      expect(element.className).toContain('px-2');
      expect(element.className).toContain('py-1.5');
    });

    it('should handle undefined className', () => {
      // Arrange & Act
      const { container } = render(
        <SelectGroup>
          <SelectLabel className={undefined} data-testid="label">
            Undefined
          </SelectLabel>
        </SelectGroup>
      );

      // Assert: Should render with defaults
      const element = container.querySelector('[data-testid="label"]') as HTMLElement;
      expect(element).toBeTruthy();
      expect(element.className).toContain('px-2');
    });

    it('should forward ref correctly', () => {
      // Arrange - Tests the forwardRef on line 95-96
      const ref = createRef<HTMLDivElement>();

      // Act
      render(
        <SelectGroup>
          <SelectLabel ref={ref}>Ref Test</SelectLabel>
        </SelectGroup>
      );

      // Assert: Ref should be forwarded to the Radix primitive
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
      expect(ref.current?.textContent).toBe('Ref Test');
    });

    it('should spread additional props to the element', () => {
      // Arrange & Act - Tests ...props spreading on line 102
      const { container } = render(
        <SelectGroup>
          <SelectLabel id="test-id" data-testid="label" aria-label="Test">
            Props Test
          </SelectLabel>
        </SelectGroup>
      );

      // Assert: Props should be applied to the element
      const element = container.querySelector('[data-testid="label"]') as HTMLElement;
      expect(element).toBeTruthy();
      expect(element.getAttribute('id')).toBe('test-id');
      expect(element.getAttribute('aria-label')).toBe('Test');
    });
  });

  /**
   * Test Suite: SelectSeparator Component
   *
   * Tests line 133-138 in select.tsx - the SelectSeparator component definition
   */
  describe('SelectSeparator', () => {
    it('should render without error with default props', () => {
      // Arrange & Act - This executes line 133-138
      // Note: SelectSeparator is a forwardRef component that wraps Radix SelectPrimitive.Separator
      const { container } = render(<SelectSeparator />);

      // Assert: Component renders (covers the return statement on line 133)
      expect(container.firstChild).toBeTruthy();
    });

    it('should apply default className from line 135', () => {
      // Arrange & Act
      const { container } = render(<SelectSeparator />);

      // Assert: Should have default classes defined on line 135
      const element = container.firstChild as HTMLElement;
      expect(element).toBeTruthy();
      // The cn() utility merges these classes
      expect(element.className).toContain('bg-muted');
      expect(element.className).toContain('-mx-1');
      expect(element.className).toContain('my-1');
      expect(element.className).toContain('h-px');
    });

    it('should merge custom className with defaults', () => {
      // Arrange & Act - Tests the className prop on line 132
      const { container } = render(<SelectSeparator className="custom-separator bg-red-500" />);

      // Assert: Should have both custom and default classes
      const element = container.firstChild as HTMLElement;
      expect(element.className).toContain('custom-separator');
      expect(element.className).toContain('bg-red-500');
      // bg-red-500 should override bg-muted via tailwind-merge
      expect(element.className).not.toContain('bg-muted');
      // Other default classes should remain
      expect(element.className).toContain('-mx-1');
      expect(element.className).toContain('my-1');
    });

    it('should override conflicting classes via tailwind-merge', () => {
      // Arrange & Act
      const { container } = render(<SelectSeparator className="mx-0 my-4 h-0.5" />);

      // Assert: Custom classes should override defaults
      const element = container.firstChild as HTMLElement;
      expect(element.className).toContain('h-0.5');
      expect(element.className).toContain('my-4');
      expect(element.className).toContain('mx-0');
      // Tailwind-merge should remove conflicting defaults
      expect(element.className).not.toContain('h-px');
      expect(element.className).not.toContain('my-1');
      expect(element.className).not.toContain('-mx-1');
    });

    it('should handle empty className', () => {
      // Arrange & Act
      const { container } = render(<SelectSeparator className="" />);

      // Assert: Should still have default classes
      const element = container.firstChild as HTMLElement;
      expect(element.className).toContain('bg-muted');
      expect(element.className).toContain('h-px');
    });

    it('should handle undefined className', () => {
      // Arrange & Act
      const { container } = render(<SelectSeparator className={undefined} />);

      // Assert: Should render with defaults
      const element = container.firstChild as HTMLElement;
      expect(element).toBeTruthy();
      expect(element.className).toContain('bg-muted');
    });

    it('should forward ref correctly', () => {
      // Arrange - Tests the forwardRef on line 129-131
      const ref = createRef<HTMLDivElement>();

      // Act
      render(<SelectSeparator ref={ref} />);

      // Assert: Ref should be forwarded to the Radix primitive
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
      // Radix sets the role when in proper Select context
      expect(ref.current).toBeTruthy();
    });

    it('should spread additional props to the element', () => {
      // Arrange & Act - Tests ...props spreading on line 136
      const { container } = render(
        <SelectSeparator id="test-separator" data-testid="sep" aria-label="Divider" />
      );

      // Assert: Props should be applied to the element
      const element = container.firstChild as HTMLElement;
      expect(element.getAttribute('id')).toBe('test-separator');
      expect(element.getAttribute('data-testid')).toBe('sep');
      expect(element.getAttribute('aria-label')).toBe('Divider');
    });

    it('should render as a decorative element', () => {
      // Arrange & Act
      const { container } = render(<SelectSeparator />);

      // Assert: Should render as a div element
      const element = container.firstChild as HTMLElement;
      expect(element).toBeInstanceOf(HTMLDivElement);
      expect(element.tagName.toLowerCase()).toBe('div');
    });

    it('should be a horizontal separator by default', () => {
      // Arrange & Act
      const { container } = render(<SelectSeparator />);

      // Assert: Should have height styling (horizontal line)
      const element = container.firstChild as HTMLElement;
      expect(element.className).toContain('h-px');
      // Should render successfully
      expect(element).toBeTruthy();
    });
  });
});
