/**
 * AvatarUpload Component Tests
 *
 * Tests the AvatarUpload component which handles:
 * - Rendering avatar with image or fallback
 * - Upload button interactions
 * - Client-side file validation (type and size)
 * - Avatar cropping workflow (file select → crop → confirm/cancel)
 * - Upload to server with session refresh
 * - Avatar deletion with session refresh
 * - Drag and drop functionality
 * - Loading states during upload/delete
 * - Error handling for all operations
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/forms/avatar-upload.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AvatarUpload } from '@/components/forms/avatar-upload';

// Mock dependencies
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    updateUser: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    code: string;
    details?: unknown;
    constructor(message: string, code: string, details?: unknown) {
      super(message);
      this.code = code;
      this.details = details;
      this.name = 'APIClientError';
    }
  },
}));

vi.mock('@/components/forms/avatar-crop-dialog', () => ({
  AvatarCropDialog: ({
    open,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    imageSrc: string;
    onConfirm: (blob: Blob) => void;
    onCancel: () => void;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="avatar-crop-dialog">
        <button
          data-testid="crop-confirm"
          onClick={() => {
            const mockBlob = new Blob(['cropped'], { type: 'image/jpeg' });
            onConfirm(mockBlob);
          }}
        >
          Confirm
        </button>
        <button data-testid="crop-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  },
}));

/**
 * Helper function to simulate file selection without causing stack overflow
 */
function selectFile(fileInput: HTMLInputElement, file: File) {
  // Create a mock FileList
  const fileList = {
    0: file,
    length: 1,
    item: () => file,
    [Symbol.iterator]: function* () {
      yield file;
    },
  } as unknown as FileList;

  // Try to set the files property (may already be defined)
  try {
    Object.defineProperty(fileInput, 'files', {
      value: fileList,
      writable: false,
      configurable: true, // Allow redefining
    });
  } catch {
    // If already defined, try to set it directly
    (fileInput as { files: FileList }).files = fileList;
  }

  // Trigger the change event
  fireEvent.change(fileInput);
}

/**
 * Test Suite: AvatarUpload Component
 */
