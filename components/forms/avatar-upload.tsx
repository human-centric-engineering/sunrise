'use client';

/**
 * Avatar Upload Component
 *
 * Allows users to upload, preview, and remove their profile picture.
 * Supports drag-and-drop and click-to-upload.
 *
 * @see .context/storage/overview.md for storage documentation
 */

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, X, Loader2, Camera, Trash2 } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { apiClient, APIClientError } from '@/lib/api/client';

/**
 * Supported image MIME types (must match server-side validation)
 */
const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE_MB = 5;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

/**
 * API error response shape
 */
interface APIErrorResponse {
  error?: {
    message?: string;
  };
}

interface AvatarUploadProps {
  /** Current avatar URL */
  currentAvatar: string | null;
  /** User's name (for avatar fallback) */
  userName: string;
  /** User initials for avatar fallback */
  initials: string;
}

export function AvatarUpload({ currentAvatar, userName, initials }: AvatarUploadProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Clear preview and error state
  const resetState = useCallback(() => {
    setPreview(null);
    setError(null);
  }, []);

  // Validate file before upload
  const validateFile = (file: File): string | null => {
    if (!SUPPORTED_TYPES.includes(file.type)) {
      return `Invalid file type. Supported: JPEG, PNG, WebP, GIF`;
    }
    if (file.size > MAX_FILE_SIZE) {
      return `File too large. Maximum size: ${MAX_FILE_SIZE_MB} MB`;
    }
    return null;
  };

  // Handle file selection
  const handleFileSelect = useCallback(
    async (file: File) => {
      resetState();

      // Validate
      const validationError = validateFile(file);
      if (validationError) {
        setError(validationError);
        return;
      }

      // Show preview
      const previewUrl = URL.createObjectURL(file);
      setPreview(previewUrl);

      // Upload
      try {
        setIsUploading(true);
        setError(null);

        const formData = new FormData();
        formData.append('file', file);

        // Use fetch directly for FormData (apiClient doesn't support FormData)
        const response = await fetch('/api/v1/users/me/avatar', {
          method: 'POST',
          body: formData,
        });

        const result = (await response.json()) as APIErrorResponse;

        if (!response.ok) {
          throw new Error(result.error?.message ?? 'Upload failed');
        }

        // Refresh to show new avatar
        router.refresh();
        setPreview(null);
      } catch (err) {
        if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('Failed to upload avatar');
        }
        setPreview(null);
      } finally {
        setIsUploading(false);
        // Clean up preview URL
        URL.revokeObjectURL(previewUrl);
      }
    },
    [router, resetState]
  );

  // Handle input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void handleFileSelect(file);
    }
    // Reset input value so same file can be selected again
    e.target.value = '';
  };

  // Handle drag events
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const file = e.dataTransfer.files?.[0];
      if (file) {
        void handleFileSelect(file);
      }
    },
    [handleFileSelect]
  );

  // Handle click to open file picker
  const handleClick = () => {
    fileInputRef.current?.click();
  };

  // Handle keyboard events for accessibility
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  // Handle avatar removal
  const handleRemove = () => {
    if (!currentAvatar) return;

    setIsDeleting(true);
    setError(null);

    apiClient
      .delete('/api/v1/users/me/avatar')
      .then(() => {
        router.refresh();
      })
      .catch((err: unknown) => {
        if (err instanceof APIClientError) {
          setError(err.message);
        } else {
          setError('Failed to remove avatar');
        }
      })
      .finally(() => {
        setIsDeleting(false);
      });
  };

  const isLoading = isUploading || isDeleting;
  const displayImage = preview || currentAvatar;

  return (
    <div className="flex items-center gap-4">
      {/* Avatar with upload overlay */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload avatar"
        className={`relative cursor-pointer ${isLoading ? 'pointer-events-none opacity-50' : ''}`}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <Avatar className="h-20 w-20">
          <AvatarImage src={displayImage || undefined} alt={userName} />
          <AvatarFallback className="text-lg">{initials}</AvatarFallback>
        </Avatar>

        {/* Hover/drag overlay */}
        <div
          className={`absolute inset-0 flex items-center justify-center rounded-full transition-all ${
            isDragging
              ? 'bg-primary/20 border-primary border-2'
              : 'bg-black/50 opacity-0 hover:opacity-100'
          }`}
        >
          {isUploading ? (
            <Loader2 className="h-6 w-6 animate-spin text-white" />
          ) : (
            <Camera className="h-6 w-6 text-white" />
          )}
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept={SUPPORTED_TYPES.join(',')}
          onChange={handleInputChange}
          className="hidden"
          disabled={isLoading}
        />
      </div>

      {/* Info and actions */}
      <div className="space-y-2">
        <p className="font-medium">{userName}</p>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleClick}
            disabled={isLoading}
          >
            {isUploading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                Upload
              </>
            )}
          </Button>

          {currentAvatar && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRemove}
              disabled={isLoading}
              className="text-destructive hover:text-destructive"
            >
              {isDeleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>

        {/* File type hint */}
        <p className="text-muted-foreground text-xs">
          JPEG, PNG, WebP or GIF. Max {MAX_FILE_SIZE_MB}MB.
        </p>

        {/* Error message */}
        {error && (
          <div className="text-destructive flex items-center gap-2 text-sm">
            <X className="h-4 w-4" />
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
