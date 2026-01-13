/**
 * PasswordInput Component Tests
 *
 * Tests the PasswordInput component with show/hide password toggle functionality:
 * - Rendering with password type by default
 * - Toggle button switches between text/password types
 * - Correct aria-labels for show/hide states
 * - Disabled state disables both input and toggle button
 * - Forwards ref correctly to underlying input
 * - Spreads additional props to input element
 * - Correct styling (pr-10 on input for button space)
 * - Icon changes based on visibility state
 *
 * Test Coverage:
 * - Initial rendering
 * - Password visibility toggling
 * - Accessibility (aria-labels)
 * - Disabled state
 * - Ref forwarding
 * - Props spreading
 * - Wrapper className
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/ui/password-input.tsx
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { PasswordInput } from '@/components/ui/password-input';

/**
 * Test Suite: PasswordInput Component
 *
 * Tests the password input with visibility toggle functionality.
 */
describe('components/ui/password-input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('should render password input with type="password" by default', () => {
      // Arrange & Act
      render(<PasswordInput placeholder="Enter password" />);

      // Assert: Input should have password type
      const input = screen.getByPlaceholderText('Enter password');
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute('type', 'password');
    });

    it('should render toggle button with "Show password" aria-label initially', () => {
      // Arrange & Act
      render(<PasswordInput />);

      // Assert: Toggle button should have correct aria-label
      const toggleButton = screen.getByLabelText('Show password');
      expect(toggleButton).toBeInTheDocument();
      expect(toggleButton).toHaveAttribute('type', 'button');
    });

    it('should render Eye icon initially (password hidden)', () => {
      // Arrange & Act
      render(<PasswordInput />);

      // Assert: Eye icon should be present (lucide-react adds "lucide-eye" class)
      const toggleButton = screen.getByLabelText('Show password');
      const svg = toggleButton.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveClass('lucide-eye');
    });

    it('should apply custom className to input', () => {
      // Arrange & Act
      const { container } = render(<PasswordInput className="custom-input-class" />);

      // Assert: Input should have custom class in addition to default pr-10
      const input = container.querySelector('input[type="password"]') as HTMLInputElement;
      expect(input).toBeInTheDocument();
      expect(input.className).toContain('custom-input-class');
      expect(input.className).toContain('pr-10');
    });

    it('should apply custom wrapperClassName to wrapper div', () => {
      // Arrange & Act
      const { container } = render(
        <PasswordInput wrapperClassName="custom-wrapper-class" placeholder="Test" />
      );

      // Assert: Wrapper should have custom class
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('relative');
      expect(wrapper).toHaveClass('custom-wrapper-class');
    });

    it('should render with placeholder', () => {
      // Arrange & Act
      render(<PasswordInput placeholder="Your password" />);

      // Assert
      const input = screen.getByPlaceholderText('Your password');
      expect(input).toBeInTheDocument();
    });

    it('should render with id attribute', () => {
      // Arrange & Act
      render(<PasswordInput id="password-field" />);

      // Assert
      const input = document.getElementById('password-field') as HTMLInputElement;
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute('type', 'password');
    });

    it('should render with name attribute', () => {
      // Arrange & Act
      const { container } = render(<PasswordInput name="password" />);

      // Assert
      const input = container.querySelector('input[name="password"]') as HTMLInputElement;
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute('type', 'password');
    });

    it('should render toggle button with tabIndex -1', () => {
      // Arrange & Act
      render(<PasswordInput />);

      // Assert: Toggle button should not be in tab order
      const toggleButton = screen.getByLabelText('Show password');
      expect(toggleButton).toHaveAttribute('tabIndex', '-1');
    });
  });

  describe('password visibility toggle', () => {
    it('should switch to type="text" when toggle button is clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<PasswordInput placeholder="Password" />);

      const input = screen.getByPlaceholderText('Password');
      const toggleButton = screen.getByLabelText('Show password');

      // Assert: Initially password type
      expect(input).toHaveAttribute('type', 'password');

      // Act: Click toggle button
      await user.click(toggleButton);

      // Assert: Should change to text type
      expect(input).toHaveAttribute('type', 'text');
    });

    it('should change aria-label to "Hide password" when password is visible', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<PasswordInput />);

      const toggleButton = screen.getByLabelText('Show password');

      // Act: Click to show password
      await user.click(toggleButton);

      // Assert: aria-label should update
      expect(screen.getByLabelText('Hide password')).toBeInTheDocument();
      expect(screen.queryByLabelText('Show password')).not.toBeInTheDocument();
    });

    it('should switch to EyeOff icon when password is visible', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<PasswordInput />);

      const toggleButton = screen.getByLabelText('Show password');

      // Act: Click to show password
      await user.click(toggleButton);

      // Assert: EyeOff icon should be present
      const hideButton = screen.getByLabelText('Hide password');
      const svg = hideButton.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveClass('lucide-eye-off');
    });

    it('should toggle back to password type when clicking hide', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<PasswordInput placeholder="Password" />);

      const input = screen.getByPlaceholderText('Password');
      const showButton = screen.getByLabelText('Show password');

      // Act: Show password
      await user.click(showButton);
      expect(input).toHaveAttribute('type', 'text');

      // Act: Hide password
      const hideButton = screen.getByLabelText('Hide password');
      await user.click(hideButton);

      // Assert: Should be password type again
      expect(input).toHaveAttribute('type', 'password');
    });

    it('should toggle back to Eye icon when password is hidden again', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<PasswordInput />);

      const showButton = screen.getByLabelText('Show password');

      // Act: Show then hide password
      await user.click(showButton);
      const hideButton = screen.getByLabelText('Hide password');
      await user.click(hideButton);

      // Assert: Eye icon should be present
      const toggleButton = screen.getByLabelText('Show password');
      const svg = toggleButton.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveClass('lucide-eye');
    });

    it('should allow multiple toggles', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<PasswordInput placeholder="Password" />);

      const input = screen.getByPlaceholderText('Password');

      // Act & Assert: Toggle multiple times
      expect(input).toHaveAttribute('type', 'password');

      await user.click(screen.getByLabelText('Show password'));
      expect(input).toHaveAttribute('type', 'text');

      await user.click(screen.getByLabelText('Hide password'));
      expect(input).toHaveAttribute('type', 'password');

      await user.click(screen.getByLabelText('Show password'));
      expect(input).toHaveAttribute('type', 'text');
    });
  });

  describe('disabled state', () => {
    it('should disable input when disabled prop is true', () => {
      // Arrange & Act
      const { container } = render(<PasswordInput disabled />);

      // Assert: Input should be disabled
      const input = container.querySelector('input') as HTMLInputElement;
      expect(input).toBeDisabled();
    });

    it('should disable toggle button when disabled prop is true', () => {
      // Arrange & Act
      render(<PasswordInput disabled />);

      // Assert: Toggle button should be disabled
      const toggleButton = screen.getByLabelText('Show password');
      expect(toggleButton).toBeDisabled();
    });

    it('should apply opacity styles to toggle button when disabled', () => {
      // Arrange & Act
      render(<PasswordInput disabled />);

      // Assert: Toggle button should have disabled styling
      const toggleButton = screen.getByLabelText('Show password');
      expect(toggleButton).toHaveClass('opacity-50');
      expect(toggleButton).toHaveClass('pointer-events-none');
    });

    it('should not toggle password visibility when disabled', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<PasswordInput disabled placeholder="Password" />);

      const input = screen.getByPlaceholderText('Password');
      const toggleButton = screen.getByLabelText('Show password');

      // Act: Try to click toggle button (should not work)
      await user.click(toggleButton);

      // Assert: Should remain password type
      expect(input).toHaveAttribute('type', 'password');
    });
  });

  describe('ref forwarding', () => {
    it('should forward ref to input element', () => {
      // Arrange
      const ref = createRef<HTMLInputElement>();

      // Act
      render(<PasswordInput ref={ref} />);

      // Assert: Ref should point to input element
      expect(ref.current).toBeInstanceOf(HTMLInputElement);
      expect(ref.current).toHaveAttribute('type', 'password');
    });

    it('should allow calling focus() on forwarded ref', () => {
      // Arrange
      const ref = createRef<HTMLInputElement>();
      render(<PasswordInput ref={ref} />);

      // Act: Focus using ref
      ref.current?.focus();

      // Assert: Input should be focused
      expect(ref.current).toHaveFocus();
    });

    it('should allow accessing value from forwarded ref', async () => {
      // Arrange
      const user = userEvent.setup();
      const ref = createRef<HTMLInputElement>();
      render(<PasswordInput ref={ref} />);

      // Act: Type into input using ref
      if (ref.current) {
        await user.type(ref.current, 'test-password');
      }

      // Assert: Value should be accessible via ref
      expect(ref.current?.value).toBe('test-password');
    });
  });

  describe('props spreading', () => {
    it('should spread additional props to input element', () => {
      // Arrange & Act
      render(
        <PasswordInput
          data-testid="custom-password-input"
          aria-describedby="password-hint"
          autoComplete="new-password"
          required
        />
      );

      // Assert: Props should be applied to input
      const input = screen.getByTestId('custom-password-input');
      expect(input).toHaveAttribute('aria-describedby', 'password-hint');
      expect(input).toHaveAttribute('autocomplete', 'new-password');
      expect(input).toBeRequired();
    });

    it('should handle value prop', () => {
      // Arrange & Act
      const { container } = render(<PasswordInput value="controlled-value" onChange={() => {}} />);

      // Assert: Input should have value
      const input = container.querySelector('input') as HTMLInputElement;
      expect(input.value).toBe('controlled-value');
    });

    it('should handle defaultValue prop', () => {
      // Arrange & Act
      const { container } = render(<PasswordInput defaultValue="default-password" />);

      // Assert: Input should have default value
      const input = container.querySelector('input') as HTMLInputElement;
      expect(input.value).toBe('default-password');
    });

    it('should handle onChange callback', async () => {
      // Arrange
      const user = userEvent.setup();
      const onChange = vi.fn();
      const { container } = render(<PasswordInput onChange={onChange} />);

      const input = container.querySelector('input') as HTMLInputElement;

      // Act: Type into input
      await user.type(input, 'a');

      // Assert: onChange should be called
      expect(onChange).toHaveBeenCalled();
    });

    it('should handle onBlur callback', async () => {
      // Arrange
      const user = userEvent.setup();
      const onBlur = vi.fn();
      const { container } = render(<PasswordInput onBlur={onBlur} />);

      const input = container.querySelector('input') as HTMLInputElement;

      // Act: Focus then blur
      input.focus();
      await user.tab();

      // Assert: onBlur should be called
      expect(onBlur).toHaveBeenCalled();
    });

    it('should handle onFocus callback', async () => {
      // Arrange
      const onFocus = vi.fn();
      const { container } = render(<PasswordInput onFocus={onFocus} />);

      const input = container.querySelector('input') as HTMLInputElement;

      // Act: Focus input
      input.focus();

      // Assert: onFocus should be called
      expect(onFocus).toHaveBeenCalled();
    });
  });

  describe('user interaction', () => {
    it('should allow typing when password is hidden', async () => {
      // Arrange
      const user = userEvent.setup();
      const { container } = render(<PasswordInput />);

      const input = container.querySelector('input') as HTMLInputElement;

      // Act: Type password
      await user.type(input, 'my-secret-password');

      // Assert: Value should be set
      expect(input.value).toBe('my-secret-password');
      expect(input).toHaveAttribute('type', 'password');
    });

    it('should allow typing when password is visible', async () => {
      // Arrange
      const user = userEvent.setup();
      const { container } = render(<PasswordInput />);

      const input = container.querySelector('input') as HTMLInputElement;
      const toggleButton = screen.getByLabelText('Show password');

      // Act: Show password then type
      await user.click(toggleButton);
      await user.type(input, 'visible-password');

      // Assert: Value should be set and visible
      expect(input.value).toBe('visible-password');
      expect(input).toHaveAttribute('type', 'text');
    });

    it('should change input type when toggling while focused', async () => {
      // Arrange
      const user = userEvent.setup();
      const { container } = render(<PasswordInput />);

      const input = container.querySelector('input') as HTMLInputElement;
      const toggleButton = screen.getByLabelText('Show password');

      // Act: Focus input, then toggle visibility
      input.focus();
      expect(input).toHaveFocus();
      expect(input).toHaveAttribute('type', 'password');

      await user.click(toggleButton);

      // Assert: Input type should change (focus may move to button, which is expected)
      expect(input).toHaveAttribute('type', 'text');
    });

    it('should preserve value when toggling visibility', async () => {
      // Arrange
      const user = userEvent.setup();
      const { container } = render(<PasswordInput />);

      const input = container.querySelector('input') as HTMLInputElement;
      const toggleButton = screen.getByLabelText('Show password');

      // Act: Type password then toggle
      await user.type(input, 'preserved-password');
      await user.click(toggleButton);

      // Assert: Value should be preserved
      expect(input.value).toBe('preserved-password');
      expect(input).toHaveAttribute('type', 'text');

      // Act: Toggle back
      const hideButton = screen.getByLabelText('Hide password');
      await user.click(hideButton);

      // Assert: Value still preserved
      expect(input.value).toBe('preserved-password');
      expect(input).toHaveAttribute('type', 'password');
    });
  });

  describe('accessibility', () => {
    it('should have proper aria-label for toggle button', () => {
      // Arrange & Act
      render(<PasswordInput />);

      // Assert: Button should have descriptive aria-label
      const toggleButton = screen.getByLabelText('Show password');
      expect(toggleButton).toHaveAccessibleName('Show password');
    });

    it('should update aria-label when toggling', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<PasswordInput />);

      // Act: Toggle visibility
      await user.click(screen.getByLabelText('Show password'));

      // Assert: aria-label should update
      const hideButton = screen.getByLabelText('Hide password');
      expect(hideButton).toHaveAccessibleName('Hide password');
    });

    it('should have button type to prevent form submission', () => {
      // Arrange & Act
      render(<PasswordInput />);

      // Assert: Button should be type="button"
      const toggleButton = screen.getByLabelText('Show password');
      expect(toggleButton).toHaveAttribute('type', 'button');
    });

    it('should support form integration with name attribute', () => {
      // Arrange & Act
      const { container } = render(
        <form>
          <PasswordInput name="user-password" />
        </form>
      );

      // Assert: Input should be part of form
      const input = container.querySelector('input') as HTMLInputElement;
      expect(input).toHaveAttribute('name', 'user-password');
      expect(input.form).toBe(container.querySelector('form'));
    });

    it('should support required attribute for form validation', () => {
      // Arrange & Act
      const { container } = render(<PasswordInput required />);

      // Assert: Input should be required
      const input = container.querySelector('input') as HTMLInputElement;
      expect(input).toBeRequired();
    });

    it('should be keyboard accessible for input', async () => {
      // Arrange
      const user = userEvent.setup();
      const { container } = render(<PasswordInput />);

      const input = container.querySelector('input') as HTMLInputElement;

      // Act: Tab to input
      await user.tab();

      // Assert: Input should be focused
      expect(input).toHaveFocus();
    });
  });

  describe('styling', () => {
    it('should apply pr-10 class to input for toggle button space', () => {
      // Arrange & Act
      const { container } = render(<PasswordInput />);

      // Assert: Input should have pr-10 class
      const input = container.querySelector('input') as HTMLInputElement;
      expect(input.className).toContain('pr-10');
    });

    it('should position toggle button absolutely', () => {
      // Arrange & Act
      render(<PasswordInput />);

      // Assert: Toggle button should have absolute positioning
      const toggleButton = screen.getByLabelText('Show password');
      expect(toggleButton).toHaveClass('absolute');
      expect(toggleButton).toHaveClass('right-2');
      expect(toggleButton).toHaveClass('top-1/2');
      expect(toggleButton).toHaveClass('-translate-y-1/2');
    });

    it('should apply wrapper relative positioning', () => {
      // Arrange & Act
      const { container } = render(<PasswordInput />);

      // Assert: Wrapper should have relative positioning
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('relative');
    });

    it('should apply hover styles to toggle button', () => {
      // Arrange & Act
      render(<PasswordInput />);

      // Assert: Toggle button should have hover styles
      const toggleButton = screen.getByLabelText('Show password');
      expect(toggleButton).toHaveClass('text-muted-foreground');
      expect(toggleButton).toHaveClass('hover:text-foreground');
    });

    it('should apply focus styles to toggle button', () => {
      // Arrange & Act
      render(<PasswordInput />);

      // Assert: Toggle button should have focus-visible styles
      const toggleButton = screen.getByLabelText('Show password');
      expect(toggleButton).toHaveClass('focus-visible:ring-ring');
      expect(toggleButton).toHaveClass('focus-visible:outline-none');
      expect(toggleButton).toHaveClass('focus-visible:ring-1');
      expect(toggleButton).toHaveClass('rounded');
    });
  });

  describe('integration with react-hook-form', () => {
    it('should work with register pattern', () => {
      // Arrange: Simulate react-hook-form register
      const register = vi.fn((name: string) => ({
        name,
        onChange: vi.fn(),
        onBlur: vi.fn(),
        ref: vi.fn(),
      }));

      // Act
      const { name, onChange, onBlur, ref } = register('password');
      const { container } = render(
        <PasswordInput name={name} onChange={onChange} onBlur={onBlur} ref={ref} />
      );

      // Assert: Register should be called
      expect(register).toHaveBeenCalledWith('password');

      // Assert: Input should have registered name
      const input = container.querySelector('input') as HTMLInputElement;
      expect(input).toHaveAttribute('name', 'password');
    });
  });

  describe('edge cases', () => {
    it('should handle undefined className gracefully', () => {
      // Arrange & Act
      const { container } = render(<PasswordInput className={undefined} />);

      // Assert: Should render without errors
      const input = container.querySelector('input') as HTMLInputElement;
      expect(input).toBeInTheDocument();
    });

    it('should handle undefined wrapperClassName gracefully', () => {
      // Arrange & Act
      const { container } = render(<PasswordInput wrapperClassName={undefined} />);

      // Assert: Should render without errors
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('relative');
    });

    it('should handle empty string className', () => {
      // Arrange & Act
      const { container } = render(<PasswordInput className="" />);

      // Assert: Should render without errors
      const input = container.querySelector('input') as HTMLInputElement;
      expect(input).toBeInTheDocument();
    });

    it('should render without any props', () => {
      // Arrange & Act
      const { container } = render(<PasswordInput />);

      // Assert: Should render with defaults
      const input = container.querySelector('input') as HTMLInputElement;
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute('type', 'password');
    });

    it('should handle rapid toggle clicks', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<PasswordInput placeholder="Password" />);

      const input = screen.getByPlaceholderText('Password');

      // Act: Rapidly toggle multiple times
      await user.click(screen.getByLabelText('Show password'));
      await user.click(screen.getByLabelText('Hide password'));
      await user.click(screen.getByLabelText('Show password'));
      await user.click(screen.getByLabelText('Hide password'));

      // Assert: Should end in password type
      expect(input).toHaveAttribute('type', 'password');
    });
  });
});
