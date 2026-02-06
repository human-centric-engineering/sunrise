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

import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { APIError, ErrorCodes } from '@/lib/api/errors';
import { uploadAvatar, isStorageEnabled, getMaxFileSize } from '@/lib/storage/upload';
import { validateImageMagicBytes, SUPPORTED_IMAGE_TYPES } from '@/lib/storage/image';
import { withAuth } from '@/lib/auth/guards';
import { getRouteLogger } from '@/lib/api/context';
import { uploadLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

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
export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  try {
    // Check upload rate limit
    const clientIP = getClientIP(request);
    const rateLimitResult = uploadLimiter.check(clientIP);

    if (!rateLimitResult.success) {
      log.warn('Avatar upload rate limit exceeded', {
        ip: clientIP,
        userId: session.user.id,
        remaining: rateLimitResult.remaining,
        reset: rateLimitResult.reset,
      });
      return createRateLimitResponse(rateLimitResult);
    }

    // Check storage is enabled
    if (!isStorageEnabled()) {
      throw new APIError('File uploads are not configured', ErrorCodes.STORAGE_NOT_CONFIGURED, 503);
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

    // Sanitize client-provided filename before logging to prevent log injection
    const sanitizedFileName = file.name.slice(0, 255).replace(/[^\w.-]/g, '_');

    log.info('Avatar upload started', {
      userId,
      fileName: sanitizedFileName,
      fileSize: file.size,
      detectedType: validation.detectedType,
    });

    // Upload avatar (overwrites existing file at same key)
    const result = await uploadAvatar(buffer, { userId });

    // Store URL with cache-busting timestamp so browsers fetch the new image
    const cacheBustedUrl = `${result.url}?v=${Date.now()}`;

    // Update user with cache-busted avatar URL
    await prisma.user.update({
      where: { id: userId },
      data: { image: cacheBustedUrl },
    });

    log.info('Avatar upload completed', {
      userId,
      url: cacheBustedUrl,
      size: result.size,
      width: result.width,
      height: result.height,
    });

    return successResponse({
      url: cacheBustedUrl,
      key: result.key,
      size: result.size,
      width: result.width,
      height: result.height,
    });
  } catch (error) {
    // Log upload-specific errors before re-throwing for withAuth to handle
    if (error instanceof APIError) {
      log.warn('Avatar upload failed', {
        code: error.code,
        message: error.message,
        details: error.details,
      });
    } else {
      log.error('Avatar upload error', error);
    }
    throw error;
  }
});

/**
 * DELETE /api/v1/users/me/avatar
 *
 * Removes the current user's avatar image.
 * Deletes from storage using the fixed key and sets user.image to null.
 *
 * @returns { success: true, message: "Avatar removed" }
 * @throws UnauthorizedError if not authenticated
 */
export const DELETE = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const userId = session.user.id;

  log.info('Avatar deletion started', { userId });

  // Delete avatar and its folder from storage
  if (isStorageEnabled()) {
    const { deleteByPrefix } = await import('@/lib/storage/upload');
    await deleteByPrefix(`avatars/${userId}/`);
  }

  // Clear avatar URL in database
  await prisma.user.update({
    where: { id: userId },
    data: { image: null },
  });

  log.info('Avatar removed', { userId });

  return successResponse({
    success: true,
    message: 'Avatar removed',
  });
});
