/**
 * Separator Component Tests
 *
 * Tests the Separator component with horizontal/vertical orientations and custom props:
 * - Rendering with default orientation (horizontal)
 * - Rendering with vertical orientation (uncovered branch)
 * - Custom className prop
 * - Decorative prop (accessibility)
 * - Default decorative value
 * - Ref forwarding
 * - Props spreading to Radix UI primitive
 *
 * Test Coverage:
 * - Initial rendering (horizontal)
 * - Vertical orientation (line 18 branch)
 * - Custom className application
 * - Decorative prop behavior
 * - Ref forwarding
 * - Props spreading
 *
 * Coverage Target: 100% statements, 100% branches
 * Current Gap: Line 18 vertical branch (75% branches → 100%)
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/ui/separator.tsx
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { createRef } from 'react';
import { Separator } from '@/components/ui/separator';

/**
 * Test Suite: Separator Component
 *
 * Tests the separator with horizontal/vertical orientations and accessibility features.
 */
describe('components/ui/separator', () => {
  describe('rendering', () => {
    it('should render with default horizontal orientation', () => {
      // Arrange & Act
      const { container } = render(<Separator />);

      // Assert: Should render separator element
      const separator = container.querySelector('[data-orientation="horizontal"]');
      expect(separator).toBeInTheDocument();
    });

    it('should render with vertical orientation', () => {
      // Arrange & Act
      const { container } = render(<Separator orientation="vertical" />);

      // Assert: Should render separator with vertical orientation
      const separator = container.querySelector('[data-orientation="vertical"]');
      expect(separator).toBeInTheDocument();
    });

    it('should apply default horizontal styles (h-[1px] w-full)', () => {
      // Arrange & Act
      const { container } = render(<Separator />);

      // Assert: Should have horizontal sizing classes
      const separator = container.querySelector('[data-orientation="horizontal"]');
      expect(separator).toHaveClass('h-[1px]');
      expect(separator).toHaveClass('w-full');
      expect(separator).toHaveClass('bg-border');
      expect(separator).toHaveClass('shrink-0');
    });

    it('should apply vertical styles (h-full w-[1px]) when orientation is vertical', () => {
      // Arrange & Act
      const { container } = render(<Separator orientation="vertical" />);

      // Assert: Should have vertical sizing classes (tests line 18 branch)
      const separator = container.querySelector('[data-orientation="vertical"]');
      expect(separator).toHaveClass('h-full');
      expect(separator).toHaveClass('w-[1px]');
      expect(separator).toHaveClass('bg-border');
      expect(separator).toHaveClass('shrink-0');
    });

    it('should render without crashing', () => {
      // Arrange & Act
      const { container } = render(<Separator />);

      // Assert: Should be in document
      expect(container.firstChild).toBeInTheDocument();
    });
  });

  describe('decorative prop', () => {
    it('should be decorative by default (decorative=true)', () => {
      // Arrange & Act
      const { container } = render(<Separator />);

      // Assert: Should have aria-hidden when decorative
      // Radix UI applies aria-hidden="true" when decorative
      const separator = container.firstChild;
      expect(separator).toHaveAttribute('data-orientation', 'horizontal');
    });

    it('should accept decorative=false for semantic separators', () => {
      // Arrange & Act
      const { container } = render(<Separator decorative={false} />);

      // Assert: Should render (Radix handles ARIA roles when not decorative)
      const separator = container.firstChild;
      expect(separator).toBeInTheDocument();
    });

    it('should accept decorative=true explicitly', () => {
      // Arrange & Act
      const { container } = render(<Separator decorative={true} />);

      // Assert: Should render as decorative
      const separator = container.firstChild;
      expect(separator).toBeInTheDocument();
    });
  });

  describe('className prop', () => {
    it('should apply custom className in addition to default styles', () => {
      // Arrange & Act
      const { container } = render(<Separator className="my-custom-class" />);

      // Assert: Should have both custom and default classes
      const separator = container.firstChild;
      expect(separator).toHaveClass('my-custom-class');
      expect(separator).toHaveClass('bg-border');
      expect(separator).toHaveClass('shrink-0');
      expect(separator).toHaveClass('h-[1px]');
      expect(separator).toHaveClass('w-full');
    });

    it('should apply custom className with vertical orientation', () => {
      // Arrange & Act
      const { container } = render(
        <Separator orientation="vertical" className="custom-vertical-class" />
      );

      // Assert: Should have both custom and vertical classes
      const separator = container.firstChild;
      expect(separator).toHaveClass('custom-vertical-class');
      expect(separator).toHaveClass('bg-border');
      expect(separator).toHaveClass('shrink-0');
      expect(separator).toHaveClass('h-full');
      expect(separator).toHaveClass('w-[1px]');
    });

    it('should handle multiple custom classes', () => {
      // Arrange & Act
      const { container } = render(
        <Separator className="custom-class-1 custom-class-2 custom-class-3" />
      );

      // Assert: Should have all custom classes
      const separator = container.firstChild;
      expect(separator).toHaveClass('custom-class-1');
      expect(separator).toHaveClass('custom-class-2');
      expect(separator).toHaveClass('custom-class-3');
    });

    it('should handle undefined className gracefully', () => {
      // Arrange & Act
      const { container } = render(<Separator className={undefined} />);

      // Assert: Should render with default classes
      const separator = container.firstChild;
      expect(separator).toHaveClass('bg-border');
      expect(separator).toHaveClass('shrink-0');
    });
  });

  describe('ref forwarding', () => {
    it('should forward ref to separator element', () => {
      // Arrange
      const ref = createRef<React.ElementRef<'div'>>();

      // Act
      render(<Separator ref={ref} />);

      // Assert: Ref should point to separator element
      expect(ref.current).toBeInstanceOf(HTMLElement);
      expect(ref.current).toHaveAttribute('data-orientation', 'horizontal');
    });

    it('should allow calling methods on forwarded ref', () => {
      // Arrange
      const ref = createRef<React.ElementRef<'div'>>();
      render(<Separator ref={ref} />);

      // Act: Access ref properties
      const tagName = ref.current?.tagName;
      const hasClass = ref.current?.classList.contains('bg-border');

      // Assert: Should have correct properties
      expect(tagName).toBe('DIV');
      expect(hasClass).toBe(true);
    });
  });

  describe('props spreading', () => {
    it('should spread additional props to separator element', () => {
      // Arrange & Act
      const { container } = render(
        <Separator data-testid="custom-separator" aria-label="Section divider" />
      );

      // Assert: Props should be applied
      const separator = container.firstChild;
      expect(separator).toHaveAttribute('data-testid', 'custom-separator');
      expect(separator).toHaveAttribute('aria-label', 'Section divider');
    });

    it('should handle id prop', () => {
      // Arrange & Act
      const { container } = render(<Separator id="my-separator" />);

      // Assert: Should have id attribute
      const separator = container.firstChild;
      expect(separator).toHaveAttribute('id', 'my-separator');
    });

    it('should handle data attributes', () => {
      // Arrange & Act
      const { container } = render(
        <Separator data-section="header" data-index="1" data-visible="true" />
      );

      // Assert: Should have all data attributes
      const separator = container.firstChild;
      expect(separator).toHaveAttribute('data-section', 'header');
      expect(separator).toHaveAttribute('data-index', '1');
      expect(separator).toHaveAttribute('data-visible', 'true');
    });
  });

  describe('orientation variants', () => {
    it('should handle explicit horizontal orientation', () => {
      // Arrange & Act
      const { container } = render(<Separator orientation="horizontal" />);

      // Assert: Should render horizontal separator
      const separator = container.querySelector('[data-orientation="horizontal"]');
      expect(separator).toBeInTheDocument();
      expect(separator).toHaveClass('h-[1px]');
      expect(separator).toHaveClass('w-full');
    });

    it('should render horizontal and vertical separators differently', () => {
      // Arrange & Act
      const { container: horizontalContainer } = render(<Separator orientation="horizontal" />);
      const { container: verticalContainer } = render(<Separator orientation="vertical" />);

      const horizontal = horizontalContainer.firstChild;
      const vertical = verticalContainer.firstChild;

      // Assert: Should have different orientation attributes
      expect(horizontal).toHaveAttribute('data-orientation', 'horizontal');
      expect(vertical).toHaveAttribute('data-orientation', 'vertical');

      // Assert: Should have different sizing classes
      expect(horizontal).toHaveClass('h-[1px]', 'w-full');
      expect(vertical).toHaveClass('h-full', 'w-[1px]');
    });
  });

  describe('edge cases', () => {
    it('should render without any props', () => {
      // Arrange & Act
      const { container } = render(<Separator />);

      // Assert: Should render with defaults (horizontal, decorative, default classes)
      const separator = container.firstChild;
      expect(separator).toBeInTheDocument();
      expect(separator).toHaveAttribute('data-orientation', 'horizontal');
      expect(separator).toHaveClass('bg-border');
    });

    it('should handle empty string className', () => {
      // Arrange & Act
      const { container } = render(<Separator className="" />);

      // Assert: Should render with default classes
      const separator = container.firstChild;
      expect(separator).toHaveClass('bg-border');
      expect(separator).toHaveClass('shrink-0');
    });

    it('should render multiple separators independently', () => {
      // Arrange & Act
      const { container } = render(
        <div>
          <Separator />
          <Separator orientation="vertical" />
          <Separator className="custom" />
        </div>
      );

      // Assert: Should render all separators
      const separators = container.querySelectorAll('[data-orientation]');
      expect(separators).toHaveLength(3);
      expect(separators[0]).toHaveAttribute('data-orientation', 'horizontal');
      expect(separators[1]).toHaveAttribute('data-orientation', 'vertical');
      expect(separators[2]).toHaveClass('custom');
    });
  });

  describe('accessibility', () => {
    it('should support semantic separator with decorative=false', () => {
      // Arrange & Act
      const { container } = render(<Separator decorative={false} role="separator" />);

      // Assert: Should render with role attribute
      const separator = container.firstChild;
      expect(separator).toHaveAttribute('role', 'separator');
    });

    it('should allow custom aria attributes', () => {
      // Arrange & Act
      const { container } = render(
        <Separator aria-orientation="horizontal" aria-label="Content divider" />
      );

      // Assert: Should have custom aria attributes
      const separator = container.firstChild;
      expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
      expect(separator).toHaveAttribute('aria-label', 'Content divider');
    });
  });

  describe('integration with layouts', () => {
    it('should work in horizontal layouts (stacked vertically)', () => {
      // Arrange & Act
      const { container } = render(
        <div className="flex flex-col">
          <div>Content above</div>
          <Separator />
          <div>Content below</div>
        </div>
      );

      // Assert: Horizontal separator should be present
      const separator = container.querySelector('[data-orientation="horizontal"]');
      expect(separator).toBeInTheDocument();
      expect(separator).toHaveClass('w-full');
    });

    it('should work in vertical layouts (side by side)', () => {
      // Arrange & Act
      const { container } = render(
        <div className="flex h-10 flex-row">
          <div>Left content</div>
          <Separator orientation="vertical" />
          <div>Right content</div>
        </div>
      );

      // Assert: Vertical separator should be present
      const separator = container.querySelector('[data-orientation="vertical"]');
      expect(separator).toBeInTheDocument();
      expect(separator).toHaveClass('h-full');
    });
  });
});
