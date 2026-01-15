/**
 * DropdownMenu Component Tests
 *
 * Tests the DropdownMenu component (shadcn/ui wrapper around Radix UI):
 * - Basic rendering of all exported components
 * - DropdownMenuSubTrigger with inset prop and ChevronRight icon
 * - DropdownMenuSubContent with custom className merging
 * - DropdownMenuCheckboxItem with checked states and Check icon indicator
 * - DropdownMenuRadioItem with selected states and Circle icon indicator
 * - DropdownMenuShortcut with keyboard shortcut display
 * - Ref forwarding for relevant components
 * - Custom className props are applied correctly
 *
 * Test Coverage:
 * - DropdownMenuSubTrigger (rendering, inset variant, icon)
 * - DropdownMenuSubContent (rendering, className)
 * - DropdownMenuCheckboxItem (checked states, indicator)
 * - DropdownMenuRadioItem (selected states, indicator)
 * - DropdownMenuShortcut (rendering, className)
 * - Accessibility (aria attributes, keyboard navigation)
 *
 * Note: These are thin wrappers around Radix UI. Tests focus on our customizations
 * (className props, inset variants, icons) rather than Radix UI functionality.
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/ui/dropdown-menu.tsx
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
} from '@/components/ui/dropdown-menu';

/**
 * Test Suite: DropdownMenu Component
 *
 * Tests the dropdown menu components with focus on shadcn/ui customizations.
 */
