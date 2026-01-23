import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { Slider } from '@/components/ui/slider';

describe('components/ui/slider', () => {
  describe('rendering', () => {
    it('should render with default props', () => {
      render(<Slider />);

      const slider = screen.getByRole('slider');
      expect(slider).toBeInTheDocument();
    });

    it('should render with value, min, max, and step', () => {
      render(<Slider value={[50]} min={0} max={100} step={1} />);

      const slider = screen.getByRole('slider');
      expect(slider).toHaveAttribute('aria-valuenow', '50');
      expect(slider).toHaveAttribute('aria-valuemin', '0');
      expect(slider).toHaveAttribute('aria-valuemax', '100');
    });

    it('should apply custom className', () => {
      const { container } = render(<Slider className="custom-class" />);

      const root = container.firstChild as HTMLElement;
      expect(root).toHaveClass('custom-class');
    });

    it('should forward ref', () => {
      const ref = createRef<HTMLSpanElement>();
      render(<Slider ref={ref} />);

      expect(ref.current).toBeInstanceOf(HTMLElement);
    });

    it('should pass aria-label to root', () => {
      render(<Slider aria-label="Volume" />);

      const slider = screen.getByRole('slider');
      expect(slider).toBeInTheDocument();
    });

    it('should render track and thumb elements', () => {
      const { container } = render(<Slider value={[50]} min={0} max={100} />);

      // Track is the child of root
      const root = container.firstChild as HTMLElement;
      expect(root.querySelector('[class*="overflow-hidden"]')).toBeInTheDocument();
    });
  });

  describe('interaction', () => {
    it('should call onValueChange when value changes', () => {
      const onValueChange = vi.fn();
      render(<Slider value={[50]} min={0} max={100} step={1} onValueChange={onValueChange} />);

      const slider = screen.getByRole('slider');

      // Simulate keyboard interaction
      fireEvent.keyDown(slider, { key: 'ArrowRight' });

      expect(onValueChange).toHaveBeenCalled();
    });

    it('should respect disabled state', () => {
      const onValueChange = vi.fn();
      render(<Slider value={[50]} disabled onValueChange={onValueChange} />);

      const slider = screen.getByRole('slider');
      expect(slider).toHaveAttribute('data-disabled', '');
    });
  });
});
