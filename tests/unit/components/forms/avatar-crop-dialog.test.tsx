import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AvatarCropDialog } from '@/components/forms/avatar-crop-dialog';
import React from 'react';

// Track the onCropComplete callback for simulating crop
let capturedOnCropComplete: ((area: unknown, pixels: unknown) => void) | null = null;

// Mock react-easy-crop
vi.mock('react-easy-crop', () => ({
  default: vi.fn((props) => {
    // Capture the onCropComplete callback
    capturedOnCropComplete = props.onCropComplete;
    return (
      <div
        data-testid="cropper"
        data-zoom={props.zoom}
        data-image={props.image}
        data-aspect={props.aspect}
        data-crop-shape={props.cropShape}
      >
        Mock Cropper
      </div>
    );
  }),
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  ZoomIn: () => <span data-testid="zoom-in-icon">ZoomIn</span>,
  ZoomOut: () => <span data-testid="zoom-out-icon">ZoomOut</span>,
}));

// Mock Radix UI Dialog components to render inline (without portals)
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange?: (open: boolean) => void;
  }) =>
    open ? (
      <div role="dialog">
        <button
          data-testid="dialog-close"
          onClick={() => onOpenChange?.(false)}
          aria-label="Close dialog"
        />
        {children}
      </div>
    ) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Mock Radix UI Slider component
vi.mock('@/components/ui/slider', () => ({
  Slider: (props: {
    value?: number[];
    min?: number;
    max?: number;
    step?: number;
    onValueChange?: (value: number[]) => void;
    'aria-label'?: string;
  }) => (
    <input
      type="range"
      aria-label={props['aria-label']}
      value={props.value?.[0]}
      min={props.min}
      max={props.max}
      step={props.step}
      onChange={(e) => props.onValueChange?.([Number(e.target.value)])}
    />
  ),
}));

// Mock Button component
vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => (
    <button {...props}>{children}</button>
  ),
}));