describe('components/ui/dropdown-menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('DropdownMenuSubTrigger', () => {
    it('should render with children', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger>Sub Menu</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>Sub Item</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: SubTrigger should be in the document
      expect(screen.getByText('Sub Menu')).toBeInTheDocument();
    });

    it('should render ChevronRight icon', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger>Sub Menu</DropdownMenuSubTrigger>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: ChevronRight icon should be present
      const subTrigger = screen.getByText('Sub Menu').parentElement;
      const chevronIcon = subTrigger?.querySelector('.lucide-chevron-right');
      expect(chevronIcon).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger className="custom-subtrigger-class">
                Sub Menu
              </DropdownMenuSubTrigger>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Custom class should be applied
      const subTrigger = screen.getByText('Sub Menu');
      expect(subTrigger).toHaveClass('custom-subtrigger-class');
    });

    it('should apply inset styling when inset prop is true', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger inset>Inset Sub Menu</DropdownMenuSubTrigger>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Inset class (pl-8) should be applied
      const subTrigger = screen.getByText('Inset Sub Menu');
      expect(subTrigger).toHaveClass('pl-8');
    });

    it('should not apply inset styling when inset prop is false', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger inset={false}>Normal Sub Menu</DropdownMenuSubTrigger>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Inset class should not be applied
      const subTrigger = screen.getByText('Normal Sub Menu');
      expect(subTrigger).not.toHaveClass('pl-8');
    });

    it('should forward ref to sub trigger element', () => {
      // Arrange
      const ref = createRef<HTMLDivElement>();

      // Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger ref={ref}>Sub Menu</DropdownMenuSubTrigger>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Ref should point to the element
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
      expect(ref.current?.textContent).toContain('Sub Menu');
    });
  });

  describe('DropdownMenuSubContent', () => {
    it('should render with children', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger>Sub Menu</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>Sub Item 1</DropdownMenuItem>
                <DropdownMenuItem>Sub Item 2</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: SubContent items should be in the document
      expect(screen.getByText('Sub Item 1')).toBeInTheDocument();
      expect(screen.getByText('Sub Item 2')).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger>Sub Menu</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="custom-subcontent-class">
                <DropdownMenuItem>Sub Item</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Custom class should be applied to SubContent
      const subItem = screen.getByText('Sub Item');
      const subContent = subItem.closest('.custom-subcontent-class');
      expect(subContent).toBeInTheDocument();
    });

    it('should apply default styling classes', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger>Sub Menu</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>Sub Item</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Default classes should be present on SubContent
      const subItem = screen.getByText('Sub Item');
      const subContent = subItem.closest('[role="menu"]');
      expect(subContent).toHaveClass('rounded-md');
      expect(subContent).toHaveClass('border');
      expect(subContent).toHaveClass('shadow-lg');
    });

    it('should forward ref to sub content element', () => {
      // Arrange
      const ref = createRef<HTMLDivElement>();

      // Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger>Sub Menu</DropdownMenuSubTrigger>
              <DropdownMenuSubContent ref={ref}>
                <DropdownMenuItem>Sub Item</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Ref should point to the element
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
    });
  });

  describe('DropdownMenuCheckboxItem', () => {
    it('should render with children', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem>Show Toolbar</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: CheckboxItem should be in the document
      expect(screen.getByText('Show Toolbar')).toBeInTheDocument();
    });

    it('should display Check icon when checked', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem checked>Checked Item</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Check icon should be present when checked
      const checkboxItem = screen.getByText('Checked Item').parentElement;
      const checkIcon = checkboxItem?.querySelector('.lucide-check');
      expect(checkIcon).toBeInTheDocument();
    });

    it('should not display Check icon when unchecked', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem checked={false}>Unchecked Item</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Check icon should not be present when unchecked
      const checkboxItem = screen.getByText('Unchecked Item').parentElement;
      const checkIcon = checkboxItem?.querySelector('.lucide-check');
      expect(checkIcon).not.toBeInTheDocument();
    });

    it('should handle indeterminate state', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem checked="indeterminate">
              Indeterminate Item
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: CheckboxItem should render with indeterminate state
      const checkboxItem = screen.getByText('Indeterminate Item').parentElement;
      expect(checkboxItem).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem className="custom-checkbox-class">
              Custom Checkbox
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Custom class should be applied
      const checkboxItem = screen.getByText('Custom Checkbox');
      expect(checkboxItem).toHaveClass('custom-checkbox-class');
    });

    it('should apply default styling with pl-8 for icon space', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem>Styled Checkbox</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Default pl-8 class should be applied for icon space
      const checkboxItem = screen.getByText('Styled Checkbox');
      expect(checkboxItem).toHaveClass('pl-8');
    });

    it('should handle onClick callback', async () => {
      // Arrange
      const user = userEvent.setup();
      const onClick = vi.fn();

      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem onClick={onClick}>Clickable</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Act: Click checkbox item
      await user.click(screen.getByText('Clickable'));

      // Assert: onClick should be called
      expect(onClick).toHaveBeenCalled();
    });

    it('should forward ref to checkbox item element', () => {
      // Arrange
      const ref = createRef<HTMLDivElement>();

      // Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem ref={ref}>Ref Item</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Ref should point to the element
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
      expect(ref.current?.textContent).toBe('Ref Item');
    });
  });

  describe('DropdownMenuRadioItem', () => {
    it('should render with children', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value="option1">
              <DropdownMenuRadioItem value="option1">Option 1</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: RadioItem should be in the document
      expect(screen.getByText('Option 1')).toBeInTheDocument();
    });

    it('should display Circle icon when selected', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value="selected">
              <DropdownMenuRadioItem value="selected">Selected Option</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Circle icon should be present when selected
      const radioItem = screen.getByText('Selected Option').parentElement;
      const circleIcon = radioItem?.querySelector('.lucide-circle');
      expect(circleIcon).toBeInTheDocument();
    });

    it('should not display Circle icon when not selected', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value="other">
              <DropdownMenuRadioItem value="not-selected">Not Selected</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Circle icon should not be present when not selected
      const radioItem = screen.getByText('Not Selected').parentElement;
      const circleIcon = radioItem?.querySelector('.lucide-circle');
      expect(circleIcon).not.toBeInTheDocument();
    });

    it('should apply custom className', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value="option">
              <DropdownMenuRadioItem value="option" className="custom-radio-class">
                Custom Radio
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Custom class should be applied
      const radioItem = screen.getByText('Custom Radio');
      expect(radioItem).toHaveClass('custom-radio-class');
    });

    it('should apply default styling with pl-8 for icon space', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value="option">
              <DropdownMenuRadioItem value="option">Styled Radio</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Default pl-8 class should be applied for icon space
      const radioItem = screen.getByText('Styled Radio');
      expect(radioItem).toHaveClass('pl-8');
    });

    it('should work within RadioGroup', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value="option2">
              <DropdownMenuRadioItem value="option1">Option 1</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="option2">Option 2</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="option3">Option 3</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: All options should be in the document
      expect(screen.getByText('Option 1')).toBeInTheDocument();
      expect(screen.getByText('Option 2')).toBeInTheDocument();
      expect(screen.getByText('Option 3')).toBeInTheDocument();

      // Assert: Only option2 should show the circle icon (selected)
      const option2 = screen.getByText('Option 2');
      const circleIcon = option2.querySelector('.lucide-circle');
      expect(circleIcon).toBeInTheDocument();

      // Assert: Option 1 and 3 should not have circle icons visible
      const option1 = screen.getByText('Option 1');
      const option3 = screen.getByText('Option 3');
      expect(option1.querySelector('.lucide-circle')).toBeNull();
      expect(option3.querySelector('.lucide-circle')).toBeNull();
    });

    it('should handle onSelect callback', async () => {
      // Arrange
      const user = userEvent.setup();
      const onSelect = vi.fn();

      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value="option1">
              <DropdownMenuRadioItem value="option2" onSelect={onSelect}>
                Select Me
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Act: Click radio item
      await user.click(screen.getByText('Select Me'));

      // Assert: onSelect should be called
      expect(onSelect).toHaveBeenCalled();
    });

    it('should forward ref to radio item element', () => {
      // Arrange
      const ref = createRef<HTMLDivElement>();

      // Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value="option">
              <DropdownMenuRadioItem value="option" ref={ref}>
                Ref Item
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Ref should point to the element
      expect(ref.current).toBeInstanceOf(HTMLDivElement);
      expect(ref.current?.textContent).toBe('Ref Item');
    });
  });

  describe('DropdownMenuShortcut', () => {
    it('should render keyboard shortcut text', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>
              New File
              <DropdownMenuShortcut>⌘N</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Shortcut should be in the document
      expect(screen.getByText('⌘N')).toBeInTheDocument();
    });

    it('should apply default styling classes', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>
              Save
              <DropdownMenuShortcut>⌘S</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Default classes should be applied
      const shortcut = screen.getByText('⌘S');
      expect(shortcut).toHaveClass('ml-auto');
      expect(shortcut).toHaveClass('text-xs');
      expect(shortcut).toHaveClass('tracking-widest');
      expect(shortcut).toHaveClass('opacity-60');
    });

    it('should apply custom className', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>
              Copy
              <DropdownMenuShortcut className="custom-shortcut-class">⌘C</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Custom class should be applied
      const shortcut = screen.getByText('⌘C');
      expect(shortcut).toHaveClass('custom-shortcut-class');
    });

    it('should render as a span element', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>
              Paste
              <DropdownMenuShortcut>⌘V</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Should be a span element
      const shortcut = screen.getByText('⌘V');
      expect(shortcut.tagName).toBe('SPAN');
    });

    it('should handle multiple shortcuts in the same menu', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>
              New File
              <DropdownMenuShortcut>⌘N</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              Save File
              <DropdownMenuShortcut>⌘S</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              Close File
              <DropdownMenuShortcut>⌘W</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: All shortcuts should be in the document
      expect(screen.getByText('⌘N')).toBeInTheDocument();
      expect(screen.getByText('⌘S')).toBeInTheDocument();
      expect(screen.getByText('⌘W')).toBeInTheDocument();
    });

    it('should position shortcut with ml-auto (aligned to the right)', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>
              Redo
              <DropdownMenuShortcut>⇧⌘Z</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: ml-auto should be present for right alignment
      const shortcut = screen.getByText('⇧⌘Z');
      expect(shortcut).toHaveClass('ml-auto');
    });

    it('should accept HTML attributes', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Trigger</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>
              Delete
              <DropdownMenuShortcut data-testid="delete-shortcut" title="Delete shortcut">
                ⌫
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: HTML attributes should be applied
      const shortcut = screen.getByTestId('delete-shortcut');
      expect(shortcut).toHaveAttribute('title', 'Delete shortcut');
    });
  });

  describe('integration and composition', () => {
    it('should render complete dropdown menu with all components', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>File Actions</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem>
                New File
                <DropdownMenuShortcut>⌘N</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem>
                Save
                <DropdownMenuShortcut>⌘S</DropdownMenuShortcut>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked>Show Toolbar</DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={false}>Show Sidebar</DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value="light">
              <DropdownMenuRadioItem value="light">Light Theme</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark Theme</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger>More Options</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>Export</DropdownMenuItem>
                <DropdownMenuItem>Import</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: All components should be present
      expect(screen.getByText('File Actions')).toBeInTheDocument();
      expect(screen.getByText('New File')).toBeInTheDocument();
      expect(screen.getByText('⌘N')).toBeInTheDocument();
      expect(screen.getByText('Show Toolbar')).toBeInTheDocument();
      expect(screen.getByText('Light Theme')).toBeInTheDocument();
      expect(screen.getByText('More Options')).toBeInTheDocument();
      expect(screen.getByText('Export')).toBeInTheDocument();
    });

    it('should handle nested sub menus', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger>Level 1</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>Level 1 Item</DropdownMenuItem>
                <DropdownMenuSub open>
                  <DropdownMenuSubTrigger>Level 2</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem>Level 2 Item</DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Nested items should be present
      expect(screen.getByText('Level 1')).toBeInTheDocument();
      expect(screen.getByText('Level 1 Item')).toBeInTheDocument();
      expect(screen.getByText('Level 2')).toBeInTheDocument();
      expect(screen.getByText('Level 2 Item')).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('should have proper role attributes for menu items', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Action</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Menu item should have proper role
      const menuItem = screen.getByText('Action');
      expect(menuItem).toHaveAttribute('role', 'menuitem');
    });

    it('should have proper role for checkbox items', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem>Option</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Checkbox item should have proper role
      const checkboxItem = screen.getByText('Option');
      expect(checkboxItem).toHaveAttribute('role', 'menuitemcheckbox');
    });

    it('should have proper role for radio items', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value="option">
              <DropdownMenuRadioItem value="option">Option</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Radio item should have proper role
      const radioItem = screen.getByText('Option');
      expect(radioItem).toHaveAttribute('role', 'menuitemradio');
    });

    it('should support keyboard navigation for menu items', async () => {
      // Arrange
      const user = userEvent.setup();

      render(
        <DropdownMenu>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Item 1</DropdownMenuItem>
            <DropdownMenuItem>Item 2</DropdownMenuItem>
            <DropdownMenuItem>Item 3</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Act: Open menu with keyboard
      const trigger = screen.getByText('Menu');
      trigger.focus();
      await user.keyboard('{Enter}');

      // Assert: Menu should open and items should be accessible
      expect(screen.getByText('Item 1')).toBeInTheDocument();
      expect(screen.getByText('Item 2')).toBeInTheDocument();
      expect(screen.getByText('Item 3')).toBeInTheDocument();
    });
  });

  describe('edge cases', () => {
    it('should handle empty dropdown menu', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Empty Menu</DropdownMenuTrigger>
          <DropdownMenuContent />
        </DropdownMenu>
      );

      // Assert: Should render without errors
      expect(screen.getByText('Empty Menu')).toBeInTheDocument();
    });

    it('should handle undefined className gracefully', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem className={undefined}>Item</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Should render without errors
      expect(screen.getByText('Item')).toBeInTheDocument();
    });

    it('should handle empty string className', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value="option">
              <DropdownMenuRadioItem value="option" className="">
                Item
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Should render without errors
      expect(screen.getByText('Item')).toBeInTheDocument();
    });

    it('should handle missing inset prop on SubTrigger', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger>Sub Menu</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>Item</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Should render without inset styling
      const subTrigger = screen.getByText('Sub Menu').parentElement;
      expect(subTrigger).not.toHaveClass('pl-8');
    });
  });

  /**
   * DropdownMenuItem inset prop tests
   *
   * Tests the inset prop branch on line 86: `inset && 'pl-8'`
   */
  describe('DropdownMenuItem inset prop', () => {
    it('should apply inset styling when inset prop is true', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem inset>Inset Item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Should have pl-8 class for inset styling
      const item = screen.getByText('Inset Item');
      expect(item).toHaveClass('pl-8');
    });

    it('should not apply inset styling when inset prop is false', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem inset={false}>Normal Item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Should not have pl-8 class
      const item = screen.getByText('Normal Item');
      expect(item).not.toHaveClass('pl-8');
    });

    it('should not apply inset styling when inset prop is not provided', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Default Item</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Should not have pl-8 class (default behavior)
      const item = screen.getByText('Default Item');
      expect(item).not.toHaveClass('pl-8');
    });
  });

  /**
   * DropdownMenuLabel inset prop tests
   *
   * Tests the inset prop branch on line 147: `inset && 'pl-8'`
   */
  describe('DropdownMenuLabel inset prop', () => {
    it('should apply inset styling when inset prop is true', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel inset>Inset Label</DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Should have pl-8 class for inset styling
      const label = screen.getByText('Inset Label');
      expect(label).toHaveClass('pl-8');
    });

    it('should not apply inset styling when inset prop is false', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel inset={false}>Normal Label</DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Should not have pl-8 class
      const label = screen.getByText('Normal Label');
      expect(label).not.toHaveClass('pl-8');
    });

    it('should not apply inset styling when inset prop is not provided', () => {
      // Arrange & Act
      render(
        <DropdownMenu open>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>Default Label</DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
      );

      // Assert: Should not have pl-8 class (default behavior)
      const label = screen.getByText('Default Label');
      expect(label).not.toHaveClass('pl-8');
    });
  });
});
