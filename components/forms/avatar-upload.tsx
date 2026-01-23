'use client';

/**
 * Avatar Upload Component
 *
 * Allows users to upload, crop, and remove their profile picture.
 * Supports drag-and-drop and click-to-upload with a crop dialog.
 *
 * @see .context/storage/overview.md for storage documentation
 */

import { useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, Loader2, Camera, Trash2 } from 'lucide-react';
import { authClient } from '@/lib/auth/client';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { apiClient, APIClientError } from '@/lib/api/client';
import { AvatarCropDialog } from './avatar-crop-dialog';

/**
 * Supported image MIME types (must match server-side validation)
 */
const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE_MB = 5;
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

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
  const [isDragging, setIsDragging] = useState(false);

  // Crop dialog state
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
  const [showCropDialog, setShowCropDialog] = useState(false);

  // Validate file before showing cropper
  const validateFile = (file: File): string | null => {
    if (!SUPPORTED_TYPES.includes(file.type)) {
      return 'Invalid file type. Supported: JPEG, PNG, WebP, GIF';
    }
    if (file.size > MAX_FILE_SIZE) {
      return `File too large. Maximum size: ${MAX_FILE_SIZE_MB} MB`;
    }
    return null;
  };

  // Handle file selection - show crop dialog
  const handleFileSelect = useCallback((file: File) => {
    setError(null);

    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    // Create object URL for the cropper
    const imageUrl = URL.createObjectURL(file);
    setCropImageSrc(imageUrl);
    setShowCropDialog(true);
  }, []);

  // Handle crop confirmation - upload the cropped blob
  const handleCropConfirm = useCallback(
    async (croppedBlob: Blob) => {
      setShowCropDialog(false);

      // Clean up the source image URL
      if (cropImageSrc) {
        URL.revokeObjectURL(cropImageSrc);
        setCropImageSrc(null);
      }

      try {
        setIsUploading(true);
        setError(null);

        const formData = new FormData();
        formData.append('file', croppedBlob, 'avatar.jpg');

        const response = await fetch('/api/v1/users/me/avatar', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const result = (await response.json()) as { error?: { message?: string } };
          throw new Error(result.error?.message ?? 'Upload failed');
        }

        // Refresh the session cache so useSession() picks up the new image URL
        await authClient.getSession();
        router.refresh();
      } catch (err) {
        if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('Failed to upload avatar');
        }
      } finally {
        setIsUploading(false);
      }
    },
    [router, cropImageSrc]
  );

  // Handle crop cancellation
  const handleCropCancel = useCallback(() => {
    setShowCropDialog(false);
    if (cropImageSrc) {
      URL.revokeObjectURL(cropImageSrc);
      setCropImageSrc(null);
    }
  }, [cropImageSrc]);

  // Handle input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
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
        handleFileSelect(file);
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
      .then(async () => {
        // Refresh the session cache so useSession() picks up the removed image
        await authClient.getSession();
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

  return (
    <>
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
            <AvatarImage src={currentAvatar || undefined} alt={userName} />
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
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
      </div>

      {/* Crop dialog */}
      {cropImageSrc && (
        <AvatarCropDialog
          open={showCropDialog}
          imageSrc={cropImageSrc}
          onConfirm={(blob) => void handleCropConfirm(blob)}
          onCancel={handleCropCancel}
        />
      )}
    </>
  );
}
