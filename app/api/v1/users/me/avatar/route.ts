/**
 * Avatar Upload Endpoint
 *
 * POST /api/v1/users/me/avatar - Upload avatar image
 * DELETE /api/v1/users/me/avatar - Remove avatar image
 *
 * Authentication: Required (session-based via better-auth)
 *
 * @see .context/storage/overview.md for storage documentation
 */

import { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { UnauthorizedError, APIError, handleAPIError, ErrorCodes } from '@/lib/api/errors';
import { uploadAvatar, deleteAvatar, isStorageEnabled, getMaxFileSize } from '@/lib/storage/upload';
import { validateImageMagicBytes, SUPPORTED_IMAGE_TYPES } from '@/lib/storage/image';
import { logger } from '@/lib/logging';

/**
 * POST /api/v1/users/me/avatar
 *
 * Uploads a new avatar image for the current user.
 * Accepts multipart/form-data with a single 'file' field.
 *
 * Processing:
 * - Validates file type via magic bytes
 * - Resizes to max 500x500 pixels
 * - Optimizes for web delivery
 * - Deletes previous avatar if exists
 *
 * @returns { url, key, size, width, height }
 * @throws UnauthorizedError if not authenticated
 * @throws APIError for validation/upload failures
 */
export async function POST(request: NextRequest) {
  try {
    // Check storage is enabled
    if (!isStorageEnabled()) {
      throw new APIError('File uploads are not configured', ErrorCodes.STORAGE_NOT_CONFIGURED, 503);
    }

    // Authenticate
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    if (!session) {
      throw new UnauthorizedError();
    }

    const userId = session.user.id;

    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      throw new APIError('No file provided', ErrorCodes.VALIDATION_ERROR, 400);
    }

    // Validate file size
    const maxSize = getMaxFileSize();
    if (file.size > maxSize) {
      const maxSizeMB = Math.round(maxSize / (1024 * 1024));
      throw new APIError(
        `File size exceeds maximum of ${maxSizeMB} MB`,
        ErrorCodes.FILE_TOO_LARGE,
        400,
        { maxSize: maxSizeMB, actualSize: Math.round(file.size / (1024 * 1024)) }
      );
    }

    // Convert to buffer for processing
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Validate magic bytes (server-side MIME type verification)
    const validation = validateImageMagicBytes(buffer);
    if (!validation.valid) {
      throw new APIError(
        validation.error || 'Invalid image format',
        ErrorCodes.INVALID_FILE_TYPE,
        400,
        { supportedTypes: SUPPORTED_IMAGE_TYPES }
      );
    }

    logger.info('Avatar upload started', {
      userId,
      fileName: file.name,
      fileSize: file.size,
      detectedType: validation.detectedType,
    });

    // Get current user to check for existing avatar
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { image: true },
    });

    // Upload new avatar
    const result = await uploadAvatar(buffer, { userId });

    // Delete old avatar if exists
    if (currentUser?.image) {
      try {
        await deleteAvatar(currentUser.image);
        logger.info('Previous avatar deleted', { userId, oldUrl: currentUser.image });
      } catch (deleteError) {
        // Log but don't fail the upload if old file deletion fails
        logger.warn('Failed to delete previous avatar', {
          userId,
          oldUrl: currentUser.image,
          error: deleteError instanceof Error ? deleteError.message : 'Unknown error',
        });
      }
    }

    // Update user with new avatar URL
    await prisma.user.update({
      where: { id: userId },
      data: { image: result.url },
    });

    logger.info('Avatar upload completed', {
      userId,
      url: result.url,
      size: result.size,
      width: result.width,
      height: result.height,
    });

    return successResponse({
      url: result.url,
      key: result.key,
      size: result.size,
      width: result.width,
      height: result.height,
    });
  } catch (error) {
    // Log upload-specific errors
    if (error instanceof APIError) {
      logger.warn('Avatar upload failed', {
        code: error.code,
        message: error.message,
        details: error.details,
      });
    }
    return handleAPIError(error);
  }
}

/**
 * DELETE /api/v1/users/me/avatar
 *
 * Removes the current user's avatar image.
 * Deletes from storage and sets user.image to null.
 *
 * @returns { success: true, message: "Avatar removed" }
 * @throws UnauthorizedError if not authenticated
 */
export async function DELETE(_request: NextRequest) {
  try {
    // Authenticate
    const requestHeaders = await headers();
    const session = await auth.api.getSession({ headers: requestHeaders });

    if (!session) {
      throw new UnauthorizedError();
    }

    const userId = session.user.id;

    // Get current avatar URL
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { image: true },
    });

    if (!user?.image) {
      return successResponse({
        success: true,
        message: 'No avatar to remove',
      });
    }

    // Delete from storage
    if (isStorageEnabled()) {
      try {
        await deleteAvatar(user.image);
        logger.info('Avatar deleted from storage', { userId, url: user.image });
      } catch (deleteError) {
        // Log but continue with database update
        logger.warn('Failed to delete avatar from storage', {
          userId,
          url: user.image,
          error: deleteError instanceof Error ? deleteError.message : 'Unknown error',
        });
      }
    }

    // Clear avatar URL in database
    await prisma.user.update({
      where: { id: userId },
      data: { image: null },
    });

    logger.info('Avatar removed', { userId });

    return successResponse({
      success: true,
      message: 'Avatar removed',
    });
  } catch (error) {
    return handleAPIError(error);
  }
}