describe('components/forms/avatar-crop-dialog', () => {
  const mockOnConfirm = vi.fn();
  const mockOnCancel = vi.fn();
  const mockImageSrc = 'blob:http://localhost/test-image';

  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnCropComplete = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('should render dialog when open is true', () => {
      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Crop Avatar')).toBeInTheDocument();
    });

    it('should not render dialog content when open is false', () => {
      render(
        <AvatarCropDialog
          open={false}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('should render description text', () => {
      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(
        screen.getByText(/drag to reposition and use the slider to zoom/i)
      ).toBeInTheDocument();
    });

    it('should render Cropper with correct props', () => {
      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const cropper = screen.getByTestId('cropper');
      expect(cropper).toHaveAttribute('data-image', mockImageSrc);
      expect(cropper).toHaveAttribute('data-aspect', '1');
      expect(cropper).toHaveAttribute('data-crop-shape', 'round');
    });

    it('should render zoom controls', () => {
      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.getByLabelText('Zoom out')).toBeInTheDocument();
      expect(screen.getByLabelText('Zoom in')).toBeInTheDocument();
      expect(screen.getByLabelText('Zoom')).toBeInTheDocument();
    });

    it('should render Cancel and Apply buttons', () => {
      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /apply/i })).toBeInTheDocument();
    });
  });

  describe('cancel action', () => {
    it('should call onCancel when Cancel button is clicked', async () => {
      const user = userEvent.setup();
      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('crop confirmation', () => {
    it('should not call onConfirm if no crop area is set', async () => {
      const user = userEvent.setup();
      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      // Click Apply without simulating onCropComplete
      await user.click(screen.getByRole('button', { name: /apply/i }));

      expect(mockOnConfirm).not.toHaveBeenCalled();
    });

    it('should call onConfirm with blob on successful crop', async () => {
      const user = userEvent.setup();

      // Mock canvas and image APIs
      const mockBlob = new Blob(['fake-image'], { type: 'image/jpeg' });
      const mockCtx = { drawImage: vi.fn() };
      const mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => mockCtx),
        toBlob: vi.fn((cb: BlobCallback) => cb(mockBlob)),
      };

      // Save original createElement before mocking
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tag) => {
        if (tag === 'canvas') return mockCanvas as unknown as HTMLCanvasElement;
        return originalCreateElement(tag);
      });

      // Mock Image constructor
      const origImage = global.Image;
      (global as any).Image = class {
        onload: (() => void) | null = null;
        crossOrigin = '';
        set src(_: string) {
          setTimeout(() => this.onload?.(), 0);
        }
      };

      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      // Simulate crop complete from Cropper
      capturedOnCropComplete?.(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 10, y: 10, width: 200, height: 200 }
      );

      await user.click(screen.getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(mockOnConfirm).toHaveBeenCalledWith(mockBlob);
      });

      global.Image = origImage;
    });

    it('should call onCancel when image loading fails', async () => {
      const user = userEvent.setup();

      // Mock Image that fails to load
      const origImage = global.Image;
      (global as any).Image = class {
        onerror: (() => void) | null = null;
        crossOrigin = '';
        set src(_: string) {
          setTimeout(() => this.onerror?.(), 0);
        }
      };

      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      // Simulate crop complete
      capturedOnCropComplete?.(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 10, y: 10, width: 200, height: 200 }
      );

      await user.click(screen.getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(mockOnCancel).toHaveBeenCalledTimes(1);
        expect(mockOnConfirm).not.toHaveBeenCalled();
      });

      global.Image = origImage;
    });

    it('should call onCancel when canvas context is unavailable', async () => {
      const user = userEvent.setup();

      // Mock canvas with null context
      const mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => null),
        toBlob: vi.fn(),
      };

      // Save original createElement before mocking
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tag) => {
        if (tag === 'canvas') return mockCanvas as unknown as HTMLCanvasElement;
        return originalCreateElement(tag);
      });

      const origImage = global.Image;
      (global as any).Image = class {
        onload: (() => void) | null = null;
        crossOrigin = '';
        set src(_: string) {
          setTimeout(() => this.onload?.(), 0);
        }
      };

      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      capturedOnCropComplete?.(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 10, y: 10, width: 200, height: 200 }
      );

      await user.click(screen.getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(mockOnCancel).toHaveBeenCalledTimes(1);
        expect(mockOnConfirm).not.toHaveBeenCalled();
      });

      global.Image = origImage;
    });

    it('should call onCancel when canvas.toBlob returns null', async () => {
      const user = userEvent.setup();

      // Mock canvas where toBlob returns null (browser failed to create blob)
      const mockCtx = { drawImage: vi.fn() };
      const mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => mockCtx),
        toBlob: vi.fn((cb: BlobCallback) => cb(null)), // blob is null
      };

      // Save original createElement before mocking
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tag) => {
        if (tag === 'canvas') return mockCanvas as unknown as HTMLCanvasElement;
        return originalCreateElement(tag);
      });

      // Mock Image constructor
      const origImage = global.Image;
      (global as any).Image = class {
        onload: (() => void) | null = null;
        crossOrigin = '';
        set src(_: string) {
          setTimeout(() => this.onload?.(), 0);
        }
      };

      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      // Simulate crop complete from Cropper
      capturedOnCropComplete?.(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 10, y: 10, width: 200, height: 200 }
      );

      await user.click(screen.getByRole('button', { name: /apply/i }));

      await waitFor(() => {
        expect(mockOnCancel).toHaveBeenCalledTimes(1);
        expect(mockOnConfirm).not.toHaveBeenCalled();
      });

      global.Image = origImage;
    });
  });

  describe('zoom controls', () => {
    it('should decrease zoom when zoom out button is clicked', async () => {
      const user = userEvent.setup();
      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const cropper = screen.getByTestId('cropper');
      expect(cropper).toHaveAttribute('data-zoom', '1'); // initial zoom

      await user.click(screen.getByLabelText('Zoom out'));

      // Zoom should not go below MIN_ZOOM (1), so stays at 1
      expect(cropper).toHaveAttribute('data-zoom', '1');
    });

    it('should increase zoom when zoom in button is clicked', async () => {
      const user = userEvent.setup();
      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      await user.click(screen.getByLabelText('Zoom in'));

      const cropper = screen.getByTestId('cropper');
      // Initial zoom is 1, step is 0.1, so zoom should be 1.1
      expect(Number(cropper.getAttribute('data-zoom'))).toBeCloseTo(1.1);
    });

    it('should update zoom when slider value changes', () => {
      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const slider = screen.getByLabelText('Zoom');
      fireEvent.change(slider, { target: { value: '2' } });

      const cropper = screen.getByTestId('cropper');
      expect(cropper).toHaveAttribute('data-zoom', '2');
    });

    it('should call onCancel when dialog is closed via onOpenChange', async () => {
      const user = userEvent.setup();
      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      // Click the close button which triggers onOpenChange(false)
      await user.click(screen.getByTestId('dialog-close'));

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('accessibility', () => {
    it('should have accessible labels for zoom controls', () => {
      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      expect(screen.getByLabelText('Zoom out')).toBeInTheDocument();
      expect(screen.getByLabelText('Zoom in')).toBeInTheDocument();
      expect(screen.getByLabelText('Zoom')).toBeInTheDocument();
    });

    it('should have proper button types', () => {
      render(
        <AvatarCropDialog
          open={true}
          imageSrc={mockImageSrc}
          onConfirm={mockOnConfirm}
          onCancel={mockOnCancel}
        />
      );

      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      const applyButton = screen.getByRole('button', { name: /apply/i });
      expect(cancelButton).toHaveAttribute('type', 'button');
      expect(applyButton).toHaveAttribute('type', 'button');
    });
  });
});