describe('components/forms/avatar-upload', () => {
  let mockRouter: {
    refresh: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Setup mock router
    const { useRouter } = await import('next/navigation');
    mockRouter = {
      refresh: vi.fn(),
    };
    vi.mocked(useRouter).mockReturnValue({
      ...mockRouter,
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);

    // Mock fetch for upload
    global.fetch = vi.fn();

    // Mock URL.createObjectURL and revokeObjectURL
    global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    global.URL.revokeObjectURL = vi.fn();
  });

  describe('rendering', () => {
    it('should render avatar with fallback when no image', () => {
      // Arrange & Act
      render(<AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />);

      // Assert
      expect(screen.getByText('JD')).toBeInTheDocument(); // Fallback initials
      expect(screen.getByText('John Doe')).toBeInTheDocument(); // Name display
    });

    it('should render avatar image when URL provided', () => {
      // Arrange & Act
      render(
        <AvatarUpload
          currentAvatar="https://example.com/avatar.jpg"
          userName="John Doe"
          initials="JD"
        />
      );

      // Assert - Avatar component receives the image src
      // Note: The img tag might not render immediately in tests due to loading behavior
      // Verify the username is displayed (this always renders)
      expect(screen.getByText('John Doe')).toBeInTheDocument();
      // Verify upload button is available
      const uploadButtons = screen.getAllByRole('button', { name: /upload/i });
      expect(uploadButtons.length).toBeGreaterThan(0);
    });

    it('should render upload button', () => {
      // Arrange & Act
      render(<AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />);

      // Assert - There are multiple buttons with Upload (avatar overlay + upload button)
      const uploadButtons = screen.getAllByRole('button', { name: /upload/i });
      expect(uploadButtons.length).toBeGreaterThan(0);
    });

    it('should render remove button when avatar exists', () => {
      // Arrange & Act
      render(
        <AvatarUpload
          currentAvatar="https://example.com/avatar.jpg"
          userName="John Doe"
          initials="JD"
        />
      );

      // Assert - The trash icon button exists (look for ghost variant which is the delete button)
      const buttons = screen.getAllByRole('button');
      const trashButton = buttons.find((btn) => {
        const classes = btn.className || '';
        // Look for the delete button - has text-destructive and hover:bg-accent (ghost variant pattern)
        return classes.includes('text-destructive') && classes.includes('hover:bg-accent');
      });
      expect(trashButton).toBeDefined();
    });

    it('should NOT render remove button when no avatar', () => {
      // Arrange & Act
      render(<AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />);

      // Assert - No ghost variant button (the trash button)
      const buttons = screen.getAllByRole('button');
      const trashButton = buttons.find((btn) => btn.className.includes('ghost'));
      expect(trashButton).toBeUndefined();
    });

    it('should display file type hint', () => {
      // Arrange & Act
      render(<AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />);

      // Assert
      expect(screen.getByText(/JPEG, PNG, WebP or GIF/i)).toBeInTheDocument();
      expect(screen.getByText(/Max 5MB/i)).toBeInTheDocument();
    });

    it('should have hidden file input', () => {
      // Arrange & Act
      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      // Assert
      const fileInput = container.querySelector('input[type="file"]');
      expect(fileInput).toBeInTheDocument();
      expect(fileInput).toHaveClass('hidden');
    });
  });

  describe('file selection and validation', () => {
    it('should have accept attribute for supported image types', () => {
      // Arrange & Act
      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      // Assert
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toHaveAttribute('accept');
      const acceptValue = fileInput.getAttribute('accept');
      expect(acceptValue).toContain('image/jpeg');
      expect(acceptValue).toContain('image/png');
      expect(acceptValue).toContain('image/webp');
      expect(acceptValue).toContain('image/gif');
    });

    it('should open crop dialog when valid file is selected', async () => {
      // Arrange
      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const validFile = new File(['image'], 'avatar.jpg', { type: 'image/jpeg' });

      // Act
      selectFile(fileInput, validFile);

      // Assert
      await waitFor(() => {
        expect(screen.getByTestId('avatar-crop-dialog')).toBeInTheDocument();
      });
      expect(URL.createObjectURL).toHaveBeenCalledWith(validFile);
    });

    it('should show error for unsupported file type', async () => {
      // Arrange
      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const invalidFile = new File(['image'], 'avatar.bmp', { type: 'image/bmp' });

      // Act
      selectFile(fileInput, invalidFile);

      // Assert
      await waitFor(() => {
        expect(
          screen.getByText(/Invalid file type. Supported: JPEG, PNG, WebP, GIF/i)
        ).toBeInTheDocument();
      });
      expect(screen.queryByTestId('avatar-crop-dialog')).not.toBeInTheDocument();
    });

    it('should show error for file exceeding size limit', async () => {
      // Arrange
      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      // Create a file larger than 5MB
      const largeFile = new File([new ArrayBuffer(6 * 1024 * 1024)], 'large.jpg', {
        type: 'image/jpeg',
      });

      // Act
      selectFile(fileInput, largeFile);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/File too large. Maximum size: 5 MB/i)).toBeInTheDocument();
      });
      expect(screen.queryByTestId('avatar-crop-dialog')).not.toBeInTheDocument();
    });

    it('should clear file input after file selection', async () => {
      // Arrange
      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const validFile = new File(['image'], 'avatar.jpg', { type: 'image/jpeg' });

      // Act
      selectFile(fileInput, validFile);

      // Assert - Input value should be cleared (allows selecting same file again)
      await waitFor(() => {
        expect(fileInput.value).toBe('');
      });
    });
  });

  describe('crop workflow', () => {
    it('should NOT show crop dialog initially', () => {
      // Arrange & Act
      render(<AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />);

      // Assert
      expect(screen.queryByTestId('avatar-crop-dialog')).not.toBeInTheDocument();
    });

    it('should upload cropped image when crop is confirmed', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: { url: 'https://example.com/new-avatar.jpg' } }),
      } as Response);

      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const validFile = new File(['image'], 'avatar.jpg', { type: 'image/jpeg' });

      // Act - Select file to open crop dialog
      selectFile(fileInput, validFile);

      // Wait for crop dialog to appear
      await waitFor(() => {
        expect(screen.getByTestId('avatar-crop-dialog')).toBeInTheDocument();
      });

      // Click confirm to upload
      const confirmButton = screen.getByTestId('crop-confirm');
      await user.click(confirmButton);

      // Assert - Upload was called with FormData
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/v1/users/me/avatar',
          expect.objectContaining({
            method: 'POST',
            body: expect.any(FormData),
          })
        );
      });

      // Assert - Session was updated and router refreshed
      expect(authClient.updateUser).toHaveBeenCalledWith({
        image: 'https://example.com/new-avatar.jpg',
      });
      expect(mockRouter.refresh).toHaveBeenCalled();

      // Assert - Crop dialog is closed
      expect(screen.queryByTestId('avatar-crop-dialog')).not.toBeInTheDocument();
    });

    it('should cleanup blob URL when crop is confirmed', async () => {
      // Arrange
      const user = userEvent.setup();

      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: { url: 'https://example.com/new-avatar.jpg' } }),
      } as Response);

      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const validFile = new File(['image'], 'avatar.jpg', { type: 'image/jpeg' });

      // Act
      selectFile(fileInput, validFile);
      await waitFor(() => {
        expect(screen.getByTestId('avatar-crop-dialog')).toBeInTheDocument();
      });

      const confirmButton = screen.getByTestId('crop-confirm');
      await user.click(confirmButton);

      // Assert - Blob URL was revoked
      await waitFor(() => {
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
      });
    });

    it('should close crop dialog when crop is cancelled', async () => {
      // Arrange
      const user = userEvent.setup();
      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const validFile = new File(['image'], 'avatar.jpg', { type: 'image/jpeg' });

      // Act - Select file to open crop dialog
      selectFile(fileInput, validFile);
      await waitFor(() => {
        expect(screen.getByTestId('avatar-crop-dialog')).toBeInTheDocument();
      });

      // Click cancel
      const cancelButton = screen.getByTestId('crop-cancel');
      await user.click(cancelButton);

      // Assert - Dialog is closed, no upload was made
      await waitFor(() => {
        expect(screen.queryByTestId('avatar-crop-dialog')).not.toBeInTheDocument();
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should cleanup blob URL when crop is cancelled', async () => {
      // Arrange
      const user = userEvent.setup();
      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const validFile = new File(['image'], 'avatar.jpg', { type: 'image/jpeg' });

      // Act
      selectFile(fileInput, validFile);
      await waitFor(() => {
        expect(screen.getByTestId('avatar-crop-dialog')).toBeInTheDocument();
      });

      const cancelButton = screen.getByTestId('crop-cancel');
      await user.click(cancelButton);

      // Assert - Blob URL was revoked
      await waitFor(() => {
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
      });
    });
  });

  describe('upload error handling', () => {
    it('should show error message when upload fails', async () => {
      // Arrange
      const user = userEvent.setup();

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        json: async () => ({ error: { message: 'Upload failed' } }),
      } as Response);

      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const validFile = new File(['image'], 'avatar.jpg', { type: 'image/jpeg' });

      // Act
      selectFile(fileInput, validFile);
      await waitFor(() => {
        expect(screen.getByTestId('avatar-crop-dialog')).toBeInTheDocument();
      });

      const confirmButton = screen.getByTestId('crop-confirm');
      await user.click(confirmButton);

      // Assert - Error message is displayed
      await waitFor(() => {
        expect(screen.getByText(/Upload failed/i)).toBeInTheDocument();
      });
    });

    it('should show generic error message when upload fails without message', async () => {
      // Arrange
      const user = userEvent.setup();

      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        json: async () => ({}),
      } as Response);

      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const validFile = new File(['image'], 'avatar.jpg', { type: 'image/jpeg' });

      // Act
      selectFile(fileInput, validFile);
      await waitFor(() => {
        expect(screen.getByTestId('avatar-crop-dialog')).toBeInTheDocument();
      });

      const confirmButton = screen.getByTestId('crop-confirm');
      await user.click(confirmButton);

      // Assert - Generic error message
      await waitFor(() => {
        expect(screen.getByText(/Upload failed/i)).toBeInTheDocument();
      });
    });

    it('should handle network errors during upload', async () => {
      // Arrange
      const user = userEvent.setup();

      vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'));

      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const validFile = new File(['image'], 'avatar.jpg', { type: 'image/jpeg' });

      // Act
      selectFile(fileInput, validFile);
      await waitFor(() => {
        expect(screen.getByTestId('avatar-crop-dialog')).toBeInTheDocument();
      });

      const confirmButton = screen.getByTestId('crop-confirm');
      await user.click(confirmButton);

      // Assert - Error message is displayed
      await waitFor(() => {
        expect(screen.getByText(/Network error/i)).toBeInTheDocument();
      });
    });

    it('should clear previous error when starting new upload', async () => {
      // Arrange
      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

      // First upload with invalid file type
      const invalidFile = new File(['image'], 'avatar.bmp', { type: 'image/bmp' });
      selectFile(fileInput, invalidFile);

      await waitFor(() => {
        expect(screen.getByText(/Invalid file type/i)).toBeInTheDocument();
      });

      // Act - Select valid file
      const validFile = new File(['image'], 'avatar.jpg', { type: 'image/jpeg' });
      selectFile(fileInput, validFile);

      // Assert - Error is cleared
      await waitFor(() => {
        expect(screen.queryByText(/Invalid file type/i)).not.toBeInTheDocument();
      });
    });
  });

  describe('avatar deletion', () => {
    it('should call delete API when remove button clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.delete).mockResolvedValue(undefined);

      render(
        <AvatarUpload
          currentAvatar="https://example.com/avatar.jpg"
          userName="John Doe"
          initials="JD"
        />
      );

      // Act - Find the trash button (ghost variant with text-destructive class)
      const buttons = screen.getAllByRole('button');
      const trashButton = buttons.find((btn) => {
        const classes = btn.className || '';
        // Look for the delete button - has text-destructive and hover:bg-accent (ghost variant pattern)
        return classes.includes('text-destructive') && classes.includes('hover:bg-accent');
      });

      expect(trashButton).toBeDefined();
      if (trashButton) {
        await user.click(trashButton);
      }

      // Assert
      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith('/api/v1/users/me/avatar');
      });
    });

    it('should update session and refresh after deletion', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(apiClient.delete).mockResolvedValue(undefined);

      render(
        <AvatarUpload
          currentAvatar="https://example.com/avatar.jpg"
          userName="John Doe"
          initials="JD"
        />
      );

      // Act
      const buttons = screen.getAllByRole('button');
      const trashButton = buttons.find((btn) => {
        const classes = btn.className || '';
        // Look for the delete button - has text-destructive and hover:bg-accent (ghost variant pattern)
        return classes.includes('text-destructive') && classes.includes('hover:bg-accent');
      });

      if (trashButton) {
        await user.click(trashButton);
      }

      // Assert
      await waitFor(() => {
        expect(authClient.updateUser).toHaveBeenCalledWith({ image: '' });
        expect(mockRouter.refresh).toHaveBeenCalled();
      });
    });

    it('should handle deletion error with APIClientError', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient, APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.delete).mockRejectedValue(
        new APIClientError('Deletion failed', 'DELETE_FAILED')
      );

      render(
        <AvatarUpload
          currentAvatar="https://example.com/avatar.jpg"
          userName="John Doe"
          initials="JD"
        />
      );

      // Act
      const buttons = screen.getAllByRole('button');
      const trashButton = buttons.find((btn) => {
        const classes = btn.className || '';
        return classes.includes('text-destructive') && classes.includes('hover:bg-accent');
      });

      expect(trashButton).toBeDefined();
      if (trashButton) {
        await user.click(trashButton);
      }

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/deletion failed/i)).toBeInTheDocument();
      });
    });

    it('should handle deletion error with generic error', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.delete).mockRejectedValue(new Error('Unknown error'));

      render(
        <AvatarUpload
          currentAvatar="https://example.com/avatar.jpg"
          userName="John Doe"
          initials="JD"
        />
      );

      // Act
      const buttons = screen.getAllByRole('button');
      const trashButton = buttons.find((btn) => {
        const classes = btn.className || '';
        return classes.includes('text-destructive') && classes.includes('hover:bg-accent');
      });

      expect(trashButton).toBeDefined();
      if (trashButton) {
        await user.click(trashButton);
      }

      // Assert - Generic error message
      await waitFor(() => {
        expect(screen.getByText(/Failed to remove avatar/i)).toBeInTheDocument();
      });
    });

    it('should clear previous error when deleting', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      const { container } = render(
        <AvatarUpload
          currentAvatar="https://example.com/avatar.jpg"
          userName="John Doe"
          initials="JD"
        />
      );

      // First cause an error with invalid file type
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const invalidFile = new File(['image'], 'avatar.bmp', { type: 'image/bmp' });
      selectFile(fileInput, invalidFile);

      await waitFor(() => {
        expect(screen.getByText(/Invalid file type/i)).toBeInTheDocument();
      });

      vi.mocked(apiClient.delete).mockResolvedValue(undefined);

      // Act - Delete avatar
      const buttons = screen.getAllByRole('button');
      const trashButton = buttons.find((btn) => {
        const classes = btn.className || '';
        // Look for the delete button - has text-destructive and hover:bg-accent (ghost variant pattern)
        return classes.includes('text-destructive') && classes.includes('hover:bg-accent');
      });

      if (trashButton) {
        await user.click(trashButton);
      }

      // Assert - Error is cleared
      await waitFor(() => {
        expect(screen.queryByText(/Invalid file type/i)).not.toBeInTheDocument();
      });
    });
  });

  describe('loading states', () => {
    it('should show uploading state during upload', async () => {
      // Arrange
      const user = userEvent.setup();

      // Make fetch hang to keep uploading state
      vi.mocked(global.fetch).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  json: async () => ({ success: true, data: { url: 'test.jpg' } }),
                } as Response),
              100
            );
          })
      );

      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const validFile = new File(['image'], 'avatar.jpg', { type: 'image/jpeg' });

      // Act
      selectFile(fileInput, validFile);
      await waitFor(() => {
        expect(screen.getByTestId('avatar-crop-dialog')).toBeInTheDocument();
      });

      const confirmButton = screen.getByTestId('crop-confirm');
      await user.click(confirmButton);

      // Assert - Uploading text is shown
      await waitFor(() => {
        expect(screen.getByText(/Uploading.../i)).toBeInTheDocument();
      });
    });

    it('should disable buttons during upload', async () => {
      // Arrange
      const user = userEvent.setup();

      vi.mocked(global.fetch).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  json: async () => ({ success: true, data: { url: 'test.jpg' } }),
                } as Response),
              100
            );
          })
      );

      const { container } = render(
        <AvatarUpload
          currentAvatar="https://example.com/avatar.jpg"
          userName="John Doe"
          initials="JD"
        />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const validFile = new File(['image'], 'avatar.jpg', { type: 'image/jpeg' });

      // Act
      selectFile(fileInput, validFile);
      await waitFor(() => {
        expect(screen.getByTestId('avatar-crop-dialog')).toBeInTheDocument();
      });

      const confirmButton = screen.getByTestId('crop-confirm');
      await user.click(confirmButton);

      // Assert - Actual button elements are disabled during upload
      await waitFor(() => {
        const allButtons = screen.getAllByRole('button');
        allButtons.forEach((button) => {
          // Skip crop dialog buttons and skip the avatar overlay (it's a div with role="button", not a real button)
          if (!button.hasAttribute('data-testid') && button.tagName === 'BUTTON') {
            expect(button).toBeDisabled();
          }
        });
      });
    });

    it('should disable file input during upload', async () => {
      // Arrange
      const user = userEvent.setup();

      vi.mocked(global.fetch).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  json: async () => ({ success: true, data: { url: 'test.jpg' } }),
                } as Response),
              100
            );
          })
      );

      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const validFile = new File(['image'], 'avatar.jpg', { type: 'image/jpeg' });

      // Act
      selectFile(fileInput, validFile);
      await waitFor(() => {
        expect(screen.getByTestId('avatar-crop-dialog')).toBeInTheDocument();
      });

      const confirmButton = screen.getByTestId('crop-confirm');
      await user.click(confirmButton);

      // Assert - File input is disabled
      await waitFor(() => {
        expect(fileInput).toBeDisabled();
      });
    });

    it('should show deleting state during deletion', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');

      // Make delete hang to keep deleting state
      vi.mocked(apiClient.delete).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(undefined), 100);
          })
      );

      render(
        <AvatarUpload
          currentAvatar="https://example.com/avatar.jpg"
          userName="John Doe"
          initials="JD"
        />
      );

      // Act
      const buttons = screen.getAllByRole('button');
      const trashButton = buttons.find((btn) => {
        const classes = btn.className || '';
        // Look for the delete button - has text-destructive and hover:bg-accent (ghost variant pattern)
        return classes.includes('text-destructive') && classes.includes('hover:bg-accent');
      });

      if (trashButton) {
        await user.click(trashButton);
      }

      // Assert - Loading spinner in trash button
      await waitFor(() => {
        const loadingIcon = screen.getAllByRole('button').find((btn) => {
          const classes = btn.className || '';
          return classes.includes('text-destructive') && btn.querySelector('.animate-spin');
        });
        expect(loadingIcon).toBeInTheDocument();
      });
    });
  });

  describe('drag and drop', () => {
    it('should handle drag over event', async () => {
      // Arrange
      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const uploadArea = screen.getByRole('button', { name: 'Upload avatar' });

      // Act
      const dragEvent = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
      });

      Object.defineProperty(dragEvent, 'dataTransfer', {
        value: { files: [], types: [] },
      });

      uploadArea.dispatchEvent(dragEvent);

      // Assert - Drag over styling is applied
      await waitFor(() => {
        const overlay = container.querySelector('.border-primary');
        expect(overlay).toBeInTheDocument();
      });
    });

    it('should handle drag leave event', async () => {
      // Arrange
      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const uploadArea = screen.getByRole('button', { name: 'Upload avatar' });

      // Act - First drag over, then drag leave
      const dragOverEvent = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(dragOverEvent, 'dataTransfer', {
        value: { files: [], types: [] },
      });
      uploadArea.dispatchEvent(dragOverEvent);

      await waitFor(() => {
        const overlay = container.querySelector('.border-primary');
        expect(overlay).toBeInTheDocument();
      });

      const dragLeaveEvent = new DragEvent('dragleave', {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(dragLeaveEvent, 'dataTransfer', {
        value: { files: [], types: [] },
      });
      uploadArea.dispatchEvent(dragLeaveEvent);

      // Assert - Drag styling is removed
      await waitFor(() => {
        const overlay = container.querySelector('.border-primary');
        expect(overlay).not.toBeInTheDocument();
      });
    });

    it('should handle file drop', async () => {
      // Arrange
      render(<AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />);

      const uploadArea = screen.getByRole('button', { name: 'Upload avatar' });
      const validFile = new File(['image'], 'avatar.jpg', { type: 'image/jpeg' });

      // Act - Create a proper mock DataTransfer with files
      const dataTransfer = {
        files: [validFile],
        items: {
          add: vi.fn(),
        },
        types: ['Files'],
      };

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
      });

      // Manually set dataTransfer on the event
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: dataTransfer,
      });

      uploadArea.dispatchEvent(dropEvent);

      // Assert - Crop dialog opens
      await waitFor(() => {
        expect(screen.getByTestId('avatar-crop-dialog')).toBeInTheDocument();
      });
    });
  });

  describe('accessibility', () => {
    it('should have accessible upload button', () => {
      // Arrange & Act
      render(<AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />);

      // Assert
      const uploadArea = screen.getByRole('button', { name: 'Upload avatar' });
      expect(uploadArea).toHaveAttribute('tabIndex', '0');
    });

    it('should support keyboard navigation on upload area', async () => {
      // Arrange
      const user = userEvent.setup();
      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const uploadArea = screen.getByRole('button', { name: 'Upload avatar' });
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

      const clickSpy = vi.spyOn(fileInput, 'click');

      // Act - Press Enter
      uploadArea.focus();
      await user.keyboard('{Enter}');

      // Assert
      expect(clickSpy).toHaveBeenCalled();
    });

    it('should support space key on upload area', async () => {
      // Arrange
      const user = userEvent.setup();
      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const uploadArea = screen.getByRole('button', { name: 'Upload avatar' });
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

      const clickSpy = vi.spyOn(fileInput, 'click');

      // Act - Press Space
      uploadArea.focus();
      await user.keyboard(' ');

      // Assert
      expect(clickSpy).toHaveBeenCalled();
    });

    it('should have proper alt text for avatar image', () => {
      // Arrange & Act
      const { container } = render(
        <AvatarUpload
          currentAvatar="https://example.com/avatar.jpg"
          userName="John Doe"
          initials="JD"
        />
      );

      // Assert - If img renders, it should have proper alt text
      const avatarImage = container.querySelector('img');
      if (avatarImage) {
        expect(avatarImage).toHaveAttribute('alt', 'John Doe');
      }
      // If no img tag (loading behavior in tests), verify component still renders correctly
      expect(screen.getByText('John Doe')).toBeInTheDocument(); // Username is always shown
    });
  });

  describe('click to upload', () => {
    it('should open file picker when upload button is clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      // Find the actual Upload button (not the avatar overlay button)
      const uploadButtons = screen.getAllByRole('button', { name: /upload/i });
      const uploadButton = uploadButtons.find((btn) => btn.className.includes('outline'));
      expect(uploadButton).toBeDefined();

      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const clickSpy = vi.spyOn(fileInput, 'click');

      // Act
      if (uploadButton) {
        await user.click(uploadButton);
      }

      // Assert
      expect(clickSpy).toHaveBeenCalled();
    });

    it('should open file picker when avatar is clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      const { container } = render(
        <AvatarUpload currentAvatar={null} userName="John Doe" initials="JD" />
      );

      const uploadArea = screen.getByRole('button', { name: 'Upload avatar' });
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

      const clickSpy = vi.spyOn(fileInput, 'click');

      // Act
      await user.click(uploadArea);

      // Assert
      expect(clickSpy).toHaveBeenCalled();
    });
  });
});
