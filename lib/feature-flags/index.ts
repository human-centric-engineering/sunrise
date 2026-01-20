/**
 * Feature Flags Utilities (Phase 4.4)
 *
 * Runtime feature toggle system for admin-controlled features.
 * Flags are stored in the database and can be toggled without redeployment.
 *
 * @example
 * ```typescript
 * import { isFeatureEnabled } from '@/lib/feature-flags';
 *
 * // Check if a feature is enabled
 * if (await isFeatureEnabled('MAINTENANCE_MODE')) {
 *   return <MaintenancePage />;
 * }
 *
 * // Get all flags
 * const flags = await getAllFlags();
 * ```
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type { FeatureFlag, Prisma } from '@/types/prisma';
import { DEFAULT_FLAGS } from './config';

/**
 * Check if a feature flag is enabled
 *
 * Returns false if the flag doesn't exist in the database.
 * Logs a warning for unknown flags to help catch typos.
 *
 * @param name - Flag name (e.g., 'MAINTENANCE_MODE')
 * @returns Whether the flag is enabled
 */
export async function isFeatureEnabled(name: string): Promise<boolean> {
  try {
    const flag = await prisma.featureFlag.findUnique({
      where: { name: name.toUpperCase() },
      select: { enabled: true },
    });

    if (!flag) {
      logger.debug('Feature flag not found', { flag: name });
      return false;
    }

    return flag.enabled;
  } catch (error) {
    logger.error('Error checking feature flag', error, { flag: name });
    return false;
  }
}

/**
 * Get all feature flags
 *
 * @returns Array of all feature flags
 */
export async function getAllFlags(): Promise<FeatureFlag[]> {
  try {
    return await prisma.featureFlag.findMany({
      orderBy: { name: 'asc' },
    });
  } catch (error) {
    logger.error('Error fetching feature flags', error);
    return [];
  }
}

/**
 * Get a single feature flag by name
 *
 * @param name - Flag name
 * @returns The flag if found, null otherwise
 */
export async function getFlag(name: string): Promise<FeatureFlag | null> {
  try {
    return await prisma.featureFlag.findUnique({
      where: { name: name.toUpperCase() },
    });
  } catch (error) {
    logger.error('Error fetching feature flag', error, { flag: name });
    return null;
  }
}

/**
 * Toggle a feature flag
 *
 * @param name - Flag name
 * @param enabled - New enabled state
 * @returns The updated flag, or null if not found
 */
export async function toggleFlag(name: string, enabled: boolean): Promise<FeatureFlag | null> {
  try {
    const flag = await prisma.featureFlag.update({
      where: { name: name.toUpperCase() },
      data: { enabled },
    });

    logger.info('Feature flag toggled', { flag: name, enabled });
    return flag;
  } catch (error) {
    logger.error('Error toggling feature flag', error, { flag: name, enabled });
    return null;
  }
}

/**
 * Create a feature flag
 *
 * @param data - Flag data
 * @returns The created flag
 */
export async function createFlag(data: {
  name: string;
  description?: string;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
  createdBy?: string;
}): Promise<FeatureFlag> {
  const flag = await prisma.featureFlag.create({
    data: {
      name: data.name.toUpperCase(),
      description: data.description,
      enabled: data.enabled ?? false,
      metadata: (data.metadata ?? {}) as Prisma.InputJsonValue,
      createdBy: data.createdBy,
    },
  });

  logger.info('Feature flag created', { flag: flag.name, enabled: flag.enabled });
  return flag;
}

/**
 * Update a feature flag
 *
 * @param id - Flag ID
 * @param data - Updated data
 * @returns The updated flag
 */
export async function updateFlag(
  id: string,
  data: {
    description?: string;
    enabled?: boolean;
    metadata?: Record<string, unknown>;
  }
): Promise<FeatureFlag> {
  const flag = await prisma.featureFlag.update({
    where: { id },
    data: {
      description: data.description,
      enabled: data.enabled,
      metadata: data.metadata as Prisma.InputJsonValue | undefined,
    },
  });

  logger.info('Feature flag updated', { flag: flag.name, id });
  return flag;
}

/**
 * Delete a feature flag
 *
 * @param id - Flag ID
 */
export async function deleteFlag(id: string): Promise<void> {
  const flag = await prisma.featureFlag.delete({
    where: { id },
  });

  logger.info('Feature flag deleted', { flag: flag.name, id });
}

/**
 * Seed default feature flags
 *
 * Creates default flags if they don't exist.
 * Safe to call multiple times - won't override existing flags.
 */
export async function seedDefaultFlags(): Promise<void> {
  for (const flag of DEFAULT_FLAGS) {
    const existing = await prisma.featureFlag.findUnique({
      where: { name: flag.name },
    });

    if (!existing) {
      await prisma.featureFlag.create({
        data: flag,
      });
      logger.info('Seeded default feature flag', { flag: flag.name });
    }
  }
}
